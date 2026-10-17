// app-handoff — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Traspaso de sesión WEB → APP. En portivapp.com no se cobra: el muro manda a la app. Para
// que el usuario no tenga que volver a iniciar sesión, la web pide un código de un solo uso
// y abre portiv://handoff?code=…; la app lo canjea aquí y recibe un token de magic link con
// el que crea su propia sesión (sb.auth.verifyOtp). Después abre el muro de Portiv Pro.
//
//   POST { action: 'create' }            Authorization: Bearer <JWT del usuario en la web>
//        → { code }                       (válido 10 min, un solo uso)
//        También marca app_metadata.pv_paywall_intent_at: si el usuario instala la app y
//        entra a mano, la app sabe que venía a suscribirse y le enseña el muro una vez.
//   POST { action: 'redeem', code }      (sin JWT: la app aún no tiene sesión)
//        → { token_hash, email }          para verifyOtp({ token_hash, type: 'magiclink' })
//
// Seguridad: el código es <uid>.<32 bytes aleatorios>; en el servidor sólo se guarda su
// SHA-256 en app_metadata (el cliente no puede escribir app_metadata). Se invalida ANTES de
// emitir el token, caduca a los 10 min y la comparación es en tiempo constante. generateLink
// no envía ningún correo.
//
// Deploy: supabase functions deploy app-handoff --no-verify-jwt
//         (el JWT de 'create' se valida aquí dentro; 'redeem' no lleva sesión)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { preflight, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const TTL_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const log = (...a: unknown[]) => console.log("[app-handoff]", ...a);

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return jsonResponse(req, { error: "bad_request" }, 400); }
  const action = String(body?.action ?? "");

  // ── create: la web (con sesión) pide un código ──
  if (action === "create") {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return jsonResponse(req, { error: "unauthorized" }, 401);
    const { data: u, error } = await admin.auth.getUser(jwt);
    const user = u?.user;
    if (error || !user?.id) return jsonResponse(req, { error: "unauthorized" }, 401);
    if (!user.email) return jsonResponse(req, { error: "no_email" }, 422);

    const code = `${user.id}.${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const now = Date.now();
    const am = { ...(user.app_metadata ?? {}) };
    am.pv_handoff = { h: await sha256(code), exp: now + TTL_MS };
    am.pv_paywall_intent_at = new Date(now).toISOString();
    const { error: uErr } = await admin.auth.admin.updateUserById(user.id, { app_metadata: am });
    if (uErr) { log("create update failed", user.id, uErr.message); return jsonResponse(req, { error: "server_error" }, 500); }
    return jsonResponse(req, { code, expires_in: TTL_MS / 1000 });
  }

  // ── redeem: la app (sin sesión) canjea el código ──
  if (action === "redeem") {
    const code = String(body?.code ?? "");
    const uid = code.split(".")[0] ?? "";
    if (!UUID_RE.test(uid) || code.length < 60 || code.length > 120) {
      return jsonResponse(req, { error: "invalid_code" }, 400);
    }
    const { data: g, error: gErr } = await admin.auth.admin.getUserById(uid);
    const user = g?.user;
    if (gErr || !user) return jsonResponse(req, { error: "invalid_code" }, 400);
    const am = { ...(user.app_metadata ?? {}) };
    const ho = am.pv_handoff as { h?: string; exp?: number } | null | undefined;
    if (!ho?.h || !ho?.exp) return jsonResponse(req, { error: "invalid_code" }, 400);
    if (Date.now() > ho.exp) return jsonResponse(req, { error: "expired_code" }, 410);
    if (!safeEqual(await sha256(code), ho.h)) return jsonResponse(req, { error: "invalid_code" }, 400);

    // Un solo uso: se invalida ANTES de emitir el token.
    am.pv_handoff = null;
    const { error: cErr } = await admin.auth.admin.updateUserById(uid, { app_metadata: am });
    if (cErr) { log("redeem clear failed", uid, cErr.message); return jsonResponse(req, { error: "server_error" }, 500); }

    if (!user.email) return jsonResponse(req, { error: "no_email" }, 422);
    const { data: link, error: lErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.email });
    const tokenHash = (link as any)?.properties?.hashed_token;
    if (lErr || !tokenHash) { log("generateLink failed", uid, lErr?.message); return jsonResponse(req, { error: "server_error" }, 500); }
    log("redeemed", uid);
    return jsonResponse(req, { token_hash: tokenHash, email: user.email });
  }

  return jsonResponse(req, { error: "unknown_action" }, 400);
});
