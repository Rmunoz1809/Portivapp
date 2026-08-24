// entitlement-sync — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Reconciliación bajo demanda: pregunta a RevenueCat por el estado REAL del
// usuario y reescribe su fila de `subscriptions`. Resuelve tres casos que el
// webhook, por sí solo, no cubre:
//
//   1. La carrera post-compra. El usuario acaba de pagar en StoreKit y el
//      webhook aún no llegó. Sin esto, _pvAwaitEntitlement() sondea 20 s a
//      ciegas y se rinde: un cliente que ACABA de pagar ve el muro
//      "necesitas una suscripción". Rechazo seguro en App Review.
//   2. Webhooks perdidos. RevenueCat reintenta, pero si el endpoint estuvo
//      caído durante toda la ventana el evento se pierde para siempre.
//   3. "Restaurar compras" tras reinstalar o cambiar de teléfono.
//
// El cliente NO puede mentir: el uid sale del JWT, nunca del body, y la
// respuesta se construye con lo que dice RevenueCat, no con lo que pide la app.
//
// Deploy:  supabase functions deploy entitlement-sync        (verify_jwt = true)
// Secrets: supabase secrets set RC_SECRET_API_KEY="sk_..."
//          (RevenueCat → Project settings → API keys → Secret key.
//           ⚠️ NUNCA en index.html ni en portiv-iap.js: lee TODOS tus suscriptores.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { preflight, jsonResponse } from "../_shared/cors.ts";

// Case-sensitive. Verificado en RevenueCat → Product catalog → Entitlements.
// Tiene que coincidir con rc-webhook y con portiv-cap/src/iap.js.
const ENTITLEMENT_ID = "Portiv Pro";
const BILLING_GRACE_DAYS = 18;

// Tiendas de Apple. Si el entitlement viene de otra (Paddle web), esta función
// no escribe nada: manda el webhook de esa tienda.
const APPLE_STORES = new Set(["app_store", "mac_app_store", "promotional"]);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RC_KEY = Deno.env.get("RC_SECRET_API_KEY") ?? "";

