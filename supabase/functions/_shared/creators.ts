// Creadores / afiliados — pieza común de creators-webhook y rc-webhook.
// Toda la lógica (atribución por Offer Code, comisión, reembolsos, sandbox, idempotencia) vive
// en SQL: public.creators_process_event() (migración 20261123120000_creadores_v2.sql), probada
// con supabase/tests/creators. Aquí solo se le pasa el evento crudo de RevenueCat.

// deno-lint-ignore no-explicit-any
type Admin = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };

// CREATORS_ACCEPT_SANDBOX=true → los eventos de sandbox también atribuyen y generan comisiones
// (marcadas is_sandbox, nunca entran en un pago). Sin él, se guardan y no se procesan.
export const CREATORS_ACCEPT_SANDBOX =
  (Deno.env.get("CREATORS_ACCEPT_SANDBOX") ?? "").toLowerCase() === "true";

export type CreatorResult = { ok: boolean; result?: string; duplicate?: boolean; error?: string };

// Nunca lanza. ok:false = no se pudo guardar/procesar (el llamador decide si reintentar).
export async function processCreatorEvent(
  admin: Admin,
  ev: Record<string, unknown>,
): Promise<CreatorResult> {
  try {
    const { data, error } = await admin.rpc("creators_process_event", {
      p: ev,
      p_accept_sandbox: CREATORS_ACCEPT_SANDBOX,
    });
    if (error) return { ok: false, error: String(error.message ?? error) };
    return (data ?? { ok: false, error: "empty_response" }) as CreatorResult;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Comparación en tiempo constante (no filtra longitud ni prefijo del secreto por timing).
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
