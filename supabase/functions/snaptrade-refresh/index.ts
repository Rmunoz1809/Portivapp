// snaptrade-refresh — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Serves the user's holdings. COST-OPTIMIZED: never triggers a paid manual sync.
// It only READS the data SnapTrade already synced in its free daily cycle.
//
//  • 60-minute cache: if snaptrade_last_refresh is < 60 min old, returns the
//    cached snaptrade_holdings without touching SnapTrade (saves rate-limited
//    read calls; the "Actualizar" button hits this and serves cache all day).
//  • On cache miss: rebuilds holdings from the per-account READ endpoints
//    (getUserAccountPositions + getUserAccountBalance) — the old aggregate
//    getAllUserHoldings/getUserHoldings endpoints are DEPRECATED (HTTP 410). These
//    are included reads, not a paid sync. Persists the result + stamps last_refresh.
//  • Captures the primary snaptrade_account_id on first success (needed by
//    snaptrade-history).
//
// Request  (POST): { userId?: string }
// Response (200):  { holdings, accountId, connected, fromCache }

import { preflight, jsonResponse } from "../_shared/cors.ts";
import {
  snaptrade,
  adminClient,
  requireUser,
  loadProfile,
  isEntitled,
} from "../_shared/snaptrade.ts";

const CACHE_MS = 60 * 60 * 1000; // 60 minutes

