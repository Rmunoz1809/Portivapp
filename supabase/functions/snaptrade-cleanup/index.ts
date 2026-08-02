// snaptrade-cleanup — Edge Function (Deno) · v2
// ─────────────────────────────────────────────────────────────────────────────
// Cron horario (pg_cron → net.http_post). ÚNICO ejecutor de la baja del broker
// por falta de suscripción: revoca el enlace de SnapTrade de todo usuario sin
// derecho activo, para cortar el cargo de ~1 USD/usuario-conectado/mes.
//
// v2 — qué cambia respecto a la v1 (y por qué):
//
//   • El barrido parte de `profiles` (TODOS los enlazados), no de
//     `subscriptions`. La v1 exigía fila de suscripción con `expires_at` no
//     nulo, así que un enlazado sin fila (o con expires_at NULL) era invisible
//     y se facturaba para siempre. Ahora nadie enlazado queda fuera del radar.
//
//   • Ancla de gracia en cascada, siempre estable (nunca `now()`, para que un
//     evento reenviado o desordenado no reinicie el reloj):
//        1. subscriptions.expires_at   (fin real del acceso pagado)
//        2. subscriptions.updated_at   (cancelación sin periodo restante)
//        3. profiles.snaptrade_connected_at  (enlazado que nunca tuvo fila)
//     Sin ninguna de las tres NO se desconecta: se sella `connected_at` y se
//     decide en el ciclo siguiente. Cortar a ciegas es peor que pagar una hora.
//
//   • Lote acotado (SNAPTRADE_CLEANUP_BATCH, 25 por defecto) para no chocar
//     con el límite de tiempo de la Edge Function; lo que sobra se recoge a la
//     hora siguiente y se reporta como `pending`.
//
//   • Cada ejecución deja traza en `snaptrade_cleanup_runs`. Una limpieza que
//     falla en silencio es exactamente la que cuesta dinero.
//
// Sigue siendo idempotente y seguro:
//   • Re-verifica `has_active_entitlement(uid)` en el momento de actuar → quien
//     re-suscribió durante la gracia (y el dueño, que tiene bypass) se salta.
//   • Si la RPC de derecho falla, NO se desconecta (fail-closed hacia el
//     usuario: ante la duda, se paga la hora y se reintenta).
//   • `snaptrade-disconnect` sólo limpia el estado local cuando SnapTrade
//     confirma el borrado; ante fallo transitorio sube el contador de reintento
//     y el ciclo siguiente vuelve sobre la misma fila.
//
// Auth: header `x-cron-secret` == SNAPTRADE_CRON_SECRET.
// Body opcional (todo para diagnóstico manual):
//   { "dry_run": true }        → calcula y reporta, sin desconectar a nadie
//   { "batch": 100 }           → tamaño de lote puntual
//   { "user_id": "<uuid>" }    → evalúa un solo usuario
// Deploy: supabase functions deploy snaptrade-cleanup --no-verify-jwt

import { adminClient } from "../_shared/snaptrade.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("SNAPTRADE_CRON_SECRET") ?? "";
const INTERNAL_SECRET =
  Deno.env.get("INTERNAL_DISCONNECT_SECRET") ??
  Deno.env.get("SNAPTRADE_CRON_SECRET") ??
  "";

// Gracia tras el FIN REAL del acceso pagado (expiró / se canceló y ya venció).
const GRACE_HOURS = Number(Deno.env.get("SNAPTRADE_GRACE_HOURS") ?? "36");
// Gracia para un enlace SIN fila de suscripción. Más larga: cubre el hueco
// entre "el usuario conecta el broker" y "el webhook de la tienda escribe la
// fila", que en Paddle/RevenueCat puede tardar minutos y, si falla el webhook,
// horas. Sin esto, un pagador legítimo se quedaría sin broker.
const ORPHAN_GRACE_HOURS = Number(Deno.env.get("SNAPTRADE_ORPHAN_GRACE_HOURS") ?? "48");
const BATCH_DEFAULT = Number(Deno.env.get("SNAPTRADE_CLEANUP_BATCH") ?? "25");

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const HOUR_MS = 60 * 60 * 1000;

/** Reintento por fallo transitorio: el ciclo siguiente re-conduce esta fila.
 *  (El cron es de un solo hilo → leer-modificar-escribir aquí no compite.) */
async function bumpRetry(admin: any, uid: string) {
  const { data } = await admin
    .from("profiles")
    .select("snaptrade_cleanup_retry_count")
    .eq("id", uid)
    .maybeSingle();
  const n = Number(data?.snaptrade_cleanup_retry_count ?? 0) + 1;
  await admin
    .from("profiles")
    .update({
      snaptrade_cleanup_retry_count: n,
      snaptrade_cleanup_last_attempt_at: new Date().toISOString(),
    })
    .eq("id", uid);
}

