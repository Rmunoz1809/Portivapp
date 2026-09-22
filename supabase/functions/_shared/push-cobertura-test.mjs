// ═══════════════════════════════════════════════════════════════════════════
//  push-cobertura-test — ¿sale la matutina TODOS los días y para TODOS?
//  ───────────────────────────────────────────────────────────────────────────
//  El 2026-09-22 la matutina pasó a ser diaria (umbral fuera + respaldo para los
//  días sin calendario). Este arnés comprueba que la promesa se cumple: recorre
//  todos los días hábiles de NYSE de 2026 y, por cada uno, simula el bucle real
//  de push-morning/index.ts con siete perfiles de cartera distintos, arrastrando
//  el historial día a día para que la fatiga y el anti-duplicado actúen de verdad.
//
//  Comprueba por día y por usuario:
//    · que SALE algo (evento o respaldo), nunca silencio
//    · que el texto cabe en la pantalla de bloqueo (título ≤35, cuerpo ≤110)
//    · que no viola las reglas de copy (imperativos, emoji)
//    · que el respaldo NUNCA guarda el id de un evento futuro (lo tacharía el
//      día que de verdad toca, por el anti-duplicado de 7 días)
//
//  Correr:  TZ=America/New_York node supabase/functions/_shared/push-cobertura-test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import {
  macroEventsForDay, eventoDeResultados, pvNewsRank, textoMatutino,
  proximoMacro, textoMatutinoSinEventos, violacionesDeCopy, iso, fromISO,
} from './push-rank.js';

const FERIADOS = ['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
  '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'];
const LIM_TITULO = 35, LIM_CUERPO = 110;

/* Siete perfiles. Cubren los casos que cambian el resultado del motor: sin datos,
   sólo ETF amplio (descuento 0.3), concentración total, tickers que ningún macro
   menciona, y carteras con resultados propios. */
const mk = (ts) => ts.map((t) => ({ ticker: t, qty: 10, price: 100 }));
const PERFILES = [
  { nombre: 'sin cartera',            holdings: [] },
  { nombre: 'sólo VOO (ETF amplio)',  holdings: mk(['VOO']) },
  { nombre: 'concentrada NVDA',       holdings: mk(['NVDA']) },
  { nombre: 'ajena al macro (KO/PG)', holdings: mk(['KO','PG']) },
  { nombre: 'diversificada 12',       holdings: mk(['AAPL','MSFT','NVDA','AMZN','VOO','TSM','MU','MA','APP','KO','PG','XOM']) },
  { nombre: 'sectorial XLF/SMH',      holdings: mk(['XLF','SMH']) },
  { nombre: 'con resultados propios', holdings: mk(['AAPL','NVDA','KO']), earnings: ['AAPL','NVDA','KO'] },
];

/** Días hábiles de NYSE de 2026 (mismo criterio que mercadoAbierto()). */
function diasHabiles2026() {
  const out = [];
  for (let d = fromISO('2026-01-01'); d.getUTCFullYear() === 2026; d = new Date(d.getTime() + 86400000)) {
    const dow = d.getUTCDay();
    const f = iso(d);
    if (dow === 0 || dow === 6 || FERIADOS.includes(f)) continue;
    out.push(f);
  }
  return out;
}

/* Resultados del día: Finnhub devuelve un universo abierto y no reproducible.
   Se simula determinista — cada ticker del perfil presenta una vez por trimestre —
   para que el resultado del arnés no dependa de la red. */
function earningsDe(perfil, fecha) {
  if (!perfil.earnings) return [];
  const dia = fromISO(fecha);
  const mes = dia.getUTCMonth(), dom = dia.getUTCDate();
  if (![0, 3, 6, 9].includes(mes)) return [];
  return perfil.earnings
    .filter((t, i) => dom === 20 + i)
    .map((t) => eventoDeResultados({ ticker: t, fechaISO: fecha, cuando: 'bmo' }));
}

