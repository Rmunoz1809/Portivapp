// _shared/entitlement.ts — verificación del derecho contra la TIENDA, no contra nuestra fila.
// ─────────────────────────────────────────────────────────────────────────────
// Por qué existe: la baja del broker en SnapTrade es IRREVERSIBLE para el usuario (tiene
// que rehacer el portal de su broker entero) y hasta ahora se disparaba desde cinco
// sitios distintos (rc-webhook, paddle-webhook, entitlement-sync, entitlement-sweeper,
// snaptrade-cleanup) leyendo cada uno su propia copia de la verdad: un evento de
// RevenueCat desordenado, un webhook de renovación perdido, un evento SANDBOX colado en
// producción o un simple retraso de RevenueCat al registrar la renovación de Apple
// bastaban para que `subscriptions.entitlement_active` pasara a false y, acto seguido,
// alguien borrara al usuario de SnapTrade. El usuario "se desconectaba solo".
//
// Regla nueva, única para todos: ANTES de retirar el acceso o de cerrar el broker se le
// pregunta a la tienda que gobierna esa suscripción (RevenueCat para App Store, Paddle
// para la web). Si la tienda dice que sigue activa, NO se toca nada. Si la tienda no
// responde, tampoco (fail-open: cortar por un fallo nuestro es un falso positivo caro;
// pagar una hora más de SnapTrade es barato y el cron reintenta).
//
// Sólo hay dos caminos que NO pasan por aquí, a propósito:
//   · la baja MANUAL ("Desconectar broker") — el usuario manda;
//   · el borrado de cuenta (delete-account) — el usuario se va.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Mismo identificador que rc-webhook / entitlement-sync / portiv-cap/src/iap.js.
export const ENTITLEMENT_ID = "Portiv Pro";

// Retraso tolerado entre el vencimiento que conoce RevenueCat y la renovación real de
// Apple. Apple emite la notificación de renovación con retraso (a veces horas) y hasta
// entonces RevenueCat sigue mostrando la fecha del periodo anterior. Mismo colchón que
// has_active_entitlement() en SQL: si allí son 48 h, aquí también.
export const RENEWAL_LAG_HOURS = 48;
// Ventana de gracia ante fallo de cobro (Apple reintenta ~16 días; 18 de colchón).
// Mismo valor que rc-webhook / entitlement-sync.
export const BILLING_GRACE_DAYS = 18;

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

const APPLE_STORES = new Set(["app_store", "mac_app_store"]);
const PADDLE_STORES = new Set(["paddle"]);

const RC_KEY = Deno.env.get("RC_SECRET_API_KEY") ?? "";
const PADDLE_KEY = Deno.env.get("PADDLE_API_KEY") ?? "";
const PADDLE_ENV = (Deno.env.get("PADDLE_ENV") ?? "production").toLowerCase();
const PADDLE_API = PADDLE_ENV === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";

const log = (...a: unknown[]) => console.log("[entitlement]", ...a);

export type StoreVerdict = {
  /** true = la tienda confirma acceso · false = la tienda confirma que NO · null = no se pudo saber */
  active: boolean | null;
  /** De dónde sale el veredicto: 'revenuecat' | 'paddle' | 'db' | 'none' */
  source: string;
  /** Motivo legible, para las bitácoras. */
  detail: string;
  /** true cuando `active` es null por un fallo TRANSITORIO (5xx, red): conviene reintentar. */
  transient: boolean;
  /** Fin de acceso que declara la tienda, si lo declara. */
  expiresAt: string | null;
};

const verdict = (
  active: boolean | null, source: string, detail: string,
  extra: Partial<StoreVerdict> = {},
): StoreVerdict => ({ active, source, detail, transient: false, expiresAt: null, ...extra });

/**
 * ¿Hay que BLOQUEAR una revocación / desconexión a la vista de este veredicto?
 *   · la tienda dice activo            → bloquear
 *   · la tienda no respondió (transitorio) → bloquear (se reintenta después)
 *   · la tienda dice inactivo, o no hay tienda que consultar → NO bloquear
 */
export function blocksRevocation(v: StoreVerdict): boolean {
  return v.active === true || (v.active === null && v.transient);
}

