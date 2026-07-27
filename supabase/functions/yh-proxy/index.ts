// yh-proxy — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Why: the chart / historical-price path used to reach Yahoo Finance through
// public CORS proxies (corsproxy.io, allorigins, codetabs, thingproxy). Those are
// now all dead or blocked (403 / 13-19s hangs), so the chart never got real data
// and stayed on the synthetic "estimado" series. This function is a SERVER-SIDE
// passthrough we control: the browser calls it (no CORS problem), it fetches the
// Yahoo URL with a browser User-Agent, and returns the JSON. Host is hard
// allow-listed to Yahoo so it can't be abused as an open relay.
//
// Client contract: GET /functions/v1/yh-proxy?url=<url-encoded yahoo url>
//   e.g. url = https://query1.finance.yahoo.com/v8/finance/chart/AMD?range=1mo&interval=1d
// No secret needed (Yahoo public endpoints). CORS open so the browser can read it.
//
// Response header `x-cache: hit|miss|coalesced` (exposed) mirrors finnhub-proxy so
// the client can measure hit-rate. This proxy's cache is per-INSTANCE memory only
// (Yahoo data is shareable, but a shared table isn't worth the write cost here —
// see SCALE_NOTES for the optional upgrade). Single-flight still collapses the
// burst of identical requests that lands on one warm instance.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-cache",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", ...extra },
  });
}

// Only Yahoo Finance query hosts, and only the chart/search/quote read endpoints.
const ALLOWED_HOSTS = new Set([
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
]);
const ALLOWED_PATHS = ["/v8/finance/chart/", "/v1/finance/search", "/v7/finance/quote", "/v10/finance/quoteSummary"];

// ── Server-side payload trimming ─────────────────────────────────────────────
// Yahoo returns far more than the client reads. We parse and re-emit ONLY the
// fields _yhChart / _yhNews consume (index.html) — this is the primary egress cut
// (2y daily chart drops open/high/low/volume + a fat meta block). Shapes MUST stay
// byte-compatible with those two readers or the app breaks.
const round4 = (v: unknown) =>
  (typeof v === "number" && isFinite(v)) ? Math.round(v * 10000) / 10000 : null;

// _yhChart reads: result[0].meta.{regularMarketPrice,previousClose,chartPreviousClose,
// fiftyTwoWeekHigh,fiftyTwoWeekLow}, result[0].timestamp, and
// indicators.adjclose[0].adjclose (preferred) | indicators.quote[0].close (fallback).
// symbol/regularMarketTime kept for identity (cheap, future-proof) though unread today.
function trimChart(raw: string): string {
  let j: any;
  try { j = JSON.parse(raw); } catch { return raw; }
  const r0 = j?.chart?.result?.[0];
  if (!r0) return raw; // error / no-data body is already tiny — pass through untouched
  const m = r0.meta || {};
  const meta = {
    regularMarketPrice: m.regularMarketPrice,
    previousClose: m.previousClose,
    chartPreviousClose: m.chartPreviousClose,
    regularMarketTime: m.regularMarketTime,
    symbol: m.symbol,
    fiftyTwoWeekHigh: m.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: m.fiftyTwoWeekLow,
  };
  const ind = r0.indicators || {};
  const adj = ind?.adjclose?.[0]?.adjclose;
  const cls = ind?.quote?.[0]?.close;
  const indicators: Record<string, unknown> = {};
  if (Array.isArray(adj)) indicators.adjclose = [{ adjclose: adj.map(round4) }];
  if (Array.isArray(cls)) indicators.quote = [{ close: cls.map(round4) }];
  return JSON.stringify({ chart: { result: [{ meta, timestamp: r0.timestamp || [], indicators }] } });
}

