// snaptrade-health — Edge Function (Deno) · cron cada 3 h
// ─────────────────────────────────────────────────────────────────────────────
// Vigía de las conexiones de broker de TODOS los usuarios enlazados.
//
// Hasta ahora una conexión caída sólo se descubría por dos vías: el webhook
// CONNECTION_BROKEN de SnapTrade (si llega) o que el usuario abriera la app. Si el
// webhook se perdía y el usuario no entraba en una semana, su cartera llevaba una semana
// congelada sin que nadie lo supiera, y al abrir la app se encontraba "Reconecta tu
// broker" de golpe. Esta función pregunta a SnapTrade por cada enlazado (lectura gratuita,
// NO es una sincronización facturada), deja el perfil coherente y, si alguna conexión está
// caída, le manda un push con el arreglo a un toque (_shared/broker-alert.ts). Mientras
// siga caída, recuerda como mucho cada 72 h.
//
// Garantía de diseño: esta función JAMÁS borra ni desconecta nada. Ni en SnapTrade ni en
// el perfil. Lo peor que puede hacer es avisar de más.
//
// Auth: header `x-cron-secret` == SNAPTRADE_CRON_SECRET (el mismo de snaptrade-cleanup).
// Body opcional: { "user_id": "<uuid>" } → revisa sólo ese usuario (diagnóstico).
// Deploy: supabase functions deploy snaptrade-health --no-verify-jwt

import { adminClient, snaptrade, isUuid } from "../_shared/snaptrade.ts";
import { inspectAndAlert, type HealthResult } from "../_shared/broker-alert.ts";

const CRON_SECRET = Deno.env.get("SNAPTRADE_CRON_SECRET") ?? "";
// Los rate limits de SnapTrade son por clientId (el proyecto entero): pocas a la vez.
const CONCURRENCY = 3;
const MAX_USERS = Number(Deno.env.get("SNAPTRADE_HEALTH_MAX") ?? "400");

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  // Fail-closed, igual que snaptrade-cleanup: sin secreto no corre nada.
  if (!CRON_SECRET) {
    console.error("[snaptrade-health] SNAPTRADE_CRON_SECRET sin configurar — ejecución rechazada");
    return json({ ok: false, error: "health not configured" }, 503);
  }
  if ((req.headers.get("x-cron-secret") ?? "") !== CRON_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* opcional */ }
  const onlyUser = isUuid(body?.user_id) ? body.user_id : null;

  const admin = adminClient();
  const startedAt = Date.now();
  try {
    let q = admin
      .from("profiles")
      .select("id")
      .not("snaptrade_user_id", "is", null)
      .not("snaptrade_user_secret", "is", null)
      .limit(MAX_USERS);
    if (onlyUser) q = q.eq("id", onlyUser);
    const { data, error } = await q;
    if (error) throw new Error(`profiles: ${error.message}`);
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);

    const st = snaptrade();
    const results: HealthResult[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= ids.length) return;
        results[i] = await inspectAndAlert(admin, st, ids[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));

    const summary = {
      ok: true,
      scanned: ids.length,
      unreadable: results.filter((r) => !r.ok).length,
      with_disabled: results.filter((r) => r.disabled > 0).length,
      notified: results.reduce((s, r) => s + (r.notified > 0 ? 1 : 0), 0),
      changed: results.filter((r) => r.changed).length,
      took_ms: Date.now() - startedAt,
      // Sólo lo que merece mirarse; los sanos no aportan nada a la bitácora.
      issues: results.filter((r) => !r.ok || r.disabled > 0 || r.changed),
    };
    console.log("[snaptrade-health]", JSON.stringify({ ...summary, issues: summary.issues.length }));
    return json(summary);
  } catch (e: any) {
    const message = String(e?.message ?? e);
    console.error("[snaptrade-health] fallo:", message);
    return json({ ok: false, error: message }, 500);
  }
});