// ── RevenueCat (App Store) ────────────────────────────────────────────────────
async function verifyRevenueCat(uid: string): Promise<StoreVerdict> {
  if (!RC_KEY) return verdict(null, "revenuecat", "RC_SECRET_API_KEY sin configurar");
  let r: Response;
  try {
    r = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, {
      headers: { Authorization: `Bearer ${RC_KEY}`, accept: "application/json" },
    });
  } catch (e) {
    return verdict(null, "revenuecat", `red: ${String(e)}`, { transient: true });
  }
  if (r.status === 404) return verdict(false, "revenuecat", "subscriber_not_found");
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return verdict(null, "revenuecat", `http_${r.status} ${t.slice(0, 120)}`, { transient: true });
  }
  let j: any;
  try { j = await r.json(); } catch { return verdict(null, "revenuecat", "json inválido", { transient: true }); }
  const sub = j?.subscriber ?? null;
  const ent = sub?.entitlements?.[ENTITLEMENT_ID] ?? null;
  if (!ent) return verdict(false, "revenuecat", "sin entitlement");

  const expiresIso: string | null = ent?.expires_date ?? null;
  const expiresMs = expiresIso ? Date.parse(expiresIso) : NaN;
  const productId: string | null = ent?.product_identifier ?? null;
  const row = productId ? sub?.subscriptions?.[productId] ?? null : null;
  const now = Date.now();

  if (row?.refunded_at) return verdict(false, "revenuecat", "refunded", { expiresAt: expiresIso });
  // Sin fecha de fin = compra no renovable / vitalicia.
  if (!expiresIso || !Number.isFinite(expiresMs)) return verdict(true, "revenuecat", "lifetime");
  if (expiresMs > now) return verdict(true, "revenuecat", "vigente", { expiresAt: expiresIso });

  // Vencida según RevenueCat. Tres motivos para NO darla por muerta todavía:
  const ageMs = now - expiresMs;
  // 1) fallo de cobro: Apple reintenta durante días y el usuario conserva el acceso.
  if (row?.billing_issues_detected_at && ageMs < BILLING_GRACE_DAYS * DAY_MS) {
    return verdict(true, "revenuecat", "billing_grace", { expiresAt: expiresIso });
  }
  // 2) el usuario NO canceló y venció hace poco: casi seguro es la renovación de Apple
  //    que RevenueCat aún no ha registrado. Se le da el mismo colchón que en SQL.
  if (!row?.unsubscribe_detected_at && ageMs < RENEWAL_LAG_HOURS * HOUR_MS) {
    return verdict(true, "revenuecat", "renewal_lag", { expiresAt: expiresIso });
  }
  // 3) nada de lo anterior → vencida de verdad.
  return verdict(false, "revenuecat", row?.unsubscribe_detected_at ? "expired_unsubscribed" : "expired",
    { expiresAt: expiresIso });
}

// ── Paddle (web) ──────────────────────────────────────────────────────────────
// No guardamos el id de suscripción de Paddle: se localiza por el email del usuario
// (Paddle → customers?email= → subscriptions?customer_id=).
async function verifyPaddle(admin: SupabaseClient, uid: string): Promise<StoreVerdict> {
  if (!PADDLE_KEY) return verdict(null, "paddle", "PADDLE_API_KEY sin configurar");
  let email = "";
  try {
    const { data } = await admin.auth.admin.getUserById(uid);
    email = (data?.user?.email ?? "").toLowerCase();
  } catch { /* sin email no hay búsqueda */ }
  if (!email) return verdict(null, "paddle", "usuario sin email");

  const H = { Authorization: `Bearer ${PADDLE_KEY}`, accept: "application/json" };
  const get = async (path: string): Promise<any | null> => {
    const r = await fetch(`${PADDLE_API}${path}`, { headers: H });
    if (!r.ok) throw Object.assign(new Error(`http_${r.status}`), { status: r.status });
    return r.json();
  };
  try {
    const cs = await get(`/customers?email=${encodeURIComponent(email)}&per_page=10`);
    const ids: string[] = ((cs?.data ?? []) as any[]).map((c) => String(c?.id ?? "")).filter(Boolean);
    if (!ids.length) return verdict(false, "paddle", "customer_not_found");
    const subs = await get(
      `/subscriptions?customer_id=${encodeURIComponent(ids.join(","))}&status=active,trialing,past_due&per_page=50`,
    );
    const live = ((subs?.data ?? []) as any[]);
    if (!live.length) return verdict(false, "paddle", "sin suscripción viva");
    // Un `scheduled_change` a cancel con fecha ya pasada equivale a cancelada.
    const now = Date.now();
    const still = live.filter((s) => {
      const sc = s?.scheduled_change;
      if (sc?.action === "cancel" && sc?.effective_at && Date.parse(sc.effective_at) <= now) return false;
      return true;
    });
    if (!still.length) return verdict(false, "paddle", "cancelación efectiva");
    const ends = still
      .map((s) => s?.current_billing_period?.ends_at ?? s?.next_billed_at ?? null)
      .filter((x): x is string => typeof x === "string")
      .sort()
      .pop() ?? null;
    return verdict(true, "paddle", still[0]?.status ?? "active", { expiresAt: ends });
  } catch (e: any) {
    const st = Number(e?.status ?? 0);
    // 4xx = nuestra petición (clave, permisos): no es transitorio pero tampoco concluye nada.
    if (st >= 400 && st < 500) return verdict(null, "paddle", `http_${st}`);
    return verdict(null, "paddle", String(e?.message ?? e), { transient: true });
  }
}

