// Shared SnapTrade + Supabase-admin helpers for Portiv Edge Functions.
//
// The Consumer Key is NEVER exposed to the client. It lives only in the function
// environment (SNAPTRADE_CONSUMER_KEY secret). All SnapTrade access is server-side.
//
// SDK: snaptrade-typescript-sdk (pinned). Method map used across functions:
//   snaptrade.authentication.registerSnapTradeUser({ userId })            -> { userId, userSecret }
//   snaptrade.authentication.loginSnapTradeUser({ userId, userSecret, ... }) -> { redirectURI, sessionId }
//   snaptrade.accountInformation.getAllUserHoldings({ userId, userSecret })
//   snaptrade.accountInformation.listUserAccounts({ userId, userSecret })
//   snaptrade.accountInformation.getAccountBalanceHistory({ userId, userSecret, accountId })
//   snaptrade.connections.deleteConnection({ connectionId, userId, userSecret })

import { Snaptrade } from "npm:snaptrade-typescript-sdk@10.0.18";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("SNAPTRADE_CLIENT_ID") ?? "";
const CONSUMER_KEY = Deno.env.get("SNAPTRADE_CONSUMER_KEY") ?? "";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** SnapTrade SDK client (server-side only). Throws if secrets are missing. */
export function snaptrade(): Snaptrade {
  if (!CLIENT_ID || !CONSUMER_KEY) {
    throw new Error(
      "SnapTrade no configurado: faltan SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY (Edge Functions → Secrets).",
    );
  }
  return new Snaptrade({ clientId: CLIENT_ID, consumerKey: CONSUMER_KEY });
}

/** Supabase admin client (service role — bypasses RLS, can read snaptrade_user_secret). */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

/**
 * Resolve the authenticated user id from the caller's JWT and confirm it matches
 * the requested userId. Prevents a client from reading another user's SnapTrade
 * data (the snaptrade_user_secret is sensitive). Returns the trusted user id.
 *
 * Throws { status, message } on any auth failure.
 */
export async function requireUser(
  req: Request,
  admin: SupabaseClient,
  bodyUserId?: unknown,
): Promise<string> {
  const authz = req.headers.get("Authorization") ?? "";
  const token = authz.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw { status: 401, message: "Falta el token de autenticación." };

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) {
    throw { status: 401, message: "Sesión inválida o expirada." };
  }
  const authedId = data.user.id;

  // Body userId is optional; if present it must match the authenticated user.
  if (bodyUserId != null && bodyUserId !== authedId) {
    throw { status: 403, message: "userId no coincide con la sesión." };
  }
  return authedId;
}

export type ProfileSnap = {
  snaptrade_user_id: string | null;
  snaptrade_user_secret: string | null;
  snaptrade_connection_id: string | null;
  snaptrade_account_id: string | null;
  snaptrade_last_refresh: string | null;
  snaptrade_holdings: unknown | null;
  snaptrade_history: unknown | null;
  snaptrade_connection_broken: boolean | null;
  snaptrade_disconnected_reason: string | null;
  snaptrade_connected_at: string | null;
  snaptrade_disconnected_at: string | null;
  snaptrade_last_manual_sync: string | null;
};

/** Load the SnapTrade-related profile columns for a user (service role). */
export async function loadProfile(
  admin: SupabaseClient,
  userId: string,
): Promise<ProfileSnap | null> {
  const { data, error } = await admin
    .from("profiles")
    .select(
      // snaptrade_connected_at / _disconnected_at: snaptrade-refresh los usa para separar
      // "nunca conectó un broker" de "se lo desconectamos". Sin ellos en el select llegan
      // como undefined y todo el mundo cae en el segundo caso.
      // snaptrade_activities NO va aquí a propósito: la lee sólo snaptrade-activities, con
      // su propia consulta tolerante. Este select se empaqueta en TODAS las funciones
      // snaptrade, así que añadirle una columna que aún no existe en la base las rompería
      // todas a la vez en el primer despliegue. El coste de la consulta extra es de esa
      // única función; el de equivocarse aquí, de la aplicación entera.
      "snaptrade_user_id, snaptrade_user_secret, snaptrade_connection_id, snaptrade_account_id, snaptrade_last_refresh, snaptrade_holdings, snaptrade_history, snaptrade_connection_broken, snaptrade_disconnected_reason, snaptrade_connected_at, snaptrade_disconnected_at, snaptrade_last_manual_sync",
    )
    .eq("id", userId)
    .maybeSingle();
  if (error) throw { status: 500, message: error.message };
  return (data as ProfileSnap) ?? null;
}

