// paddle-webhook — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Paddle Billing (checkout WEB) → Supabase entitlement mirror. Es el hermano de
// rc-webhook: misma tabla `public.subscriptions`, mismo espejo legacy a `profiles`,
// misma forma de respuesta. RevenueCat cubre iOS (IAP nativo); Paddle cubre la web.
// Se distinguen por la columna `store` ('paddle' aquí, el store de RC allí) y por
// `rc_app_user_id`, que aquí queda NULL a propósito: no existe app_user_id de RC.
//
// Auth: NO hay JWT de usuario (Paddle postea servidor-a-servidor). La autenticidad
// se prueba con la firma HMAC del header `Paddle-Signature` — ver verifySignature().
// Deploy: supabase functions deploy paddle-webhook --no-verify-jwt
// Paddle → Developer tools → Notifications → New destination:
//   URL: https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/paddle-webhook
//   Secret key del destino → `supabase secrets set PADDLE_WEBHOOK_SECRET=...`
// El user_id de Supabase viaja en custom_data del checkout (ver _pvStartCheckout()
// en index.html: `customData: { supabase_user_id: uid }`).
//
// Contrato de códigos (importante: Paddle REINTENTA ante cualquier no-2xx durante
// ~3 días, así que un 4xx por un evento que nunca vamos a poder procesar sería un
// bucle infinito de reintentos):
//   200 → procesado O ignorado a propósito (evento desconocido, usuario no mapeable).
//   401 → SOLO firma inválida / ausente / caducada.
//   500 → SOLO fallo de configuración (falta el secreto) o de base de datos, casos
//         en los que SÍ queremos que Paddle reintente.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PADDLE_SECRET = Deno.env.get("PADDLE_WEBHOOK_SECRET") ?? "";
// Paddle no documenta un campo de entorno en el cuerpo de la notificación; si el
// header no viene, este secreto decide qué se escribe en `environment`.
const PADDLE_ENV_FALLBACK = (Deno.env.get("PADDLE_ENV") ?? "production").toLowerCase();
// Mismo par de secretos que usa snaptrade-cleanup para la llamada interna.
const INTERNAL_SECRET =
  Deno.env.get("INTERNAL_DISCONNECT_SECRET") ??
  Deno.env.get("SNAPTRADE_CRON_SECRET") ??
  "";

// Ventana anti-replay: un atacante que capture un POST válido no puede reenviarlo
// pasados 5 minutos (la firma incluye el ts, así que no puede moverlo sin el secreto).
const MAX_SKEW_MS = 5 * 60 * 1000;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// ── Firma ────────────────────────────────────────────────────────────────────
// Paddle Billing manda `Paddle-Signature: ts=1671552777;h1=<hex sha256>`.
// El payload firmado es EXACTAMENTE `${ts}:${rawBody}` con el cuerpo CRUDO: por eso
// se lee con req.text() antes de cualquier JSON.parse. Reserializar rompería la firma
// (orden de claves, espacios, escapes unicode… no se conservan al re-stringify).

