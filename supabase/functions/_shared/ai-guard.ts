// _shared/ai-guard.ts — puerta común de los proxies de IA (anthropic-proxy, gemini-proxy).
// ─────────────────────────────────────────────────────────────────────────────
// Por qué existe (3 nov 2026): anthropic-proxy aceptaba la ANON key, que viaja en el HTML
// público de portivapp.com. Cualquiera podía usar Claude con la key de Portiv, con el modelo
// que quisiera y sin techo. gemini-proxy ya exigía sesión, pero un usuario gratis podía hacer
// un bucle infinito o pedir un modelo caro. Aquí van, una sola vez para los dos:
//   · identidad: JWT de usuario (rol authenticated) — la anon key no entra;
//   · modelos: sólo las familias que usa la app;
//   · tamaño del cuerpo: tope duro antes de leerlo;
//   · cupo por usuario: ráfaga por minuto + tope diario (bump_rate_limit, service role);
//   · registro de consumo en ai_usage (fire-and-forget) para vigilar el gasto.
// verify_jwt:true de la plataforma ya validó la FIRMA del token antes de llegar aquí, así
// que basta con leer sus claims.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db = SUPABASE_URL && SERVICE_ROLE
  ? createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

// Visión manda imágenes en base64 (ya reducidas por _prepImagesForOCR): 8 MB sobra.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

// perDay es por usuario; globalPerDay, para TODOS juntos: con «Confirm email» apagado una
// persona puede abrir cuentas sin fin, y el tope por usuario no basta como techo de gasto.
export type AiLimits = { perMinute: number; perDay: number; globalPerDay: number };

// Fila de rate_limits que lleva la cuenta global (no es un usuario real).
const GLOBAL_UID = "00000000-0000-0000-0000-000000000000";

type Claims = { role: string; sub: string };

function claimsOf(req: Request): Claims {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  try {
    const p = tok.split(".")[1];
    if (!p) return { role: "", sub: "" };
    const b = atob(p.replace(/-/g, "+").replace(/_/g, "/"));
    const j = JSON.parse(b) || {};
    return { role: String(j.role || ""), sub: String(j.sub || "") };
  } catch {
    return { role: "", sub: "" };
  }
}

export type GuardResult =
  | { ok: true; userId: string | null }
  | { ok: false; status: number; body: Record<string, unknown> };

const fail = (status: number, message: string, error_code: string): GuardResult =>
  ({ ok: false, status, body: { error: { message }, error_code } });

/**
 * Identidad + tamaño + cupo. `bucket` distingue el proxy ('anthropic' | 'gemini').
 * Si la base no responde, se deja pasar (fail-open): cortar la IA a todos por un fallo
 * nuestro es peor que unos minutos sin tope; la identidad sí es obligatoria siempre.
 */
export async function guardAi(req: Request, bucket: string, limits: AiLimits): Promise<GuardResult> {
  const { role, sub } = claimsOf(req);
  if (role === "service_role") return { ok: true, userId: null };
  if (role !== "authenticated" || !/^[0-9a-f-]{36}$/i.test(sub)) {
    return fail(401, "Inicia sesión para usar las funciones de IA.", "auth_required");
  }

  const len = Number(req.headers.get("content-length") || "0");
  if (len > MAX_BODY_BYTES) return fail(413, "La solicitud es demasiado grande.", "too_large");

  if (db) {
    try {
      const [m, d, all] = await Promise.all([
        db.rpc("bump_rate_limit", { p_user: sub, p_bucket: `ai:${bucket}:min`, p_max: limits.perMinute, p_window_secs: 60 }),
        db.rpc("bump_rate_limit", { p_user: sub, p_bucket: `ai:${bucket}:day`, p_max: limits.perDay, p_window_secs: 86400 }),
        db.rpc("bump_rate_limit", { p_user: GLOBAL_UID, p_bucket: `ai:${bucket}:global`, p_max: limits.globalPerDay, p_window_secs: 86400 }),
      ]);
      if (m.data === false) return fail(429, "Vas muy rápido. Espera un minuto e inténtalo de nuevo.", "rate_limited");
      if (d.data === false) return fail(429, "Alcanzaste tu límite diario de IA. Vuelve mañana.", "daily_limit");
      if (all.data === false) {
        console.error(`[ai-guard] tope GLOBAL diario de ${bucket} alcanzado (${limits.globalPerDay})`);
        return fail(503, "La IA está saturada en este momento. Inténtalo más tarde.", "global_limit");
      }
    } catch (_e) { /* fail-open */ }
  }
  return { ok: true, userId: sub };
}

/** ¿El modelo pedido pertenece a una familia permitida? */
export function modelAllowed(model: string, allow: RegExp[]): boolean {
  const m = String(model || "").toLowerCase();
  return allow.some((re) => re.test(m));
}

/** Anota el consumo de una llamada. Nunca lanza ni retrasa la respuesta. */
export function logUsage(source: string, userId: string | null, model: string, usage: any) {
  if (!db || !usage) return;
  const row = {
    source,
    user_id: userId,
    model,
    tokens_in: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0,
    tokens_out: Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0,
    cache_read: Number(usage.cache_read_input_tokens ?? 0) || 0,
    cache_write: Number(usage.cache_creation_input_tokens ?? 0) || 0,
  };
  // EdgeRuntime.waitUntil mantiene viva la promesa tras responder; si no existe, se suelta.
  const p = db.from("ai_usage").insert(row).then(() => {}, () => {});
  try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch (_e) { /* nada */ }
}
