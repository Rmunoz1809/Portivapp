// snaptrade-refresh — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Serves the user's holdings. COST-OPTIMIZED: never triggers a paid manual sync.
// It only READS the data SnapTrade already synced in its free daily cycle.
//
//  • 60-minute cache: if snaptrade_last_refresh is < 60 min old, returns the
//    cached snaptrade_holdings without touching SnapTrade (saves rate-limited
//    read calls; the "Actualizar" button hits this and serves cache all day).
//  • On cache miss: rebuilds holdings from the per-account READ endpoints
//    (getUserAccountPositions + getUserAccountBalance) — the old aggregate
//    getAllUserHoldings/getUserHoldings endpoints are DEPRECATED (HTTP 410). These
//    are included reads, not a paid sync. Persists the result + stamps last_refresh.
//  • Captures the primary snaptrade_account_id on first success (needed by
//    snaptrade-history).
//
//  • `force: true` (botón "Sincronizar ahora") SALTA la caché y, si hace falta, pide a
//    SnapTrade una sincronización real con el broker. Ver el bloque SINCRONIZACIÓN MANUAL.
//
// Request  (POST): { userId?: string, force?: boolean }
// Response (200):  { holdings, accountId, connected, fromCache, lastSync, syncQueued, disabled }

import { preflight, jsonResponse } from "../_shared/cors.ts";
import {
  snaptrade,
  adminClient,
  requireUser,
  loadProfile,
  isEntitled,
  resolveIbkrSlugs,
  fxRatesFor,
} from "../_shared/snaptrade.ts";

const CACHE_MS = 60 * 60 * 1000; // 60 minutes

// ── SINCRONIZACIÓN MANUAL (facturada) ────────────────────────────────────────────
// Las conexiones con `data_freshness_mode: "delayed"` (nuestro plan) sólo refrescan sus
// posiciones UNA VEZ AL DÍA. Comprobado en producción: una compra del día 29 no aparecía
// en SnapTrade el día 31 — no era un fallo nuestro de lectura, es que SnapTrade todavía
// no había vuelto a preguntarle al broker. La única palanca es
// connections.refreshBrokerageAuthorization, que SnapTrade FACTURA por llamada.
//
// Por eso: sólo a petición explícita del usuario (`force`), sólo si los datos que ya
// tenemos son viejos (STALE_MS) y como mucho una vez cada MANUAL_SYNC_MIN_MS por usuario.
// El límite vive en el servidor: el cliente podría pulsar el botón en bucle.
const MANUAL_SYNC_MIN_MS = 30 * 60 * 1000; // 1 sincronización facturada / 30 min / usuario
const STALE_MS = 15 * 60 * 1000;           // datos con < 15 min no se pagan por refrescar

// ── Identidad REAL del broker ────────────────────────────────────────────────────
// `brokerage.slug` es el único identificador que SnapTrade garantiza por contrato:
// "A short, unique identifier for the brokerage … will never change". `display_name`
// (lo único que llegaba hasta ahora al cliente) es texto comercial: cambia, se localiza,
// y colgar de él un indexOf('Interactive') rompe en silencio el día que lo toquen.
//
// El valor concreto del slug de IBKR NO está escrito en el fuente a propósito: se
// configura como secreto (`supabase secrets set SNAPTRADE_IBKR_SLUG=…`) con el valor que
// devuelve referenceData.listAllBrokerages(). Mientras no esté puesto, toda la lógica
// específica de IBKR queda INERTE y la app se comporta igual que antes — que es el fallo
// correcto: es mejor no tratar a IBKR de forma especial que tratar como IBKR al broker
// equivocado por haber adivinado el slug.
// El valor ya no se lee a pelo del entorno: `resolveIbkrSlug` lo VALIDA contra el catálogo
// real de SnapTrade y, si el secreto está mal escrito o no está, lo descubre. Un slug
// equivocado no da error en ninguna parte — simplemente apaga toda la lógica de IBKR en
// silencio y deja el portal en blanco —, así que confiar en él sin comprobarlo no vale.
// Nunca lanza; devuelve null cuando no se puede determinar (comportamiento de siempre).
async function ibkrSlug(lazy = false): Promise<{ ibkr: string | null; ibkrAll: string[] }> {
  try {
    const all = await resolveIbkrSlugs(snaptrade(), lazy ? { lazy: true } : undefined);
    return { ibkr: all[0] ?? null, ibkrAll: all };
  } catch { return { ibkr: null, ibkrAll: [] }; }
}

// Divisas presentes en un payload de holdings (efectivo y posiciones). Es lo que hay que
// cubrir con tipos de cambio para que el cliente pueda dar UN total en vez de un total
// parcial más una nota de lo que no cabe.
function currencyCodesOf(holdings: any): string[] {
  const out = new Set<string>();
  const code = (c: any) => {
    const v = (c && typeof c === "object") ? (c.code ?? c.iso_code) : c;
    if (typeof v === "string" && /^[A-Za-z]{3,5}$/.test(v)) out.add(v.toUpperCase());
  };
  const arr = Array.isArray(holdings) ? holdings : (holdings?.accounts ?? []);
  for (const h of Array.isArray(arr) ? arr : []) {
    for (const b of (Array.isArray(h?.balances) ? h.balances : [])) code(b?.currency);
    for (const p of (Array.isArray(h?.positions) ? h.positions : [])) {
      code(p?.currency);
      const so = p?.symbol;
      code(so?.currency);
      code(so?.symbol?.currency);
    }
    code(h?.account?.balance?.currency);
  }
  return Array.from(out);
}

/** Tabla de cambio para las divisas de este payload. Nunca lanza; {} si no hace falta. */
async function ratesFor(holdings: any): Promise<Record<string, number>> {
  try {
    const codes = currencyCodesOf(holdings);
    if (codes.length < 2) return {};
    return await fxRatesFor(snaptrade(), codes);
  } catch { return {}; }
}

// Días sin una sola cuenta ni un solo sync tras los que una conexión se declara dormida
// (ver el bloque `dormantConnections`, más abajo).
const DORMANT_DAYS = Number(Deno.env.get("SNAPTRADE_DORMANT_DAYS") ?? "7");

