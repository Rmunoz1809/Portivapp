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

// ── Auth: usuario con sesión, o anon key con permisos recortados ─────────────
// Portiv se puede usar SIN cuenta (cartera de ejemplo en la web, primer arranque de la
// app), y esas sesiones también dibujan gráficas. Exigir un JWT de usuario para TODO
// dejaba a esos visitantes sin ninguna vela: la reconstrucción intradía (gráfica 1D
// 09:30→ahora) y la diaria nunca recibían dato y la curva caía al plan B de snapshots
// locales, que sólo tiene puntos desde que se abrió el app.
//   · tier "user"  → JWT de usuario válido. Acceso a toda la allow-list.
//   · tier "anon"  → la anon key (pública, viaja en el bundle). SÓLO /v2/stocks/bars,
//                    con tope de símbolos y presupuesto de llamadas upstream por IP.
//   · null         → sin credencial: 401.
// La anon key es pública (viaja en el bundle) pero aquí hace de credencial de tier, así
// que tiene que compararse contra un valor del servidor. `SUPABASE_ANON_KEY` no está
// inyectada en este proyecto → se guarda además como secret PV_ANON_KEY. Rotarla obliga
// a actualizar el secret junto con window.PV_SB_ANON del index.html.
const ANON_KEYS = new Set(
  [Deno.env.get("SUPABASE_ANON_KEY"), Deno.env.get("PV_ANON_KEY")]
    .map((k) => (k ?? "").trim()).filter(Boolean),
);

function bearer(req: Request): string {
  return (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

async function authTier(req: Request): Promise<"user" | "anon" | null> {
  const token = bearer(req);
  if (!token) return null;
  // La anon key es un JWT válido con rol `anon`: getUser() la rechaza, así que se
  // compara antes por igualdad exacta contra el secret del proyecto.
  if (ANON_KEYS.has(token)) return "anon";
  try {
    const { data, error } = await db.auth.getUser(token);
    if (!error && data?.user) return "user";
  } catch { /* token ilegible → sin tier */ }
  return null;
}

// ── Presupuesto de llamadas upstream para el tier anon ───────────────────────
// En memoria del isolate (sin filas nuevas en la base): no es infalible si Supabase
// levanta varias instancias, pero corta en seco el martilleo trivial contra nuestra
// cuota de Alpaca. Sólo cuentan los MISS de caché — un hit no cuesta upstream.
const ANON_MAX_UPSTREAM_PER_HOUR = 120;
const ANON_MAX_SYMBOLS = 40;
const _anonHits = new Map<string, { n: number; reset: number }>();

function anonBudgetOk(ip: string): boolean {
  const now = Date.now();
  const cur = _anonHits.get(ip);
  if (!cur || now > cur.reset) {
    if (_anonHits.size > 5000) _anonHits.clear();       // techo de memoria del isolate
    _anonHits.set(ip, { n: 1, reset: now + 3600_000 });
    return true;
  }
  cur.n++;
  return cur.n <= ANON_MAX_UPSTREAM_PER_HOUR;
}

function clientIp(req: Request): string {
  const f = req.headers.get("x-forwarded-for") ?? "";
  return (f.split(",")[0] || req.headers.get("cf-connecting-ip") || "?").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const tier = await authTier(req);
  if (!tier) return json({ error: "unauthorized" }, 401);

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

  // Recorte del tier anon: sólo velas, y con un tope de símbolos por petición para que
  // nadie pueda pedir el mercado entero de una sentada con una key pública.
  if (tier === "anon") {
    if (!path.toLowerCase().startsWith("/v2/stocks/bars")) {
      return json({ error: "sign in required for this endpoint" }, 403);
    }
    const syms = (new URLSearchParams(path.split("?")[1] ?? "").get("symbols") ?? "")
      .split(",").map((x) => x.trim()).filter(Boolean);
    if (syms.length > ANON_MAX_SYMBOLS) {
      return json({ error: "too many symbols" }, 400);
    }
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
  //    El tier anon gasta presupuesto SÓLO aquí: los hits de caché salen gratis.
  if (tier === "anon" && !anonBudgetOk(clientIp(req))) {
    try {
      const { data: row } = await db.from("fh_cache").select("data").eq("key", cacheKey).maybeSingle();
      if (row) return json(row.data, 200);               // caché vencida antes que romper la gráfica
    } catch (_e) { /* ignore */ }
    return json({ error: "rate limited" }, 429);
  }
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
