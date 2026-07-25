// snaptrade-disconnect — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Removes a user's SnapTrade linkage. TWO callers:
//   1. INTERNAL (rc-webhook, service-to-service): header
//      `x-internal-secret == INTERNAL_DISCONNECT_SECRET` (falls back to
//      SNAPTRADE_CRON_SECRET). Body: { app_user_id }.
//   2. USER (manual "Desconectar broker"): a normal user JWT → id from the token.
//
// It deletes the SnapTrade user (which removes ALL their connections and stops the
// per-connected-user charge) and clears the snaptrade_* columns so snaptrade-refresh
// reports `connected:false` afterwards.
//
// Idempotent: no linkage → { ok:true, disconnected:false }.
// Deploy: supabase functions deploy snaptrade-disconnect --no-verify-jwt

import { preflight, jsonResponse } from "../_shared/cors.ts";
import { snaptrade, adminClient, requireUser, isUuid } from "../_shared/snaptrade.ts";

const INTERNAL_SECRET =
  Deno.env.get("INTERNAL_DISCONNECT_SECRET") ??
  Deno.env.get("SNAPTRADE_CRON_SECRET") ??
  "";

// ── SnapTrade error classification (borrowed from snaptrade-connect) ──
// Distinguishes "already gone" (idempotent success) from a transient failure where
// the user may STILL exist upstream and keep incurring the per-connected-user charge.
const _sd = (e: any) => e?.response?.data ?? e?.responseBody ?? e?.body ?? e?.data ?? null;
const _detail = (e: any) => {
  const sd = _sd(e);
  return (((sd && (sd.detail ?? sd.message)) ?? e?.message ?? "") + "");
};
const _isGone = (e: any) => {
  const s = e?.response?.status ?? e?.status ?? 0;
  if (s === 404) return true;
  return /not.?found|does not exist|no.?such.?user|already.*delet/i.test(_detail(e));
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* optional */ }

    // ── Resolve the target user id: trusted internal secret OR user JWT. ──
    const internalHdr = req.headers.get("x-internal-secret") ?? "";
    const isInternal = !!INTERNAL_SECRET && internalHdr === INTERNAL_SECRET;

    let userId: string;
    if (isInternal) {
      const appUserId = body?.app_user_id ?? body?.userId ?? "";
      if (!isUuid(appUserId)) return jsonResponse(req, { error: "app_user_id inválido" }, 400);
      userId = appUserId;
    } else {
      // Manual client call — must be an authenticated user acting on their own account.
      userId = await requireUser(req, admin, body?.userId);
    }

    // Reason recorded on the profile (audit + drives the client "trial vencido" UI).
    // Internal caller (cron/webhook) may pass an explicit reason; default to the
    // trial-expiry cause. A manual user-initiated disconnect is always "manual".
    const reason = isInternal
      ? (typeof body?.reason === "string" && body.reason ? body.reason : "trial_expired_no_payment")
      : "manual";

    // ── Read the current linkage (service role can see the secret). ──
    const { data: prof, error: selErr } = await admin
      .from("profiles")
      .select("snaptrade_user_id")
      .eq("id", userId)
      .maybeSingle();
    if (selErr) return jsonResponse(req, { error: selErr.message }, 500);

    const snapUserId = prof?.snaptrade_user_id ?? null;

    // Nothing linked → idempotent no-op. Do NOT overwrite an existing reason/marker.
    if (!snapUserId) {
      return jsonResponse(req, { ok: true, disconnected: false });
    }

    // ── Delete on SnapTrade, then CLASSIFY the outcome (acceptance criterion #5). ──
    //   success / already-gone (404, "not found") → safe to clear local state.
    //   transient (5xx, network, timeout — the user may STILL exist and be billed) →
    //     DO NOT clear; report retry so the cron re-drives next run. The whole point:
    //     never mark a user disconnected while SnapTrade still has them live.
    let deletedRemote = false;
    try {
      await snaptrade().authentication.deleteSnapTradeUser({ userId: snapUserId });
      deletedRemote = true;
    } catch (e: any) {
      if (_isGone(e)) {
        deletedRemote = true; // already deleted upstream → idempotent success
      } else {
        const detail = _detail(e) || "snaptrade_delete_failed";
        console.error("[snaptrade-disconnect] upstream delete failed (will retry):", detail);
        return jsonResponse(req, { ok: false, retry: true, disconnected: false, error: detail }, 502);
      }
    }

    // ── Confirmed removed (or already gone) → clear local linkage + stamp reason. ──
    const { error: updErr } = await admin
      .from("profiles")
      .update({
        snaptrade_user_id: null,
        snaptrade_user_secret: null,
        snaptrade_connection_id: null,
        snaptrade_account_id: null,
        snaptrade_last_refresh: null,
        snaptrade_holdings: null,
        snaptrade_history: null,
        snaptrade_connection_broken: false,
        snaptrade_disconnected_reason: reason,
        snaptrade_disconnected_at: new Date().toISOString(),
      })
      .eq("id", userId);
    if (updErr) return jsonResponse(req, { error: updErr.message }, 500);

    return jsonResponse(req, { ok: true, disconnected: true, deletedRemote, reason });
  } catch (e: any) {
    const status = e?.status ?? 500;
    const message = e?.message ?? e?.responseBody?.detail ?? String(e);
    return jsonResponse(req, { error: message }, status);
  }
});
