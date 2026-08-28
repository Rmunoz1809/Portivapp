// snaptrade-history — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Returns up to ~1 year of portfolio value history for the performance chart.
//
// Uses getAccountBalanceHistory — an EXPERIMENTAL SnapTrade endpoint (max 1y
// lookback) that is DISABLED by default and must be enabled per-account by
// emailing SnapTrade. Until then it returns empty/errors — we handle that
// gracefully and tell the frontend to show a "coming soon" placeholder instead
// of crashing.
//
//  • Daily cache: historical data does not change intraday, so if
//    snaptrade_history was written today, it is returned from cache (0 calls).
//
//  • Suma TODAS las cuentas del usuario, no sólo snaptrade_account_id (ver mergeSeries).
//
// Request  (POST): { userId?: string, force?: boolean }
// Response (200):  { history: [{date,value}], available, reason?, terminal?, partial?,
//                    accounts?, fromCache? }
//   terminal: reintentar en esta sesión no puede cambiar el resultado → el cliente para.
//   partial:  hay curva pero le falta alguna cuenta → la suma va por debajo de la real.
//   partialBrokers: [{name,slug}] de quién son esas cuentas ausentes, para poder decir si
//     el hueco es transitorio o una limitación permanente de esa conexión (IBKR).
//   currency: en qué moneda está la curva. El cliente manda la suya en `currency` (la que
//     snapMapHoldings eligió para el total) y aquí se convierte cada cuenta a esa moneda.
//
// ── POR QUÉ LA MONEDA ─────────────────────────────────────────────────────────────
// mergeSeries sumaba los saldos de todas las cuentas 1:1. Con una cuenta en euros y otra
// en dólares —lo normal en Interactive Brokers, que es multidivisa por diseño— eso producía
// una curva que no está en ninguna moneda: ni euros ni dólares, la suma cruda de las dos.
// Y desde que snaptrade-refresh presenta el total en UNA moneda, esa curva y la cifra grande
// de la tarjeta discrepan sin que nada lo explique: el usuario compara el último punto de su
// gráfica con su patrimonio y no cuadran. Ahora cada serie se convierte antes de sumarse, y
// la cuenta cuya moneda no se pueda convertir se queda FUERA y se declara (partial), que es
// lo mismo que ya se hacía con la cuenta que no responde.

import { preflight, jsonResponse } from "../_shared/cors.ts";
import {
  snaptrade,
  adminClient,
  requireUser,
  loadProfile,
  requireEntitlement,
  fxRatesFor,
} from "../_shared/snaptrade.ts";

const todayUTC = () => new Date().toISOString().slice(0, 10);

