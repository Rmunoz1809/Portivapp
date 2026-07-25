// rc-webhook — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// RevenueCat → Supabase entitlement mirror (server-authoritative source of truth).
// RevenueCat is the ground truth; this writes public.subscriptions AND mirrors the
// legacy profiles.subscription_status / subscription_expired_at (so the existing
// snaptrade-cleanup cron and any legacy reads keep working). On a REAL expiry it
// triggers snaptrade-disconnect to drop the broker link.
//
// Auth: no user JWT (RevenueCat posts server-to-server). The Authorization header
// must equal RC_WEBHOOK_SECRET (falls back to REVENUECAT_WEBHOOK_SECRET, so if you
// already set that for the old webhook you need no new secret).
// Deploy: supabase functions deploy rc-webhook --no-verify-jwt
// RevenueCat → Integrations → Webhooks:
//   URL:  https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/rc-webhook
//   Authorization header: the secret value.
// Requires app_user_id == Supabase user.id  (Purchases.logIn(session.user.id)).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET =
  Deno.env.get("RC_WEBHOOK_SECRET") ??
  Deno.env.get("REVENUECAT_WEBHOOK_SECRET") ??
  "";
const ACCEPT_SANDBOX = (Deno.env.get("RC_ACCEPT_SANDBOX") ?? "").toLowerCase() === "true";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// event.type → active entitlement.
const ACTIVE = new Set([
  "INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE",
  "UNCANCELLATION", "SUBSCRIPTION_EXTENDED", "NON_RENEWING_PURCHASE",
]);
// Real end of access → deactivate + disconnect the broker.
const EXPIRE = new Set(["EXPIRATION", "SUBSCRIPTION_PAUSED"]);
// CANCELLATION (auto-renew off, still active until expiry) and BILLING_ISSUE
// (grace: Apple retrying) are handled specially below.

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  if (SECRET) {
    const auth = req.headers.get("Authorization") ?? "";
    if (auth !== SECRET && auth !== `Bearer ${SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response("Bad Request", { status: 400 }); }

  const ev: any = body?.event ?? {};
  const type: string = ev.type ?? "";
  const appUserId: string = ev.app_user_id ?? "";
  const env: string = String(ev.environment ?? "").toUpperCase();

  if (!UUID_RE.test(appUserId)) return json({ ok: true, skipped: "non-uuid app_user_id", type });

  // Environment gate: in production, ignore SANDBOX events unless explicitly opted in.
  if (env === "SANDBOX" && !ACCEPT_SANDBOX) return json({ ok: true, ignored_sandbox: true, type });

  const expMs = Number(ev.expiration_at_ms ?? 0);
  const expiresAt = expMs > 0 ? new Date(expMs).toISOString() : null;
  const alreadyExpired = expMs > 0 && expMs <= Date.now();

  let active: boolean;
  let status: string;
  let willRenew: boolean | null = null;

  if (ACTIVE.has(type)) {
    active = true; status = "active"; willRenew = true;
  } else if (type === "CANCELLATION") {
    active = true; status = "canceled"; willRenew = false;   // still has access until expiry → no disconnect
  } else if (type === "BILLING_ISSUE") {
    if (alreadyExpired) { active = false; status = "expired"; }
    else { active = true; status = "grace"; }                // Apple retrying → keep access
  } else if (EXPIRE.has(type)) {
    active = false; status = "expired";
  } else {
    return json({ ok: true, ignored: type });                // TEST / TRANSFER / etc.
  }

  const nowIso = new Date().toISOString();

  // 1) Authoritative entitlement table.
  const { error: subErr } = await admin.from("subscriptions").upsert({
    user_id: appUserId,
    rc_app_user_id: appUserId,
    entitlement_active: active,
    status,
    product_id: ev.product_id ?? null,
    store: ev.store ?? null,
    environment: env || null,
    expires_at: expiresAt,
    will_renew: willRenew,
    last_event: type,
    updated_at: nowIso,
  }, { onConflict: "user_id" });
  if (subErr) {
    console.error("subscriptions upsert failed:", subErr.message);
    return json({ ok: false, error: subErr.message }, 500);
  }

  // 2) Mirror legacy profiles columns (keeps snaptrade-cleanup cron + legacy reads working).
  const profPatch: Record<string, unknown> = { subscription_status: status };
  profPatch.subscription_expired_at = active ? null : nowIso;
  await admin.from("profiles").update(profPatch).eq("id", appUserId)
    .then(() => {}, (e: any) => console.error("profiles mirror failed:", e?.message));

  // 3) Disconnect is NOT done here. Hybrid design: this webhook only RECORDS state;
  //    the hourly snaptrade-cleanup cron revokes the SnapTrade link after a grace
  //    window (SNAPTRADE_GRACE_HOURS), re-checking entitlement at action time. That
  //    avoids cutting a user whose billing retry (BILLING_ISSUE grace) still succeeds,
  //    and makes replayed / out-of-order events harmless (no immediate irreversible cut).
  return json({ ok: true, type, status, active });
});
