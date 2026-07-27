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
  return 60;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!FINNHUB_KEY) return json({ error: "FINNHUB_KEY not configured on server" }, 500);

  const url = new URL(req.url);
  let path = url.searchParams.get("path") ?? "";
  if (!path) return json({ error: "missing ?path" }, 400);
  if (!path.startsWith("/")) path = "/" + path;

  // Hard allow-list of endpoints so the proxy can't be abused as an open relay.
  const allowed = [
    "/quote", "/stock/candle", "/company-news", "/news", "/calendar/earnings",
    "/stock/earnings", "/stock/recommendation", "/stock/price-target",
    "/stock/profile2", "/stock/metric", "/search",
  ];
  if (!allowed.some((a) => path.toLowerCase().startsWith(a))) {
    return json({ error: "endpoint not allowed" }, 403);
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
        return json(row.data, 200);
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
      if (row) return json(row.data, 200);
    } catch (_e) { /* ignore */ }
    return json({ error: "rate limited" }, 429);
  }
  if (!fhRes.ok) return json({ error: `upstream ${fhRes.status}` }, fhRes.status);

  const payload = await fhRes.json().catch(() => null);
  if (payload === null) return json({ error: "bad upstream json" }, 502);

  // 3) Write-through cache for the next callers in this TTL window.
  try {
    await db.from("fh_cache").upsert(
      { key: cacheKey, data: payload, fetched_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch (_e) { /* cache write failed → still return the fresh data */ }

  return json(payload, 200);
});
