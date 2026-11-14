// finnhub-proxy — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Why: the browser used to call finnhub.io directly with the API key embedded in
// the HTML. That made the key public AND meant every one of N users burned the
// 60 req/min free quota individually. This function moves the key server-side and
// adds a SHARED Postgres cache so that N users requesting the same data only cost
// ONE upstream Finnhub call per TTL window. Result: the free tier scales to many
// users because Finnhub only ever sees a trickle of distinct, cache-missing calls.
//
// Client contract: GET  /functions/v1/finnhub-proxy?path=<url-encoded finnhub path>
//   e.g. path = "/quote?symbol=AAPL"  →  upstream "https://finnhub.io/api/v1/quote?symbol=AAPL&token=SECRET"
// The client never sends a token; the secret FINNHUB_KEY is read from the
// function's environment (set via `supabase secrets set`).
//
// Cache: table public.fh_cache(key text pk, data jsonb, fetched_at timestamptz).
// Service-role key (auto-injected by Supabase) bypasses RLS for reads/writes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FINNHUB_KEY = Deno.env.get("FINNHUB_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Per-endpoint cache lifetime (seconds). Tuned to how fast each datum changes vs
// how often the UI asks for it, so we minimise upstream calls without going stale.
function ttlFor(path: string): number {
  const p = path.toLowerCase();
  if (p.startsWith("/quote")) return 20;                 // live-ish price
  if (p.startsWith("/stock/candle")) return 300;          // intraday/historical bars
  if (p.startsWith("/company-news") || p.startsWith("/news")) return 600; // news feed
  if (p.startsWith("/calendar/earnings") || p.startsWith("/stock/earnings")) return 3600;
  if (p.startsWith("/stock/recommendation") || p.startsWith("/stock/price-target")) return 3600;
  if (p.startsWith("/stock/profile2") || p.startsWith("/stock/metric") || p.startsWith("/search")) return 86400; // ~static
  // Estados financieros reportados a la SEC (10-K/10-Q): cambian una vez por trimestre como
  // mucho, y la ficha sólo usa los anuales. Una semana de caché compartida basta y evita que
  // cada apertura de ficha cueste una llamada upstream (el payload pesa cientos de KB).
  if (p.startsWith("/stock/financials-reported")) return 7 * 86400;
  return 60;
}

