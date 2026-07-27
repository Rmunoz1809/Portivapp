// snaptrade-history — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Returns up to ~1 year of portfolio value history for the performance chart.
//
// Uses getAccountBalanceHistory — an EXPERIMENTAL SnapTrade endpoint (max 1y
// lookback) that is DISABLED by default and must be enabled per-account by
// emailing SnapTrade. Until then it returns empty/errors — we handle that
// gracefully and tell the frontend to show a "coming soon" placeholder instead
// of crashing.
//
//  • Daily cache: historical data does not change intraday, so if
//    snaptrade_history was written today, it is returned from cache (0 calls).
//
// Request  (POST): { userId?: string }
// Response (200):  { history: [{date,value}], available: boolean, reason?: string, fromCache?: boolean }

import { preflight, jsonResponse } from "../_shared/cors.ts";
import {
  snaptrade,
  adminClient,
  requireUser,
  loadProfile,
  requireEntitlement,
} from "../_shared/snaptrade.ts";

const todayUTC = () => new Date().toISOString().slice(0, 10);

/** Normalize whatever the experimental endpoint returns into [{date,value}]. */
function normalize(raw: any): { date: string; value: number }[] {
  const arr = Array.isArray(raw) ? raw : raw?.history ?? raw?.data ?? [];
  if (!Array.isArray(arr)) return [];
  const out: { date: string; value: number }[] = [];
  for (const it of arr) {
    const date = it?.date ?? it?.snapshotDate ?? it?.day ?? it?.timestamp;
    const rawVal = it?.value ?? it?.total_value ?? it?.totalValue ?? it?.balance ?? it?.equity;
    const value = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (date && Number.isFinite(value)) {
      out.push({ date: String(date).slice(0, 10), value });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // Trim the leading pre-funding stretch. getAccountBalanceHistory returns a FULL year
  // and reports value 0 for every day BEFORE the account was funded. Left in, those
  // zeros stretched the chart axis to ~1y and inflated the ALL % (comparing "now" to an
  // early ~$0 value → a fake +34%). Start the series at the first day with real value.
  const firstReal = out.findIndex((p) => p.value > 0);
  if (firstReal === -1) return []; // account never held value → no real series
  return firstReal > 0 ? out.slice(firstReal) : out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* optional */ }

    const userId = await requireUser(req, admin, body?.userId);
    await requireEntitlement(admin, userId); // gate: no entitlement → no history
    const profile = await loadProfile(admin, userId);

    if (!profile?.snaptrade_user_id || !profile?.snaptrade_user_secret) {
      return jsonResponse(req, { history: [], available: false, reason: "not_connected" });
    }

    // ── Daily cache ── (omitida si el cliente pide `force`: p.ej. tras habilitar el
    // lookback completo de 1 año en SnapTrade, un "Actualizar" manual trae el historial
    // ampliado al instante en vez de esperar hasta 24h a que expire la caché diaria).
    const cached: any = profile.snaptrade_history;
    if (!body?.force && cached && cached.updatedAt && String(cached.updatedAt).slice(0, 10) === todayUTC()) {
      return jsonResponse(req, {
        history: cached.history ?? [],
        available: !!cached.available,
        reason: cached.reason,
        fromCache: true,
      });
    }

    const st = snaptrade();
    const accountId = profile.snaptrade_account_id;
    if (!accountId) {
      // Nothing to query yet; let the frontend show the placeholder.
      const payload = { updatedAt: new Date().toISOString(), available: false, reason: "no_account", history: [] };
      await admin.from("profiles").update({ snaptrade_history: payload }).eq("id", userId);
      return jsonResponse(req, { history: [], available: false, reason: "no_account" });
    }

    // ── Experimental endpoint — everything below is graceful on failure ──
    let history: { date: string; value: number }[] = [];
    let available = false;
    let reason: string | undefined;
    try {
      const raw = (
        await st.accountInformation.getAccountBalanceHistory({
          userId: profile.snaptrade_user_id,
          userSecret: profile.snaptrade_user_secret,
          accountId,
        } as any)
      ).data;
      history = normalize(raw);
      available = history.length > 0;
      if (!available) reason = "empty"; // endpoint likely not enabled for this account
    } catch (err: any) {
      available = false;
      reason = "endpoint_disabled";
      console.warn("getAccountBalanceHistory unavailable:", err?.message ?? String(err));
    }

    const payload = { updatedAt: new Date().toISOString(), available, reason, history };
    await admin.from("profiles").update({ snaptrade_history: payload }).eq("id", userId);

    return jsonResponse(req, { history, available, reason });
  } catch (e: any) {
    // Even on unexpected failure, never break the chart — return placeholder state.
    const message = e?.message ?? String(e);
    return jsonResponse(req, { history: [], available: false, reason: "error", error: message }, 200);
  }
});
