// creators-webhook — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Webhook de RevenueCat para el programa de creadores (Offer Codes). Recibe el evento crudo,
// lo guarda de forma idempotente y calcula atribución y comisiones con
// public.creators_process_event(). No toca el acceso Pro: eso sigue siendo de rc-webhook.
//
// Dos formas de alimentarlo (las dos pueden convivir: el procesado es idempotente por event id):
//   1. rc-webhook ya le pasa cada evento por dentro (processCreatorEvent), sin configurar nada
//      más en RevenueCat.
//   2. Como SEGUNDO webhook de RevenueCat (plan Pro): Integrations → Webhooks → Add new
//      configuration, URL https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/creators-webhook,
//      Authorization = valor de CREATORS_WEBHOOK_SECRET (literal, sin "Bearer"), entorno: ambos.
//
// También lo usa scripts/creadores/evento-prueba.mjs para mandar eventos simulados.
//
// Secretos (supabase secrets set):
//   CREATORS_WEBHOOK_SECRET   obligatorio. Sin él la función responde 500 y no procesa nada.
//   CREATORS_ACCEPT_SANDBOX   "true" para que los eventos de sandbox atribuyan (pruebas).
//
// Deploy: supabase functions deploy creators-webhook --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { processCreatorEvent, safeEqual } from "../_shared/creators.ts";

const SECRET = Deno.env.get("CREATORS_WEBHOOK_SECRET") ?? "";
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const log = (...a: unknown[]) => console.log("[creators-webhook]", ...a);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  if (!SECRET) {
    log("FATAL: CREATORS_WEBHOOK_SECRET no configurado");
    return json({ error: "server_misconfigured" }, 500);
  }
  const presented = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!safeEqual(presented, SECRET)) {
    log("unauthorized");
    return new Response("Unauthorized", { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const ev = body?.event ?? body;
  if (!ev || typeof ev !== "object" || !ev.id || !ev.type) return json({ error: "missing_id_or_type" }, 400);

  const r = await processCreatorEvent(admin, ev);
  if (!r.ok) {
    // 5xx → RevenueCat reintenta; el procesado es idempotente.
    log("error", ev.id, ev.type, r.error);
    return json({ ok: false, error: r.error }, 500);
  }
  log(ev.type, ev.environment ?? "", r.duplicate ? "duplicate" : r.result);
  return json(r);
});
