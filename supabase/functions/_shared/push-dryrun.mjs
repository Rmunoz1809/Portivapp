// Calibración del motor matutino — 30 días × 3 carteras sintéticas.
// REVISIÓN HUMANA OBLIGATORIA antes de mandar un solo push real.
// La simulación es SECUENCIAL: cada día ve el historial que generaron los días
// anteriores, porque las reglas de fatiga dependen de lo que ya se envió.
//
//   TZ=America/New_York node supabase/functions/_shared/push-dryrun.mjs
import {
  macroEventsForDay, eventoDeResultados, pvNewsRank, umbralPara,
  textoMatutino, violacionesDeCopy, iso, fromISO,
} from './push-rank.js';

const mkH = (pares) => pares.map(([ticker, peso]) => ({ ticker, qty: peso * 1000, price: 100 }));

const CARTERAS = {
  'A · tech concentrada': mkH([['NVDA',0.30],['AAPL',0.20],['MSFT',0.20],['VOO',0.30]]),
  'B · ETF dominante':    mkH([['VOO',0.60],['AAPL',0.05],['MSFT',0.05],['AMZN',0.05],
                               ['MA',0.05],['NVDA',0.05],['TSM',0.05],['MU',0.05],['APP',0.05]]),
  'C · dividendos':       mkH([['KO',0.30],['JNJ',0.25],['PG',0.25],['XLU',0.20]]),
};

// Resultados SINTÉTICOS: la lista real viene de Finnhub en ejecución. Aquí se coloca
// un reporte por posición individual dentro de la ventana (patrón de temporada), para
// que la pista B se ejercite. No son fechas reales de reporte.
const EARNINGS = {
  'A · tech concentrada': { '2026-08-19':['NVDA'], '2026-08-27':['AAPL'], '2026-09-03':['MSFT'] },
  'B · ETF dominante':    { '2026-08-18':['AAPL'], '2026-08-25':['NVDA'], '2026-09-02':['AMZN'], '2026-09-08':['MA'] },
  'C · dividendos':       { '2026-08-20':['KO'], '2026-08-26':['JNJ'], '2026-09-04':['PG'] },
};

const HOY = '2026-09-09';
const dias = [];
for (let i = 29; i >= 0; i--) dias.push(iso(new Date(fromISO(HOY).getTime() - i * 86400000)));

const DOW = ['dom','lun','mar','mié','jue','vie','sáb'];
const resultados = {}, filas = [];
let violaciones = [];

for (const [nombre, holdings] of Object.entries(CARTERAS)) {
  const historial = [];                     // más recientes primero
  resultados[nombre] = { enviados: 0, porPista: { A: 0, B: 0 }, porTipo: {} };
  for (const fecha of dias) {
    const eventos = [
      ...macroEventsForDay(fecha),
      ...((EARNINGS[nombre][fecha] || []).map((t) =>
        eventoDeResultados({ ticker: t, fechaISO: fecha, cuando: 'amc' }))),
    ];
    const umbral = umbralPara(historial);
    const r = pvNewsRank({ fechaISO: fecha, eventos, holdings, historial, umbral });

    let celda;
    if (r.enviado) {
      const { titulo, cuerpo } = textoMatutino(r.ganador, holdings);
      violaciones.push(...violacionesDeCopy(titulo + ' ' + cuerpo)
        .map((v) => `${fecha} ${nombre}: "${v}"`));
      celda = `${r.ganador.evento.key} ${r.ganador.score}`;
      resultados[nombre].enviados++;
      resultados[nombre].porPista[r.ganador.pista]++;
      const k = r.ganador.evento.key;
      resultados[nombre].porTipo[k] = (resultados[nombre].porTipo[k] || 0) + 1;
      historial.unshift({
        fecha, enviado: true, ganador_id: r.ganador.evento.id,
        ganador_tickers: r.ganador.pista === 'B' ? [r.ganador.evento.ticker] : r.ganador.evento.tickers,
        ganador_tipo: k, ganador_pista: r.ganador.pista, abierto: true,
      });
      resultados[nombre].ultimoTexto = `${titulo} / ${cuerpo}`;
    } else {
      const top = r.candidatos[0];
      celda = r.motivo.startsWith('bajo_umbral') && top ? `— (${top.score})` : '—';
      historial.unshift({ fecha, enviado: false, ganador_tickers: [], abierto: false });
    }
    (filas[dias.indexOf(fecha)] ||= { fecha })[nombre] = celda;
  }
}

// ── Tabla día × cartera ──
const nombres = Object.keys(CARTERAS);
const w = [16, 22, 22, 22];
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log('\n═══ Motor matutino · dryRun 30 días × 3 carteras ═══');
console.log('celda = evento_ganador score   ·   "—" = no se envía   ·   (n) = score del mejor candidato\n');
console.log(pad('fecha', w[0]) + nombres.map((n, i) => pad(n, w[i + 1])).join(''));
console.log('─'.repeat(w.reduce((a, b) => a + b, 0)));
for (const f of filas) {
  const dow = DOW[fromISO(f.fecha).getUTCDay()];
  const finde = dow === 'sáb' || dow === 'dom';
  console.log(pad(`${f.fecha} ${dow}`, w[0]) +
    nombres.map((n, i) => pad(finde ? '· fin de semana' : (f[n] || '—'), w[i + 1])).join(''));
}

console.log('\n═══ Resumen ═══');
for (const n of nombres) {
  const r = resultados[n];
  const porSem = (r.enviados / 30 * 7).toFixed(1);
  console.log(`${pad(n, 24)} ${r.enviados} envíos en 30 días  ≈ ${porSem}/semana` +
    `   pista A ${r.porPista.A} · pista B ${r.porPista.B}`);
  console.log(`${' '.repeat(24)} tipos: ${Object.entries(r.porTipo).map(([k, v]) => `${k}×${v}`).join(', ') || '—'}`);
}
console.log('\nEsperado por diseño: 2–4 matutinas por semana. Fuera de ese rango → recalibrar.');
console.log(violaciones.length
  ? `\n✗ COPY: ${violaciones.length} violaciones\n  ${violaciones.join('\n  ')}`
  : '\n✓ copy: ningún imperativo, ningún emoji en los textos generados');

// ── Determinismo: re-correr el mismo día tiene que dar lo mismo ──
const h = CARTERAS['A · tech concentrada'];
const ev = macroEventsForDay('2026-08-19');
const a = JSON.stringify(pvNewsRank({ fechaISO: '2026-08-19', eventos: ev, holdings: h, historial: [] }));
const b = JSON.stringify(pvNewsRank({ fechaISO: '2026-08-19', eventos: ev, holdings: h, historial: [] }));
console.log(a === b ? '✓ determinismo: dos corridas del mismo día → resultado idéntico'
                    : '✗ determinismo ROTO');
