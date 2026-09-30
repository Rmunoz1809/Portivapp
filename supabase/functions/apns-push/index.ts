// ═══════════════════════════════════════════════════════════════════════════
//  apns-push — envío manual de UN push. Para pruebas y reenvíos puntuales.
//  Los envíos programados NO pasan por aquí: push-morning y push-close importan
//  _shared/apns.ts directamente y se ahorran un salto de red por destinatario.
//
//  Deploy:  supabase functions deploy apns-push --no-verify-jwt
//  Secrets: supabase secrets set APNS_KEY_P8="$(cat AuthKey_XXXX.p8)" \
//                                APNS_KEY_ID=XXXXXXXXXX APNS_TEAM_ID=K97579JSV7 \
//                                PUSH_CRON_SECRET="…"
// ═══════════════════════════════════════════════════════════════════════════
import { enviarPush } from "../_shared/apns.ts";
import { admin, autorizado, borrarToken, enviarConFallback } from "../_shared/push-common.ts";

Deno.serve(async (req) => {
  if (!await autorizado(req)) return new Response("forbidden", { status: 403 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const body = await req.json().catch(() => null);
  const titulo = String(body?.titulo ?? "").trim();
  const cuerpo = String(body?.cuerpo ?? "").trim();
  const deeplink = String(body?.deeplink ?? "portiv://home");
  if (!titulo || !cuerpo) return json({ error: "titulo y cuerpo son obligatorios" }, 400);

  // Destino: un token explícito, todos los de un usuario, o TODOS los dispositivos
  // (`todos: true`, p. ej. el aviso de versión nueva). `dry_run: true` sólo cuenta.
  let filas: { token: string; environment: "sandbox" | "production" }[] = [];
  if (body?.todos === true) {
    const { data } = await admin.from("device_tokens").select("token,environment");
    filas = (data ?? []) as typeof filas;
    if (body?.dry_run === true) return json({ destinatarios: filas.length, titulo, cuerpo, deeplink });
    let enviados = 0, fallidos = 0;
    // Lotes de 10 en paralelo: APNs aguanta mucho más, pero así un fallo no se lleva todo.
    for (let i = 0; i < filas.length; i += 10) {
      await Promise.all(filas.slice(i, i + 10).map(async (f) => {
        const r = await enviarConFallback({ token: f.token, environment: f.environment, titulo, cuerpo, deeplink });
        if (r.ok) enviados++; else { fallidos++; if (r.borrarToken) await borrarToken(f.token, r.reason); }
      }));
    }
    return json({ destinatarios: filas.length, enviados, fallidos });
  } else if (body?.token) {
    filas = [{ token: String(body.token), environment: body.environment === "production" ? "production" : "sandbox" }];
  } else if (body?.user_id) {
    const { data } = await admin.from("device_tokens")
      .select("token,environment").eq("user_id", String(body.user_id));
    filas = (data ?? []) as typeof filas;
  } else {
    return json({ error: "hace falta token, user_id o todos" }, 400);
  }
  if (!filas.length) return json({ error: "sin destinatarios" }, 404);

  const resultados = [];
  for (const f of filas) {
    const r = await enviarPush({ token: f.token, environment: f.environment, titulo, cuerpo, deeplink });
    if (!r.ok && r.borrarToken) await borrarToken(f.token, r.reason);
    resultados.push({ token: f.token.slice(0, 8) + "…", ...r });
  }
  return json({ resultados });
});

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