/** Marca el intento (sin contarlo como fallo). Se sella a TODO el que se evalúa,
 *  incluidos los que tienen suscripción al día: el lote se ordena por este campo,
 *  y si los que están al día no se sellaran, con más usuarios que `batch` se
 *  quedarían siempre en cabeza (su valor sigue NULL → nullsFirst) y los morosos
 *  no llegarían nunca a evaluarse. Rotación justa = nadie se queda sin turno. */
async function stampAttempt(admin: any, uid: string, extra: Record<string, unknown> = {}) {
  await admin
    .from("profiles")
    .update({ snaptrade_cleanup_last_attempt_at: new Date().toISOString(), ...extra })
    .eq("id", uid);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Fail-CLOSED. Con el `if (CRON_SECRET)` de antes bastaba con que el secreto no
  // estuviera puesto en el entorno para que TODA la comprobación desapareciera — y esta
  // función se despliega con --no-verify-jwt, así que no queda ninguna otra puerta: un
  // POST anónimo desconectaba en masa los brokers de los usuarios sin derecho activo.
  // Es el mismo agujero que ya se cerró en snaptrade-webhook. Sin secreto no corre nada;
  // el 503 lo deja gritando en los logs en vez de fallar en silencio.
  if (!CRON_SECRET) {
    console.error("[snaptrade-cleanup] SNAPTRADE_CRON_SECRET sin configurar — ejecución rechazada");
    return json({ ok: false, error: "cleanup not configured" }, 503);
  }
  const provided = req.headers.get("x-cron-secret") ?? "";
  if (provided !== CRON_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* body opcional */ }
  const dryRun = body?.dry_run === true;
  const batch = Math.max(1, Math.min(200, Number(body?.batch ?? BATCH_DEFAULT) || BATCH_DEFAULT));
  const onlyUser = typeof body?.user_id === "string" ? body.user_id : null;

  const admin = adminClient();
  const startedAt = Date.now();
  const nowIso = new Date().toISOString();
  const results: any[] = [];
  // Ids a sellar en UNA sola escritura al final (ver stampAttempt): sellar uno a uno
  // sería una consulta por usuario y por hora sin ninguna ganancia.
  const toStamp: string[] = [];
  let disconnected = 0, skipped = 0, failed = 0, pending = 0;

  try {
    // ── 1. Candidatos: TODO perfil con enlace vivo a SnapTrade. ───────────────
    //    Los más antiguos sin intentar primero → rotación justa entre ciclos.
    let q = admin
      .from("profiles")
      .select("id, snaptrade_user_id, snaptrade_connected_at, snaptrade_cleanup_retry_count")
      .not("snaptrade_user_id", "is", null)
      .order("snaptrade_cleanup_last_attempt_at", { ascending: true, nullsFirst: true })
      .limit(batch);
    if (onlyUser) q = q.eq("id", onlyUser);

    const { data: linked, error: pErr } = await q;
    if (pErr) throw new Error(`profiles: ${pErr.message}`);

    if (!linked?.length) {
      await admin.from("snaptrade_cleanup_runs").insert({
        ok: true, scanned: 0, disconnected: 0, skipped: 0, failed: 0, pending: 0,
        dry_run: dryRun, detail: { note: "sin usuarios enlazados" },
      });
      return json({ ok: true, scanned: 0, disconnected: 0, skipped: 0, failed: 0, pending: 0, results: [] });
    }

    // Cuántos quedan fuera del lote (sólo informativo, para ver si el lote se queda corto).
    if (!onlyUser) {
      const { count } = await admin
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .not("snaptrade_user_id", "is", null);
      pending = Math.max(0, Number(count ?? 0) - linked.length);
    }

    // ── 2. Suscripciones de ese lote, en una sola consulta. ───────────────────
    const ids = linked.map((p: any) => p.id);
    const { data: subs, error: sErr } = await admin
      .from("subscriptions")
      .select("user_id, entitlement_active, status, expires_at, updated_at, store")
      .in("user_id", ids);
    if (sErr) throw new Error(`subscriptions: ${sErr.message}`);
    const subById = new Map<string, any>((subs ?? []).map((s: any) => [s.user_id, s]));

    // ── 3. Evaluar uno a uno. ────────────────────────────────────────────────
    for (const p of linked as any[]) {
      const uid = p.id as string;

      // 3.a Derecho activo AHORA (incluye el bypass del dueño). Fuente de verdad
      //     en el momento de actuar: cubre re-suscripciones dentro de la gracia.
      const { data: ent, error: eErr } = await admin.rpc("has_active_entitlement", { uid });
      if (eErr) {
        // La comprobación no está disponible → NO se desconecta. Se pagará una
        // hora más; cortar por un fallo nuestro sería un falso positivo caro.
        skipped++;
        toStamp.push(uid);
        results.push({ id: uid, skipped: "entitlement_check_failed", error: eErr.message });
        continue;
      }
      if (ent === true) {
        skipped++;
        toStamp.push(uid);
        results.push({ id: uid, skipped: "still_entitled" });
        continue;
      }

      // 3.b Ancla de la ventana de gracia (estable, nunca `now()`).
      const sub = subById.get(uid);
      let anchor: string | null = null;
      let anchorKind = "";
      let graceHours = GRACE_HOURS;

      if (sub?.expires_at) { anchor = sub.expires_at; anchorKind = "expires_at"; }
      else if (sub?.updated_at) { anchor = sub.updated_at; anchorKind = "sub_updated_at"; }
      else if (p.snaptrade_connected_at) {
        anchor = p.snaptrade_connected_at; anchorKind = "connected_at"; graceHours = ORPHAN_GRACE_HOURS;
      }

      if (!anchor) {
        // Enlace sin ninguna referencia temporal (fila anterior a esta versión).
        // Se sella el ancla y se decide en el ciclo siguiente: jamás se corta a
        // ciegas a alguien de quien no sabemos cuándo se conectó.
        if (!dryRun) await stampAttempt(admin, uid, { snaptrade_connected_at: nowIso });
        skipped++;
        results.push({ id: uid, skipped: "anchor_seeded" });
        continue;
      }

      const ageMs = Date.now() - new Date(anchor).getTime();
      if (!(ageMs >= graceHours * HOUR_MS)) {
        toStamp.push(uid);
        skipped++;
        results.push({
          id: uid, skipped: "within_grace", anchor_kind: anchorKind,
          hours_left: Math.round((graceHours * HOUR_MS - ageMs) / HOUR_MS * 10) / 10,
        });
        continue;
      }

      const reason = sub
        ? `subscription_inactive_${sub.store ?? "unknown"}:${sub.status ?? "unknown"}`
        : "trial_expired_no_payment";

      if (dryRun) {
        results.push({ id: uid, would_disconnect: true, anchor_kind: anchorKind, reason });
        continue;
      }

      // 3.c Delegar en la ÚNICA implementación de la baja (maneja el fallo
      //     transitorio correctamente: sólo limpia si SnapTrade confirma).
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/snaptrade-disconnect`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-secret": INTERNAL_SECRET,
            "Authorization": `Bearer ${SERVICE_ROLE}`,
          },
          body: JSON.stringify({ app_user_id: uid, reason }),
        });
        const j = await r.json().catch(() => ({} as any));

        if (r.ok && j?.ok && j?.disconnected) {
          disconnected++;
          await stampAttempt(admin, uid, { snaptrade_cleanup_retry_count: 0 });
          results.push({ id: uid, disconnected: true, anchor_kind: anchorKind, reason });
        } else if (j?.retry || !r.ok) {
          failed++;
          await bumpRetry(admin, uid); // fallo aguas arriba → se reintenta el ciclo siguiente
          results.push({ id: uid, disconnected: false, retry: true, error: j?.error ?? `http_${r.status}` });
        } else {
          // ok:true sin enlace vivo aguas arriba (ya estaba borrado) → hecho.
          await stampAttempt(admin, uid, { snaptrade_cleanup_retry_count: 0 });
          skipped++;
          results.push({ id: uid, disconnected: false, skipped: "already_gone" });
        }
      } catch (e: any) {
        failed++;
        await bumpRetry(admin, uid);
        results.push({ id: uid, disconnected: false, retry: true, error: String(e?.message ?? e) });
      }
    }

    // Sellado en bloque de los evaluados que no requirieron escritura propia.
    if (!dryRun && toStamp.length) {
      const { error: stErr } = await admin
        .from("profiles")
        .update({ snaptrade_cleanup_last_attempt_at: nowIso })
        .in("id", toStamp);
      // No es fatal: si falla, el peor caso es que el orden del lote no rote esta vuelta.
      if (stErr) console.error("[snaptrade-cleanup] sellado en bloque falló:", stErr.message);
    }

    const summary = {
      ok: true,
      scanned: linked.length,
      disconnected, skipped, failed, pending,
      dry_run: dryRun,
      grace_hours: GRACE_HOURS,
      orphan_grace_hours: ORPHAN_GRACE_HOURS,
      took_ms: Date.now() - startedAt,
      results,
    };

    await admin.from("snaptrade_cleanup_runs").insert({
      ok: true,
      scanned: linked.length,
      disconnected, skipped, failed, pending,
      dry_run: dryRun,
      detail: { took_ms: summary.took_ms, results },
    });

    return json(summary);
  } catch (e: any) {
    const message = String(e?.message ?? e);
    console.error("[snaptrade-cleanup] fallo:", message);
    // La bitácora del fallo es lo que dispara la alerta del health-check.
    try {
      await admin.from("snaptrade_cleanup_runs").insert({
        ok: false, scanned: results.length, disconnected, skipped, failed, pending,
        dry_run: dryRun, detail: { error: message, results },
      });
    } catch { /* si ni siquiera podemos loguear, ya está en los logs de la función */ }
    return json({ ok: false, error: message }, 500);
  }
});
