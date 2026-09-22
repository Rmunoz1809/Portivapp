// ═══════════════════════════════════════════════════════════════════════════
//  push-morning — el evento del calendario más relevante para SU cartera
//  ───────────────────────────────────────────────────────────────────────
//  Todo el motor vive en _shared/push-rank.js y es determinista: mismo input →
//  mismo output. Cero llamadas a IA en esta ruta.
//
//  Se dispara a las 8:30 ET, una hora antes de la apertura, a la MISMA hora
//  absoluta para todos. El calendario económico es de EE.UU. y la apertura es un
//  instante único: adelantarlo o atrasarlo por la hora local del usuario haría que
//  el aviso llegue con el mercado ya abierto (PT) o de madrugada.
//
//  Deploy: supabase functions deploy push-morning --no-verify-jwt
//  Cron:   cada hora al minuto 30.
// ═══════════════════════════════════════════════════════════════════════════
// @deno-types="../_shared/push-rank.d.ts"
import {
  macroEventsForDay, eventoDeResultados, pvNewsRank, textoMatutino,
  proximoMacro, textoMatutinoSinEventos,
} from "../_shared/push-rank.js";
import type { EventoPush } from "../_shared/push-rank.d.ts";
import {
  admin, autorizado, enviarConFallback, enZona, mercadoAbierto, borrarToken,
  type FilaPortafolio, type FilaToken,
} from "../_shared/push-common.ts";

const HORA_ET = 8;               // el cron corre al minuto 30 → cae 8:30 ET (apertura 9:30)

/* Umbral de la matutina: NINGUNO. Decisión de producto del 2026-09-22.
   El umbral de 45 (`umbralPara()`) silenciaba casi todos los días: el dryRun ya
   avisaba de 0.9–1.6 avisos por semana, y el 22-sep el mejor candidato del día
   sacó 31.53 — el log quedó en `bajo_umbral(31.53<45)` y no salió nada.
   El aviso de antes de la apertura pasa a ser DIARIO en día de mercado: el
   ranking ya no decide SI se manda, sólo QUÉ se manda. Los días en que el
   calendario no publica nada los cubre `textoMatutinoSinEventos()`.
   `umbralPara()` y `UMBRAL_BASE` siguen en el motor para el arnés de calibración. */
const UMBRAL_MATUTINO = 0;

Deno.serve(async (req) => {
  if (!await autorizado(req)) return new Response("forbidden", { status: 403 });
  const url = new URL(req.url);
  const forzar = url.searchParams.get("force") === "1";

  const ahora = new Date();
  const et = enZona(ahora, "America/New_York");
  // El calendario económico es de EE.UU.: en día sin mercado no hay nada que contar.
  if (!forzar) {
    if (!mercadoAbierto(et.fecha, et.diaSemana)) return json({ skip: "mercado cerrado", fecha: et.fecha });
    if (et.hora !== HORA_ET) return json({ skip: "fuera de ventana", et });
  }

  const { data: tokens } = await admin.from("device_tokens")
    .select("id,user_id,token,environment,timezone,opt_in_am,opt_in_close")
    .eq("opt_in_am", true);
  if (!tokens?.length) return json({ enviados: 0, motivo: "sin tokens" });

  // La ventana ya se decidió arriba en ET: aquí entran todos los que la pidieron.
  const enVentana = tokens as FilaToken[];

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

  let enviados = 0, respaldos = 0, fallos = 0;
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
    const r = pvNewsRank({
      fechaISO: et.fecha, eventos, holdings, historial, umbral: UMBRAL_MATUTINO });

    let titulo: string, cuerpo: string, deeplinkId: string, tituloEvento: string;
    let logRow: Record<string, unknown>;

    if (r.enviado && r.ganador) {
      const ev = r.ganador.evento;
      ({ titulo, cuerpo } = textoMatutino(r.ganador, holdings));
      deeplinkId = ev.id;
      tituloEvento = ev.titulo;
      logRow = {
        ganador_id: ev.id, ganador_score: r.ganador.score,
        ganador_tickers: r.ganador.pista === "B" ? [ev.ticker!] : (ev.tickers ?? []),
        ganador_tipo: ev.key, ganador_pista: r.ganador.pista,
        candidatos: r.candidatos,
      };
    } else {
      // Sin candidatos hoy (o todos descartados por el anti-duplicado de 7 días).
      // Se cuenta qué viene, que es información real, en vez de callar.
      respaldos++;
      const prox = proximoMacro(et.fecha);
      ({ titulo, cuerpo } = textoMatutinoSinEventos(et.fecha, prox));
      // El deeplink apunta al PRÓXIMO evento, pero el log NO guarda su id: el
      // anti-duplicado de 7 días lo daría por enviado y lo tacharía el día que
      // de verdad toca. Por eso un id sintético que no colisiona con ninguno.
      deeplinkId = prox ? prox.evento.id : "";
      tituloEvento = prox ? prox.evento.titulo : "";
      logRow = {
        ganador_id: `sinev_${et.fecha}`, ganador_score: 0,
        ganador_tickers: [], ganador_tipo: "sin_eventos", ganador_pista: "A",
        candidatos: r.candidatos, motivo_no_envio: r.motivo,
      };
    }

    const { data: fila } = await admin.from("push_selection_log").upsert({
      user_id: tk.user_id, fecha: et.fecha, enviado: true, ...logRow,
    }, { onConflict: "user_id,fecha" }).select("id").single();

    const res = await enviarConFallback({
      token: tk.token, environment: tk.environment, titulo, cuerpo,
      // Abre el calendario POSICIONADO en el evento. No el home, no la lista completa.
      deeplink: `portiv://calendario/${encodeURIComponent(deeplinkId)}`,
      logId: fila?.id, tituloEvento, collapseId: `am-${et.fecha}`,
    });
    if (res.ok) enviados++;
    else { fallos++; if (res.borrarToken) await borrarToken(tk.token, res.reason); }
  }

  return json({ fecha: et.fecha, enVentana: enVentana.length, enviados, respaldos, fallos });
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
