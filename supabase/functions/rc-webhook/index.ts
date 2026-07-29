// rc-webhook — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// RevenueCat → Supabase entitlement mirror (server-authoritative source of truth).
// RevenueCat es la verdad; esto escribe public.subscriptions Y espeja las columnas
// legadas profiles.subscription_status / subscription_expired_at (para que
// snaptrade-cleanup y cualquier lectura antigua sigan funcionando). Cuando el
// acceso muere de verdad, desconecta el broker en el acto.
//
// Auth: sin JWT de usuario (RevenueCat postea server-to-server). El header
// Authorization debe igualar RC_WEBHOOK_SECRET (con fallback a
// REVENUECAT_WEBHOOK_SECRET, para no tener que rotar el secreto ya configurado).
//
// Deploy: supabase functions deploy rc-webhook --no-verify-jwt
// RevenueCat → Integrations → Webhooks:
//   URL:  https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/rc-webhook
//   Authorization header: el valor del secreto (literal, SIN prefijo "Bearer").
// Requiere app_user_id == Supabase user.id  (PortivIAP.login(session.user.id)).
//
// ── Qué cambió respecto de la versión anterior ──────────────────────────────
//   + Idempotencia real (tabla subscription_events). RevenueCat reintenta hasta
//     recibir 2xx; sin esto, un reintento de EXPIRATION posterior a una
//     re-suscripción vuelve a dejar sin acceso a alguien que ya pagó.
//   + Guardia cross-store: un EXPIRATION de App Store no puede tocar una fila
//     cuya `store` es 'paddle'.
//   + REFUND / SUBSCRIPTION_PAUSED / TRANSFER → revocación.
//   + Huérfanos: compras con $RCAnonymousID se guardan en vez de descartarse.
//   + Desconexión inmediata del broker al morir el acceso (antes se delegaba
//     entera en el cron horario snaptrade-cleanup, que sigue como red de apoyo).
//   = Se conserva el gate de entorno SANDBOX, que el diseño original no tenía.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Configuración de negocio ───────────────────────────────────────────────
// Identificador del entitlement en RevenueCat (case-sensitive). Verificado en
// el dashboard: Product catalog → Entitlements → campo "Identifier". Aquí el id
// y el display name coinciden, ambos "Portiv Pro". Tiene que ser idéntico al
// ENTITLEMENT_ID de portiv-cap/src/iap.js; si no, el webhook ignora el evento.
const ENTITLEMENT_ID = "Portiv Pro";

// ¿Cortar el acceso en el INSTANTE en que el usuario desactiva la renovación?
//
//   false (RECOMENDADO) — conserva el acceso hasta expiration_at. Es el modelo
//     de Apple: ya pagó ese periodo. Cortar antes genera solicitudes de
//     reembolso, reseñas de 1 estrella y —si Apple lo ve en revisión— rechazo
//     por Guideline 3.1.2. El corte real llega solo, vía EXPIRATION.
//
//   true — corte inmediato al cancelar. Sólo asumiendo lo anterior.
const REVOKE_ON_CANCEL = false;

// Ventana de gracia ante fallo de cobro. Apple reintenta ~16 días; 18 de colchón.
// Durante la ventana el usuario ve un banner, no un muro.
const BILLING_GRACE_DAYS = 18;

// Tiendas que gobierna ESTA función. Un evento de otra tienda no puede tocar
// una fila que no es suya (ver guardia cross-store más abajo).
const OWNED_STORES = new Set(["APP_STORE", "MAC_APP_STORE", "PROMOTIONAL"]);

// ── Infra ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET =
  Deno.env.get("RC_WEBHOOK_SECRET") ??
  Deno.env.get("REVENUECAT_WEBHOOK_SECRET") ??
  "";
const ACCEPT_SANDBOX = (Deno.env.get("RC_ACCEPT_SANDBOX") ?? "").toLowerCase() === "true";

// snaptrade-disconnect ya expone un modo interno propio y probado:
// header `x-internal-secret` + body { app_user_id, reason }. Se reutiliza tal
// cual en vez de abrir un segundo camino de autenticación en esa función, que
// es la que borra usuarios en SnapTrade y es la más delicada del sistema.
const INTERNAL_SECRET =
  Deno.env.get("INTERNAL_DISCONNECT_SECRET") ??
  Deno.env.get("SNAPTRADE_CRON_SECRET") ??
  "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const log = (...a: unknown[]) => console.log("[rc-webhook]", ...a);

