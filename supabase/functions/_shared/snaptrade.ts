// Shared SnapTrade + Supabase-admin helpers for Portiv Edge Functions.
//
// The Consumer Key is NEVER exposed to the client. It lives only in the function
// environment (SNAPTRADE_CONSUMER_KEY secret). All SnapTrade access is server-side.
//
// SDK: snaptrade-typescript-sdk (pinned). Method map used across functions:
//   snaptrade.authentication.registerSnapTradeUser({ userId })            -> { userId, userSecret }
//   snaptrade.authentication.loginSnapTradeUser({ userId, userSecret, ... }) -> { redirectURI, sessionId }
//   snaptrade.accountInformation.getAllUserHoldings({ userId, userSecret })
//   snaptrade.accountInformation.listUserAccounts({ userId, userSecret })
//   snaptrade.accountInformation.getAccountBalanceHistory({ userId, userSecret, accountId })
//   snaptrade.connections.deleteConnection({ connectionId, userId, userSecret })

import { Snaptrade } from "npm:snaptrade-typescript-sdk@10.0.18";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("SNAPTRADE_CLIENT_ID") ?? "";
const CONSUMER_KEY = Deno.env.get("SNAPTRADE_CONSUMER_KEY") ?? "";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** SnapTrade SDK client (server-side only). Throws if secrets are missing. */
export function snaptrade(): Snaptrade {
  if (!CLIENT_ID || !CONSUMER_KEY) {
    throw new Error(
      "SnapTrade no configurado: faltan SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY (Edge Functions → Secrets).",
    );
  }
  return new Snaptrade({ clientId: CLIENT_ID, consumerKey: CONSUMER_KEY });
}

/** Supabase admin client (service role — bypasses RLS, can read snaptrade_user_secret). */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

/**
 * Resolve the authenticated user id from the caller's JWT and confirm it matches
 * the requested userId. Prevents a client from reading another user's SnapTrade
 * data (the snaptrade_user_secret is sensitive). Returns the trusted user id.
 *
 * Throws { status, message } on any auth failure.
 */
export async function requireUser(
  req: Request,
  admin: SupabaseClient,
  bodyUserId?: unknown,
): Promise<string> {
  const authz = req.headers.get("Authorization") ?? "";
  const token = authz.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw { status: 401, message: "Falta el token de autenticación." };

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) {
    throw { status: 401, message: "Sesión inválida o expirada." };
  }
  const authedId = data.user.id;

  // Body userId is optional; if present it must match the authenticated user.
  if (bodyUserId != null && bodyUserId !== authedId) {
    throw { status: 403, message: "userId no coincide con la sesión." };
  }
  return authedId;
}

export type ProfileSnap = {
  snaptrade_user_id: string | null;
  snaptrade_user_secret: string | null;
  snaptrade_connection_id: string | null;
  snaptrade_account_id: string | null;
  snaptrade_last_refresh: string | null;
  snaptrade_holdings: unknown | null;
  snaptrade_history: unknown | null;
  snaptrade_connection_broken: boolean | null;
  snaptrade_disconnected_reason: string | null;
  snaptrade_connected_at: string | null;
  snaptrade_disconnected_at: string | null;
  snaptrade_last_manual_sync: string | null;
};

/** Load the SnapTrade-related profile columns for a user (service role). */
export async function loadProfile(
  admin: SupabaseClient,
  userId: string,
): Promise<ProfileSnap | null> {
  const { data, error } = await admin
    .from("profiles")
    .select(
      // snaptrade_connected_at / _disconnected_at: snaptrade-refresh los usa para separar
      // "nunca conectó un broker" de "se lo desconectamos". Sin ellos en el select llegan
      // como undefined y todo el mundo cae en el segundo caso.
      // snaptrade_activities NO va aquí a propósito: la lee sólo snaptrade-activities, con
      // su propia consulta tolerante. Este select se empaqueta en TODAS las funciones
      // snaptrade, así que añadirle una columna que aún no existe en la base las rompería
      // todas a la vez en el primer despliegue. El coste de la consulta extra es de esa
      // única función; el de equivocarse aquí, de la aplicación entera.
      "snaptrade_user_id, snaptrade_user_secret, snaptrade_connection_id, snaptrade_account_id, snaptrade_last_refresh, snaptrade_holdings, snaptrade_history, snaptrade_connection_broken, snaptrade_disconnected_reason, snaptrade_connected_at, snaptrade_disconnected_at, snaptrade_last_manual_sync",
    )
    .eq("id", userId)
    .maybeSingle();
  if (error) throw { status: 500, message: error.message };
  return (data as ProfileSnap) ?? null;
}

/**
 * Enforce an active subscription entitlement (or owner bypass) for `userId`.
 * Reads the server-authoritative has_active_entitlement(uid) SQL function via the
 * service-role client — the client cannot forge this. Throws
 * { status: 403, message: 'subscription_required' } when the user is not entitled.
 *
 * Fail-CLOSED on a definite "not entitled".
 *
 * When the check ITSELF errors the default is fail-OPEN, so a transient DB hiccup never
 * locks out a paying user mid-session. Callers that would incur a NEW recurring cost by
 * being wrong must pass { failClosed: true }: an unchecked connect creates a SnapTrade
 * brokerage link that bills ~$1/month for as long as it exists, so "let them through and
 * sort it out later" is not a recoverable mistake there. Read paths keep the open default —
 * nobody who already pays should lose their data because our RPC blinked.
 */
export async function requireEntitlement(
  admin: SupabaseClient,
  userId: string,
  opts?: { failClosed?: boolean },
): Promise<void> {
  const { data, error } = await admin.rpc("has_active_entitlement", { uid: userId });
  if (error) {
    if (opts?.failClosed) {
      console.error("[requireEntitlement] rpc failed (fail-CLOSED):", error.message);
      throw { status: 503, message: "entitlement_check_unavailable" };
    }
    console.error("[requireEntitlement] rpc failed (fail-open):", error.message);
    return; // check unavailable → don't punish the user for our outage
  }
  if (data !== true) throw { status: 403, message: "subscription_required" };
}

/**
 * Soft entitlement check → boolean (no throw). Same server-authoritative predicate
 * as requireEntitlement, but returns a flag the caller can act on (e.g. snaptrade-
 * refresh short-circuits to a "trial vencido" response instead of erroring).
 *
 * Fail-OPEN (true) if the RPC itself errors, so a transient DB hiccup never
 * mislabels a paying user as unpaid mid-session.
 */
export async function isEntitled(
  admin: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("has_active_entitlement", { uid: userId });
  if (error) {
    console.error("[isEntitled] rpc failed (fail-open):", error.message);
    return true;
  }
  return data === true;
}