/** Best-effort extraction of the primary account id from a holdings payload. */
function primaryAccountId(holdings: any): string | null {
  const arr = Array.isArray(holdings) ? holdings : holdings?.accounts ?? [];
  for (const h of arr) {
    const id = h?.account?.id ?? h?.account_id ?? h?.id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* optional */ }

    const userId = await requireUser(req, admin, body?.userId);
    const entitled = await isEntitled(admin, userId);
    const profile = await loadProfile(admin, userId);
    const reason = profile?.snaptrade_disconnected_reason ?? null;

    // No active subscription → do NOT serve broker data, and tell the client WHY so the
    // UI can show "Tu prueba terminó — suscríbete para reconectar" (reason stamped by
    // snaptrade-cleanup) instead of the generic "nunca conectaste". Soft check (no throw)
    // so the client renders a clean state rather than catching a 403.
    if (!entitled) {
      return jsonResponse(req, {
        connected: false,
        entitled: false,
        disconnectedReason: reason || "subscription_inactive",
        holdings: null,
        accountId: null,
        fromCache: false,
      });
    }

    // Entitled but no SnapTrade user yet → not connected. Frontend shows "Conectar broker".
    if (!profile?.snaptrade_user_id || !profile?.snaptrade_user_secret) {
      return jsonResponse(req, {
        connected: false,
        entitled: true,
        disconnectedReason: null,
        holdings: null,
        accountId: null,
        fromCache: false,
      });
    }

    // ── Serve from cache if fresh (respects rate limits, zero SnapTrade calls) ──
    const last = profile.snaptrade_last_refresh
      ? new Date(profile.snaptrade_last_refresh).getTime()
      : 0;
    const fresh = last && Date.now() - last < CACHE_MS;
    if (fresh && profile.snaptrade_holdings != null) {
      return jsonResponse(req, {
        connected: true,
        broken: !!profile.snaptrade_connection_broken,
        holdings: profile.snaptrade_holdings,
        accountId: profile.snaptrade_account_id,
        fromCache: true,
      });
    }

    // ── Cache miss → read SnapTrade (included daily-synced data, never a paid sync) ──
    const st = snaptrade();
    const sid = {
      userId: profile.snaptrade_user_id,
      userSecret: profile.snaptrade_user_secret,
    };

    // Does a holdings array actually carry REAL data (positions, options, or cash)?
    // The aggregate endpoint can return an account object with empty positions for a
    // few minutes after connecting — that must count as "still syncing", not a live "$0".
    const carriesData = (arr: any[]): boolean =>
      Array.isArray(arr) && arr.some((h) => {
        const pos = h?.positions ?? [];
        const opt = h?.option_positions ?? h?.optionPositions ?? [];
        const bals = h?.balances ?? h?.balance ?? [];
        const cash = Array.isArray(bals)
          ? bals.reduce((s: number, b: any) => s + Number(b?.cash ?? b?.amount ?? 0), 0)
          : Number(bals?.cash ?? 0);
        const total = Number(
          h?.account?.balance?.total?.amount ??
            h?.account?.balance?.total ??
            h?.total_value?.value ??
            0,
        );
        return (Array.isArray(pos) && pos.length > 0) ||
          (Array.isArray(opt) && opt.length > 0) ||
          (Number.isFinite(cash) && cash !== 0) ||
          (Number.isFinite(total) && total !== 0);
      });

    // ── DEFINITIVE FIX ──────────────────────────────────────────────────────────
    // SnapTrade DEPRECATED the aggregate holdings endpoints: getAllUserHoldings AND
    // getUserHoldings now return HTTP 410 (Gone). That is why the app sat on
    // "Sincronizando…" forever — the old code called a dead endpoint, caught the
    // error, and always saw empty holdings even though the account was fully synced.
    //
    // listUserAccounts is the only holdings-adjacent endpoint that still works. We
    // rebuild the holdings array from the LIVE per-account reads (all included READs,
    // never a paid sync) in the exact shape the client's snapMapHoldings expects:
    //   getUserAccountPositions   → GET /accounts/{id}/positions   (positions)
    //   getUserAccountBalance     → GET /accounts/{id}/balances    (cash)
    //   options.listOptionHoldings→ option positions (best-effort)
    let accts: any[] = [];
    try {
      accts = ((await st.accountInformation.listUserAccounts(sid)).data as any[]) ?? [];
    } catch { accts = []; }
    const hasAccount = Array.isArray(accts) && accts.length > 0;

    // Earliest real inception across accounts (SnapTrade's first_transaction_date). The
    // client clamps its Yahoo reconstruction to this so it never projects current shares
    // to before the account existed (that caused a fake +34% "ALL" on first render).
    let inceptionDate: string | null = null;
    for (const a of accts) {
      const d = a?.sync_status?.transactions?.first_transaction_date;
      if (typeof d === "string" && d && (!inceptionDate || d < inceptionDate)) inceptionDate = d;
    }

    const ai: any = st.accountInformation;
    let holdings: any[] = [];
    for (const a of accts) {
      const accountId = a?.id ?? a?.account_id;
      if (!accountId) continue;
      let positions: any[] = [];
      let balances: any[] = [];
      let optionPositions: any[] = [];
      try { positions = (await ai.getUserAccountPositions({ ...sid, accountId })).data ?? []; } catch { /* not ready yet */ }
      try { balances = (await ai.getUserAccountBalance({ ...sid, accountId })).data ?? []; } catch { /* not ready yet */ }
      try { optionPositions = (await (st as any).options.listOptionHoldings({ ...sid, accountId })).data ?? []; } catch { /* optional */ }
      const total = a?.balance?.total?.amount ?? a?.balance?.total ?? null;
      holdings.push({
        account: { id: accountId, ...(total != null ? { balance: { total } } : {}) },
        balances,
        positions,
        option_positions: optionPositions,
      });
    }
    const holdArr = holdings;

    const hasHoldings = carriesData(holdArr);

    if (!hasHoldings) {
      if (!hasAccount) {
        // Registered on SnapTrade but NO broker linked yet → not broken; needs to connect.
        return jsonResponse(req, {
          connected: false,
          needsConnection: true,
          holdings: null,
          accountId: null,
          fromCache: false,
        });
      }
      // A brokerage account exists but holdings are still empty → the INITIAL SYNC is
      // running. SnapTrade pulls holdings asynchronously after CONNECTION_ADDED (usually
      // 1–2 min, sometimes more). Report `syncing` so the client shows "Sincronizando…"
      // and keeps polling. Only a webhook-confirmed break is reported as genuinely broken.
      const brokenFlag = !!profile.snaptrade_connection_broken;
      return jsonResponse(req, {
        connected: true,
        broken: brokenFlag,
        syncing: !brokenFlag,
        holdings: holdArr,
        accountId: profile.snaptrade_account_id ?? null,
        inceptionDate,
        fromCache: false,
      });
    }

    // ── Have holdings → success. Resolve primary account id + clear any broken flag. ──
    let accountId = profile.snaptrade_account_id ?? primaryAccountId(holdings);
    if (!accountId && Array.isArray(accts) && accts[0]) {
      accountId = accts[0].id ?? accts[0].account_id ?? null;
    }

    const { error } = await admin
      .from("profiles")
      .update({
        snaptrade_holdings: holdings,
        snaptrade_last_refresh: new Date().toISOString(),
        snaptrade_connection_broken: false, // got live data → connection healthy
        // Live data means they're connected & paying again → clear any prior
        // "trial vencido" disconnect marker so refresh stops reporting it.
        snaptrade_disconnected_reason: null,
        snaptrade_disconnected_at: null,
        ...(accountId ? { snaptrade_account_id: accountId } : {}),
      })
      .eq("id", userId);
    if (error) return jsonResponse(req, { error: error.message }, 500);

    return jsonResponse(req, {
      connected: true,
      broken: false,
      holdings,
      accountId,
      inceptionDate,
      fromCache: false,
    });
  } catch (e: any) {
    const status = e?.status ?? 500;
    const message = e?.message ?? e?.responseBody?.detail ?? String(e);
    return jsonResponse(req, { error: message }, status);
  }
});
