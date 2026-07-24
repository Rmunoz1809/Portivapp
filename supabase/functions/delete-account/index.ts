// delete-account — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Permanently deletes the CALLER'S OWN account (Apple Guideline 5.1.1(v)).
//
// SECURITY INVARIANT: the target user id comes ONLY from the caller's JWT
// (admin.auth.getUser(token), via requireUser). The request body is NEVER
// consulted for identity — this function can not be told to delete another
// user_id. requireUser is called WITHOUT a bodyUserId argument on purpose.
//
// Steps (service role — bypasses RLS):
//   1. Resolve uid from the JWT.
//   2. Delete the profiles row (idempotent; the client also attempts this first).
//   3. Delete the auth user (auth.admin.deleteUser). 404 / already-gone → success.
//
// SnapTrade unlinking is done by the client (snaptrade-disconnect) BEFORE this
// call, so the per-connected-user charge is stopped while the linkage still exists.
//
// Deploy: supabase functions deploy delete-account --no-verify-jwt
//   (the JWT is validated inside via requireUser; --no-verify-jwt lets us return
//    friendly CORS/JSON errors instead of the gateway's opaque 401.)

import { preflight, jsonResponse } from "../_shared/cors.ts";
import { adminClient, requireUser } from "../_shared/snaptrade.ts";

// "Already gone" upstream → treat as idempotent success, not an error.
const _isGone = (e: any) => {
  const s = e?.status ?? e?.response?.status ?? 0;
  if (s === 404) return true;
  return /not.?found|does not exist|user.*not.*found/i.test(
    (e?.message ?? e?.error?.message ?? "") + "",
  );
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    // Identity comes ONLY from the JWT. No bodyUserId argument → the body can
    // never influence which account is deleted.
    const userId = await requireUser(req, admin);

    // 1) Delete the profile row (idempotent safety net; service role bypasses RLS).
    const { error: delProfErr } = await admin.from("profiles").delete().eq("id", userId);
    if (delProfErr) {
      return jsonResponse(req, { error: "No se pudo borrar el perfil: " + delProfErr.message }, 500);
    }

    // 2) Delete the auth user. Already-gone (404 / not found) → idempotent success.
    try {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error && !_isGone(error)) {
        return jsonResponse(req, { error: "No se pudo borrar la cuenta: " + error.message }, 500);
      }
    } catch (e: any) {
      if (!_isGone(e)) {
        return jsonResponse(req, { error: "No se pudo borrar la cuenta: " + (e?.message ?? String(e)) }, 500);
      }
    }

    return jsonResponse(req, { ok: true, deleted: true });
  } catch (e: any) {
    const status = e?.status ?? 500;
    const message = e?.message ?? String(e);
    return jsonResponse(req, { error: message }, status);
  }
});
