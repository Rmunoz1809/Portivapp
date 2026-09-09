// Drift test: el calendario del PUSH vs el calendario de la APP.
// El motor de push tiene su propia copia de _macroEventsForWeek() porque corre en el
// servidor y no puede importar nada del monolito de index.html. Dos copias se separan
// solas con el tiempo, y el síntoma sería silencioso y feo: la app mostrando un
// calendario y el push hablando de otro. Este test extrae la función REAL de
// index.html, la corre junto al port sobre 260 semanas y compara evento por evento.
//
//   TZ=America/New_York node supabase/functions/_shared/push-drift-test.mjs
import { readFileSync } from 'node:fs';
import { macroEventsForWeek, mondayOf, iso } from './push-rank.js';

const SRC = '/Users/rafael/Portiv/index.html';
const html = readFileSync(SRC, 'utf8');

// ── Extracción por conteo de llaves (nunca por número de línea absoluto) ──
const start = html.indexOf('function _macroEventsForWeek(monday) {');
if (start < 0) { console.error('✗ no se encontró _macroEventsForWeek en index.html'); process.exit(1); }
let depth = 0, end = -1;
for (let i = html.indexOf('{', start); i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = html.slice(start, end);

const _DOW_ES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const appFn = new Function('_DOW_ES', `${fnSrc}; return _macroEventsForWeek;`)(_DOW_ES);

// ── Normalización a un shape comparable ──
const norm = (e) => JSON.stringify({
  fecha: e.fecha ?? e._date,
  titulo: e.titulo ?? e.h,
  imp: e.imp,
  time: e.time,
  dayIdx: e.dayIdx,
  tickers: (e.tickers ?? String(e.impact || '').split(',').map((s) => s.trim()).filter(Boolean)),
});
const orden = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

let semanas = 0, fallos = 0;
// 5 años alrededor de hoy: cubre los 8 FOMC de 2026 y todos los patrones de fin de mes.
let d = new Date(Date.UTC(2025, 0, 6));
for (let w = 0; w < 260; w++, d = new Date(d.getTime() + 7 * 86400000)) {
  const mon = mondayOf(d);
  const app  = appFn(new Date(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate())).map(norm).sort(orden);
  const push = macroEventsForWeek(mon).map(norm).sort(orden);
  semanas++;
  if (JSON.stringify(app) !== JSON.stringify(push)) {
    fallos++;
    if (fallos <= 3) {
      console.error(`\n✗ DRIFT en la semana del ${iso(mon)}`);
      const soloApp  = app.filter((x) => !push.includes(x));
      const soloPush = push.filter((x) => !app.includes(x));
      soloApp.forEach((x) => console.error('   sólo en la APP :', x));
      soloPush.forEach((x) => console.error('   sólo en el PUSH:', x));
    }
  }
}
console.log(fallos === 0
  ? `✓ sin drift — ${semanas} semanas, calendario del push idéntico al de la app`
  : `✗ ${fallos}/${semanas} semanas con drift`);
process.exit(fallos === 0 ? 0 : 1);