// _yhNews reads: news[].{title,publisher,link,summary,thumbnail.resolutions[0].url,
// providerPublishTime,relatedTickers}. Drop quotes/nav/lists and every other field.
function trimSearch(raw: string): string {
  let j: any;
  try { j = JSON.parse(raw); } catch { return raw; }
  const news = Array.isArray(j?.news) ? j.news : [];
  const out = news.map((a: any) => ({
    title: a?.title || "",
    publisher: a?.publisher || "",
    link: a?.link || "",
    summary: a?.summary || "",
    thumbnail: { resolutions: [{ url: a?.thumbnail?.resolutions?.[0]?.url || "" }] },
    providerPublishTime: a?.providerPublishTime || 0,
    relatedTickers: Array.isArray(a?.relatedTickers) ? a.relatedTickers : [],
  }));
  return JSON.stringify({ news: out });
}

function trimForPath(pathname: string, body: string): string {
  if (pathname.startsWith("/v8/finance/chart/")) return trimChart(body);
  if (pathname.startsWith("/v1/finance/search")) return trimSearch(body);
  return body; // quote / quoteSummary: unmodified passthrough
}

// Browser (and any shared CDN) cache window per endpoint. Chart's last daily bar
// only moves intraday and 5m bars don't change within 5 min → 60s is safe; news → 5 min.
function cacheControlFor(pathname: string): string {
  if (pathname.startsWith("/v8/finance/chart/")) return "public, max-age=60, s-maxage=60";
  if (pathname.startsWith("/v1/finance/search")) return "public, max-age=300, s-maxage=300";
  return "no-store";
}

// Small per-instance memory cache to soften repeated identical hits (best effort;
// instances are ephemeral). Real repeat-load speed comes from the client's
// localStorage cache — this just protects Yahoo from bursts within one instance.
const mem = new Map<string, { at: number; body: string; status: number; ct: string }>();
const MEM_TTL_MS = 20_000;

// Single-flight: concurrent misses for the same URL await one upstream fetch.
type YResult = { status: number; body: string; ct: string; xcache: string };
const inflight = new Map<string, Promise<YResult>>();

async function fetchYahoo(key: string, u: URL): Promise<YResult> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(u.toString(), {
      signal: ctrl.signal,
      headers: {
        // Yahoo rejects non-browser agents / needs an Accept; mimic a real browser.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
      },
    });
    clearTimeout(tid);
    let body = await r.text();
    const ct = r.headers.get("content-type") || "application/json";
    // Trim to the client-read fields, then cache only successful responses (so the
    // per-instance mem cache also serves the small body, not the raw Yahoo blob).
    if (r.ok) {
      body = trimForPath(u.pathname, body);
      mem.set(key, { at: Date.now(), body, status: 200, ct });
    }
    return { status: r.status, body, ct, xcache: "miss" };
  } catch (e) {
    clearTimeout(tid);
    return {
      status: 502,
      body: JSON.stringify({ error: "upstream fetch failed", detail: String((e as Error)?.message || e) }),
      ct: "application/json",
      xcache: "miss",
    };
  }
}

function coalescedY(key: string, u: URL): Promise<YResult> {
  const existing = inflight.get(key);
  if (existing) return existing.then((r) => ({ ...r, xcache: "coalesced" }));
  const p = fetchYahoo(key, u).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const reqUrl = new URL(req.url);
  const target = reqUrl.searchParams.get("url") ?? "";
  if (!target) return json({ error: "missing ?url" }, 400);

  let u: URL;
  try { u = new URL(target); } catch { return json({ error: "bad url" }, 400); }
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) {
    return json({ error: "host not allowed" }, 403);
  }
  if (!ALLOWED_PATHS.some((p) => u.pathname.startsWith(p))) {
    return json({ error: "endpoint not allowed" }, 403);
  }

  const key = u.toString();
  const cc = cacheControlFor(u.pathname);
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < MEM_TTL_MS) {
    return new Response(hit.body, { status: hit.status, headers: { ...CORS, "content-type": hit.ct, "x-cache": "hit", "Cache-Control": cc } });
  }

  const result = await coalescedY(key, u);
  const ok2xx = result.status >= 200 && result.status < 300;
  return new Response(result.body, {
    status: result.status,
    headers: { ...CORS, "content-type": result.ct, "x-cache": result.xcache, "Cache-Control": ok2xx ? cc : "no-store" },
  });
});