// Cotizaciones en lote: lee la caché de todos los símbolos de una vez, pide a Finnhub sólo
// los que faltan o vencieron (en paralelo, acotado) y escribe las frescas en un solo upsert.
// Si Finnhub falla para un símbolo se sirve su dato vencido antes que nada.
async function quoteBatch(syms: string[]) {
  const ttl = ttlFor("/quote");
  const now = Date.now();
  const keyOf = (s: string) => `/quote?symbol=${s}`;
  const out: Record<string, unknown> = {};
  const stale: Record<string, unknown> = {};
  let missing: string[] = [];
  try {
    const { data: rows } = await db.from("fh_cache").select("key, data, fetched_at").in("key", syms.map(keyOf));
    const byKey = new Map<string, any>((rows ?? []).map((r: any) => [r.key, r]));
    for (const s of syms) {
      const r = byKey.get(keyOf(s));
      if (r && r.fetched_at && (now - new Date(r.fetched_at).getTime()) / 1000 < ttl) out[s] = r.data;
      else { missing.push(s); if (r) stale[s] = r.data; }
    }
  } catch (_e) {
    missing = syms.slice();
  }
  const fresh: { key: string; data: unknown; fetched_at: string }[] = [];
  let i = 0;
  const worker = async () => {
    while (i < missing.length) {
      const s = missing[i++];
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${FINNHUB_KEY}`);
        if (r.ok) {
          const d = await r.json().catch(() => null);
          if (d && typeof d.c === "number") {
            out[s] = d;
            fresh.push({ key: keyOf(s), data: d, fetched_at: new Date().toISOString() });
            continue;
          }
        }
      } catch (_e) { /* sigue con la caché vencida */ }
      if (s in stale) out[s] = stale[s];
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, missing.length) }, worker));
  if (fresh.length) {
    try { await db.from("fh_cache").upsert(fresh, { onConflict: "key" }); } catch (_e) { /* se devuelve igual */ }
  }
  return json({ quotes: out }, 200);
}

function json(body: unknown, status = 200, maxAge = 0) {
  const h: Record<string, string> = { ...CORS, "content-type": "application/json" };
  // Caché del navegador / WKWebView (privada: la petición lleva Authorization). Repetir la
  // misma ficha dentro de la ventana ya no cuesta invocación ni egress.
  if (status === 200 && maxAge > 0) h["cache-control"] = `private, max-age=${maxAge}`;
  return new Response(JSON.stringify(body), { status, headers: h });
}

// ── Recorte del payload (14 nov 2026) ─────────────────────────────────────────
// El plan gratis de Supabase incluye 5 GB de egress al mes. Finnhub devuelve mucho más de
// lo que lee index.html, así que se guarda y se sirve SOLO lo que la app usa. Se aplica al
// escribir en fh_cache y también al servir filas viejas (idempotente), así el ahorro es
// inmediato. Medido con AAPL, comprimido en el cable:
//   /stock/metric              70 KB → ~2 KB   (`series` = 98 % del peso; la app no lo lee)
//   /company-news (14 días)    60 KB → ~6 KB   (la app usa 14 noticias y 6 campos)
//   /stock/financials-reported 36/84 KB → ~1/3 (la app lee concept+value; muestra 6 años / 8 trim.)
// Si index.html empieza a leer un campo nuevo, añádelo aquí.
const NEWS_KEEP = 20;          // la app usa 14 (por acción) / 16 (generales)
const FIN_ANNUAL_KEEP = 10;    // la app muestra 6 años y compara con el anterior
const FIN_QUARTER_KEEP = 24;   // la app muestra 8 trimestres; T4 = 10-K − 9 meses
// deno-lint-ignore no-explicit-any
function shrink(path: string, payload: any): any {
  if (!payload || typeof payload !== "object") return payload;
  const p = path.toLowerCase();
  try {
    if (p.startsWith("/stock/metric")) {
      if (!("series" in payload)) return payload;
      const { series: _drop, ...rest } = payload;
      return rest;
    }
    if (p.startsWith("/company-news") || p.startsWith("/news")) {
      if (!Array.isArray(payload)) return payload;
      // deno-lint-ignore no-explicit-any
      return payload.slice(0, NEWS_KEEP).map((a: any) => ({
        id: a?.id, category: a?.category, datetime: a?.datetime, headline: a?.headline,
        image: a?.image, related: a?.related, source: a?.source, summary: a?.summary, url: a?.url,
      }));
    }
    if (p.startsWith("/stock/financials-reported") && Array.isArray(payload.data)) {
      const keep = /freq=quarterly/.test(p) ? FIN_QUARTER_KEEP : FIN_ANNUAL_KEEP;
      // deno-lint-ignore no-explicit-any
      const fin = (d: any) => Date.parse(String(d?.endDate || "").slice(0, 10)) || 0;
      // deno-lint-ignore no-explicit-any
      const lines = (arr: any) => Array.isArray(arr)
        // deno-lint-ignore no-explicit-any
        ? arr.map((f: any) => ({ concept: f?.concept, value: f?.value }))
        : arr;
      const data = payload.data.slice().sort((a: unknown, b: unknown) => fin(b) - fin(a)).slice(0, keep)
        // deno-lint-ignore no-explicit-any
        .map((d: any) => ({
          year: d.year, quarter: d.quarter, form: d.form, startDate: d.startDate, endDate: d.endDate,
          filedDate: d.filedDate,
          report: d.report ? { bs: lines(d.report.bs), ic: lines(d.report.ic), cf: lines(d.report.cf) } : d.report,
        }));
      return { cik: payload.cik, symbol: payload.symbol, data };
    }
  } catch (_e) { /* ante la duda, el original */ }
  return payload;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!FINNHUB_KEY) return json({ error: "FINNHUB_KEY not configured on server" }, 500);

  const url = new URL(req.url);
  let path = url.searchParams.get("path") ?? "";
  if (!path) return json({ error: "missing ?path" }, 400);
  if (!path.startsWith("/")) path = "/" + path;

  // ── Estimados guardados (no va a Finnhub): /portiv/estimates?symbol=X ──────
  // Lo que esperaban los analistas en cada trimestre, también de los ya reportados (Finnhub
  // los borra del calendario al poco de reportar). Lo llena captureEstimates, más abajo.
  if (/^\/portiv\/estimates\?/i.test(path)) {
    const sym = (new URLSearchParams(path.split("?")[1] ?? "").get("symbol") ?? "").toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) return json({ error: "bad symbol" }, 400);
    try {
      const { data, error } = await db.from("earnings_estimates")
        .select("year, quarter, report_date, eps_estimate, revenue_estimate")
        .eq("symbol", sym).order("year", { ascending: true }).order("quarter", { ascending: true }).limit(80);
      if (error) return json({ estimates: [] }, 200);
      return json({ estimates: data ?? [] }, 200);
    } catch (_e) {
      return json({ estimates: [] }, 200);
    }
  }

  // Hard allow-list of endpoints so the proxy can't be abused as an open relay.
  const allowed = [
    "/quote", "/stock/candle", "/company-news", "/news", "/calendar/earnings",
    "/stock/earnings", "/stock/recommendation", "/stock/price-target",
    "/stock/profile2", "/stock/metric", "/search",
    "/stock/financials-reported",   // Piotroski F-Score y Altman Z (ficha de la acción)
  ];
  if (!allowed.some((a) => path.toLowerCase().startsWith(a))) {
    return json({ error: "endpoint not allowed" }, 403);
  }

  // ── LOTE de cotizaciones: /quote?symbols=A,B,C ─────────────────────────────
  // Una invocación y UNA lectura de caché para toda la cartera. Las claves son las mismas
  // que usa el camino individual (/quote?symbol=X), así que ambos comparten la caché.
  if (/^\/quote\?/i.test(path)) {
    const symsParam = new URLSearchParams(path.split("?")[1] ?? "").get("symbols");
    if (symsParam) {
      const syms = Array.from(new Set(
        symsParam.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.\-]{1,12}$/.test(s)),
      )).slice(0, 60);
      if (!syms.length) return json({ error: "no symbols" }, 400);
      return await quoteBatch(syms);
    }
  }

  const cacheKey = path;
  const ttl = ttlFor(path);
  const now = Date.now();

  // 1) Try shared cache. A fresh row means we serve N users from ONE upstream call.
  try {
    const { data: row } = await db
      .from("fh_cache")
      .select("data, fetched_at")
      .eq("key", cacheKey)
      .maybeSingle();
    if (row && row.fetched_at) {
      const age = (now - new Date(row.fetched_at).getTime()) / 1000;
      if (age < ttl) {
        return json(shrink(path, row.data), 200, Math.max(1, Math.round(Math.min(ttl - age, ttl))));
      }
    }
  } catch (_e) { /* cache read failed → fall through to upstream */ }

  // 2) Cache miss/stale → call Finnhub once with the server-side secret key.
  const sep = path.includes("?") ? "&" : "?";
  const upstream = `https://finnhub.io/api/v1${path}${sep}token=${FINNHUB_KEY}`;
  let fhRes: Response;
  try {
    fhRes = await fetch(upstream);
  } catch (_e) {
    return json({ error: "upstream fetch failed" }, 502);
  }

  if (fhRes.status === 429) {
    // Upstream rate-limited: serve stale cache if we have any, else surface 429.
    try {
      const { data: row } = await db.from("fh_cache").select("data").eq("key", cacheKey).maybeSingle();
      if (row) return json(shrink(path, row.data), 200);
    } catch (_e) { /* ignore */ }
    return json({ error: "rate limited" }, 429);
  }
  if (!fhRes.ok) return json({ error: `upstream ${fhRes.status}` }, fhRes.status);

  const raw = await fhRes.json().catch(() => null);
  if (raw === null) return json({ error: "bad upstream json" }, 502);
  // El calendario guarda sus estimados con el payload completo; lo demás se recorta ya.
  const payload = shrink(path, raw);

  // 3) Write-through cache for the next callers in this TTL window.
  try {
    await db.from("fh_cache").upsert(
      { key: cacheKey, data: payload, fetched_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch (_e) { /* cache write failed → still return the fresh data */ }

  // 4) Calendario de resultados: se guardan los estimados de los trimestres aún sin reportar.
  if (/^\/calendar\/earnings/i.test(path)) {
    const job = captureEstimates(payload).catch(() => {});
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === "function") rt.waitUntil(job); else await job;
  }

  return json(payload, 200, ttl);
});

// Guarda en public.earnings_estimates cada fila del calendario SIN resultado todavía: el
// último estimado antes del reporte es el que queda. Una fila con resultado no se toca (su
// estimado ya es el de antes del reporte). Una llamada del calendario semanal trae cientos
// de empresas: van en lotes de 500 en un solo upsert cada uno.
// deno-lint-ignore no-explicit-any
async function captureEstimates(payload: any) {
  const rows = Array.isArray(payload?.earningsCalendar) ? payload.earningsCalendar : [];
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (!r || typeof r.symbol !== "string" || !r.year || !r.quarter) continue;
    if (r.epsActual != null || r.revenueActual != null) continue;
    const eps = typeof r.epsEstimate === "number" && isFinite(r.epsEstimate) ? r.epsEstimate : null;
    const rev = typeof r.revenueEstimate === "number" && isFinite(r.revenueEstimate) && r.revenueEstimate > 0 ? r.revenueEstimate : null;
    if (eps == null && rev == null) continue;
    const symbol = r.symbol.toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) continue;
    const k = `${symbol}|${r.year}|${r.quarter}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      symbol, year: +r.year, quarter: +r.quarter,
      report_date: /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "") ? r.date : null,
      eps_estimate: eps, revenue_estimate: rev, updated_at: now,
    });
  }
  for (let i = 0; i < out.length; i += 500) {
    await db.from("earnings_estimates").upsert(out.slice(i, i + 500), { onConflict: "symbol,year,quarter" });
  }
}