// Mismo contrato interno que usa snaptrade-cleanup para desconectar.
const INTERNAL_SECRET =
  Deno.env.get("INTERNAL_DISCONNECT_SECRET") ??
  Deno.env.get("SNAPTRADE_CRON_SECRET") ??
  "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const log = (...a: unknown[]) => console.log("[ent-sync]", ...a);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  // 1 · Identidad. Del JWT y de ningún otro sitio.
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return jsonResponse(req, { error: "unauthorized" }, 401);

  const { data: u, error: uErr } = await admin.auth.getUser(jwt);
  const uid = u?.user?.id;
  if (uErr || !uid) return jsonResponse(req, { error: "unauthorized" }, 401);

  // Cuentas de DEMO/REVIEW: no se reconcilian nunca. El acceso se concede a mano en
  // `subscriptions` (store='promotional'); en RevenueCat no existe ninguna compra, así
  // que esta función devolvía 'never' y apagaba la fila en el primer arranque — la
  // concesión manual no sobrevivía al primer login. No hay nada que reconciliar en una
  // cuenta sin compra. Mismo criterio que DEMO_EMAILS en index.html y que el bypass de
  // has_active_entitlement().
  const DEMO_EMAILS = ["review@portivapp01.com"];
  const _em = (u?.user?.email ?? "").toLowerCase();
  if (_em && DEMO_EMAILS.includes(_em)) {
    log("demo account, skipping sync", uid, _em);
    return jsonResponse(req, {
      ok: true,
      skipped: "demo_account",
      entitlement_active: true,
      status: "active",
      expires_at: null,
      will_renew: false,
    });
  }

  if (!RC_KEY) {
    log("FATAL: RC_SECRET_API_KEY no configurado");
    return jsonResponse(req, { error: "server_misconfigured" }, 500);
  }

  // Estado guardado — se usa para el fail-open y para detectar la transición
  // activo → inactivo (webhook perdido).
  const { data: prev } = await admin
    .from("subscriptions")
    .select("entitlement_active,status,expires_at,will_renew,store,original_transaction_id")
    .eq("user_id", uid)
    .maybeSingle();

  // 2 · Estado real según RevenueCat. La v1 resuelve los alias sola: si el
  //     usuario compró anónimo y luego PortivIAP.login(uid) los enlazó,
  //     consultar por el uid devuelve la suscripción igual.
  let sub: Record<string, any> | null = null;
  try {
    const r = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`,
      { headers: { Authorization: `Bearer ${RC_KEY}`, accept: "application/json" } },
    );
    if (r.status === 404) {
      sub = null;                       // nunca compró: no es un error
    } else if (!r.ok) {
      const t = await r.text().catch(() => "");
      log("rc api error", r.status, t.slice(0, 200));
      // Fail-open: una caída de RevenueCat NO puede expulsar a quien pagó.
      // Se devuelve el estado guardado sin tocarlo.
      return jsonResponse(req, {
        ok: true,
        stale: true,
        entitlement_active: prev?.entitlement_active === true,
        status: prev?.status ?? "never",
        expires_at: prev?.expires_at ?? null,
        will_renew: prev?.will_renew ?? null,
      });
    } else {
      const j = await r.json();
      sub = j?.subscriber ?? null;
    }
  } catch (e) {
    log("rc fetch failed", String(e));
    return jsonResponse(req, { ok: false, error: "upstream_unavailable" }, 503);
  }

  // 3 · Traducción del subscriber a la fila.
  const ent = sub?.entitlements?.[ENTITLEMENT_ID] ?? null;
  const expiresIso: string | null = ent?.expires_date ?? null;
  const expiresMs = expiresIso ? Date.parse(expiresIso) : null;
  // Un entitlement no vitalicio está activo mientras no haya vencido.
  // expires_date null = compra no renovable / lifetime → activo.
  const active = !!ent && (expiresMs === null || expiresMs > Date.now());

  const productId: string | null = ent?.product_identifier ?? null;
  const subRow = productId ? sub?.subscriptions?.[productId] ?? null : null;
  const store: string = String(subRow?.store ?? "app_store").toLowerCase();

  // Sólo se gobiernan las tiendas de Apple desde aquí.
  if (subRow && !APPLE_STORES.has(store)) {
    log("non-apple store, skipping write", uid, store);
    return jsonResponse(req, {
      ok: true,
      skipped: "non_apple_store",
      entitlement_active: prev?.entitlement_active === true,
      status: prev?.status ?? "never",
      expires_at: prev?.expires_at ?? null,
      will_renew: prev?.will_renew ?? null,
    });
  }

  // Guardia cross-store, endurecida. Una REVOCACIÓN sólo se escribe si hay
  // prueba de que este usuario está gobernado por Apple: o RevenueCat devuelve
  // una suscripción de una tienda de Apple, o la fila guardada ya era de una.
  //
  // Sin esto, un usuario de Paddle que llegue aquí (o cuya fila sea antigua y
  // tenga `store` a null, anterior a que paddle-webhook empezara a sellarla)
  // recibiría un 404 de RevenueCat —"nunca compró"— y se le apagaría el
  // entitlement que sí pagó por web. paddle-webhook escribe store:'paddle',
  // así que hoy el caso normal ya estaría cubierto; esto cubre el resto.
  const prevStore = prev?.store ? String(prev.store).toLowerCase() : null;
  const appleGoverned =
    (!!subRow && APPLE_STORES.has(store)) ||
    (!!prevStore && APPLE_STORES.has(prevStore));

  if (!active && !appleGoverned) {
    log("non-apple / unproven store, skipping revocation", uid, prevStore ?? "null");
    return jsonResponse(req, {
      ok: true,
      skipped: "cross_store",
      entitlement_active: prev?.entitlement_active === true,
      status: prev?.status ?? "never",
      expires_at: prev?.expires_at ?? null,
      will_renew: prev?.will_renew ?? null,
    });
  }

  const unsubscribed = !!subRow?.unsubscribe_detected_at;
  const billingIssue = !!subRow?.billing_issues_detected_at;

  let status: string;
  if (!ent) status = "never";
  else if (!active) status = billingIssue ? "past_due" : "expired";
  else if (billingIssue) status = "past_due";
  else if (unsubscribed) status = "canceled";     // acceso hasta expires_at
  else status = "active";

  const nowIso = new Date().toISOString();

  // 4 · Escritura idempotente.
  const { error: wErr } = await admin.from("subscriptions").upsert({
    user_id: uid,
    entitlement_active: active,
    status,
    expires_at: expiresIso,
    will_renew: active && !unsubscribed,
    store,
    product_id: productId,
    rc_app_user_id: uid,
    // La API v1 de RC no siempre expone este campo; el webhook sí lo recibe en
    // el payload. Sin el fallback a `prev`, cada SYNC borraba lo que había
    // escrito el INITIAL_PURCHASE. Es el id con el que Apple referencia la
    // suscripción de por vida: hace falta para reembolsos y soporte.
    original_transaction_id:
      subRow?.original_transaction_id ?? prev?.original_transaction_id ?? null,
    grace_until: billingIssue
      ? new Date(Date.now() + BILLING_GRACE_DAYS * 86400000).toISOString()
      : null,
    revoked_at: active ? null : nowIso,
    revoked_reason: active ? null : `sync:${status}`,
    last_event: "SYNC",
    updated_at: nowIso,
  }, { onConflict: "user_id" });

  if (wErr) {
    log("upsert error", uid, wErr.message);
    return jsonResponse(req, { error: "db_error" }, 500);
  }

  // Espejo legado (snaptrade-cleanup y lecturas antiguas).
  await admin
    .from("profiles")
    .update({ subscription_status: status, subscription_expired_at: active ? null : nowIso })
    .eq("id", uid)
    .then(() => {}, (e: any) => log("profiles mirror failed", uid, e?.message));

  // 5 · Transición activo → inactivo detectada por sync (webhook perdido):
  //     hay que cerrar el broker igual que lo haría el webhook.
  if (prev?.entitlement_active === true && !active) {
    const reason = `subscription_ended_appstore:sync_${status}`;
    log("sync-detected revocation", uid, status);
    if (INTERNAL_SECRET) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/snaptrade-disconnect`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SECRET },
          body: JSON.stringify({ app_user_id: uid, reason }),
        });
      } catch (e) {
        // No propaga: snaptrade-cleanup reintenta cada hora.
        log("disconnect on sync failed", uid, String(e));
      }
    }
  }

  // 6 · Reclamar huérfanos: la compra anónima ya tiene dueño. Se marcan los
  //     eventos guardados cuyo app_user_id coincide con este usuario o con su
  //     original_app_user_id (el anónimo que RevenueCat acaba de aliasar).
  try {
    const keys = [uid, sub?.original_app_user_id]
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    if (keys.length) {
      await admin
        .from("subscription_orphans")
        .update({ claimed_by: uid })
        .in("rc_app_user_id", keys)
        .is("claimed_by", null);
    }
  } catch { /* no crítico */ }

  return jsonResponse(req, {
    ok: true,
    entitlement_active: active,
    status,
    expires_at: expiresIso,
    will_renew: active && !unsubscribed,
  });
});
