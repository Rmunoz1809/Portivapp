// entitlement-sweeper — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Red de seguridad diaria. Los webhooks se pierden: el endpoint puede estar
// caído durante toda la ventana de reintentos, RevenueCat puede tener un
// incidente, un evento puede llegar mal formado. Sin este barrido, un solo
// EXPIRATION perdido = acceso gratis indefinido.
//
// ── Alcance deliberadamente estrecho ────────────────────────────────────────
// Esta función SÓLO apaga filas: `entitlement_active = true` con `expires_at`
// ya vencido (más un colchón de 48 h) pasa a `false`.
//
// NO borra usuarios en SnapTrade. Eso lo sigue haciendo `snaptrade-cleanup`,
// que ya corre cada hora, revalida `has_active_entitlement(uid)` en el momento
// de actuar y clasifica los fallos upstream. Dos funciones borrando usuarios en
// SnapTrade a la vez sería una carrera con consecuencias irreversibles (el
// usuario tendría que rehacer todo el flujo del broker). Al final de la pasada,
// si hubo revocaciones, se invoca a snaptrade-cleanup UNA vez para que el corte
// del broker no espere a la siguiente hora en punto.
//
// Por qué hace falta apagar la fila y no basta con has_active_entitlement():
// el cliente (_pvSubStatus en index.html) lee `entitlement_active` DIRECTO de
// la tabla, no por RPC. Si la fila sigue en true, el muro no aparece aunque el
// servidor ya esté respondiendo 403.
//
// Deploy: supabase functions deploy entitlement-sweeper --no-verify-jwt
//   (la autenticación es por secreto propio, igual que snaptrade-cleanup)
// Programación: Supabase → Edge Functions → Schedules → 17 7 * * *
//   (o el bloque pg_cron comentado en sql/01-subscriptions-ios.sql)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("SNAPTRADE_CRON_SECRET") ?? "";

// Colchón sobre expires_at. Apple emite la notificación de renovación con
// retraso; cortar a los 0 minutos expulsaría a gente que sí renovó.
const GRACE_HOURS = Number(Deno.env.get("ENTITLEMENT_SWEEP_GRACE_HOURS") ?? "48");

// Techo por ejecución. Lo que sobre se barre mañana.
const MAX_PER_RUN = 200;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const log = (...a: unknown[]) => console.log("[sweeper]", ...a);

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  // Auth: el secreto del cron (header propio) o la service_role key en el
  // Authorization — pg_net y los Schedules de Supabase mandan lo segundo.
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const cronHdr = req.headers.get("x-cron-secret") ?? "";
  const authorized =
    (!!CRON_SECRET && cronHdr === CRON_SECRET) ||
    (!!SERVICE_ROLE && bearer === SERVICE_ROLE);
  if (!authorized) return json({ ok: false, error: "forbidden" }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { /* body opcional */ }
  const dryRun = body?.dry_run === true;

  const cutoff = new Date(Date.now() - GRACE_HOURS * 3600000).toISOString();
  const nowIso = new Date().toISOString();
  const out = { scanned: 0, revoked: 0, errors: 0, dry_run: dryRun, cleanup_triggered: false };
  const results: any[] = [];

  // Entitlements vencidos que siguen marcados como activos. `grace_until` en el
  // futuro = fallo de cobro con Apple aún reintentando → no se toca.
  const { data: stale, error: sErr } = await admin
    .from("subscriptions")
    .select("user_id, status, store, expires_at, grace_until")
    .eq("entitlement_active", true)
    .not("expires_at", "is", null)
    .lt("expires_at", cutoff)
    .limit(MAX_PER_RUN);

  if (sErr) {
    log("query stale error", sErr.message);
    return json({ ok: false, error: sErr.message, ...out }, 500);
  }

  out.scanned = (stale ?? []).length;

  for (const row of stale ?? []) {
    if (row.grace_until && Date.parse(row.grace_until) > Date.now()) {
      results.push({ id: row.user_id, skipped: "billing_grace", grace_until: row.grace_until });
      continue;
    }

    const reason = `subscription_ended_${row.store ?? "appstore"}:sweeper_expired`;

    if (dryRun) {
      results.push({ id: row.user_id, would_revoke: true, expires_at: row.expires_at, reason });
      continue;
    }

    // El `.eq("entitlement_active", true)` del update no es redundante: entre el
    // select y aquí puede haber llegado un RENEWAL. Sin él, el barrido pisaría
    // una renovación recién escrita.
    const { error } = await admin.from("subscriptions").update({
      entitlement_active: false,
      status: "expired",
      will_renew: false,
      revoked_at: nowIso,
      revoked_reason: reason,
      last_event: "SWEEP",
      updated_at: nowIso,
    }).eq("user_id", row.user_id).eq("entitlement_active", true);

    if (error) {
      out.errors++;
      log("revoke error", row.user_id, error.message);
      results.push({ id: row.user_id, error: error.message });
      continue;
    }

    // Espejo legado.
    await admin
      .from("profiles")
      .update({ subscription_status: "expired", subscription_expired_at: nowIso })
      .eq("id", row.user_id)
      .then(() => {}, (e: any) => log("profiles mirror failed", row.user_id, e?.message));

    out.revoked++;
    results.push({ id: row.user_id, revoked: true, expires_at: row.expires_at, reason });
    log("revoked", row.user_id, "expired", row.expires_at);
  }

  // Si algo se revocó, se despierta a snaptrade-cleanup en el acto para que el
  // broker no siga conectado (y facturando) hasta la siguiente hora en punto.
  // Es él quien decide y ejecuta la baja: aquí no se toca SnapTrade.
  if (out.revoked > 0 && CRON_SECRET) {
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/snaptrade-cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": CRON_SECRET },
        body: JSON.stringify({}),
      });
      out.cleanup_triggered = r.ok;
      if (!r.ok) log("snaptrade-cleanup no-ok", r.status);
    } catch (e) {
      log("snaptrade-cleanup trigger failed", String(e));
    }
  }

  log("done", JSON.stringify(out));
  return json({ ok: true, ...out, results });
});
