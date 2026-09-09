// Piezas compartidas por push-close y push-morning.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const admin = createClient(
  Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });

export const CRON_SECRET = Deno.env.get("PUSH_CRON_SECRET") ?? "";
export function autorizado(req: Request): boolean {
  const h = req.headers.get("x-cron-secret") ?? "";
  return CRON_SECRET.length > 0 && h === CRON_SECRET;
}

/** Partes de fecha/hora de un instante en una zona IANA. Sin librerías. */
export function enZona(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    hora: +p.hour % 24,
    minuto: +p.minute,
    diaSemana: p.weekday,           // 'Mon' … 'Sun'
  };
}

export const esFinDeSemana = (w: string) => w === "Sat" || w === "Sun";

// Feriados de NYSE. Si falta el año en curso, `mercadoAbierto` devuelve false para
// TODO ese año: preferimos no mandar nada a mandar un cierre en un día sin cierre.
export const FERIADOS_NYSE: Record<string, string[]> = {
  "2026": ["2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19",
           "2026-07-03","2026-09-07","2026-11-26","2026-12-25"],
  "2027": ["2027-01-01","2027-01-18","2027-02-15","2027-03-26","2027-05-31","2027-06-18",
           "2027-07-05","2027-09-06","2027-11-25","2027-12-24"],
};

export function mercadoAbierto(fechaET: string, diaSemana: string): boolean {
  if (esFinDeSemana(diaSemana)) return false;
  const anio = fechaET.slice(0, 4);
  const lista = FERIADOS_NYSE[anio];
  if (!lista) return false;                       // año no cargado → silencio, no adivinar
  return !lista.includes(fechaET);
}

/** Cotizaciones del día en LOTE: una llamada por ticker único de TODOS los usuarios. */
export async function cotizaciones(tickers: string[]): Promise<Map<string, number>> {
  const KEY = Deno.env.get("FINNHUB_KEY") ?? "";
  const out = new Map<string, number>();
  if (!KEY) return out;
  const unicos = [...new Set(tickers.map((t) => t.toUpperCase()))];
  const LOTE = 8;
  for (let i = 0; i < unicos.length; i += LOTE) {
    await Promise.all(unicos.slice(i, i + LOTE).map(async (t) => {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${KEY}`);
        if (!r.ok) return;
        const j = await r.json();
        // dp = cambio porcentual del día. Sin dato → el ticker se omite; NUNCA se estima.
        if (typeof j?.dp === "number" && Number.isFinite(j.dp)) out.set(t, j.dp);
      } catch { /* un ticker que falla no tumba el lote */ }
    }));
  }
  return out;
}

export type FilaPortafolio = { user_id: string; posiciones: { t: string; w: number }[]; updated_at: string };
export type FilaToken = {
  id: string; user_id: string; token: string;
  environment: "sandbox" | "production"; timezone: string;
  opt_in_am: boolean; opt_in_close: boolean;
};

/** Borra un token que Apple rechazó por muerto. */
export async function borrarToken(token: string, motivo: string) {
  console.log("[push] token muerto, se borra:", motivo);
  await admin.from("device_tokens").delete().eq("token", token);
}

import { enviarPush, type Envio, type Resultado } from "./apns.ts";

/**
 * Envía corrigiendo el entorno solo.
 *
 * El cliente NO puede saber con certeza si su token es de sandbox o de producción
 * (iOS no se lo dice al JS), así que manda su mejor conjetura. Si Apple responde
 * BadDeviceToken, casi siempre significa "token del OTRO entorno": se reintenta en
 * el host contrario y, si funciona, se corrige la fila para siempre. Sin esto, el
 * bug clásico es que todo anda en TestFlight y en producción no llega nada.
 *
 * Sólo se borra el token cuando Apple dice que está muerto de verdad
 * (410 Unregistered / DeviceTokenNotForTopic).
 */
export async function enviarConFallback(e: Envio): Promise<Resultado> {
  const r = await enviarPush(e);
  if (r.ok || r.status === 0) return r;
  if (r.reason !== "BadDeviceToken") return r;

  const otro: "sandbox" | "production" = e.environment === "production" ? "sandbox" : "production";
  const r2 = await enviarPush({ ...e, environment: otro });
  if (r2.ok) {
    await admin.from("device_tokens")
      .update({ environment: otro, updated_at: new Date().toISOString() })
      .eq("token", e.token);
    console.log("[push] entorno corregido a", otro);
  }
  return r2;
}
