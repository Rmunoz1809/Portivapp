// sec-proxy — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Why: la cobertura de intereses de la ficha (EBIT ÷ gasto por intereses del último 10-K)
// sale de /stock/financials-reported de Finnhub, que solo trae los estados financieros. Muchas
// empresas no separan el gasto por intereses en el estado de resultados y lo dejan en las
// NOTAS —Microsoft: $3,051 M en FY2026, 50.9× con su EBIT de $155,237 M—, y ahí Finnhub no
// llega. La API XBRL de la SEC (data.sec.gov) sí lo tiene, pero no admite CORS y exige un
// User-Agent con contacto: esta función la consulta desde el servidor.
//
// Client contract: GET /functions/v1/sec-proxy?symbol=MSFT
//   → { symbol, cik, entity, interestExpense: [{ tag, val, start, end, form, filed, accn }, …] }
//   Una cifra por ejercicio anual (10-K), en USD, de la más reciente a la más antigua (5 como
//   mucho). El cliente usa la que cierra en la misma fecha que su 10-K de Finnhub, para que
//   EBIT y gasto sean del mismo ejercicio. Ticker que la SEC no conoce → cik null y lista vacía.
// Se despliega como finnhub-proxy, con verificación de JWT: basta la anon key del bundle.
//
// Caché: reusa public.fh_cache (como alpaca-proxy) con claves "sec:". Siete días por símbolo,
// igual que financials-reported en finnhub-proxy; el «no hay dato» también se guarda, para no
// volver a la SEC en cada apertura de una empresa que no reporta intereses. El mapa
// ticker → CIK (company_tickers.json, ~800 KB) se guarda compacto en "sec:tickers".
//
// SEC (https://www.sec.gov/os/accessing-edgar-data): como mucho 10 peticiones/s por IP y
// User-Agent declarado. Un miss cuesta 4 peticiones (una por tag) y, como mucho una vez por
// semana, la del mapa de tickers. Aquí se espacian a ~9/s y se limita cuántos miss puede
// provocar cada IP por hora.
// La lógica de la SEC vive en sec.ts (pura, se prueba en Node con datos reales).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cikFor, secInterest, tickerMap } from "./sec.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// La SEC pide «Empresa contacto@dominio». Por defecto, el correo de soporte que publica
// portivapp.com; el secret SEC_USER_AGENT lo cambia sin tocar el código.
const SEC_UA = Deno.env.get("SEC_USER_AGENT") ?? "Portiv rm@portivapp.com";

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const TTL_S = 7 * 86400;           // un 10-K se presenta una vez al año
const TICKERS_TTL_S = 7 * 86400;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function cacheGet(key: string): Promise<{ data: any; age: number } | null> {
  try {
    const { data: row } = await db.from("fh_cache").select("data, fetched_at").eq("key", key).maybeSingle();
    if (row && row.fetched_at) return { data: row.data, age: (Date.now() - new Date(row.fetched_at).getTime()) / 1000 };
  } catch (_e) { /* fallo de caché → upstream */ }
  return null;
}

async function cachePut(key: string, data: unknown) {
  try {
    await db.from("fh_cache").upsert(
      { key, data, fetched_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch (_e) { /* si falla la escritura igual devolvemos el dato fresco */ }
}

// Peticiones a la SEC espaciadas ≥110 ms dentro del isolate (≈9/s, bajo el tope de 10/s).
let _nextSlot = 0;
async function secGet(url: string): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, _nextSlot - now);
  _nextSlot = Math.max(now, _nextSlot) + 110;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  return fetch(url, {
    headers: { "User-Agent": SEC_UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
}

// Mapa ticker → CIK: memoria del isolate, luego fh_cache y, si venció, la SEC.
let _tickers: { at: number; map: Record<string, number> } | null = null;
async function tickers(): Promise<Record<string, number>> {
  if (_tickers && Date.now() - _tickers.at < TICKERS_TTL_S * 1000) return _tickers.map;
  const hit = await cacheGet("sec:tickers");
  if (hit && hit.age < TICKERS_TTL_S && hit.data && typeof hit.data === "object") {
    _tickers = { at: Date.now() - hit.age * 1000, map: hit.data };
    return hit.data;
  }
  let map: Record<string, number> = {};
  try {
    const r = await secGet("https://www.sec.gov/files/company_tickers.json");
    if (r.ok) map = tickerMap(await r.json());
    else await r.body?.cancel();
  } catch (_e) { /* abajo: el vencido antes que nada */ }
  if (Object.keys(map).length < 1000) {          // respuesta rota o recortada: no se guarda
    if (hit?.data && typeof hit.data === "object") return hit.data;
    throw new Error("sec tickers unavailable");
  }
  _tickers = { at: Date.now(), map };
  await cachePut("sec:tickers", map);
  return map;
}

// Presupuesto de miss por IP (en memoria del isolate, como alpaca-proxy): los hits de caché
// salen gratis; recorrer todos los tickers de golpe no puede tumbar nuestro acceso a la SEC.
const MAX_MISSES_PER_HOUR = 60;
const _misses = new Map<string, { n: number; reset: number }>();
function missBudgetOk(ip: string): boolean {
  const now = Date.now();
  const cur = _misses.get(ip);
  if (!cur || now > cur.reset) {
    if (_misses.size > 5000) _misses.clear();       // techo de memoria del isolate
    _misses.set(ip, { n: 1, reset: now + 3600_000 });
    return true;
  }
  cur.n++;
  return cur.n <= MAX_MISSES_PER_HOUR;
}

function clientIp(req: Request): string {
  const f = req.headers.get("x-forwarded-for") ?? "";
  return (f.split(",")[0] || req.headers.get("cf-connecting-ip") || "?").trim();
}

// Single-flight: varios miss simultáneos del mismo símbolo esperan UNA consulta a la SEC.
const inflight = new Map<string, Promise<unknown>>();
async function build(symbol: string): Promise<unknown> {
  const cik = cikFor(await tickers(), symbol);
  const payload = cik == null
    ? { symbol, cik: null, entity: "", interestExpense: [] }
    : { symbol, ...(await secInterest(cik, secGet)) };
  await cachePut("sec:interest:" + symbol, payload);
  return payload;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase().trim();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return json({ error: "bad symbol" }, 400);

  // 1) Caché compartida: N usuarios con el mismo símbolo → UNA consulta a la SEC por semana.
  const hit = await cacheGet("sec:interest:" + symbol);
  if (hit && hit.age < TTL_S) return json(hit.data, 200);

  // 2) Miss o vencida → SEC, dentro del presupuesto de la IP.
  if (!inflight.has(symbol) && !missBudgetOk(clientIp(req))) {
    if (hit) return json(hit.data, 200);
    return json({ error: "rate limited" }, 429);
  }
  let p = inflight.get(symbol);
  if (!p) {
    p = build(symbol).finally(() => inflight.delete(symbol));
    inflight.set(symbol, p);
  }
  try {
    return json(await p, 200);
  } catch (e) {
    // SEC caída, 403/429 o timeout: el dato vencido antes que nada.
    if (hit) return json(hit.data, 200);
    return json({ error: "upstream failed", detail: String((e as Error)?.message || e).slice(0, 200) }, 502);
  }
});
