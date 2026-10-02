// _shared/broker-alert.ts — aviso push "reconecta tu broker".
// ─────────────────────────────────────────────────────────────────────────────
// Una conexión de broker que se cae (el broker caducó la sesión, el usuario cambió la
// contraseña, revocó el permiso) NO la podemos evitar desde aquí: el arreglo exige que el
// usuario renueve el permiso en el portal de su broker. Lo que sí está en nuestra mano es
// que se entere EN EL MOMENTO y no la próxima vez que abra la app —que puede ser dentro de
// una semana, con la cartera congelada todo ese tiempo—, y que el arreglo sea un toque.
//
// La llaman dos sitios:
//   · snaptrade-webhook, al llegar CONNECTION_BROKEN (aviso inmediato);
//   · snaptrade-health, el cron que revisa las conexiones de todos los enlazados (red de
//     seguridad si el webhook se pierde, y recordatorio si sigue caída).
//
// Cadencia: un aviso al detectarlo y, mientras siga caída, un recordatorio como mucho cada
// REMIND_HOURS. `snaptrade_broken_notified_at` lleva la cuenta; se limpia cuando la
// conexión vuelve (clearBrokerAlert).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { enviarConFallback, borrarToken } from "./push-common.ts";

const REMIND_HOURS = Number(Deno.env.get("SNAPTRADE_BROKEN_REMIND_HOURS") ?? "72");

/**
 * Avisa al usuario de que su broker necesita reconexión, respetando la cadencia.
 * Nunca lanza. Devuelve cuántos dispositivos recibieron el aviso (0 si no tocaba).
 */
export async function notifyBrokenBroker(
  admin: SupabaseClient,
  userId: string,
  brokerName?: string | null,
): Promise<number> {
  try {
    const { data: prof } = await admin
      .from("profiles")
      .select("snaptrade_broken_notified_at")
      .eq("id", userId)
      .maybeSingle();
    const last = prof?.snaptrade_broken_notified_at
      ? Date.parse(prof.snaptrade_broken_notified_at)
      : NaN;
    if (Number.isFinite(last) && Date.now() - last < REMIND_HOURS * 3600_000) return 0;

    const { data: rows } = await admin
      .from("device_tokens")
      .select("token, environment")
      .eq("user_id", userId);
    const devices = (rows ?? []) as { token: string; environment: "sandbox" | "production" }[];

    // Se sella ANTES de enviar: si el envío falla a medias, el siguiente intento no debe
    // convertirse en una ráfaga de avisos repetidos. Un aviso perdido lo recupera el cron.
    await admin
      .from("profiles")
      .update({ snaptrade_broken_notified_at: new Date().toISOString() })
      .eq("id", userId);
    if (!devices.length) return 0;

    const nombre = (brokerName ?? "").trim();
    const titulo = nombre ? `Reconecta ${nombre}` : "Reconecta tu broker";
    const cuerpo = (nombre ? `${nombre} dejó` : "Tu broker dejó") +
      " de enviar datos a Portiv. Toca para renovar el permiso en un minuto: no pierdes tu historial.";

    let enviados = 0;
    for (const d of devices) {
      const r = await enviarConFallback({
        token: d.token,
        environment: d.environment,
        titulo,
        cuerpo,
        deeplink: "portiv://broker/reconectar",
        // Un recordatorio sustituye al anterior en el centro de notificaciones.
        collapseId: "broker-reconectar",
      });
      if (r.ok) enviados++;
      else if (r.borrarToken) await borrarToken(d.token, r.reason);
    }
    console.log("[broker-alert] aviso de reconexión", userId, nombre || "(sin nombre)", `${enviados}/${devices.length}`);
    return enviados;
  } catch (e) {
    console.error("[broker-alert] no se pudo avisar:", userId, String(e));
    return 0;
  }
}

export type HealthResult = {
  userId: string;
  ok: boolean;               // false = no se pudo preguntar a SnapTrade (no se concluye nada)
  total: number;             // conexiones (brokerage authorizations) del usuario
  disabled: number;          // de ellas, deshabilitadas
  notified: number;          // dispositivos avisados en esta pasada
  changed: boolean;          // la bandera `broken` del perfil cambió
  error?: string;
  /** Resumen por conexión (sin secretos). snaptrade-health sólo lo devuelve con `detail`. */
  connections?: Array<{
    id: string | null; slug: string | null; name: string | null; type: string | null;
    disabled: boolean; disabledSince: string | null; created: string | null;
  }>;
};