/** Best-effort extraction of the primary account id from a holdings payload. */
function primaryAccountId(holdings: any): string | null {
  const arr = Array.isArray(holdings) ? holdings : holdings?.accounts ?? [];
  for (const h of arr) {
    const id = h?.account?.id ?? h?.account_id ?? h?.id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* optional */ }

    const userId = await requireUser(req, admin, body?.userId);
    const force = body?.force === true;   // el usuario pulsó "Sincronizar ahora"
    const entitled = await isEntitled(admin, userId);
    const profile = await loadProfile(admin, userId);
    const reason = profile?.snaptrade_disconnected_reason ?? null;

    // No active subscription → do NOT serve broker data, and tell the client WHY so the
    // UI can show "Tu prueba terminó — suscríbete para reconectar" (reason stamped by
    // snaptrade-cleanup) instead of the generic "nunca conectaste". Soft check (no throw)
    // so the client renders a clean state rather than catching a 403.
    if (!entitled) {
      // ⚠ El `|| "subscription_inactive"` de antes se aplicaba a TODO el mundo sin
      // suscripción activa, incluidos los que NUNCA conectaron un broker. El cliente
      // lo traduce con _isSubReason() a "Cerramos la conexión con tu broker porque tu
      // suscripción terminó", así que un usuario recién registrado, que jamás tuvo
      // broker, leía que le habíamos cerrado una conexión inexistente — y encima con
      // un CTA de "Reactivar suscripción" en lugar del de conectar. `reason` sólo lo
      // sella snaptrade-cleanup cuando desconecta DE VERDAD; si no hay reason ni
      // rastro alguno de una conexión pasada, no hay nada que explicar.
      const everConnected = !!(
        profile?.snaptrade_user_id ||
        profile?.snaptrade_connected_at ||
        profile?.snaptrade_disconnected_at
      );
      return jsonResponse(req, {
        connected: false,
        entitled: false,
        neverConnected: !everConnected,
        disconnectedReason: reason || (everConnected ? "subscription_inactive" : null),
        holdings: null,
        accountId: null,
        fromCache: false,
      });
    }

    // Entitled but no SnapTrade user yet → not connected. Frontend shows "Conectar broker".
    if (!profile?.snaptrade_user_id || !profile?.snaptrade_user_secret) {
      return jsonResponse(req, {
        connected: false,
        entitled: true,
        disconnectedReason: null,
        holdings: null,
        accountId: null,
        fromCache: false,
      });
    }

    // ── Serve from cache if fresh (respects rate limits, zero SnapTrade calls) ──
    const last = profile.snaptrade_last_refresh
      ? new Date(profile.snaptrade_last_refresh).getTime()
      : 0;
    const fresh = last && Date.now() - last < CACHE_MS;
    // ── La bandera `broken` NUNCA se sirve desde caché ────────────────────────────
    // `snaptrade_connection_broken` sólo la levantaba el webhook CONNECTION_BROKEN y sólo la
    // bajaba una lectura con datos vivos. Pero este atajo devolvía la bandera SIN preguntarle
    // a SnapTrade, y el webhook no invalidaba la caché: una caída transitoria que SnapTrade ya
    // había reparado por su cuenta dejaba al usuario mirando "Reconecta tu broker" hasta 60
    // minutos, con un botón que no arregla nada porque no hay nada roto. Y al no llevar
    // `institutions`, el cartel ni siquiera podía decir QUÉ broker. Marcado como roto → se cae
    // al camino vivo, que cuesta UNA llamada (listBrokerageAuthorizations) y resuelve el estado
    // real: o lo confirma (allDisabled, que sale ahí mismo) o lo desmiente y baja la bandera.
    const brokenFlagged = !!profile.snaptrade_connection_broken;
    // `force` = el usuario pulsó el botón. Servirle la caché entonces era exactamente el
    // bug del que se quejaba: pulsar "Actualizar" no movía una sola cifra durante una hora
    // aunque su broker ya tuviera la operación.
    if (!force && fresh && !brokenFlagged && profile.snaptrade_holdings != null) {
      return jsonResponse(req, {
        connected: true,
        broken: !!profile.snaptrade_connection_broken,
        holdings: profile.snaptrade_holdings,
        accountId: profile.snaptrade_account_id,
        // El slug no cuesta una llamada: sale de la variable de entorno. Sin él, cada
        // respuesta de caché —que son la mayoría, la caché dura 60 min— apagaba en el
        // cliente todo lo específico de IBKR hasta la siguiente lectura viva. Las
        // `institutions` sí exigirían una llamada a SnapTrade, así que NO se recalculan
        // aquí: el cliente conserva las últimas que recibió (ver snapRefresh).
        // Omitir la clave cuando el modo lazy no sabe (isolate frío): el cliente aplica
        // `hasOwnProperty` y conserva los últimos slugs buenos. Mandarla vacía se los
        // borraba y _snapIsIbkr() quedaba en false durante la hora que dura la caché.
        ...(await (async () => { const bs = await ibkrSlug(true);
            return bs.ibkrAll.length ? { brokerSlugs: bs } : {}; })()),
        // Los tipos de cambio viajan TAMBIÉN con la caché: son de la tabla del isolate, no
        // cuestan una llamada, y sin ellos el cliente pasaría 60 minutos (lo que dura la
        // caché) sin poder dar un total único en una cartera multidivisa — que es justo el
        // caso normal de Interactive Brokers.
        rates: await ratesFor(profile.snaptrade_holdings),
        fromCache: true,
      });
    }

    // ── Cache miss → read SnapTrade (included daily-synced data, never a paid sync) ──
    const st = snaptrade();
    const sid = {
      userId: profile.snaptrade_user_id,
      userSecret: profile.snaptrade_user_secret,
    };

    // ── Estado REAL de la conexión ────────────────────────────────────────────────
    // Una conexión DESHABILITADA sigue devolviendo posiciones: SnapTrade responde con el
    // último estado cacheado, sin error. Así que un usuario cuya conexión se cae (cambió la
    // contraseña del broker, caducó la sesión, revocó el acceso) veía cifras de aspecto
    // normal congeladas para siempre, y `snaptrade_connection_broken` seguía en false porque
    // el webhook CONNECTION_BROKEN era el ÚNICO camino por el que nos enterábamos — si ese
    // evento se perdía, nadie volvía a preguntar. Ahora se comprueba en cada lectura.
    let conns: any[] = [];
    try {
      conns = ((await st.connections.listBrokerageAuthorizations(sid)).data as any[]) ?? [];
    } catch (e: any) {
      console.warn("[snaptrade-refresh] listBrokerageAuthorizations falló:",
        (e?.response?.data?.detail ?? e?.message ?? String(e)).toString().slice(0, 200));
    }
    const conn =
      conns.find((c: any) => c?.id && c.id === profile.snaptrade_connection_id) ??
      conns.find((c: any) => !c?.disabled) ??
      conns[0] ?? null;
    const anyLive = conns.some((c: any) => c && c.disabled !== true);
    const allDisabled = conns.length > 0 && !anyLive;

    // La conexión que el perfil tenía apuntada puede haber cambiado (reconexión, alta nueva,
    // webhook perdido). Se re-apunta sola: snaptrade-connect necesita este id para el modo
    // `reconnect`, y sin él la reconexión degenera en "añadir otra conexión" y no arregla nada.
    if (conn?.id && conn.id !== profile.snaptrade_connection_id) {
      await admin.from("profiles").update({ snaptrade_connection_id: conn.id }).eq("id", userId);
    }

    if (allDisabled) {
      // Se sirven las ÚLTIMAS posiciones conocidas (mejor que una pantalla vacía) pero
      // marcadas como rotas y viejas, para que la UI pida reconectar en vez de dejar que
      // el usuario tome decisiones con una foto de hace días creyéndola de hoy.
      //
      // `institutions` / `staleConnections` viajan TAMBIÉN por aquí. Este return está antes
      // del bloque que los calcula (necesita `accts`, que aún no se ha leído), así que hasta
      // ahora el caso más importante —el usuario con la conexión REALMENTE caída— era el único
      // que llegaba al cliente sin ellos: la tarjeta decía "Tu broker cortó la conexión" sin
      // nombrar cuál, y su único botón iba sin `connectionId`, de modo que con dos brokers
      // caídos siempre se reconectaba el primero de la lista y el segundo no tenía arreglo.
      // Aquí no hay cuentas que contar (todas las conexiones están muertas), así que se
      // construye la versión mínima que la tarjeta necesita: id, nombre y desde cuándo.
      const downInstitutions = conns.map((c: any) => ({
        id: c?.id ?? null,
        name: c?.brokerage?.display_name ?? c?.brokerage?.name ?? c?.name ?? null,
        slug: c?.brokerage?.slug ?? null,
        createdDate: c?.created_date ?? null,
        accounts: 0,
        disabled: true,
        disabledSince: c?.disabled_date ?? null,
        lastSync: null,
        maintenance: c?.brokerage?.maintenance_mode === true,
        degraded: c?.brokerage?.is_degraded === true,
      }));
      await admin
        .from("profiles")
        .update({ snaptrade_connection_broken: true })
        .eq("id", userId);
      return jsonResponse(req, {
        connected: true,
        broken: true,
        disabled: true,
        stale: true,
        disabledSince: conn?.disabled_date ?? null,
        holdings: profile.snaptrade_holdings ?? null,
        accountId: profile.snaptrade_account_id ?? null,
        lastSync: profile.snaptrade_last_refresh ?? null,
        institutions: downInstitutions,
        staleConnections: downInstitutions.map((i) => ({
          id: i.id, name: i.name, disabledSince: i.disabledSince, accounts: i.accounts,
        })),
        // Aquí NO se pide la versión perezosa: este camino ya ha hablado con SnapTrade, y es
        // justo el del usuario con la conexión caída — el que más necesita que la app sepa
        // que su broker es IBKR para ofrecerle la guía correcta al reconectar.
        brokerSlugs: await ibkrSlug(),
        rates: await ratesFor(profile.snaptrade_holdings),
        fromCache: true,
      });
    }

    // Does a holdings array actually carry REAL data (positions, options, or cash)?
    // The aggregate endpoint can return an account object with empty positions for a
    // few minutes after connecting — that must count as "still syncing", not a live "$0".
    const carriesData = (arr: any[]): boolean =>
      Array.isArray(arr) && arr.some((h) => {
        const pos = h?.positions ?? [];
        const opt = h?.option_positions ?? h?.optionPositions ?? [];
        // Una cuenta SÓLO de futuros tampoco es una cuenta vacía (ver other_positions abajo).
        const oth = h?.other_positions ?? [];
        const bals = h?.balances ?? h?.balance ?? [];
        const cash = Array.isArray(bals)
          ? bals.reduce((s: number, b: any) => s + Number(b?.cash ?? b?.amount ?? 0), 0)
          : Number(bals?.cash ?? 0);
        const total = Number(
          h?.account?.balance?.total?.amount ??
            h?.account?.balance?.total ??
            h?.total_value?.value ??
            0,
        );
        return (Array.isArray(pos) && pos.length > 0) ||
          (Array.isArray(opt) && opt.length > 0) ||
          (Array.isArray(oth) && oth.length > 0) ||
          (Number.isFinite(cash) && cash !== 0) ||
          (Number.isFinite(total) && total !== 0);
      });

    // ── DEFINITIVE FIX ──────────────────────────────────────────────────────────
    // SnapTrade DEPRECATED the aggregate holdings endpoints: getAllUserHoldings AND
    // getUserHoldings now return HTTP 410 (Gone). That is why the app sat on
    // "Sincronizando…" forever — the old code called a dead endpoint, caught the
    // error, and always saw empty holdings even though the account was fully synced.
    //
    // listUserAccounts is the only holdings-adjacent endpoint that still works. We
    // rebuild the holdings array from the LIVE per-account reads (all included READs,
    // never a paid sync) in the exact shape the client's snapMapHoldings expects:
    //   getUserAccountPositions   → GET /accounts/{id}/positions   (positions)
    //   getUserAccountBalance     → GET /accounts/{id}/balances    (cash)
    //   options.listOptionHoldings→ option positions (best-effort)
    // El catch de aquí era `catch { accts = []; }` a secas, y esa igualación entre "SnapTrade
    // respondió que no hay cuentas" y "SnapTrade no respondió" era el bug: un 429, un 5xx o un
    // timeout salían por la misma puerta que un usuario sin broker, el endpoint devolvía
    // needsConnection:true y el cliente borraba `pv_broker_*` y pintaba el cartel de "Conecta
    // tu broker" a alguien que ACABA de conectarlo — y sin reintento, porque el poll solo se
    // reagenda con `connected && syncing`. Un 429 al volver del portal dejaba el onboarding
    // muerto hasta relanzar la app. Ahora el fallo de transporte se reporta como tal.
    let accts: any[] = [];
    let acctsErr: unknown = null;
    try {
      accts = ((await st.accountInformation.listUserAccounts(sid)).data as any[]) ?? [];
    } catch (e) { acctsErr = e; accts = []; }

    // ── Cuentas cerradas ────────────────────────────────────────────────────────────
    // SnapTrade sigue listando las cuentas cerradas y archivadas: iterarlas gasta lecturas y
    // mete en la cartera un $0 de algo que el usuario ya no tiene. `status` es opcional y sus
    // valores son 'open' | 'closed' | 'archived' | 'unavailable' — 'unavailable' NO significa
    // cerrada, significa que el broker no supo decirlo, así que sólo se filtra lo explícito:
    // filtrar de más deja al usuario sin una cuenta VIVA, que es peor que enseñarle una
    // cerrada a $0. Y si TODAS quedaran filtradas no se filtra ninguna: dejar `accts` vacío
    // convertiría al usuario en needsConnection y el cliente borraría pv_broker_* para
    // pintarle el cartel de captación a alguien que SÍ tiene un broker enlazado.
    let closedAccounts = 0;
    if (accts.length > 0) {
      const open = accts.filter((a: any) => {
        const s = String(a?.status ?? "").toLowerCase();
        return s !== "closed" && s !== "archived";
      });
      if (open.length > 0 && open.length < accts.length) {
        closedAccounts = accts.length - open.length;
        console.warn(
          `[snaptrade-refresh] ${closedAccounts}/${accts.length} cuenta(s) cerrada(s)/archivada(s) filtrada(s)`,
        );
        accts = open;
      }
    }
    const hasAccount = Array.isArray(accts) && accts.length > 0;

    // Earliest real inception across accounts (SnapTrade's first_transaction_date). The
    // client clamps its Yahoo reconstruction to this so it never projects current shares
    // to before the account existed (that caused a fake +34% "ALL" on first render).
    let inceptionDate: string | null = null;
    for (const a of accts) {
      const d = a?.sync_status?.transactions?.first_transaction_date;
      if (typeof d === "string" && d && (!inceptionDate || d < inceptionDate)) inceptionDate = d;
    }

    // Cuándo fue la última vez que SnapTrade habló DE VERDAD con el broker. Es el dato que
    // le faltaba al usuario: la app decía "Sincronizado ahora mismo" cuando lo único reciente
    // era nuestra propia lectura de una foto de ayer.
    //
    // Se toma el MÍNIMO, no el máximo. Con Schwab sincronizado hace 2 minutos e IBKR hace 3
    // días, quedarse con el más reciente hacía que _snapSyncLabel() pintara "Datos de tu
    // broker de hace un momento" y el usuario tomaba decisiones sobre una cartera cuya mitad
    // tenía tres días. La antigüedad honesta del conjunto es la de su cuenta MÁS VIEJA.
    // (Ojo: `inceptionDate`, arriba, SÍ es un mínimo por otro motivo y ya estaba bien.)
    let lastSync: string | null = null;
    let accountsWithoutSync = 0;
    for (const a of accts) {
      const s = a?.sync_status?.holdings?.last_successful_sync;
      if (typeof s === "string" && s) {
        if (!lastSync || s < lastSync) lastSync = s;
      } else {
        // Una cuenta sin marca de sync no debe hacer parecer fresco al conjunto: no sabemos
        // de cuándo son sus datos, así que se declara aparte en vez de ignorarla.
        accountsWithoutSync++;
      }
    }

    // ── Suelo de reconstrucción cuando no hay primera transacción ───────────────────
    // `inceptionDate` (arriba) sale de first_transaction_date. Hay conexiones —IBKR entre
    // ellas— que son "Balance Only": entregan posiciones y efectivo pero NUNCA actividades,
    // así que ese campo llega null en TODAS las cuentas y el cliente no llega a establecer
    // `_BROKER_INCEPTION`. Sin ese tope, su reconstrucción Yahoo proyecta las participaciones
    // de hoy hacia atrás sin límite: es exactamente el "+34 % en ALL" falso que el clamp se
    // escribió para matar, reaparecido por la puerta de atrás para un usuario solo-IBKR.
    //
    // Va en un campo DISTINTO a propósito. `inceptionDate` significa "cuándo empezó tu cartera
    // de verdad" y el cliente lo trata como dato duro; esto es una estimación prudente ("antes
    // de esta fecha seguro que no había nada"). Meterlas en el mismo campo convertiría una
    // estimación en un hecho, y el cliente pintaría un "desde el principio" que no lo es.
    let inceptionFloor: string | null = null;
    if (!inceptionDate) {
      for (const c of conns) {
        const d = typeof c?.created_date === "string" && c.created_date ? c.created_date : null;
        if (d && (!inceptionFloor || d < inceptionFloor)) inceptionFloor = d;
      }
      // Sin fecha de creación (el broker no la reporta) queda el sync más viejo: es un suelo
      // peor —posterior a la conexión real— pero sigue siendo mejor que ninguno.
      if (!inceptionFloor && lastSync) inceptionFloor = lastSync;
    }
    const inceptionSource: "transactions" | "connection" | null =
      inceptionDate ? "transactions" : (inceptionFloor ? "connection" : null);

    // ── ¿Terminó la sincronización INICIAL de todas las cuentas? ─────────────────────
    // Hoy `syncing` se deduce heurísticamente ("hay cuenta pero no hay datos → estará
    // sincronizando"). Para una cuenta real a $0 —recién abierta o liquidada— eso nunca deja
    // de ser cierto: la tarjeta se queda en "Sincronizando…" para siempre, el cliente agota
    // sus 14 reintentos de historial y _BROKER_HISTORY_PENDING bloquea el gráfico.
    // `initial_sync_completed` es el dato autoritativo. Si llega `undefined` (broker que no
    // lo reporta) se trata como false → comportamiento de siempre. NUNCA asumir `true` por
    // ausencia: eso convertiría un sync en curso en "cartera vacía" y pondría el portafolio
    // a $0 al conectar, que es exactamente el bug que documenta el Bloque 4 del cliente.
    const allInitialSyncDone = accts.length > 0 &&
      accts.every((a: any) => a?.sync_status?.holdings?.initial_sync_completed === true);

    // ── Rotura PARCIAL de conexión ──────────────────────────────────────────────────
    // `allDisabled` (arriba) sólo salta si se caen TODAS. Con dos brokers y uno caído seguía
    // en false, el flujo continuaba normal y las cuentas del broker muerto SEGUÍAN devolviendo
    // datos: una conexión deshabilitada sirve su último estado cacheado sin error. Resultado:
    // cifras congeladas mezcladas con cifras vivas bajo la etiqueta "Conectado", sin un aviso.
    // No se deja de servir esas posiciones —el dato viejo es mejor que una pantalla vacía—:
    // lo que faltaba era DECIR que es viejo y de qué broker.
    // ── Quién es tu broker, de verdad (F5) ──────────────────────────────────────────
    // La tarjeta enseñaba siempre los mismos chips de adorno ("Charles Schwab ·
    // Interactive Brokers · + más") daba igual con quién estuvieras conectado: alguien
    // con Fidelity veía el nombre de dos brokers que no son el suyo. Y cuando una
    // conexión se rompía, el aviso decía "tu broker" sin decir CUÁL, que con dos
    // conectados es justo el dato que hace falta para saber dónde ir a arreglarlo.
    //
    // `display_name` antes que `name`: el primero es el nombre comercial que el usuario
    // reconoce; el segundo suele ser el identificador interno.
    //
    // `maintenance_mode` / `is_degraded` los reporta SnapTrade sobre el broker, no sobre
    // la conexión: explican unos datos congelados mucho mejor que cualquier cosa que
    // podamos deducir nosotros, y hasta ahora se tiraban a la basura.
    const institutions = conns.map((c: any) => {
      const mine = accts.filter((a: any) => a?.brokerage_authorization === c?.id);
      let instSync: string | null = null;
      for (const a of mine) {
        const s = a?.sync_status?.holdings?.last_successful_sync;
        // El MÁS VIEJO de sus cuentas, mismo criterio que `lastSync` global: si una cuenta
        // de este broker lleva tres días sin sincronizar, el broker no está "al día".
        if (typeof s === "string" && s && (!instSync || s < instSync)) instSync = s;
      }
      return {
        id: c?.id ?? null,
        name: c?.brokerage?.display_name ?? c?.brokerage?.name ?? c?.name ?? null,
        // Identidad estable (ver IBKR_SLUG arriba). `name` sigue siendo lo que se PINTA;
        // `slug` es lo único con lo que el cliente decide comportamiento.
        slug: c?.brokerage?.slug ?? null,
        // Cuándo se estableció la conexión en SnapTrade. Es el reloj de las dos esperas
        // que el cliente necesita medir: las 48 h de habilitación de IBKR y la ventana
        // de `dormantConnections`.
        createdDate: c?.created_date ?? null,
        accounts: mine.length,
        disabled: c?.disabled === true,
        disabledSince: c?.disabled_date ?? null,
        lastSync: instSync,
        maintenance: c?.brokerage?.maintenance_mode === true,
        degraded: c?.brokerage?.is_degraded === true,
      };
    });

    // Se deriva de `institutions` en vez de recalcularse: dos listas construidas por
    // separado acaban discrepando, y discrepar aquí significa que el aviso nombra a un
    // broker y los chips a otro.
    const staleConnections = institutions
      .filter((i) => i.disabled)
      .map((i) => ({
        id: i.id,
        name: i.name,
        disabledSince: i.disabledSince,
        accounts: i.accounts,
      }));

    // ── Conexiones que nunca llegaron a entregar nada ───────────────────────────────
    // Una conexión IBKR cuyo dueño no completó el paso del engranaje en el portal de IBKR
    // —o cuya cuenta aún no está fondeada— jamás habilita el acceso: se queda VIVA en
    // SnapTrade, sin una sola cuenta y sin un solo sync. SnapTrade no la reporta como rota
    // (no lo está), así que hoy no aparece por ninguna parte: al usuario le cuesta el enlace
    // todos los meses, indefinidamente, a cambio de cero datos.
    //
    // Aquí sólo se DETECTA y se declara. No se desconecta sola a propósito: el usuario puede
    // estar dentro de su ventana legítima (IBKR tarda hasta 48 h) o a punto de completar el
    // proceso, y desconectarle le obligaría a rehacerlo entero — el peor resultado posible.
    // La decisión es suya; nuestro trabajo es que la vea. Va aquí y no en snaptrade-cleanup
    // porque cleanup es un cron que ACTÚA y cuya salida no lee nadie, mientras que esto es
    // exactamente lo que pinta la tarjeta, derivado de `institutions` que ya está calculado.
    const dormantConnections = institutions
      .filter((i) => {
        if (i.disabled) return false;      // eso ya lo cuenta staleConnections
        if (!i.createdDate) return false;  // sin edad no se acusa a nadie
        const age = Date.now() - new Date(i.createdDate).getTime();
        if (!isFinite(age) || age < DORMANT_DAYS * 86400000) return false;
        return i.accounts === 0 || !i.lastSync;
      })
      .map((i) => ({
        id: i.id,
        name: i.name,
        slug: i.slug,
        createdDate: i.createdDate,
        accounts: i.accounts,
      }));

    // ── Sincronización manual (ver cabecera): sólo con `force`, sólo si hace falta ──
    let syncQueued = false;
    let syncThrottled = false;
    if (force && conn?.id && conn?.disabled !== true) {
      const realtime = /real/i.test(String(conn?.data_freshness_mode ?? ""));
      // `lastSync` es ahora el de la cuenta MÁS VIEJA (ver arriba), así que esto mide "¿le
      // queda a alguna cuenta dato viejo?" y no "¿está fresca la más reciente?". Es lo que el
      // usuario quiere decir al pulsar el botón: con Schwab de hace 2 min e IBKR de hace 3
      // días, el criterio anterior concluía "acaban de sincronizar" y no refrescaba nada.
      // El gasto sigue acotado por MANUAL_SYNC_MIN_MS, que no se toca.
      const syncAge = lastSync ? Date.now() - new Date(lastSync).getTime() : Infinity;
      const lastManual = profile.snaptrade_last_manual_sync
        ? new Date(profile.snaptrade_last_manual_sync).getTime()
        : 0;
      const throttleLeft = lastManual ? MANUAL_SYNC_MIN_MS - (Date.now() - lastManual) : 0;
      if (realtime || !(syncAge > STALE_MS)) {
        // Conexión en tiempo real, o SnapTrade acaba de sincronizar: pagar no traería
        // ni un dato nuevo. La lectura de abajo ya devuelve lo último.
      } else if (throttleLeft > 0) {
        syncThrottled = true;
      } else {
        try {
          await (st as any).connections.refreshBrokerageAuthorization({
            authorizationId: conn.id,
            ...sid,
          });
          syncQueued = true;
          await admin
            .from("profiles")
            .update({ snaptrade_last_manual_sync: new Date().toISOString() })
            .eq("id", userId);
          // SnapTrade encola el sync y avisa por webhook (ACCOUNT_HOLDINGS_UPDATED, que
          // invalida la caché). Esta espera corta basta para que muchos brokers ya
          // devuelvan lo nuevo en la lectura de abajo; si no, el cliente reintenta.
          await new Promise((r) => setTimeout(r, 6000));
        } catch (e: any) {
          console.warn("[snaptrade-refresh] refreshBrokerageAuthorization falló:",
            (e?.response?.data?.detail ?? e?.message ?? String(e)).toString().slice(0, 200));
        }
      }
    }

    const ai: any = st.accountInformation;

    // ── Una cuenta que no responde NO es una cuenta vacía ─────────────────────────
    // Los `catch { /* not ready yet */ }` mudos de antes emitían esa cuenta con
    // positions:[] y balances:[]. Con más de una cuenta el resultado pasaba igualmente
    // el filtro carriesData (gracias a las que SÍ respondieron), así que esa foto
    // TRUNCADA se guardaba en profiles.snaptrade_holdings y se sellaba last_refresh:
    // el usuario veía su cartera sin una cuenta entera —o sin su efectivo— durante los
    // 60 minutos siguientes, con el total y el donut cuadrando entre ellos y con la
    // realidad no, y sin un solo aviso. Un 429 puntual bastaba. Ahora cada lectura
    // reintenta una vez y, si vuelve a fallar, la cuenta se cuenta como ROTA.
    const readAcct = async (fn: () => Promise<any>): Promise<{ ok: boolean; data: any[] }> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return { ok: true, data: (await fn()).data ?? [] }; }
        catch (e) {
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
          console.warn("[snaptrade-refresh] lectura de cuenta falló:",
            ((e as any)?.response?.data?.detail ?? (e as any)?.message ?? String(e)).toString().slice(0, 160));
        }
      }
      return { ok: false, data: [] };
    };

    // ── Clases de activo que los endpoints clásicos NO devuelven ────────────────────
    // getUserAccountPositions da equity / ETF / cripto / fondos y listOptionHoldings las
    // opciones. Un FUTURO de tastytrade o IBKR no salía por ninguno de los dos: ni como fila,
    // ni en el aviso de la tarjeta, ni descontado del total. Un descuadre silencioso.
    //
    // GET /accounts/{id}/positions/all lo devuelve TODO, así que SUSTITUYE a
    // listOptionHoldings —el presupuesto de llamadas por cuenta no cambia— y de paso saca a la
    // luz futuros y CFDs. Su forma es OTRA (`instrument` es una unión discriminada por `kind`,
    // y units/price llegan como CADENA), por eso NO se usa para la cartera: las clases que el
    // endpoint clásico ya cubre se ignoran aquí para no contarlas dos veces. El camino de
    // equity, que es el que alimenta la UI, se queda exactamente como estaba.
    const OTHER_KINDS = new Set(["future", "cfd", "other"]);
    const splitAllPositions = (rows: any[]) => {
      const opts: any[] = [], others: any[] = [];
      for (const r of Array.isArray(rows) ? rows : []) {
        const inst = r?.instrument ?? {};
        const kind = String(inst?.kind ?? "").toLowerCase();
        const units = Number(r?.units ?? 0);
        const price = Number(r?.price ?? 0);
        // Forma que snapMapHoldings ya espera para las opciones (units/price numéricos; el
        // multiplicador de 100 del contrato lo aplica el cliente, como hasta ahora).
        // La divisa viaja con la opción: sin ella, en una cuenta IBKR base EUR con opciones
        // en USD el cliente descontaba del total la cifra en dólares como si fueran euros.
        const ccy = (typeof r?.currency === "string" && r.currency)
          ? r.currency
          : (typeof r?.currency?.code === "string" ? r.currency.code : null);
        if (kind === "option") opts.push({ symbol: inst?.symbol ?? null, units, price, currency: ccy });
        // Del resto se declara sólo lo que SnapTrade dice, sin derivar ninguna valoración:
        // el notional de un futuro no es lo que aporta a tu patrimonio, y no vamos a inventar
        // una cifra para restarla del total.
        else if (OTHER_KINDS.has(kind)) {
          others.push({ kind, symbol: inst?.symbol ?? null, units, price, currency: ccy });
        }
      }
      return { opts, others };
    };

    // Lectura completa de UNA cuenta. Es el cuerpo del bucle de siempre, extraído tal cual
    // para poder lanzarlo en paralelo. Devuelve null si la cuenta no trae id: ni se lee, ni
    // cuenta como rota —no hay nada que leer, no es que el broker no respondiera.
    const readOneAccount = async (a: any) => {
      const accountId = a?.id ?? a?.account_id;
      if (!accountId) return null;
      const pos = await readAcct(() => ai.getUserAccountPositions({ ...sid, accountId }));
      const bal = await readAcct(() => ai.getUserAccountBalance({ ...sid, accountId }));
      let optionPositions: any[] = [];
      let otherPositions: any[] = [];
      // Las opciones sí son best-effort: el cliente no las valora, sólo las declara aparte.
      try {
        const all = (await ai.getAllAccountPositions({ ...sid, accountId })).data?.results ?? [];
        const split = splitAllPositions(all);
        optionPositions = split.opts;
        otherPositions = split.others;
      } catch {
        // Broker o plan sin el endpoint unificado (404/410/501) → se vuelve al de siempre y se
        // pierde sólo la visibilidad de futuros, que es lo que había hasta hoy. Ni éste ni el
        // fallback marcan la cuenta como ROTA: esto es declarativo, no alimenta la cartera.
        try { optionPositions = (await (st as any).options.listOptionHoldings({ ...sid, accountId })).data ?? []; } catch { /* optional */ }
      }
      // `amount` es OPCIONAL en el SDK: `{ currency: "EUR" }` sin importe es una respuesta
      // válida. El `??` en cadena devolvía entonces el OBJETO, el cliente lo sumaba como
      // total declarado (NaN) y esa cuenta desaparecía del patrimonio. Sólo pasa un número.
      const rawTotal = a?.balance?.total;
      const totalAmt = (rawTotal && typeof rawTotal === "object") ? rawTotal.amount : rawTotal;
      const totalNum = Number(totalAmt);
      const total = (totalAmt != null && Number.isFinite(totalNum)) ? totalNum : null;
      // La divisa del total se descartaba. En una cuenta multidivisa —IBKR siempre lo es—
      // ese número está en la moneda BASE de la cuenta, y sin saber cuál es el cliente no
      // podía ni compararlo con la suma de las posiciones ni convertirlo: lo trataba como si
      // fuera de la moneda dominante que él mismo dedujo. Cuando no coincidían, el total del
      // broker mandaba y la cartera entera quedaba mal denominada.
      const totalCcy = a?.balance?.total?.currency?.code ?? a?.balance?.total?.currency ?? null;
      return {
        broken: !pos.ok || !bal.ok,
        entry: {
          account: { id: accountId,
                     ...(total != null
                         ? { balance: { total, ...(typeof totalCcy === "string" && totalCcy ? { currency: totalCcy } : {}) } }
                         : {}) },
          balances: bal.data,
          positions: pos.data,
          option_positions: optionPositions,
          other_positions: otherPositions,
        },
      };
    };

    // ── Las cuentas en paralelo, pero con la correa corta ────────────────────────────
    // En serie cada cuenta encadenaba sus lecturas a la latencia total: con 5 cuentas eran
    // 15 viajes de ida y vuelta uno detrás de otro —y el reintento de 800 ms de readAcct
    // encima— mientras el usuario mira un esqueleto. Ninguna cuenta depende de otra.
    //
    // Con TECHO de 4, no Promise.all a pelo: los rate limits de SnapTrade son por clientId,
    // o sea del proyecto ENTERO, no de este usuario. Alguien con 12 cuentas dispararía 12
    // peticiones simultáneas y se llevaría por delante los refrescos de los demás con 429s
    // —que readAcct convertiría en "cuenta rota" y el afectado vería su cartera a medias.
    // El número de llamadas es exactamente el mismo que antes; sólo cambia cuántas viajan
    // a la vez.
    const CONCURRENCY = 4;
    const slots: Awaited<ReturnType<typeof readOneAccount>>[] = new Array(accts.length).fill(null);
    let nextIdx = 0;
    const worker = async () => {
      while (true) {
        const i = nextIdx++;   // seguro sin cerrojo: el bucle de eventos de Deno es un solo hilo
        if (i >= accts.length) return;
        slots[i] = await readOneAccount(accts[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, accts.length) }, () => worker()));

    // El recuento de rotas y el montaje del array van DESPUÉS, recorriendo `slots` en orden.
    // Dos motivos: incrementar brokenAccounts desde dentro de las tareas lo haría depender de
    // quién termine antes, y sobre todo el orden de `holdings` tiene que seguir siendo el de
    // `accts` —el cliente casa cuentas por posición en más de un sitio, y reordenarlas según
    // cuál conteste primero movería el efectivo de una cuenta a otra entre dos refrescos.
    const holdings: any[] = [];
    let brokenAccounts = 0;
    for (const r of slots) {
      if (!r) continue;
      if (r.broken) brokenAccounts++;
      holdings.push(r.entry);
    }
    const holdArr = holdings;

    // Foto incompleta → jamás se persiste ni se sirve como si fuera la cartera entera.
    if (brokenAccounts > 0) {
      console.error(
        `[snaptrade-refresh] ${brokenAccounts}/${accts.length} cuenta(s) sin responder — no se persiste la foto parcial`,
      );
      if (profile.snaptrade_holdings != null) {
        // La última foto COMPLETA conocida, marcada como vieja: mejor un dato entero de hace
        // un rato que uno de ahora al que le falta una cuenta.
        return jsonResponse(req, {
          connected: true,
          broken: !!profile.snaptrade_connection_broken,
          holdings: profile.snaptrade_holdings,
          accountId: profile.snaptrade_account_id ?? null,
          inceptionDate,
          inceptionFloor,
          inceptionSource,
          lastSync: lastSync ?? profile.snaptrade_last_refresh ?? null,
          stale: true,
          partial: true,
          staleConnections,
          institutions,
          dormantConnections,
          brokerSlugs: await ibkrSlug(),
          rates: await ratesFor(profile.snaptrade_holdings),
          accountsWithoutSync,
          closedAccounts,
          fromCache: true,
        });
      }
      // Sin foto previa no hay nada íntegro que servir. `unavailable` = el cliente conserva
      // su estado local y reintenta con backoff (nunca borra pv_broker_* ni pinta el CTA).
      return jsonResponse(req, {
        connected: false,
        needsConnection: false,
        unavailable: true,
        holdings: null,
        accountId: null,
        fromCache: false,
      });
    }

    const hasHoldings = carriesData(holdArr);

    if (!hasHoldings) {
      if (!hasAccount) {
        // No sabemos si tiene broker: la llamada falló. NO es needsConnection.
        // `unavailable` le dice al cliente: conserva el estado local y vuelve a intentar.
        if (acctsErr) {
          const d = (acctsErr as any);
          const st2 = d?.response?.status ?? d?.status ?? 0;
          console.error("[snaptrade-refresh] listUserAccounts falló:", st2,
            (d?.response?.data?.detail ?? d?.message ?? String(acctsErr)).toString().slice(0, 200));
          return jsonResponse(req, {
            connected: false,
            needsConnection: false,
            unavailable: true,          // ← el cliente NO debe borrar pv_broker_* ni parar el poll
            upstreamStatus: st2 || null,
            holdings: null,
            accountId: null,
            fromCache: false,
          });
        }
        // Registered on SnapTrade but NO broker linked yet → not broken; needs to connect.
        return jsonResponse(req, {
          connected: false,
          needsConnection: true,
          holdings: null,
          accountId: null,
          fromCache: false,
        });
      }
      // A brokerage account exists but holdings are still empty → the INITIAL SYNC is
      // running. SnapTrade pulls holdings asynchronously after CONNECTION_ADDED (usually
      // 1–2 min, sometimes more). Report `syncing` so the client shows "Sincronizando…"
      // and keeps polling. Only a webhook-confirmed break is reported as genuinely broken.
      //
      // …salvo que SnapTrade ya haya dado por terminada la sincronización inicial de TODAS
      // las cuentas: entonces el vacío es un dato real (cuenta recién abierta o liquidada) y
      // no un sync en curso. `settled` se lo dice al cliente, cuya lógica `_settled` en
      // snapRefresh ya sabe aplicar una cartera vacía de verdad.
      const brokenFlag = !!profile.snaptrade_connection_broken;
      const settled = allInitialSyncDone && !brokenFlag;
      return jsonResponse(req, {
        connected: true,
        broken: brokenFlag,
        syncing: !brokenFlag && !allInitialSyncDone,
        settled,
        holdings: holdArr,
        accountId: profile.snaptrade_account_id ?? null,
        inceptionDate,
        inceptionFloor,
        inceptionSource,
        lastSync,
        staleConnections,
        institutions,
        dormantConnections,
        brokerSlugs: await ibkrSlug(),
        rates: await ratesFor(holdArr),
        accountsWithoutSync,
        closedAccounts,
        syncQueued,
        syncThrottled,
        fromCache: false,
      });
    }

    // ── Have holdings → success. Resolve primary account id + clear any broken flag. ──
    let accountId = profile.snaptrade_account_id ?? primaryAccountId(holdings);
    if (!accountId && Array.isArray(accts) && accts[0]) {
      accountId = accts[0].id ?? accts[0].account_id ?? null;
    }

    const { error } = await admin
      .from("profiles")
      .update({
        snaptrade_holdings: holdings,
        snaptrade_last_refresh: new Date().toISOString(),
        snaptrade_connection_broken: false, // got live data → connection healthy
        // Live data means they're connected & paying again → clear any prior
        // "trial vencido" disconnect marker so refresh stops reporting it.
        snaptrade_disconnected_reason: null,
        snaptrade_disconnected_at: null,
        ...(accountId ? { snaptrade_account_id: accountId } : {}),
      })
      .eq("id", userId);
    if (error) return jsonResponse(req, { error: error.message }, 500);

    // ⚠ Este es el camino BUENO —el que recorre todo el mundo cuyo broker responde— y era
    // el ÚNICO camino vivo al que le faltaban cuatro campos que sus dos hermanos degradados
    // (foto parcial e initial-sync) sí mandaban. El efecto era que TODO lo específico de
    // IBKR sólo existía mientras algo iba mal:
    //   · brokerSlugs        → sin él _snapIsIbkr() da false para todo: ni la guía de IBKR,
    //                          ni la nota de la curva ("esa conexión no entrega histórico"),
    //                          ni el aviso del engranaje. Muertos en cuanto llegan datos.
    //   · dormantConnections → una conexión IBKR que nunca entregó una cuenta sólo se veía
    //                          si NINGÚN broker traía datos. Con IBKR dormido + otro broker
    //                          sano —el caso que de verdad ocurre— el enlace seguía cobrando
    //                          cada mes sin que el usuario llegara a enterarse nunca.
    //   · inceptionFloor /   → IBKR (Balance Only) no da primera transacción, así que
    //     inceptionSource      `inceptionDate` es null y sin el suelo la reconstrucción Yahoo
    //                          vuelve a inventar meses anteriores a la conexión: el "+34 % a
    //                          1 año" que este archivo dice haber matado, entrando por aquí.
    // Cualquier campo nuevo que se añada a los otros dos returns tiene que añadirse también
    // aquí: los tres describen el mismo estado, sólo cambia cuánto dato lo acompaña.
    return jsonResponse(req, {
      connected: true,
      broken: false,
      holdings,
      accountId,
      inceptionDate,
      inceptionFloor,
      inceptionSource,
      lastSync,
      staleConnections,
      institutions,
      dormantConnections,
      brokerSlugs: await ibkrSlug(),
      // Cambio real entre las divisas de ESTA cartera (SnapTrade primero, Yahoo para los
      // huecos). Es lo que le faltaba al cliente para dar UN total en vez de "el total en
      // la moneda dominante, y aparte lo que no cabe". Un par que no se resuelva no viaja:
      // el cliente vuelve solo al comportamiento anterior para esa moneda.
      rates: await ratesFor(holdings),
      accountsWithoutSync,
      closedAccounts,
      syncQueued,
      syncThrottled,
      fromCache: false,
    });
  } catch (e: any) {
    const status = e?.status ?? 500;
    const message = e?.message ?? e?.responseBody?.detail ?? String(e);
    return jsonResponse(req, { error: message }, status);
  }
});
