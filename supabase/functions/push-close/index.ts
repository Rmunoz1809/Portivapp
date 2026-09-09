// ═══════════════════════════════════════════════════════════════════════════
//  push-close — resumen del movimiento del día de la cartera
//  ───────────────────────────────────────────────────────────────────────
//  Plantilla de JS pura, sin IA. Porcentajes, nunca dólares: la pantalla de
//  bloqueo la ve quien esté al lado.
//
//  Se dispara a la MISMA hora absoluta para todos (4:05 PM ET), no en hora local:
//  el cierre del mercado ocurre en un solo instante. Mandárselo a un usuario de PT
//  a las 5 PM de su hora sería un resumen de hace cuatro horas.
//
//  Deploy: supabase functions deploy push-close --no-verify-jwt
//  Cron:   cada hora al minuto 5; la función misma decide si es la hora correcta en ET.
// ═══════════════════════════════════════════════════════════════════════════
// @deno-types="../_shared/push-rank.d.ts"
import { textoCierre } from "../_shared/push-rank.js";
import {
  admin, autorizado, enviarConFallback, enZona, mercadoAbierto, cotizaciones, borrarToken,
  type FilaPortafolio, type FilaToken,
} from "../_shared/push-common.ts";

const HORA_ET = 16;              // 4 PM ET
const MINUTO_MIN = 5;            // se deja respirar al cierre antes de leer precios; el cron
                                 // corre al minuto 5, así que la ventana tiene que empezar ahí
                                 // o la hora entera se salta y el cierre no sale nunca.
const DIAS_SNAPSHOT_MAX = 7;     // datos rancios son peores que nada

Deno.serve(async (req) => {
  if (!autorizado(req)) return new Response("forbidden", { status: 403 });
  const forzar = new URL(req.url).searchParams.get("force") === "1";

  const ahora = new Date();
  const et = enZona(ahora, "America/New_York");
  if (!forzar) {
    if (!mercadoAbierto(et.fecha, et.diaSemana)) return json({ skip: "mercado cerrado", fecha: et.fecha });
    if (et.hora !== HORA_ET || et.minuto < MINUTO_MIN) return json({ skip: "fuera de ventana", et });
  }

  // Idempotencia: si ya se mandó el cierre de hoy, no se repite.
  const { data: yaHecho } = await admin.from("push_selection_log")
    .select("id").eq("fecha", et.fecha).eq("ganador_tipo", "cierre").limit(1);
  if (yaHecho?.length && !forzar) return json({ skip: "ya enviado hoy" });

  const { data: tokens } = await admin.from("device_tokens")
    .select("id,user_id,token,environment,timezone,opt_in_am,opt_in_close")
    .eq("opt_in_close", true);
  if (!tokens?.length) return json({ enviados: 0, motivo: "sin tokens" });

  const uids = [...new Set((tokens as FilaToken[]).map((t) => t.user_id))];
  const corte = new Date(ahora.getTime() - DIAS_SNAPSHOT_MAX * 86400000).toISOString();
  const { data: carteras } = await admin.from("push_portfolio")
    .select("user_id,posiciones,updated_at").in("user_id", uids).gte("updated_at", corte);
  if (!carteras?.length) return json({ enviados: 0, motivo: "sin carteras frescas" });

  // Fan-out por EVENTO, no por usuario: una sola pasada de cotizaciones para la
  // unión de tickers. El costo escala con tickers distintos, no con usuarios.
  const universo = (carteras as FilaPortafolio[]).flatMap((c) => (c.posiciones || []).map((p) => p.t));
  const quotes = await cotizaciones(universo);

  const porUsuario = new Map<string, FilaPortafolio>();
  for (const c of carteras as FilaPortafolio[]) porUsuario.set(c.user_id, c);

  let enviados = 0, sinDatos = 0, fallos = 0;
  for (const tk of tokens as FilaToken[]) {
    const cart = porUsuario.get(tk.user_id);
    if (!cart) continue;

    // El motor pide {ticker, qty, price, dayChgPct}. Se reconstruye con peso y precio
    // ficticio 100: sólo importan las PROPORCIONES, y así el dinero real nunca sale
    // del teléfono. Un ticker sin cotización se descarta — jamás se estima.
    const holdings = (cart.posiciones || [])
      .filter((p) => quotes.has(p.t.toUpperCase()))
      .map((p) => ({ ticker: p.t.toUpperCase(), qty: p.w * 1000, price: 100,
                     dayChgPct: quotes.get(p.t.toUpperCase())! }));
    const texto = textoCierre(holdings);
    if (!texto) { sinDatos++; continue; }

    const r = await enviarConFallback({
      token: tk.token, environment: tk.environment,
      titulo: texto.titulo, cuerpo: texto.cuerpo,
      // Abre el DETALLE de la posición mencionada. Si abriera el home, el usuario
      // mira el total y cierra.
      deeplink: `portiv://posicion/${texto.ticker}`,
      collapseId: `cierre-${et.fecha}`,
    });
    if (r.ok) enviados++;
    else { fallos++; if (r.borrarToken) await borrarToken(tk.token, r.reason); }
  }

  await admin.from("push_selection_log").upsert({
    user_id: null, fecha: et.fecha, ganador_id: `cierre_${et.fecha}`,
    ganador_tipo: "cierre", enviado: enviados > 0,
    motivo_no_envio: enviados ? null : "sin destinatarios con datos",
    candidatos: { enviados, sinDatos, fallos },
  }, { onConflict: "user_id,fecha" });

  return json({ enviados, sinDatos, fallos });
});

const json = (o: unknown) => new Response(JSON.stringify(o), {
  headers: { "content-type": "application/json" } });
