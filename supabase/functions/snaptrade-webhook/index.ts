// snaptrade-webhook — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Receives SnapTrade webhook events (server-to-server POST). Deploy with
// --no-verify-jwt (SnapTrade does not send a Supabase JWT).
//
//   CONNECTION_ADDED    -> store brokerageAuthorizationId as snaptrade_connection_id
//   CONNECTION_UPDATED  -> clear the "broken" flag (connection healed)
//   CONNECTION_BROKEN   -> set snaptrade_connection_broken = true (frontend asks to reconnect)
//   CONNECTION_DELETED  -> clear snaptrade_connection_id and the broken flag
//
// Optional shared secret: if SNAPTRADE_WEBHOOK_SECRET is set, the body must carry
// a matching `webhookSecret` (configure it in the SnapTrade dashboard).
//
// Always returns 200 quickly so SnapTrade does not retry.

import { adminClient, isUuid } from "../_shared/snaptrade.ts";

const WEBHOOK_SECRET = Deno.env.get("SNAPTRADE_WEBHOOK_SECRET") ?? "";
const ok = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body: any;
  try { body = await req.json(); } catch { return ok({ ok: false, error: "bad json" }, 400); }

  // Optional shared-secret check.
  if (WEBHOOK_SECRET) {
    const provided = body?.webhookSecret ?? req.headers.get("x-snaptrade-secret") ?? "";
    if (provided !== WEBHOOK_SECRET) return ok({ ok: false, error: "unauthorized" }, 401);
  }

  const type: string = body?.eventType ?? body?.type ?? "";
  // SnapTrade sends the SnapTrade userId (== our Supabase user.id) and the
  // brokerage authorization (connection) id.
  const snapUserId: string = body?.userId ?? body?.user_id ?? "";
  const connectionId: string =
    body?.brokerageAuthorizationId ?? body?.authorizationId ?? body?.connectionId ?? "";

  if (!isUuid(snapUserId)) return ok({ ok: true, skipped: "non-uuid userId", type });

  const admin = adminClient();

  let patch: Record<string, unknown> | null = null;
  switch (type) {
    case "CONNECTION_ADDED":
      // Fresh (re)connection → clear any prior "trial vencido" disconnect marker so
      // the client stops showing the resubscribe copy for a now-connected user.
      patch = {
        snaptrade_connection_id: connectionId || null,
        snaptrade_connection_broken: false,
        snaptrade_disconnected_reason: null,
        snaptrade_disconnected_at: null,
      };
      break;
    case "CONNECTION_UPDATED":
    case "CONNECTION_FIXED":
      patch = { snaptrade_connection_broken: false };
      break;
    case "CONNECTION_BROKEN":
      patch = { snaptrade_connection_broken: true };
      break;
    case "CONNECTION_DELETED":
      patch = { snaptrade_connection_id: null, snaptrade_connection_broken: false };
      break;
    default:
      return ok({ ok: true, ignored: type }); // holdings-updated, etc. — nothing to persist
  }

  const { error } = await admin
    .from("profiles")
    .update(patch)
    .eq("snaptrade_user_id", snapUserId);

  if (error) {
    console.error("webhook update failed:", error.message);
    return ok({ ok: false, error: error.message }, 200); // still 200 to avoid retries storm
  }
  return ok({ ok: true, type });
});
