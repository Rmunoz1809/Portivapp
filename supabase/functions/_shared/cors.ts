// Shared CORS helper for Portiv Edge Functions.
// Allowlist: production domain + Capacitor native origins + local dev.
// Reflects the request Origin when allowed; otherwise falls back to the prod domain.

const STATIC_ALLOW = new Set<string>([
  "https://portivapp.com",
  "https://www.portivapp.com",
  "capacitor://localhost", // iOS Capacitor
  "ionic://localhost", // iOS (older / Ionic)
  "https://localhost", // Android Capacitor
  "http://localhost", // Android Capacitor (cleartext)
]);

function originAllowed(origin: string): boolean {
  if (!origin) return false;
  if (STATIC_ALLOW.has(origin)) return true;
  // Any localhost / 127.0.0.1 dev port (vite, live-server, capacitor serve, etc.)
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = originAllowed(origin) ? origin : "https://portivapp.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "content-type": "application/json" },
  });
}

export function preflight(req: Request): Response {
  return new Response("ok", { headers: corsHeaders(req) });
}
