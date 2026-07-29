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
//   2. Desvincular en SnapTrade (ver abajo) ANTES de perder la fila.
//   3. Delete the profiles row (idempotent; the client also attempts this first).
//   4. Delete the auth user (auth.admin.deleteUser). 404 / already-gone → success.
//
// ── Paso 2: por qué está aquí y no sólo en el cliente ────────────────────────
// Antes el desenlace de SnapTrade lo hacía EXCLUSIVAMENTE el cliente llamando a
// snaptrade-disconnect justo antes de esto. Ese orden deja un agujero permanente:
// si esa llamada falla —red caída, 5xx, el usuario mata la app entre una y otra—
// esta función borra igualmente la fila de `profiles`, y con ella el
// snaptrade_user_id. A partir de ese instante el usuario de SnapTrade queda VIVO,
// con sus conexiones de broker activas, sin nadie que lo posea y sin ninguna forma
// de volver a borrarlo: se factura ~1 $/mes por conexión indefinidamente y quedan
// enlaces de solo-lectura contra cuentas de broker reales de alguien que pidió que
// se le borrara todo. Es el peor final posible para un borrado de cuenta.
//
// deleteSnapTradeUser sólo necesita el userId (nunca el userSecret), así que se
// puede hacer aquí sin depender de nada más. Es best-effort e idempotente: si
// SnapTrade no responde NO se aborta el borrado —el usuario pidió irse y tiene
// derecho a irse— pero se registra en `snaptrade_orphans` para poder reaparlo
// después. Si esa tabla no existe, queda al menos el console.error.

import { preflight, jsonResponse } from "../_shared/cors.ts";
import { adminClient, requireUser, snaptrade } from "../_shared/snaptrade.ts";

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

    // 1) Desvincular en SnapTrade ANTES de perder la fila que lo identifica.
    //    Best-effort: un fallo aquí NO bloquea el borrado de la cuenta.
    let snapUnlinked: boolean | null = null;
    try {
      const { data: prof } = await admin
        .from("profiles")
        .select("snaptrade_user_id")
        .eq("id", userId)
        .maybeSingle();
      const snapUserId = prof?.snaptrade_user_id ?? null;
      if (snapUserId) {
        try {
          await snaptrade().authentication.deleteSnapTradeUser({ userId: snapUserId });
          snapUnlinked = true;
        } catch (e: any) {
          // Ya borrado en SnapTrade → objetivo cumplido, no es un huérfano.
          if (_isGone(e) || _isGone(e?.response?.data)) {
            snapUnlinked = true;
          } else {
            snapUnlinked = false;
            const detail = (e?.response?.data?.detail ?? e?.message ?? String(e)) + "";
            console.error(
              "[delete-account] SnapTrade sigue vivo tras borrar la cuenta — HUÉRFANO FACTURABLE.",
              "snaptrade_user_id=", snapUserId, "detalle=", detail.slice(0, 300),
            );
            // Se apunta para reaparlo. Si la tabla no existe el insert falla y sólo
            // queda el log de arriba: nunca debe tumbar el borrado.
            try {
              await admin.from("snaptrade_orphans").insert({
                snaptrade_user_id: snapUserId,
                supabase_user_id: userId,
                reason: detail.slice(0, 500),
              });
            } catch (_) { /* tabla ausente → basta con el console.error */ }
          }
        }
      }
    } catch (e) {
      console.error("[delete-account] no se pudo leer snaptrade_user_id:", String(e));
    }

    // 2) Delete the profile row (idempotent safety net; service role bypasses RLS).
    const { error: delProfErr } = await admin.from("profiles").delete().eq("id", userId);
    if (delProfErr) {
      return jsonResponse(req, { error: "No se pudo borrar el perfil: " + delProfErr.message }, 500);
    }

    // 3) Delete the auth user. Already-gone (404 / not found) → idempotent success.
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

    return jsonResponse(req, { ok: true, deleted: true, snapUnlinked });
  } catch (e: any) {
    const status = e?.status ?? 500;
    const message = e?.message ?? String(e);
    return jsonResponse(req, { error: message }, status);
  }
});