// Comparación en tiempo constante: un `===` sobre el secreto filtra su longitud
// y su prefijo por timing. Barato de evitar.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Resolución del usuario Supabase ────────────────────────────────────────
// PortivIAP.login(uid) hace que app_user_id == UUID de Supabase. Pero una compra
// iniciada antes de ese login llega como "$RCAnonymousID:…" y el UUID bueno
// puede estar sólo en `aliases`.
//
// OJO: `transferred_to` NO entra aquí a propósito. En un TRANSFER el que pierde
// el entitlement es el ORIGEN; meter el destino entre los candidatos revocaría
// justo a quien acaba de ganar la suscripción.
function resolveUid(ev: Record<string, any>): string | null {
  const candidates: string[] = [
    ev.app_user_id,
    ev.original_app_user_id,
    ...(Array.isArray(ev.aliases) ? ev.aliases : []),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  for (const c of candidates) if (UUID_RE.test(c)) return c;
  return null;
}

// ── Desconexión de SnapTrade ───────────────────────────────────────────────
// No se duplica la lógica de SnapTrade: se llama a la Edge Function que ya
// existe, en su modo interno. Esa función clasifica el fallo upstream y sólo
// limpia el enlace local cuando SnapTrade confirma la baja, así que un 502 de
// aquí NO deja al usuario marcado como desconectado mientras sigue facturando.
async function disconnectBroker(uid: string, reason: string): Promise<void> {
  if (!INTERNAL_SECRET) {
    log("WARN: sin INTERNAL_DISCONNECT_SECRET/SNAPTRADE_CRON_SECRET; el broker lo cerrará snaptrade-cleanup");
    return;
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/snaptrade-disconnect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ app_user_id: uid, reason }),
    });
    const txt = await r.text().catch(() => "");
    if (!r.ok) log("snaptrade-disconnect no-ok", uid, r.status, txt.slice(0, 200));
    else log("snaptrade-disconnect ok", uid, reason);
  } catch (e) {
    // Nunca propaga: si SnapTrade falla, la revocación del entitlement TIENE que
    // persistir igual. snaptrade-cleanup (horario) reintenta la desconexión.
    log("snaptrade-disconnect error", uid, String(e));
  }
}

// ── Máquina de estados ─────────────────────────────────────────────────────
type Plan = {
  active: boolean;
  status: string;
  revoke: boolean;       // ¿hay que matar el acceso y el broker?
  reason?: string;       // motivo sellado en profiles
  graceDays?: number;
};

function planFor(type: string, ev: Record<string, any>): Plan | null {
  switch (type) {
    // ── Sigue vivo ──────────────────────────────────────────────────────
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "PRODUCT_CHANGE":
    case "SUBSCRIPTION_EXTENDED":
    // Apple otorgó un periodo no renovable: acceso completo igual.
    case "NON_RENEWING_PURCHASE":
      return { active: true, status: "active", revoke: false };

    // ── Canceló la renovación ───────────────────────────────────────────
    // Conserva el acceso hasta expires_at. El corte llega con EXPIRATION.
    case "CANCELLATION": {
      if (REVOKE_ON_CANCEL) {
        return {
          active: false,
          status: "canceled",
          revoke: true,
          reason: "subscription_ended_appstore:cancellation",
        };
      }
      return { active: true, status: "canceled", revoke: false };
    }

    // ── Fallo de cobro: ventana de gracia, NO expulsión ─────────────────
    case "BILLING_ISSUE":
      return {
        active: true,
        status: "past_due",
        revoke: false,
        graceDays: BILLING_GRACE_DAYS,
      };

    // ── Muerte del acceso ───────────────────────────────────────────────
    case "EXPIRATION": {
      // cancel_reason distingue "no quiso renovar" de "la tarjeta falló".
      const cr = String(ev.cancellation_reason ?? ev.cancel_reason ?? "unknown").toLowerCase();
      return {
        active: false,
        status: cr.includes("billing") ? "past_due" : "expired",
        revoke: true,
        reason: `subscription_ended_appstore:expiration_${cr}`,
      };
    }

    case "REFUND":
    case "REFUND_REVERSED_TO_CUSTOMER":
      return {
        active: false,
        status: "refunded",
        revoke: true,
        reason: "subscription_ended_appstore:refund",
      };

    case "SUBSCRIPTION_PAUSED":
      return {
        active: false,
        status: "paused",
        revoke: true,
        reason: "subscription_ended_appstore:paused",
      };

    case "TRANSFER":
      return {
        active: false,
        status: "transferred",
        revoke: true,
        reason: "subscription_ended_appstore:transfer",
      };

    // TEST y cualquier tipo futuro desconocido: se registra y se ignora.
    // Nunca se revoca por un evento que no se entiende.
    default:
      return null;
  }
}