function parsePaddleSignature(header: string): { ts: string; h1: string } | null {
  let ts = "";
  let h1 = "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "ts") ts = v;
    else if (k === "h1") h1 = v; // Paddle puede rotar el secreto y mandar varias h1
  }
  return ts && h1 ? { ts, h1 } : null;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Comparación en tiempo constante. Un `a === b` normal sale en el primer byte
 * distinto, y esa diferencia de tiempo es medible: permite reconstruir la firma
 * byte a byte (timing attack). Aquí se recorren SIEMPRE todas las posiciones y se
 * acumula el XOR; la única ramificación depende de la longitud, que no es secreta.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = i < ab.length ? ab[i] : 0;
    const y = i < bb.length ? bb[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

// ── Utilidades de payload ────────────────────────────────────────────────────

/** ISO-8601 normalizado, o null si el valor no es una fecha usable. */
function toIso(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** ¿El `status` de una suscripción de Paddle implica acceso? */
function statusGrantsAccess(s: string): boolean {
  switch (s) {
    case "active":
    case "trialing":
      return true;
    case "past_due":
      return true; // gracia: Paddle sigue reintentando el cobro, no se corta al primer fallo
    case "paused":
    case "canceled":
      return false;
    default:
      return false; // estado desconocido → fail-closed (el cron re-verifica igualmente)
  }
}

/**
 * user_id de Supabase. Orden: custom_data del objeto → custom_data del price (por si
 * el checkout se creó desde un enlace con datos en el precio) → email.
 * Si no se resuelve, el llamador responde 200: un evento que NUNCA vamos a poder
 * mapear (p. ej. una compra hecha fuera de la app) no debe provocar reintentos eternos.
 */
async function resolveUserId(data: any): Promise<{ id: string; via: string } | null> {
  const direct = data?.custom_data?.supabase_user_id;
  if (UUID_RE.test(String(direct ?? ""))) return { id: String(direct), via: "custom_data" };

  const items = Array.isArray(data?.items) ? data.items : [];
  for (const it of items) {
    const fromPrice = it?.price?.custom_data?.supabase_user_id ?? it?.custom_data?.supabase_user_id;
    if (UUID_RE.test(String(fromPrice ?? ""))) return { id: String(fromPrice), via: "price.custom_data" };
  }

  // Fallback por email. `data.customer_id` es un id de Paddle, no trae email, así que
  // sólo sirve si el propio evento incluye el correo.
  const email = String(
    data?.customer?.email ?? data?.billing_details?.email ?? data?.customer_email ?? "",
  ).trim().toLowerCase();
  if (!email) return null;

  // 1) profiles.email — lo escribe el propio cliente en cada login (index.html), es la
  //    vía barata y no necesita la Admin API. Se compara con `eq` y no con `ilike`: en
  //    ilike el guion bajo es comodín de un carácter, y los emails llevan guiones bajos
  //    a menudo → podría resolver al usuario EQUIVOCADO. Supabase guarda el email en
  //    minúsculas, y si alguna fila vieja tuviera mayúsculas cae al paso 2.
  const { data: prof } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .limit(2);
  if (prof && prof.length === 1 && UUID_RE.test(String((prof[0] as any).id))) {
    return { id: String((prof[0] as any).id), via: "profiles.email" };
  }

  // 2) auth.users vía Admin API de GoTrue. supabase-js v2 no expone getUserByEmail,
  //    de ahí el fetch directo (misma service role, sin dependencias nuevas).
  try {
    const r = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=2`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      const users: any[] = Array.isArray(j?.users) ? j.users : [];
      const hit = users.find((u) => String(u?.email ?? "").toLowerCase() === email);
      if (hit && UUID_RE.test(String(hit.id))) return { id: String(hit.id), via: "auth.users" };
    } else {
      console.error("[paddle-webhook] admin users lookup http", r.status);
    }
  } catch (e) {
    console.error("[paddle-webhook] admin users lookup failed:", (e as any)?.message ?? e);
  }
  return null;
}

/**
 * Baja del broker cuando el usuario se queda sin entitlement. Se reutiliza el único
 * mecanismo que ya existe (el que usa snaptrade-cleanup): POST interno a
 * snaptrade-disconnect con `x-internal-secret` + service role. Best-effort: si falla,
 * NO se devuelve error — el cron horario snaptrade-cleanup vuelve a intentarlo, y
 * devolver 5xx aquí haría que Paddle reintentara el evento y reescribiera la fila.
 *
 * (Nota: rc-webhook NO llama a disconnect; delega TODO en ese cron para no cortar a
 * un usuario en periodo de gracia. Aquí se corta ya porque el mapeo pedido sólo pone
 * entitlement_active=false en finales reales de acceso — pause / cancelación efectiva.)
 */
async function triggerDisconnect(userId: string, reason: string): Promise<void> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/snaptrade-disconnect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
        "Authorization": `Bearer ${SERVICE_ROLE}`,
      },
      body: JSON.stringify({ app_user_id: userId, reason }),
    });
    if (!r.ok) console.error("[paddle-webhook] disconnect http", r.status, "(cron reintentará)");
  } catch (e) {
    console.error("[paddle-webhook] disconnect failed (cron reintentará):", (e as any)?.message ?? e);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Sin secreto NO se acepta nada: aceptar sin verificar dejaría a cualquiera activar
  // entitlements con un curl. 500 (no 200) para que el fallo sea visible y Paddle
  // reintente cuando el secreto esté puesto.
  if (!PADDLE_SECRET) {
    console.error("[paddle-webhook] falta PADDLE_WEBHOOK_SECRET — evento rechazado sin verificar");
    return json({ ok: false, error: "webhook_secret_not_configured" }, 500);
  }

  // Cuerpo CRUDO primero: es lo que se firma.
  const raw = await req.text();

  const parsedSig = parsePaddleSignature(req.headers.get("Paddle-Signature") ?? "");
  if (!parsedSig) return json({ ok: false, error: "missing_signature" }, 401);

  const tsMs = Number(parsedSig.ts) * 1000; // el ts de Paddle va en SEGUNDOS unix
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MAX_SKEW_MS) {
    return json({ ok: false, error: "stale_signature" }, 401);
  }

  const expected = await hmacSha256Hex(PADDLE_SECRET, `${parsedSig.ts}:${raw}`);
  if (!timingSafeEqualHex(expected, parsedSig.h1.toLowerCase())) {
    return json({ ok: false, error: "invalid_signature" }, 401);
  }

  // ── A partir de aquí el evento es auténtico ────────────────────────────────
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    console.error("[paddle-webhook] cuerpo firmado pero no parseable — ignorado");
    return json({ ok: true, ignored: "unparseable_body" });
  }

  const eventType: string = String(body?.event_type ?? "");
  const data: any = body?.data ?? {};
  // Paddle no documenta `environment` en el cuerpo; sí manda el header en los envíos
  // de sus destinos. Si no está, manda el secreto PADDLE_ENV.
  const environment =
    (req.headers.get("Paddle-Environment") ?? "").toLowerCase() || PADDLE_ENV_FALLBACK;

  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  const price = items[0]?.price ?? null;
  // product_id guarda el PRECIO/producto de Paddle (no el id de suscripción).
  const productId: string | null = price?.id ?? price?.product_id ?? items[0]?.price_id ?? null;

  // Fin de acceso: periodo de facturación en curso (suscripción) → periodo de la
  // transacción → próxima fecha de cobro.
  const expiresAt =
    toIso(data?.current_billing_period?.ends_at) ??
    toIso(data?.billing_period?.ends_at) ??
    toIso(data?.next_billed_at);

  // Un cambio programado a 'cancel' significa que NO se renovará al final del periodo.
  const scheduled = data?.scheduled_change ?? null;
  const willRenew = !scheduled || scheduled.action !== "cancel";

  const paddleStatus = String(data?.status ?? "");
  const nowMs = Date.now();

  let active: boolean;
  let status: string;

  switch (eventType) {
    case "subscription.created":
    case "subscription.activated":
    case "subscription.resumed":
      active = true;
      status = "active";
      break;

    case "subscription.updated":
      // El evento genérico: la verdad está en data.status (cambio de plan, reanudación,
      // cancelación programada, pausa programada…).
      active = statusGrantsAccess(paddleStatus);
      status = paddleStatus || "active";
      break;

    case "subscription.canceled": {
      // Paddle manda este evento tanto al programar la baja como al hacerse efectiva.
      // Si el corte ya ocurrió (status canceled, cambio programado ya vencido o periodo
      // terminado) se retira el acceso; si aún queda periodo pagado, se conserva.
      const scPassed = scheduled?.effective_at
        ? (Date.parse(scheduled.effective_at) || 0) <= nowMs
        : false;
      const periodOver = expiresAt ? Date.parse(expiresAt) <= nowMs : true;
      active = !(paddleStatus === "canceled" || scPassed || periodOver);
      status = "canceled";
      break;
    }

    case "subscription.past_due":
      // Gracia deliberada: Paddle reintenta el cobro varios días. Cortar al primer
      // rechazo expulsaría a un cliente que sólo tiene la tarjeta vencida.
      active = true;
      status = "past_due";
      break;

    case "subscription.paused":
      active = false;
      status = "paused";
      break;

    case "transaction.payment_failed":
      active = true; // igual que arriba: un fallo de cobro no es el fin de la suscripción
      status = "past_due";
      break;

    case "transaction.completed":
      active = true;
      status = "active";
      break;

    default:
      // subscription.trialing, transaction.created, adjustment.*, etc. No los
      // suscribimos, pero si alguien los activa en el dashboard no deben escribir nada.
      console.log("[paddle-webhook] evento ignorado:", eventType);
      return json({ ok: true, ignored: eventType });
  }

  const resolved = await resolveUserId(data);
  if (!resolved) {
    // 200 a propósito (ver contrato de códigos arriba): sin user_id no hay fila que
    // tocar y reintentarlo 3 días no lo va a arreglar.
    console.warn(
      "[paddle-webhook] sin supabase_user_id:",
      eventType,
      "customer_id=", data?.customer_id ?? "-",
      "subscription_id=", data?.subscription_id ?? data?.id ?? "-",
    );
    return json({ ok: true, skipped: "unmapped_user", type: eventType });
  }
  const userId = resolved.id;

  // Momento LÓGICO del evento (no el de recepción): con esto se ordenan reintentos y
  // eventos que llegan desordenados.
  const eventIso = toIso(data?.updated_at) ?? toIso(body?.occurred_at) ?? new Date().toISOString();

  // ── Idempotencia / orden ───────────────────────────────────────────────────
  // El upsert por user_id ya es idempotente, pero Paddle reintenta y puede entregar
  // fuera de orden: un `subscription.updated` viejo llegando después del `canceled`
  // reactivaría al usuario. Se descarta lo más viejo que la fila. La comparación sólo
  // se aplica a filas escritas por Paddle: las de RevenueCat llevan updated_at = now()
  // del webhook de RC y bloquearían eventos legítimos de Paddle.
  const { data: current, error: readErr } = await admin
    .from("subscriptions")
    .select("updated_at, store, last_event")
    .eq("user_id", userId)
    .maybeSingle();
  if (readErr) {
    console.error("[paddle-webhook] lectura de subscriptions falló:", readErr.message);
    return json({ ok: false, error: readErr.message }, 500);
  }
  if (
    current?.store === "paddle" &&
    current?.updated_at &&
    Date.parse(eventIso) < Date.parse(current.updated_at as string)
  ) {
    console.log("[paddle-webhook] evento obsoleto descartado:", eventType, "<", current.updated_at);
    return json({ ok: true, skipped: "stale_event", type: eventType });
  }

  // 1) Tabla autoritativa de entitlement (la que leen has_active_entitlement, el cliente
  //    y el cron snaptrade-cleanup). rc_app_user_id queda NULL: no hay usuario de RC.
  const { error: subErr } = await admin.from("subscriptions").upsert({
    user_id: userId,
    rc_app_user_id: null,
    entitlement_active: active,
    status,
    product_id: productId,
    store: "paddle",
    environment,
    expires_at: expiresAt,
    will_renew: willRenew,
    last_event: eventType,
    // Se guarda la hora del EVENTO (no now()) para que la comparación de arriba sea
    // homogénea y el descarte de eventos viejos funcione entre reintentos.
    updated_at: eventIso,
  }, { onConflict: "user_id" });
  if (subErr) {
    console.error("[paddle-webhook] subscriptions upsert falló:", subErr.message);
    return json({ ok: false, error: subErr.message }, 500);
  }

  // 2) Espejo de las columnas legacy de profiles — mismo criterio que rc-webhook, para
  //    que cualquier lector antiguo vea lo mismo. No es crítico: si falla, se logea.
  await admin
    .from("profiles")
    .update({
      subscription_status: status,
      subscription_expired_at: active ? null : new Date().toISOString(),
    })
    .eq("id", userId)
    .then(() => {}, (e: any) => console.error("[paddle-webhook] espejo a profiles falló:", e?.message));

  // 3) Sin entitlement → se suelta el enlace del broker (SnapTrade cobra ~1 USD por
  //    usuario conectado al mes). Best-effort; el cron horario es la red de seguridad.
  if (!active) await triggerDisconnect(userId, `subscription_ended_paddle:${eventType}`);

  return json({ ok: true, type: eventType, status, active, via: resolved.via });
});
