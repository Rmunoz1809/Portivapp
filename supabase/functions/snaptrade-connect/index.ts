// snaptrade-connect — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Registers the user on SnapTrade (first time only) and returns a fresh
// Connection Portal redirectURI. The redirectURI expires in ~5 min, so it is
// generated on every request.
//
// The SnapTrade userId IS the Supabase auth user.id (immutable UUID) — never the
// email. userSecret is generated once by SnapTrade and stored server-side only.
//
// Request  (POST): { userId?: string }   // userId optional; taken from the JWT
// Response (200):  { redirectURI: string }

import { preflight, jsonResponse } from "../_shared/cors.ts";
import {
  snaptrade,
  adminClient,
  requireUser,
  loadProfile,
  requireEntitlement,
} from "../_shared/snaptrade.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* body optional */ }

    const userId = await requireUser(req, admin, body?.userId);
    await requireEntitlement(admin, userId); // gate: only entitled users may link a broker
    // Where SnapTrade's Connection Portal returns the user after "Done".
    const redirect = typeof body?.redirect === "string" && body.redirect ? body.redirect : undefined;
    const st = snaptrade();

    let profile = await loadProfile(admin, userId);
    let snapUserId = profile?.snaptrade_user_id ?? null;
    let userSecret = profile?.snaptrade_user_secret ?? null;

    // ── SnapTrade error helpers ────────────────────────────────────────────
    const _sd = (e: any) => e?.response?.data ?? e?.responseBody ?? e?.body ?? e?.data ?? null;
    const _detail = (e: any) => {
      const sd = _sd(e);
      return (((sd && (sd.detail ?? sd.message)) ?? e?.message ?? "") + "");
    };
    // Code 1010 = "User with the following userId already exist" (orphaned user:
    // SnapTrade has the user but we lost/never stored its secret).
    const _isAlreadyExists = (e: any) => {
      const sd = _sd(e);
      const code = (sd && typeof sd === "object") ? (sd.code ?? sd.status_code) : null;
      return String(code) === "1010" || /already exist/i.test(_detail(e));
    };
    // Stored secret unusable (signature/secret/user mismatch) → heal & retry login.
    const _isAuthish = (e: any) => {
      const s = e?.response?.status ?? e?.status ?? 0;
      return (s === 400 || s === 401) &&
        /secret|signature|unable to verify|does not exist|not found|no.?such.?user|invalid/i.test(_detail(e));
    };

    // Al sellar el enlace se guarda TAMBIÉN el momento (`snaptrade_connected_at`):
    // es el ancla de la ventana de gracia que usa snaptrade-cleanup cuando el
    // usuario aún no tiene fila en `subscriptions` (el webhook de la tienda puede
    // tardar). Y se borran los marcadores de una baja anterior, para que la UI no
    // siga mostrando "tu suscripción terminó" sobre una conexión ya viva.
    const persist = async (uid: string, secret: string) => {
      const { error } = await admin
        .from("profiles")
        .update({
          snaptrade_user_id: uid,
          snaptrade_user_secret: secret,
          snaptrade_connected_at: new Date().toISOString(),
          snaptrade_disconnected_reason: null,
          snaptrade_disconnected_at: null,
          snaptrade_cleanup_retry_count: 0,
        })
        .eq("id", userId);
      if (error) throw { status: 500, message: error.message };
    };
    const register = async () => {
      const reg = (await st.authentication.registerSnapTradeUser({ userId })).data as any;
      const uid = reg.userId ?? userId;
      const secret = reg.userSecret ?? null;
      if (!secret) throw { status: 502, message: "SnapTrade no devolvió userSecret." };
      await persist(uid, secret);
      snapUserId = uid; userSecret = secret;
    };
    // Recover an ORPHANED SnapTrade user: its secret can't be fetched back (SnapTrade
    // only returns it at creation), so delete the user and re-register to mint a fresh
    // secret we can store. Deletion is asynchronous on SnapTrade's side, so re-register
    // is retried with backoff until the old user clears.
    const healOrphan = async () => {
      try { await st.authentication.deleteSnapTradeUser({ userId }); } catch (_) { /* best-effort */ }
      let lastErr: any = null;
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, i < 2 ? 1500 : 2500));
        try { await register(); return; }
        catch (e) {
          lastErr = e;
          // Keep waiting only while SnapTrade still reports the user as existing/deleting.
          if (!_isAlreadyExists(e) && !/deleti|in progress|queued/i.test(_detail(e))) throw e;
        }
      }
      throw lastErr ?? { status: 502, message: "No se pudo re-registrar en SnapTrade." };
    };

    // Ensure we hold a usable (userId, secret).
    if (!snapUserId || !userSecret) {
      try { await register(); }
      catch (e) { if (_isAlreadyExists(e)) { await healOrphan(); } else throw e; }
    }

    // Generate a fresh Connection Portal link (read-only). If the stored secret is
    // stale (auth failure), heal once and retry.
    const doLogin = async () => {
      const l = (await st.authentication.loginSnapTradeUser({
        userId: snapUserId!,
        userSecret: userSecret!,
        // Prefer read-only where the broker supports it; fall back to the broker's
        // standard connection otherwise. Forcing "read" makes SnapTrade's portal throw
        // "Unexpected Error" for brokers that don't offer a pure read-only connection.
        // Portiv still only READS data — it never places trades.
        connectionType: "trade-if-available",
        ...(redirect ? { customRedirect: redirect } : {}),
      } as any)).data as any;
      // The SDK model field is `redirectURI` (some versions: `redirectUri`).
      return l?.redirectURI ?? l?.redirectUri ?? null;
    };
    let redirectURI: string | null = null;
    try { redirectURI = await doLogin(); }
    catch (e) {
      if (_isAuthish(e)) { await healOrphan(); redirectURI = await doLogin(); }
      else throw e;
    }
    if (!redirectURI) {
      return jsonResponse(req, { error: "SnapTrade no devolvió redirectURI." }, 502);
    }

    return jsonResponse(req, { redirectURI });
  } catch (e: any) {
    // Surface the REAL SnapTrade error (the SDK hides it behind an axios
    // "Request failed with status code 400" message). The useful detail lives in
    // the response body: check every field the SDK/axios might use.
    const sd = e?.response?.data ?? e?.responseBody ?? e?.body ?? e?.data ?? null;
    const detail =
      (sd && typeof sd === "object" ? (sd.detail ?? sd.message ?? JSON.stringify(sd))
       : (typeof sd === "string" ? sd : null)) ?? null;
    const code = (sd && typeof sd === "object") ? (sd.code ?? sd.status_code ?? null) : null;
    const status = e?.response?.status ?? e?.status ?? (sd ? 502 : 500);
    const message = detail ?? e?.message ?? String(e) ?? "Error desconocido";
    console.error("[snaptrade-connect] fail", JSON.stringify({ status, code, detail, raw: e?.message }));
    return jsonResponse(req, { error: message, detail, code }, status);
  }
});