/**
 * Enforce an active subscription entitlement (or owner bypass) for `userId`.
 * Reads the server-authoritative has_active_entitlement(uid) SQL function via the
 * service-role client — the client cannot forge this. Throws
 * { status: 403, message: 'subscription_required' } when the user is not entitled.
 *
 * Fail-CLOSED on a definite "not entitled".
 *
 * When the check ITSELF errors the default is fail-OPEN, so a transient DB hiccup never
 * locks out a paying user mid-session. Callers that would incur a NEW recurring cost by
 * being wrong must pass { failClosed: true }: an unchecked connect creates a SnapTrade
 * brokerage link that bills ~$1/month for as long as it exists, so "let them through and
 * sort it out later" is not a recoverable mistake there. Read paths keep the open default —
 * nobody who already pays should lose their data because our RPC blinked.
 */
export async function requireEntitlement(
  admin: SupabaseClient,
  userId: string,
  opts?: { failClosed?: boolean },
): Promise<void> {
  const { data, error } = await admin.rpc("has_active_entitlement", { uid: userId });
  if (error) {
    if (opts?.failClosed) {
      console.error("[requireEntitlement] rpc failed (fail-CLOSED):", error.message);
      throw { status: 503, message: "entitlement_check_unavailable" };
    }
    console.error("[requireEntitlement] rpc failed (fail-open):", error.message);
    return; // check unavailable → don't punish the user for our outage
  }
  if (data !== true) throw { status: 403, message: "subscription_required" };
}

/**
 * Soft entitlement check → boolean (no throw). Same server-authoritative predicate
 * as requireEntitlement, but returns a flag the caller can act on (e.g. snaptrade-
 * refresh short-circuits to a "trial vencido" response instead of erroring).
 *
 * Fail-OPEN (true) if the RPC itself errors, so a transient DB hiccup never
 * mislabels a paying user as unpaid mid-session.
 */
export async function isEntitled(
  admin: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("has_active_entitlement", { uid: userId });
  if (error) {
    console.error("[isEntitled] rpc failed (fail-open):", error.message);
    return true;
  }
  return data === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// IDENTIDAD DE INTERACTIVE BROKERS
// ─────────────────────────────────────────────────────────────────────────────
// El slug de IBKR se configura como secreto (SNAPTRADE_IBKR_SLUG) porque no queremos
// adivinarlo en el fuente. Pero un secreto MAL ESCRITO es peor que no tenerlo: el cliente
// recibe un `brokerSlugs.ibkr` que no coincide con ninguna conexión (toda la UI de IBKR
// muere en silencio) y snaptrade-connect le manda a `loginSnapTradeUser` un `broker` que
// SnapTrade no reconoce → 400 mudo y una pantalla en blanco donde debería estar el portal.
// Nadie se entera: no falla nada, simplemente no funciona nada.
//
// Aquí se VALIDA lo configurado contra la lista real de SnapTrade y, si no cuadra (o no
// hay nada configurado), se descubre. La lista es reference data: una lectura pública del
// catálogo de brokers, sin usuario, sin coste por conexión. Se cachea por isolate.
// Se guarda la LISTA, no un valor: el catálogo de SnapTrade puede tener más de una entrada
// para el mismo broker (la de Flex Query y cualquier integración que añadan después). Con un
// solo slug, el cliente reconocía como IBKR exactamente una de ellas y trataba la otra como
// un broker cualquiera: sin la guía del Query ID, sin el aviso de "esta conexión no da
// histórico" y sin la detección de conexión dormida — justo donde más falta hacen.
let _ibkrSlugs: string[] | undefined = undefined;
let _ibkrSlugAt = 0;
const SLUG_TTL_MS = 12 * 60 * 60 * 1000;

/** Normaliza para comparar: sólo letras, en mayúsculas ("Interactive Brokers" → INTERACTIVEBROKERS). */
const _normSlug = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z]/g, "");

/**
 * Slug REAL de Interactive Brokers según SnapTrade, o null si no se puede determinar.
 * Nunca lanza: si la lista no responde se cree lo configurado (comportamiento de siempre).
 */
export async function resolveIbkrSlug(st: Snaptrade): Promise<string | null> {
  return (await resolveIbkrSlugs(st))[0] ?? null;
}