/**
 * Pregunta a SnapTrade por el estado REAL de las conexiones de `userId` (lectura gratuita,
 * no es una sincronización), deja el perfil coherente y avisa si alguna está caída.
 *
 *  · `snaptrade_connection_broken` = TODAS caídas (mismo criterio que snaptrade-refresh).
 *    Cuando cambia, se invalida la caché para que la app relea al abrirse.
 *  · `snaptrade_connection_id` se re-apunta si falta o ya no existe (lo necesita el modo
 *    `reconnect` de snaptrade-connect para arreglar ESA conexión y no crear otra).
 *  · alguna caída → aviso push (con cadencia); ninguna → se rearma el aviso.
 *
 * NUNCA borra nada en SnapTrade, ni siquiera si el usuario ya no existe allí: eso sólo se
 * registra. Nunca lanza.
 */
export async function inspectAndAlert(
  admin: SupabaseClient,
  st: { connections: { listBrokerageAuthorizations: (a: { userId: string; userSecret: string }) => Promise<{ data: unknown }> } },
  userId: string,
): Promise<HealthResult> {
  const out: HealthResult = { userId, ok: false, total: 0, disabled: 0, notified: 0, changed: false };
  try {
    const { data: p } = await admin
      .from("profiles")
      .select("snaptrade_user_id, snaptrade_user_secret, snaptrade_connection_id, snaptrade_connection_broken")
      .eq("id", userId)
      .maybeSingle();
    if (!p?.snaptrade_user_id || !p?.snaptrade_user_secret) { out.error = "sin enlace"; return out; }

    let conns: any[] = [];
    try {
      conns = ((await st.connections.listBrokerageAuthorizations({
        userId: p.snaptrade_user_id, userSecret: p.snaptrade_user_secret,
      })).data as any[]) ?? [];
    } catch (e: any) {
      const status = e?.response?.status ?? e?.status ?? 0;
      const detail = String(e?.response?.data?.detail ?? e?.message ?? e).slice(0, 200);
      // Un usuario que SnapTrade ya no reconoce se REGISTRA y nada más: borrar o limpiar el
      // enlace por una lectura fallida es exactamente el tipo de error que desconecta a la gente.
      console.warn("[broker-alert] no se pudo leer las conexiones:", userId, status, detail);
      out.error = `http_${status}: ${detail}`;
      return out;
    }
    out.ok = true;
    out.total = conns.length;
    // `type` (read | trade) importa para la DURACIÓN: según la tabla de SnapTrade, una
    // conexión de Schwab de trading caduca en días y una de solo lectura dura años.
    out.connections = conns.map((c) => ({
      id: c?.id ?? null,
      slug: c?.brokerage?.slug ?? null,
      name: c?.brokerage?.display_name ?? c?.brokerage?.name ?? null,
      type: c?.type ?? null,
      disabled: c?.disabled === true,
      disabledSince: c?.disabled_date ?? null,
      created: c?.created_date ?? null,
    }));
    const down = conns.filter((c) => c?.disabled === true);
    out.disabled = down.length;
    const allDown = conns.length > 0 && down.length === conns.length;

    const patch: Record<string, unknown> = {};
    if (!!p.snaptrade_connection_broken !== allDown) {
      patch.snaptrade_connection_broken = allDown;
      patch.snaptrade_last_refresh = null;   // la app relee el estado real al abrirse
      out.changed = true;
    }
    const pointed = conns.find((c) => c?.id && c.id === p.snaptrade_connection_id);
    if (!pointed && conns.length) {
      const pick = conns.find((c) => c?.id && c.disabled !== true) ?? conns.find((c) => c?.id);
      if (pick?.id) patch.snaptrade_connection_id = pick.id;
    }
    if (Object.keys(patch).length) await admin.from("profiles").update(patch).eq("id", userId);

    if (down.length) {
      const name = down.length === 1
        ? (down[0]?.brokerage?.display_name ?? down[0]?.brokerage?.name ?? null)
        : null;
      out.notified = await notifyBrokenBroker(admin, userId, name);
    } else {
      await clearBrokerAlert(admin, userId);
    }
    return out;
  } catch (e) {
    out.error = String(e);
    return out;
  }
}

/** La conexión volvió: se rearma el aviso para la próxima caída. Nunca lanza. */
export async function clearBrokerAlert(admin: SupabaseClient, userId: string): Promise<void> {
  try {
    await admin
      .from("profiles")
      .update({ snaptrade_broken_notified_at: null })
      .eq("id", userId)
      .not("snaptrade_broken_notified_at", "is", null);
  } catch { /* no crítico */ }
}
