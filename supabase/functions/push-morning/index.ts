// ═══════════════════════════════════════════════════════════════════════════
//  push-morning — el evento del calendario más relevante para SU cartera
//  ───────────────────────────────────────────────────────────────────────
//  Todo el motor vive en _shared/push-rank.js y es determinista: mismo input →
//  mismo output. Cero llamadas a IA en esta ruta.
//
//  Agendado por la zona horaria del usuario para caer a las 7:30 locales. El
//  mercado objetivo (hispanos en EE.UU.) va de ET a PT: nunca asumir ET.
//
//  Deploy: supabase functions deploy push-morning --no-verify-jwt
//  Cron:   cada hora al minuto 30.
// ═══════════════════════════════════════════════════════════════════════════
// @deno-types="../_shared/push-rank.d.ts"
import {
  macroEventsForDay, eventoDeResultados, pvNewsRank, umbralPara, textoMatutino,
} from "../_shared/push-rank.js";
import type { EventoPush } from "../_shared/push-rank.d.ts";
import {
  admin, autorizado, enviarConFallback, enZona, mercadoAbierto, borrarToken,
  type FilaPortafolio, type FilaToken,
} from "../_shared/push-common.ts";

const HORA_LOCAL_OBJETIVO = 7;   // el cron corre al minuto 30 → cae 7:30 local