/**
 * TODOS los slugs con los que SnapTrade puede presentar Interactive Brokers. El primero es
 * el que se usa para abrir el portal; la lista entera sirve para RECONOCER una conexión.
 * Nunca lanza.
 */
export async function resolveIbkrSlugs(
  st: Snaptrade,
  opts?: { lazy?: boolean },
): Promise<string[]> {
  const configured = (Deno.env.get("SNAPTRADE_IBKR_SLUG") ?? "").trim();
  if (_ibkrSlugs !== undefined && Date.now() - _ibkrSlugAt < SLUG_TTL_MS) return _ibkrSlugs;
  // `lazy` = esta respuesta no puede pagar una llamada de red. La sirven los caminos que se
  // resuelven desde caché en milisegundos: meterles un viaje al catálogo de SnapTrade para
  // validar un valor que casi siempre está bien sería cambiar una respuesta instantánea por
  // una lenta a cambio de nada. Se responde lo configurado y la validación la hace la primera
  // lectura VIVA del isolate, que ya va a hablar con SnapTrade de todas formas.
  if (opts?.lazy) return configured ? [configured.toUpperCase()] : [];

  let list: any[] = [];
  try {
    list = ((await st.referenceData.listAllBrokerages()).data as any[]) ?? [];
  } catch (e: any) {
    // Sin catálogo no hay nada que validar. Se conserva lo configurado: equivocarse por
    // exceso de cautela aquí apagaría la UI de IBKR de alguien a quien le funcionaba.
    console.warn("[snaptrade] listAllBrokerages falló:",
      (e?.response?.data?.detail ?? e?.message ?? String(e)).toString().slice(0, 160));
    // Sin catálogo NO se cachea: un fallo puntual dejaría a IBKR resuelto a medias durante
    // 12 horas enteras. Se responde con lo configurado y se reintenta en la próxima lectura.
    return configured ? [configured.toUpperCase()] : [];
  }

  const pick = (b: any) => (typeof b?.slug === "string" && b.slug) ? b.slug : null;
  // Se acepta el slug corto 'IBKR' y cualquier variante que contenga "INTERACTIVEBROKERS" en
  // slug, name o display_name — 'INTERACTIVE-BROKERS-FLEX' entra por ahí. No se mira nada
  // más: emparejar a ciegas por "INTERACTIVE" cazaría a Interactive Investor, otro broker real.
  const isIbkr = (b: any) => {
    const s = _normSlug(pick(b));
    if (!s) return false;
    if (s === "IBKR" || s.includes("INTERACTIVEBROKERS")) return true;
    return _normSlug(b?.name).includes("INTERACTIVEBROKERS") ||
           _normSlug(b?.display_name).includes("INTERACTIVEBROKERS");
  };
  // Se devuelven TAL CUAL los escribe SnapTrade. El primero viaja como parámetro `broker` a
  // loginSnapTradeUser: normalizarlos por nuestra cuenta reintroduciría por la puerta de atrás
  // el mismo riesgo que este resolvedor existe para eliminar.
  const found = list.filter(isIbkr).map(pick).filter((x): x is string => !!x);
  // Lo configurado va PRIMERO si el catálogo lo reconoce: es la elección explícita del
  // despliegue y puede ser la correcta entre varias entradas de IBKR.
  const cfgHit = configured ? found.find((sl) => _normSlug(sl) === _normSlug(configured)) : undefined;
  const out = cfgHit ? [cfgHit, ...found.filter((sl) => sl !== cfgHit)] : found.slice();

  if (configured && !cfgHit) {
    console.error(
      `[snaptrade] SNAPTRADE_IBKR_SLUG='${configured}' NO existe en el catálogo de SnapTrade` +
      (out.length ? ` — se usa el descubierto '${out[0]}'` : " y tampoco se encontró Interactive Brokers"),
    );
  }
  if (!out.length) {
    console.error(`[snaptrade] Interactive Brokers NO aparece en el catálogo de SnapTrade (${list.length} brokers)`);
  } else if (out.length > 1) {
    console.warn(`[snaptrade] IBKR aparece con varios slugs: ${out.join(", ")} — se conecta por '${out[0]}'`);
  }

  _ibkrSlugs = out;
  _ibkrSlugAt = Date.now();
  return _ibkrSlugs;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS DE CAMBIO
// ─────────────────────────────────────────────────────────────────────────────
// Una cuenta de Interactive Brokers es multidivisa por diseño: el efectivo va por moneda y
// cada posición se valora en la suya. Sin tipos de cambio, el cliente sólo podía sumar la
// moneda dominante y declarar el resto aparte — es decir, parte del patrimonio del usuario
// desaparecía de su total y de los pesos de la cartera. La alternativa nunca fue inventar
// una cifra: era tener una FUENTE. Aquí está.
//
//   1. SnapTrade (`listAllCurrenciesRates`) — la misma fuente que da los saldos. Preferida.
//   2. Yahoo (`{SRC}{DST}=X`) — para los pares que SnapTrade no cubre.
//
// Lo que no se resuelva se devuelve sin par: el cliente vuelve al comportamiento de siempre
// (excluir esa moneda del total y decirlo). Degradar es correcto; adivinar no.
let _fxCache: Record<string, number> = {};
let _fxAt = 0;
const FX_TTL_MS = 12 * 60 * 60 * 1000;

function _fxPut(map: Record<string, number>, src: string, dst: string, rate: number) {
  if (!src || !dst || src === dst) return;
  if (!Number.isFinite(rate) || rate <= 0) return;
  map[src + dst] = rate;
  if (!map[dst + src]) map[dst + src] = 1 / rate;
}

async function _yahooPair(src: string, dst: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${src}${dst}=X?range=1d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } },
    );
    if (!r.ok) return null;
    const j = await r.json();
    const px = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return (typeof px === "number" && Number.isFinite(px) && px > 0) ? px : null;
  } catch { return null; }
}