// Aplica el plan a UN uid. Devuelve null si todo fue bien, o un motivo de
// descarte. Se extrae en función porque TRANSFER revoca a varios a la vez.
async function applyPlan(
  uid: string,
  plan: Plan,
  ev: Record<string, any>,
  type: string,
  store: string,
  env: string,
): Promise<{ skipped?: string; error?: string }> {
  const { data: current } = await admin
    .from("subscriptions")
    .select("store, expires_at, entitlement_active")
    .eq("user_id", uid)
    .maybeSingle();

  // Guardia cross-store: no revocar una suscripción de OTRA tienda. Un usuario
  // que paga por Paddle en la web no puede perder el acceso porque le llegue un
  // EXPIRATION de App Store de una prueba vieja.
  if (plan.revoke && current?.store && store && current.store.toUpperCase() !== store) {
    log("cross-store revoke blocked", uid, current.store, "vs", store);
    return { skipped: "cross_store" };
  }

  const expMs = Number(ev.expiration_at_ms ?? 0);
  const expiresAt = expMs > 0
    ? new Date(expMs).toISOString()
    : plan.active
    ? current?.expires_at ?? null
    : new Date().toISOString();

  const nowIso = new Date().toISOString();
  const graceUntil = plan.graceDays
    ? new Date(Date.now() + plan.graceDays * 86400000).toISOString()
    : null;

  const { error: subErr } = await admin.from("subscriptions").upsert({
    user_id: uid,
    rc_app_user_id: String(ev.app_user_id ?? uid),
    entitlement_active: plan.active,
    status: plan.status,
    product_id: ev.product_id ?? null,
    original_transaction_id: ev.original_transaction_id ?? null,
    store: store ? store.toLowerCase() : current?.store ?? "app_store",
    environment: env || null,
    expires_at: expiresAt,
    will_renew: plan.status === "active",
    grace_until: graceUntil,
    revoked_at: plan.revoke ? nowIso : null,
    revoked_reason: plan.revoke ? plan.reason ?? type : null,
    last_event: type,
    updated_at: nowIso,
  }, { onConflict: "user_id" });

  if (subErr) {
    log("subscriptions upsert failed", uid, subErr.message);
    return { error: subErr.message };
  }

  // Espejo de las columnas legadas (snaptrade-cleanup y lecturas antiguas).
  await admin
    .from("profiles")
    .update({
      subscription_status: plan.status,
      subscription_expired_at: plan.active ? null : nowIso,
    })
    .eq("id", uid)
    .then(() => {}, (e: any) => log("profiles mirror failed", uid, e?.message));

  // Muerte del acceso → cerrar también la conexión del broker. Va DESPUÉS del
  // upsert a propósito: el entitlement es la verdad y no puede quedar sin
  // escribir porque SnapTrade tarde o falle.
  if (plan.revoke) {
    await disconnectBroker(uid, plan.reason ?? "subscription_ended_appstore");
  }

  return {};
}

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // 1 · Autenticación del webhook.
  if (SECRET) {
    const auth = req.headers.get("Authorization") ?? "";
    const presented = auth.replace(/^Bearer\s+/i, "").trim();
    if (!safeEqual(presented, SECRET)) {
      log("unauthorized webhook attempt");
      return new Response("Unauthorized", { status: 401 });
    }
  } else {
    log("FATAL: RC_WEBHOOK_SECRET no configurado — el webhook está abierto");
    return json({ error: "server_misconfigured" }, 500);
  }

  // 2 · Parseo.
  let body: any;
  try { body = await req.json(); } catch { return new Response("Bad Request", { status: 400 }); }

  const ev: any = body?.event ?? body ?? {};
  const type = String(ev.type ?? "").toUpperCase();
  const eventId = String(ev.id ?? "");
  const store = String(ev.store ?? "").toUpperCase();
  const env = String(ev.environment ?? "").toUpperCase();

  if (!type) return json({ error: "missing_type" }, 400);
  if (type === "TEST") return json({ ok: true, test: true });

  // 3 · Gate de entorno. En producción se ignoran los eventos de SANDBOX salvo
  //     que se opte explícitamente (RC_ACCEPT_SANDBOX=true durante las pruebas).
  if (env === "SANDBOX" && !ACCEPT_SANDBOX) {
    return json({ ok: true, ignored_sandbox: true, type });
  }

  // 4 · Sólo eventos de las tiendas que gobierna esta función.
  if (store && !OWNED_STORES.has(store)) {
    log("ignored store", store, type);
    return json({ ok: true, ignored: "store" });
  }

  // 5 · Sólo el entitlement 'pro'. RC manda todos los del proyecto.
  const ents: string[] = Array.isArray(ev.entitlement_ids)
    ? ev.entitlement_ids
    : ev.entitlement_id
    ? [ev.entitlement_id]
    : [];
  if (ents.length > 0 && !ents.includes(ENTITLEMENT_ID)) {
    log("ignored entitlement", ents.join(","), type);
    return json({ ok: true, ignored: "entitlement" });
  }

  // 6 · Resolución del usuario. En TRANSFER el que pierde el acceso es el
  //     ORIGEN, y RevenueCat lo manda en `transferred_from` (puede ser más de
  //     uno). El destinatario gana el entitlement en su propio evento.
  let targets: string[] = [];
  if (type === "TRANSFER") {
    const from = Array.isArray(ev.transferred_from) ? ev.transferred_from : [];
    targets = from.filter((x: unknown): x is string => typeof x === "string" && UUID_RE.test(x));
  } else {
    const uid = resolveUid(ev);
    if (uid) targets = [uid];
  }

  if (targets.length === 0) {
    // Compra anónima (o TRANSFER sin origen conocido): se guarda para que
    // entitlement-sync la reclame cuando el usuario entre con sesión. Se
    // responde 200 — un 4xx haría que RC reintentara este evento para siempre.
    try {
      await admin.from("subscription_orphans").insert({
        rc_app_user_id: String(ev.app_user_id ?? ""),
        event_id: eventId || null,
        payload: ev,
      });
    } catch (e) {
      log("orphan insert error", String(e));
    }
    log("orphan event", type, ev.app_user_id);
    return json({ ok: true, orphan: true, type });
  }

  // 7 · Idempotencia. Se registra ANTES de aplicar: si el evento ya estaba,
  //     no se toca nada. Sin esto, un reintento de EXPIRATION posterior a una
  //     re-suscripción vuelve a dejar sin acceso a alguien que ya pagó.
  if (eventId) {
    const { error: dupErr } = await admin.from("subscription_events").insert({
      event_id: eventId,
      user_id: targets[0],
      type,
      store: store || null,
      event_ms: Number(ev.event_timestamp_ms ?? 0) || null,
      payload: ev,
    });
    if (dupErr) {
      if ((dupErr as any).code === "23505") {   // unique_violation → ya procesado
        log("duplicate", eventId);
        return json({ ok: true, duplicate: true });
      }
      // Registrar es deseable, no crítico: no se aborta.
      log("event log error", dupErr.message);
    }
  }

  // 8 · Plan de acción.
  const plan = planFor(type, ev);
  if (!plan) {
    log("unhandled type", type);
    return json({ ok: true, unhandled: type });
  }

  // 9 · Aplicación.
  const applied: Record<string, unknown>[] = [];
  for (const uid of targets) {
    const r = await applyPlan(uid, plan, ev, type, store, env);
    if (r.error) {
      // 5xx → RevenueCat reintenta. Es lo correcto: perder un EXPIRATION en
      // silencio es regalar acceso indefinido.
      return json({ ok: false, error: r.error }, 500);
    }
    applied.push({ uid, skipped: r.skipped ?? null });
    log("applied", type, uid, plan.status, "active=" + plan.active, r.skipped ?? "");
  }

  // Compatibilidad con el criterio de aceptación #12: si el único destino se
  // saltó por cross-store, se dice explícitamente.
  if (applied.length === 1 && applied[0].skipped === "cross_store") {
    return json({ ok: true, ignored: "cross_store" });
  }

  return json({ ok: true, type, status: plan.status, active: plan.active, applied });
});