Deno.serve(async (req) => {
  if (!autorizado(req)) return new Response("forbidden", { status: 403 });
  const url = new URL(req.url);
  const forzar = url.searchParams.get("force") === "1";

  const ahora = new Date();
  const et = enZona(ahora, "America/New_York");
  // El calendario económico es de EE.UU.: en día sin mercado no hay nada que contar.
  if (!mercadoAbierto(et.fecha, et.diaSemana) && !forzar) {
    return json({ skip: "mercado cerrado", fecha: et.fecha });
  }

  const { data: tokens } = await admin.from("device_tokens")
    .select("id,user_id,token,environment,timezone,opt_in_am,opt_in_close")
    .eq("opt_in_am", true);
  if (!tokens?.length) return json({ enviados: 0, motivo: "sin tokens" });

  // Sólo los dispositivos cuya hora LOCAL es la de la ventana.
  const enVentana = (tokens as FilaToken[]).filter((t) => {
    try { return forzar || enZona(ahora, t.timezone).hora === HORA_LOCAL_OBJETIVO; }
    catch { return false; }                       // zona inválida → se ignora, no se adivina
  });
  if (!enVentana.length) return json({ enviados: 0, motivo: "nadie en ventana", et });

  const uids = [...new Set(enVentana.map((t) => t.user_id))];
  const { data: carteras } = await admin.from("push_portfolio")
    .select("user_id,posiciones,updated_at").in("user_id", uids);
  const porUsuario = new Map<string, FilaPortafolio>();
  for (const c of (carteras ?? []) as FilaPortafolio[]) porUsuario.set(c.user_id, c);

  // Historial de los últimos 15 días (fatiga: 3, 7 y 14 días + últimas 5 aperturas).
  const desde = new Date(ahora.getTime() - 20 * 86400000).toISOString().slice(0, 10);
  const { data: logs } = await admin.from("push_selection_log")
    .select("user_id,fecha,enviado,ganador_id,ganador_tickers,ganador_tipo,ganador_pista,abierto")
    .in("user_id", uids).gte("fecha", desde).order("fecha", { ascending: false });
  const histPorUsuario = new Map<string, any[]>();
  for (const l of logs ?? []) {
    if (!histPorUsuario.has(l.user_id)) histPorUsuario.set(l.user_id, []);
    histPorUsuario.get(l.user_id)!.push(l);
  }

  // ── Fan-out por EVENTO: el calendario macro es una función pura (una vez) y los
  // resultados del día son UNA llamada a Finnhub para todos los usuarios. El costo
  // escala con eventos, no con usuarios.
  const macro = macroEventsForDay(et.fecha);
  const earnings = await earningsDelDia(et.fecha);

  let enviados = 0, silencios = 0, fallos = 0;
  for (const tk of enVentana) {
    const cart = porUsuario.get(tk.user_id);
    // Cartera desconectada → se manda igual: el calendario es información pública y
    // no depende de sus datos. Simplemente va sin la línea de exposición.
    const holdings = (cart?.posiciones ?? []).map((p: { t: string; w: number }) => ({
      ticker: p.t.toUpperCase(), qty: p.w * 1000, price: 100 }));
    const misTickers = new Set(holdings.map((h) => h.ticker));

    const eventos = [
      ...macro,
      ...earnings.filter((e) => !!e.ticker && misTickers.has(e.ticker)),
    ];
    const historial = histPorUsuario.get(tk.user_id) ?? [];

    // Idempotencia por usuario y día. Sin esto, un reintento del cron dentro de la
    // misma hora volvía a puntuar, el anti-duplicado descartaba sólo el evento ya
    // enviado, ganaba el SEGUNDO mejor y el usuario recibía dos notificaciones.
    if (historial.some((h) => h.fecha === et.fecha && h.enviado)) { continue; }
    const umbral = umbralPara(historial);
    const r = pvNewsRank({ fechaISO: et.fecha, eventos, holdings, historial, umbral });

    if (!r.enviado || !r.ganador) {
      silencios++;
      // El silencio también se registra: sin esto no se puede responder "¿por qué
      // hoy no mandó nada?" ni recalibrar los pesos.
      await admin.from("push_selection_log").upsert({
        user_id: tk.user_id, fecha: et.fecha, enviado: false,
        motivo_no_envio: r.motivo, candidatos: r.candidatos,
      }, { onConflict: "user_id,fecha" });
      continue;
    }

    const { titulo, cuerpo } = textoMatutino(r.ganador, holdings);
    const ev = r.ganador.evento;
    const { data: fila } = await admin.from("push_selection_log").upsert({
      user_id: tk.user_id, fecha: et.fecha,
      ganador_id: ev.id, ganador_score: r.ganador.score,
      ganador_tickers: r.ganador.pista === "B" ? [ev.ticker!] : (ev.tickers ?? []),
      ganador_tipo: ev.key, ganador_pista: r.ganador.pista,
      candidatos: r.candidatos, enviado: true,
    }, { onConflict: "user_id,fecha" }).select("id").single();

    const res = await enviarConFallback({
      token: tk.token, environment: tk.environment, titulo, cuerpo,
      // Abre el calendario POSICIONADO en el evento. No el home, no la lista completa.
      deeplink: `portiv://calendario/${encodeURIComponent(ev.id)}`,
      logId: fila?.id, tituloEvento: ev.titulo, collapseId: `am-${et.fecha}`,
    });
    if (res.ok) enviados++;
    else { fallos++; if (res.borrarToken) await borrarToken(tk.token, res.reason); }
  }

  return json({ fecha: et.fecha, enVentana: enVentana.length, enviados, silencios, fallos });
});

/** Resultados del día desde Finnhub. Una sola llamada para todos los usuarios. */
async function earningsDelDia(fecha: string): Promise<EventoPush[]> {
  const KEY = Deno.env.get("FINNHUB_KEY") ?? "";
  if (!KEY) return [];
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${fecha}&to=${fecha}&token=${KEY}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.earningsCalendar ?? [])
      .filter((e: { symbol?: string }) => !!e?.symbol)
      .map((e: { symbol: string; hour?: string }) => eventoDeResultados({
        ticker: String(e.symbol).toUpperCase(), fechaISO: fecha,
        cuando: e.hour === "bmo" ? "bmo" : e.hour === "amc" ? "amc" : "",
      }));
  } catch { return []; }        // sin datos de resultados → sólo compite el macro
}

const json = (o: unknown) => new Response(JSON.stringify(o), {
  headers: { "content-type": "application/json" } });