/**
 * Tabla de cambio que cubre TODOS los pares entre `codes`, en la medida de lo posible.
 * Claves "EURUSD" → cuántos USD vale 1 EUR. Nunca lanza; puede devolver {}.
 */
export async function fxRatesFor(st: Snaptrade, codes: string[]): Promise<Record<string, number>> {
  const want = Array.from(new Set(codes.filter((c) => typeof c === "string" && /^[A-Z]{3,5}$/.test(c))));
  if (want.length < 2) return {};

  if (!Object.keys(_fxCache).length || Date.now() - _fxAt >= FX_TTL_MS) {
    const map: Record<string, number> = {};
    try {
      const rows = ((await st.referenceData.listAllCurrenciesRates()).data as any[]) ?? [];
      for (const p of rows) {
        _fxPut(map, String(p?.src?.code ?? "").toUpperCase(),
                    String(p?.dst?.code ?? "").toUpperCase(), Number(p?.exchange_rate));
      }
    } catch (e: any) {
      console.warn("[snaptrade] listAllCurrenciesRates falló:",
        (e?.response?.data?.detail ?? e?.message ?? String(e)).toString().slice(0, 160));
    }
    _fxCache = map;
    _fxAt = Date.now();
  }

  // Se parte de la caché y se completan sólo los pares que faltan para ESTE usuario.
  const out: Record<string, number> = {};
  const missing: Array<[string, string]> = [];
  for (const a of want) {
    for (const b of want) {
      if (a === b) continue;
      const r = _fxCache[a + b];
      if (r) out[a + b] = r;
      else if (!missing.some(([x, y]) => x === b && y === a)) missing.push([a, b]);
    }
  }
  // Antes de salir a un tercero: puente por una moneda que YA se tenga. Con USD↔EUR y
  // USD↔CAD en la tabla, EUR↔CAD sale de multiplicar los dos — mismo dato, cero peticiones.
  const pivots = Object.keys(_fxCache).map((k) => k.slice(0, 3));
  const stillMissing: Array<[string, string]> = [];
  for (const [a, b] of missing) {
    let done = false;
    for (const m of new Set(pivots)) {
      if (m === a || m === b) continue;
      const r1 = _fxCache[a + m], r2 = _fxCache[m + b];
      if (r1 && r2) { _fxPut(_fxCache, a, b, r1 * r2); _fxPut(out, a, b, r1 * r2); done = true; break; }
    }
    if (!done) stillMissing.push([a, b]);
  }
  // Yahoo, sólo para los huecos que quedan y con techo: un usuario con seis divisas no puede
  // convertir esta lectura en quince peticiones a un tercero.
  for (const [a, b] of stillMissing.slice(0, 6)) {
    const px = await _yahooPair(a, b);
    if (px) { _fxPut(_fxCache, a, b, px); _fxPut(out, a, b, px); }
  }
  return out;
}