/** Normalize whatever the experimental endpoint returns into [{date,value}]. */
function normalize(raw: any): { date: string; value: number }[] {
  const arr = Array.isArray(raw) ? raw : raw?.history ?? raw?.data ?? [];
  if (!Array.isArray(arr)) return [];
  const out: { date: string; value: number }[] = [];
  for (const it of arr) {
    const date = it?.date ?? it?.snapshotDate ?? it?.day ?? it?.timestamp;
    const rawVal = it?.value ?? it?.total_value ?? it?.totalValue ?? it?.balance ?? it?.equity;
    const value = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (date && Number.isFinite(value)) {
      out.push({ date: String(date).slice(0, 10), value });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // Trim the leading pre-funding stretch. getAccountBalanceHistory returns a FULL year
  // and reports value 0 for every day BEFORE the account was funded. Left in, those
  // zeros stretched the chart axis to ~1y and inflated the ALL % (comparing "now" to an
  // early ~$0 value → a fake +34%). Start the series at the first day with real value.
  const firstReal = out.findIndex((p) => p.value > 0);
  if (firstReal === -1) return []; // account never held value → no real series
  return firstReal > 0 ? out.slice(firstReal) : out;
}

/**
 * Suma las series de TODAS las cuentas en una sola curva de portafolio.
 *
 * Antes esta función pedía el historial de UNA sola cuenta (profiles.snaptrade_account_id,
 * que es simplemente la primera que apareció). snaptrade-refresh, en cambio, agrega las
 * posiciones de TODAS. Con dos cuentas —brokerage + Roth IRA, o dos brokers— el valor de
 * la tarjeta y el último punto de la gráfica no coincidían, y el % de rendimiento salía
 * calculado sobre una fracción de la cartera. Cuanto más repartido el patrimonio, mayor
 * la mentira.
 *
 * Alineación: las cuentas no comparten calendario (una se abrió después, otra tiene
 * huecos). Para cada fecha se toma de cada cuenta su ÚLTIMO valor conocido en o antes de
 * esa fecha; si la fecha es anterior a su primer punto real, esa cuenta aporta 0 —que es
 * la verdad: todavía no existía. Un forward-fill ingenuo por índice desplazaría las
 * series entre sí e inventaría saltos.
 */
function mergeSeries(series: { date: string; value: number }[][]): { date: string; value: number }[] {
  const live = series.filter((s) => s.length > 0);
  if (live.length === 0) return [];
  if (live.length === 1) return live[0];

  const dates = Array.from(new Set(live.flatMap((s) => s.map((p) => p.date)))).sort();
  const idx = new Array(live.length).fill(0);
  const last = new Array(live.length).fill(0);
  const out: { date: string; value: number }[] = [];

  for (const d of dates) {
    let sum = 0;
    for (let i = 0; i < live.length; i++) {
      const s = live[i];
      while (idx[i] < s.length && s[idx[i]].date <= d) { last[i] = s[idx[i]].value; idx[i]++; }
      sum += last[i]; // 0 mientras la cuenta aún no tenga ningún punto ≤ d
    }
    out.push({ date: d, value: sum });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* optional */ }

    const userId = await requireUser(req, admin, body?.userId);
    await requireEntitlement(admin, userId); // gate: no entitlement → no history
    // Moneda en la que el cliente está presentando la cartera (la que eligió snapMapHoldings).
    // Sin ella no se convierte nada y todo se comporta como antes.
    const wantCcy = (typeof body?.currency === "string" && /^[A-Za-z]{3,5}$/.test(body.currency))
      ? body.currency.toUpperCase()
      : null;
    const profile = await loadProfile(admin, userId);

    if (!profile?.snaptrade_user_id || !profile?.snaptrade_user_secret) {
      return jsonResponse(req, { history: [], available: false, reason: "not_connected" });
    }

    // ── Daily cache ── (omitida si el cliente pide `force`: p.ej. tras habilitar el
    // lookback completo de 1 año en SnapTrade, un "Actualizar" manual trae el historial
    // ampliado al instante en vez de esperar hasta 24h a que expire la caché diaria).
    const cached: any = profile.snaptrade_history;
    // La caché guarda la curva YA convertida, así que sólo sirve si está en la misma moneda
    // que se pide ahora. Servirla a ciegas devolvía euros a quien acababa de pasar a dólares.
    const cacheCcyOk = !wantCcy || (cached?.currency ?? null) === wantCcy;
    if (!body?.force && cacheCcyOk && cached && cached.updatedAt && String(cached.updatedAt).slice(0, 10) === todayUTC()) {
      return jsonResponse(req, {
        history: cached.history ?? [],
        available: !!cached.available,
        reason: cached.reason,
        terminal: !!cached.terminal,
        partial: !!cached.partial,
        partialBrokers: cached.partialBrokers ?? [],
        accounts: cached.accounts ?? null,
        currency: cached.currency ?? null,
        fromCache: true,
      });
    }

    const st = snaptrade();
    const sid = {
      userId: profile.snaptrade_user_id,
      userSecret: profile.snaptrade_user_secret,
    };

    // ── TODAS las cuentas, no sólo snaptrade_account_id ──────────────────────
    // snaptrade_account_id es la primera cuenta que se vio, no "la cuenta". Se listan
    // todas y se cae a la guardada si el listado falla, para no quedarnos sin gráfica
    // por un 429.
    let accountIds: string[] = [];
    let usableRows: any[] = [];
    try {
      const accts = ((await st.accountInformation.listUserAccounts(sid)).data as any[]) ?? [];
      // Cuentas cerradas/archivadas fuera: pedir su curva gasta una llamada a un endpoint
      // experimental y lento por una cuenta que ya no existe, y su serie plana ensucia el
      // agregado. Sólo se filtra el `status` explícito ('unavailable' NO es cerrada, es "el
      // broker no supo decirlo") y nunca hasta vaciar la lista: quedarse sin cuentas
      // degradaría la gráfica a `no_account` en vez de servir lo que haya.
      const openAccts = accts.filter((a) => {
        const s = String(a?.status ?? "").toLowerCase();
        return s !== "closed" && s !== "archived";
      });
      const usable = openAccts.length > 0 ? openAccts : accts;
      if (usable.length < accts.length) {
        console.warn(
          `[snaptrade-history] ${accts.length - usable.length} cuenta(s) cerrada(s)/archivada(s) omitida(s)`,
        );
      }
      usableRows = usable;
      accountIds = usable.map((a) => a?.id ?? a?.account_id).filter((x): x is string => !!x);
    } catch (e) {
      console.warn("[snaptrade-history] listUserAccounts falló:", String(e).slice(0, 200));
    }
    if (accountIds.length === 0 && profile.snaptrade_account_id) {
      accountIds = [profile.snaptrade_account_id];
    }
    if (accountIds.length === 0) {
      // Nothing to query yet; let the frontend show the placeholder.
      const payload = { updatedAt: new Date().toISOString(), available: false, reason: "no_account", history: [] };
      await admin.from("profiles").update({ snaptrade_history: payload }).eq("id", userId);
      return jsonResponse(req, { history: [], available: false, reason: "no_account", terminal: false });
    }

    // ── Experimental endpoint — everything below is graceful on failure ──
    // En paralelo: en serie, N cuentas multiplican por N la latencia de una función que ya
    // llama a un endpoint experimental lento, y el usuario mira un esqueleto de gráfica
    // mientras tanto. Ninguna llamada depende de otra.
    let transient = 0;   // 429 / 5xx / red: reintentar SÍ puede cambiar el resultado
    const settled = await Promise.all(accountIds.map(async (accountId) => {
      try {
        const raw = (
          await st.accountInformation.getAccountBalanceHistory({ ...sid, accountId } as any)
        ).data;
        return normalize(raw);
      } catch (err: any) {
        const s = err?.response?.status ?? err?.status ?? 0;
        // Distinguir "el endpoint no está habilitado para esta cuenta" (permanente hasta
        // que SnapTrade lo active) de "ahora mismo no responde" (429, 5xx, timeout). Sin
        // esta separación un 429 puntual se marcaba `terminal` y el cliente dejaba de
        // pedir el historial el resto de la sesión por un fallo de un segundo.
        if (s === 429 || s >= 500 || s === 0) transient++;
        console.warn(`getAccountBalanceHistory unavailable (${accountId}) status=${s}:`, err?.message ?? String(err));
        return null;   // null = falló; [] = respondió pero sin datos
      }
    }));
    const failed = settled.filter((s) => s === null).length;
    const series = settled.map((s) => s ?? []);

    // ── Cada cuenta a la moneda de presentación, ANTES de sumarlas ──────────────────
    // getAccountBalanceHistory devuelve el saldo en la moneda BASE de esa cuenta. Sumar
    // euros con dólares da un número que no es dinero de ninguna moneda (ver la cabecera).
    // Sin `wantCcy`, sin monedas declaradas, o con una sola moneda en juego, no se toca nada
    // y el comportamiento es idéntico al de siempre.
    let seriesCcys: (string | null)[] = accountIds.map(() => null);
    if (usableRows.length) {
      const byId = new Map<string, any>();
      for (const a of usableRows) {
        const id = a?.id ?? a?.account_id;
        if (id) byId.set(String(id), a);
      }
      seriesCcys = accountIds.map((id) => {
        const a = byId.get(String(id));
        let c = a?.balance?.total?.currency ?? a?.balance?.currency ?? null;
        if (c && typeof c === "object") c = c.code ?? c.iso_code ?? null;
        return (typeof c === "string" && /^[A-Za-z]{3,5}$/.test(c)) ? c.toUpperCase() : null;
      });
    }
    // Cuentas que aportan datos y declaran moneda distinta de la pedida.
    const presentes = seriesCcys.filter((c, i) => !!c && series[i].length > 0) as string[];
    const necesitaFx = !!wantCcy && presentes.some((c) => c !== wantCcy);
    let noConvertibles = 0;
    if (necesitaFx) {
      const rates = await fxRatesFor(st, Array.from(new Set([wantCcy!, ...presentes])));
      for (let i = 0; i < series.length; i++) {
        const c = seriesCcys[i];
        if (!series[i].length || !c || c === wantCcy) continue;
        const r = Number(rates[c + wantCcy!]);
        if (Number.isFinite(r) && r > 0) {
          series[i] = series[i].map((p) => ({ date: p.date, value: p.value * r }));
        } else {
          // Sin cambio para esa moneda no se inventa uno: esa cuenta sale de la curva y la
          // ausencia se declara igual que la de una cuenta que no respondió. Una curva corta
          // y dicha es mejor que una curva que suma monedas distintas y calla.
          console.warn(`[snaptrade-history] sin tipo de cambio ${c}->${wantCcy}: la cuenta queda fuera de la curva`);
          series[i] = [];
          noConvertibles++;
        }
      }
    }

    const history = mergeSeries(series);
    const available = history.length > 1;   // un solo punto no dibuja una curva
    let reason: string | undefined;
    if (!available) reason = failed === accountIds.length ? "endpoint_disabled" : "empty";
    // Serie PARCIAL: hay curva, pero le falta al menos una cuenta → la suma está por
    // debajo del valor real de la cartera. Se avisa en vez de pintarla como completa.
    // Una cuenta descartada por falta de tipo de cambio cuenta igual: también falta.
    const partial = available && (failed > 0 || noConvertibles > 0);

    // ── ¿De QUIÉN son las cuentas que faltan? ──────────────────────────────────────
    // Con `partial` a secas el cliente dice "Falta al menos una de tus cuentas en esta
    // curva", que invita a reintentar. Si la cuenta ausente es de una conexión que nunca
    // va a entregar esa serie (IBKR: integración Balance Only), reintentar no puede
    // cambiar nada — no es un fallo transitorio, es una limitación permanente de esa
    // conexión. Nombrar al broker es la diferencia entre un usuario que espera algo que
    // no va a llegar y uno que entiende lo que tiene.
    //
    // Se devuelve `slug` además del nombre: el cliente decide comportamiento por slug
    // (estable por contrato) y pinta el nombre (texto comercial, puede cambiar).
    // La llamada extra sólo se hace cuando ya sabemos que falta algo: en el camino bueno
    // esta función no gasta ni una petición más de las que gastaba.
    let partialBrokers: { name: string | null; slug: string | null }[] = [];
    if (failed > 0 && usableRows.length) {
      const missing = new Set(accountIds.filter((_, i) => settled[i] === null));
      try {
        const conns = ((await st.connections.listBrokerageAuthorizations(sid)).data as any[]) ?? [];
        const byId = new Map(conns.map((c: any) => [c?.id, c]));
        const seen = new Set<string>();
        for (const a of usableRows) {
          const id = a?.id ?? a?.account_id;
          if (!id || !missing.has(id)) continue;
          const c: any = byId.get(a?.brokerage_authorization);
          const slug = c?.brokerage?.slug ?? null;
          const name = c?.brokerage?.display_name ?? c?.brokerage?.name ?? null;
          const key = String(slug ?? name ?? "");
          if (!key || seen.has(key)) continue;
          seen.add(key);
          partialBrokers.push({ name, slug });
        }
      } catch (e) {
        // Sin saber de quién es el hueco, se deja el aviso genérico de siempre. Nombrar
        // al broker equivocado sería peor que no nombrar a ninguno.
        console.warn("[snaptrade-history] listBrokerageAuthorizations falló:", String(e).slice(0, 200));
      }
    }

    // `terminal` = reintentar en esta sesión no puede cambiar la respuesta, así que el
    // cliente debe dejar de insistir. getAccountBalanceHistory es experimental y viene
    // DESHABILITADO por defecto: hay que pedirle a SnapTrade que lo active por cuenta.
    // Mientras no lo hagan, cada reintento es una llamada tirada a la basura y una
    // escritura en profiles. "empty" sí puede cambiar: la cuenta puede estar aún
    // sincronizando.
    const terminal = !available && reason === "endpoint_disabled" && transient === 0;

    // `terminal` se guarda calculado, no se recalcula al leer la caché: `transient` sólo
    // se conoce en el momento de la llamada, y sin él la caché convertía un 429 de hace
    // horas en un "no insistas" permanente.
    const payload = { updatedAt: new Date().toISOString(), available, reason, terminal, partial, partialBrokers,
                      accounts: accountIds.length, currency: wantCcy, noConvertibles, history };
    await admin.from("profiles").update({ snaptrade_history: payload }).eq("id", userId);

    return jsonResponse(req, { history, available, reason, terminal, partial, partialBrokers,
                               accounts: accountIds.length, currency: wantCcy, noConvertibles });
  } catch (e: any) {
    // Even on unexpected failure, never break the chart — return placeholder state.
    const message = e?.message ?? String(e);
    return jsonResponse(req, { history: [], available: false, reason: "error", error: message }, 200);
  }
});
