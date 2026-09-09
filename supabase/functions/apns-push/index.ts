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
import { admin, autorizado, borrarToken } from "../_shared/push-common.ts";

Deno.serve(async (req) => {
  if (!await autorizado(req)) return new Response("forbidden", { status: 403 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const body = await req.json().catch(() => null);
  const titulo = String(body?.titulo ?? "").trim();
  const cuerpo = String(body?.cuerpo ?? "").trim();
  const deeplink = String(body?.deeplink ?? "portiv://home");
  if (!titulo || !cuerpo) return json({ error: "titulo y cuerpo son obligatorios" }, 400);

  // Destino: un token explícito, o todos los de un usuario.
  let filas: { token: string; environment: "sandbox" | "production" }[] = [];
  if (body?.token) {
    filas = [{ token: String(body.token), environment: body.environment === "production" ? "production" : "sandbox" }];
  } else if (body?.user_id) {
    const { data } = await admin.from("device_tokens")
      .select("token,environment").eq("user_id", String(body.user_id));
    filas = (data ?? []) as typeof filas;
  } else {
    return json({ error: "hace falta token o user_id" }, 400);
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