/**
 * Veredicto de la tienda que gobierna la suscripción de `uid`.
 *
 *   · store app_store / mac_app_store → RevenueCat
 *   · store paddle                    → Paddle
 *   · promotional / demo / manual / sin fila → has_active_entitlement() (la fila ES la
 *     verdad: no hay tienda a la que preguntar). Incluye el bypass del dueño.
 *
 * `storeHint` permite al llamador (un webhook) declarar la tienda del evento cuando la
 * fila aún no existe.
 */
export async function verifyEntitlementWithStore(
  admin: SupabaseClient,
  uid: string,
  storeHint?: string | null,
): Promise<StoreVerdict> {
  let row: any = null;
  try {
    const { data } = await admin
      .from("subscriptions")
      .select("store, entitlement_active, expires_at, grace_until, status, environment")
      .eq("user_id", uid)
      .maybeSingle();
    row = data ?? null;
  } catch { /* se sigue con el hint */ }

  const store = String(row?.store ?? storeHint ?? "").toLowerCase();

  // El dueño y las cuentas de demo pasan siempre: la RPC ya lo sabe.
  try {
    const { data: ent, error } = await admin.rpc("has_active_entitlement", { uid });
    if (!error && ent === true && !APPLE_STORES.has(store) && !PADDLE_STORES.has(store)) {
      return verdict(true, "db", `fila activa (${store || "sin tienda"})`, { expiresAt: row?.expires_at ?? null });
    }
  } catch { /* la RPC no es imprescindible aquí */ }

  let v: StoreVerdict;
  if (APPLE_STORES.has(store)) v = await verifyRevenueCat(uid);
  else if (PADDLE_STORES.has(store)) v = await verifyPaddle(admin, uid);
  else if (!store) v = verdict(false, "none", "sin fila ni tienda");
  else v = verdict(row?.entitlement_active === true, "db", `store=${store}`, { expiresAt: row?.expires_at ?? null });

  log(uid, "→", v.source, v.active, v.detail);
  return v;
}

/**
 * Autocuración: si la tienda dice que el usuario SÍ tiene acceso pero nuestra fila lo
 * niega, se reactiva la fila (y el espejo legado). Es el complemento de la verificación:
 * de nada sirve no cortar el broker si el candado de la app sigue cerrado.
 */
export async function healSubscriptionRow(
  admin: SupabaseClient,
  uid: string,
  v: StoreVerdict,
  storeHint?: string | null,
): Promise<void> {
  if (v.active !== true || v.source === "db") return;
  const nowIso = new Date().toISOString();
  const status = v.detail === "billing_grace" ? "past_due" : "active";
  const { error } = await admin.from("subscriptions").upsert({
    user_id: uid,
    entitlement_active: true,
    status,
    store: v.source === "revenuecat" ? (storeHint ?? "app_store").toLowerCase() : "paddle",
    ...(v.expiresAt ? { expires_at: v.expiresAt } : {}),
    grace_until: status === "past_due" ? new Date(Date.now() + BILLING_GRACE_DAYS * DAY_MS).toISOString() : null,
    revoked_at: null,
    revoked_reason: null,
    last_event: "STORE_HEAL",
    updated_at: nowIso,
  }, { onConflict: "user_id" });
  if (error) { log("heal failed", uid, error.message); return; }
  await admin.from("profiles")
    .update({ subscription_status: status, subscription_expired_at: null })
    .eq("id", uid)
    .then(() => {}, () => {});
  log("fila reactivada por la tienda", uid, v.source, v.detail);
}