const dias = diasHabiles2026();
let casos = 0, fallos = 0, respaldos = 0, porEvento = 0;
const motivosRespaldo = new Map();
const err = (f, p, msg) => { fallos++; if (fallos <= 15) console.log(`  ✗ ${f} · ${p} · ${msg}`); };

for (const perfil of PERFILES) {
  const historial = [];                       // más recientes primero, como en index.ts
  let resPerfil = 0;
  for (const fecha of dias) {
    casos++;
    const eventos = [...macroEventsForDay(fecha), ...earningsDe(perfil, fecha)];
    // El umbral es el de producción: 0. El ranking elige QUÉ, no SI.
    const r = pvNewsRank({ fechaISO: fecha, eventos, holdings: perfil.holdings, historial, umbral: 0 });

    let titulo, cuerpo, fila;
    if (r.enviado && r.ganador) {
      porEvento++;
      ({ titulo, cuerpo } = textoMatutino(r.ganador, perfil.holdings));
      const ev = r.ganador.evento;
      fila = { fecha, enviado: true, ganador_id: ev.id, ganador_pista: r.ganador.pista,
               ganador_tipo: ev.key, abierto: false,
               ganador_tickers: r.ganador.pista === 'B' ? [ev.ticker] : (ev.tickers ?? []) };
    } else {
      respaldos++; resPerfil++;
      motivosRespaldo.set(r.motivo, (motivosRespaldo.get(r.motivo) || 0) + 1);
      const prox = proximoMacro(fecha);
      ({ titulo, cuerpo } = textoMatutinoSinEventos(fecha, prox));
      fila = { fecha, enviado: true, ganador_id: `sinev_${fecha}`, ganador_pista: 'A',
               ganador_tipo: 'sin_eventos', ganador_tickers: [], abierto: false };
      // El respaldo NO puede reservar el id del evento que viene.
      if (prox && fila.ganador_id === prox.evento.id) err(fecha, perfil.nombre, 'el respaldo guardó el id del próximo evento');
      if (prox && prox.evento.fecha <= fecha) err(fecha, perfil.nombre, `proximoMacro devolvió ${prox.evento.fecha}, no es futuro`);
    }

    if (!titulo || !cuerpo) err(fecha, perfil.nombre, 'sin texto');
    if (titulo.length > LIM_TITULO) err(fecha, perfil.nombre, `título ${titulo.length} > ${LIM_TITULO}: "${titulo}"`);
    if (cuerpo.length > LIM_CUERPO) err(fecha, perfil.nombre, `cuerpo ${cuerpo.length} > ${LIM_CUERPO}: "${cuerpo}"`);
    const v = violacionesDeCopy(`${titulo} ${cuerpo}`);
    if (v.length) err(fecha, perfil.nombre, `copy: ${v.join(', ')}`);

    historial.unshift(fila);
    if (historial.length > 25) historial.pop();      // index.ts sólo carga 20 días
  }
  console.log(`  · ${perfil.nombre.padEnd(24)} ${dias.length} días, ${dias.length - resPerfil} por evento, ${resPerfil} de respaldo`);
}

console.log(`\nDías hábiles NYSE 2026: ${dias.length} · perfiles: ${PERFILES.length} · casos: ${casos}`);
console.log(`Por evento: ${porEvento} (${(100*porEvento/casos).toFixed(1)}%) · de respaldo: ${respaldos} (${(100*respaldos/casos).toFixed(1)}%)`);
console.log('Motivos del respaldo:', [...motivosRespaldo].map(([k,n]) => `${k}=${n}`).join(', ') || '—');
console.log(fallos === 0
  ? `\n✓ ${casos} casos: sale notificación TODOS los días hábiles, para los ${PERFILES.length} perfiles`
  : `\n✗ ${fallos} fallos de ${casos} casos`);
process.exit(fallos === 0 ? 0 : 1);
