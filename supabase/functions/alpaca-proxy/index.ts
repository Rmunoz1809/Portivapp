// alpaca-proxy — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Why: Portiv necesita series históricas de precios con licencia comercial. Yahoo
// se retiró (App Review 5C, fuente sin licencia) y /stock/candle de Finnhub exige
// plan de pago (403 en el plan actual), así que la gráfica "Precio Histórico" se
// quedó sin fuente. Alpaca Markets sí permite uso comercial en su tier gratuito
// (feed IEX), pero la SECRET KEY da acceso a la cuenta completa: jamás puede vivir
// en el bundle del navegador. Esta función la mantiene server-side.
//
// Contrato con el cliente:
//   GET /functions/v1/alpaca-proxy?path=<path url-encoded de la Market Data API>
//   ej. path = "/v2/stocks/bars?symbols=AAPL&timeframe=1Day&start=2026-01-01"
//        →  upstream "https://data.alpaca.markets/v2/stocks/bars?..." con headers
//           APCA-API-KEY-ID / APCA-API-SECRET-KEY inyectados aquí.
// El cliente nunca ve ninguna credencial.
//
// Caché: reusa la tabla public.fh_cache (key text pk, data jsonb, fetched_at
// timestamptz) que ya usa finnhub-proxy, con las claves prefijadas "alpaca:" para
// no colisionar. No hace falta migración nueva. N usuarios pidiendo la misma serie
// cuestan UNA sola llamada upstream por ventana de TTL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Los secrets se guardaron con guiones (igual que los headers de Alpaca). Algunos
// entornos normalizan a guión bajo, así que se aceptan las dos formas: si un día se
// re-suben como APCA_API_KEY_ID la función sigue funcionando sin tocar nada.
const KEY_ID = Deno.env.get("APCA-API-KEY-ID") ?? Deno.env.get("APCA_API_KEY_ID") ?? "";
const KEY_SECRET = Deno.env.get("APCA-API-SECRET-KEY") ?? Deno.env.get("APCA_API_SECRET_KEY") ?? "";
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

// TTL por granularidad: las barras diarias sólo cambian al cierre, las intradía cada
// pocos minutos. Ajustado a qué tan rápido cambia el dato, no a qué tan seguido lo pide la UI.
function ttlFor(path: string): number {
  const p = path.toLowerCase();
  if (p.includes("timeframe=1day")) return 6 * 3600;   // cierre diario → 6 h
  if (p.includes("timeframe=1week")) return 12 * 3600;
  if (p.includes("timeframe=1month")) return 24 * 3600;
  if (p.includes("min")) return 300;                    // 5Min / 30Min → 5 min
  return 900;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

// ── Auth: sólo usuarios con sesión ───────────────────────────────────────────
// Esta función estaba desplegada SIN ninguna verificación: bastaba conocer la URL para
// gastar nuestra cuota de market data de Alpaca y nuestro egress de Supabase. La anon
// key no sirve como credencial — viaja en el bundle público (index.html:32) — así que
// se exige un JWT de usuario y se valida contra auth.getUser().
async function isAuthedUser(req: Request): Promise<boolean> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  // La anon key es un JWT válido con rol `anon`: getUser() la rechaza (no hay `sub` de
  // usuario), así que no hace falta filtrarla aparte.
  if (!token) return false;
  try {
    const { data, error } = await db.auth.getUser(token);
    return !error && !!data?.user;
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!(await isAuthedUser(req))) return json({ error: "unauthorized" }, 401);

  if (!KEY_ID || !KEY_SECRET) {
    return json({ error: "APCA-API-KEY-ID / APCA-API-SECRET-KEY no configuradas en el servidor" }, 500);
  }

  const url = new URL(req.url);
  let path = url.searchParams.get("path") ?? "";
  if (!path) return json({ error: "missing ?path" }, 400);
  if (!path.startsWith("/")) path = "/" + path;

  // Allow-list dura: sólo lectura de market data. La misma credencial puede operar en
  // la cuenta de trading, así que el proxy NUNCA debe poder relevar /v2/orders y demás.
  const allowed = ["/v2/stocks/bars", "/v2/stocks/snapshots", "/v2/stocks/quotes/latest"];
  if (!allowed.some((a) => path.toLowerCase().startsWith(a))) {
    return json({ error: "endpoint not allowed" }, 403);
  }

  const cacheKey = "alpaca:" + path;
  const ttl = ttlFor(path);
  const now = Date.now();

  // 1) Caché compartida: N usuarios con la misma serie → UNA llamada upstream.
  try {
    const { data: row } = await db
      .from("fh_cache")
      .select("data, fetched_at")
      .eq("key", cacheKey)
      .maybeSingle();
    if (row && row.fetched_at) {
      const age = (now - new Date(row.fetched_at).getTime()) / 1000;
      if (age < ttl) return json(row.data, 200);
    }
  } catch (_e) { /* fallo de caché → seguimos a upstream */ }

  // 2) Miss o vencida → una llamada a Alpaca con las credenciales del servidor.
  const upstream = `https://data.alpaca.markets${path}`;
  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: {
        "APCA-API-KEY-ID": KEY_ID,
        "APCA-API-SECRET-KEY": KEY_SECRET,
        "accept": "application/json",
      },
    });
  } catch (_e) {
    return json({ error: "upstream fetch failed" }, 502);
  }

  if (res.status === 429) {
    // Rate limit de Alpaca: servimos caché vencida antes que romper la gráfica.
    try {
      const { data: row } = await db.from("fh_cache").select("data").eq("key", cacheKey).maybeSingle();
      if (row) return json(row.data, 200);
    } catch (_e) { /* ignore */ }
    return json({ error: "rate limited" }, 429);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return json({ error: `upstream ${res.status}`, detail: body.slice(0, 300) }, res.status);
  }

  const payload = await res.json().catch(() => null);
  if (payload === null) return json({ error: "bad upstream json" }, 502);

  // 3) Write-through para los siguientes en esta ventana de TTL.
  try {
    await db.from("fh_cache").upsert(
      { key: cacheKey, data: payload, fetched_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch (_e) { /* si falla la escritura igual devolvemos el dato fresco */ }

  return json(payload, 200);
});
