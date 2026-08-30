/* ════════════════════════════════════════════════════════════════════════════
   PORTIV · CALIBRACIÓN DE ANCLAS SECTORIALES
   ────────────────────────────────────────────────────────────────────────────
   Mide los percentiles REALES de cada métrica dentro de cada sector, en vez de
   escribirlos a mano. Esa es la diferencia entre "objetivo" y "creíble":
   cualquiera reejecuta esto y obtiene las mismas anclas.

   Universo: los tickers que ya viven en index.html (lista del S&P 500 completo).
   Agrupación: por el MISMO clasificador que usa el motor, para que las anclas
   correspondan exactamente a los cubos que el motor asigna en producción.

   Uso:  node scripts/calibrar-anclas.mjs [--limit N] [--solo-cache]
   Sale: portiv-anclas-sectoriales.json
   ════════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(RAIZ, '.cache-anclas');
const SALIDA= path.join(RAIZ, 'portiv-anclas-sectoriales.json');
const N_MINIMO = 12;               // menos empresas que esto → ancla no fiable

const args = process.argv.slice(2);
const LIMITE     = (() => { const i = args.indexOf('--limit'); return i >= 0 ? +args[i+1] : Infinity; })();
const SOLO_CACHE = args.includes('--solo-cache');

// ── El clasificador del motor, reutilizado tal cual ──────────────────────────
const require = createRequire(import.meta.url);
const motorCjs = path.join(CACHE, 'motor.cjs');
fs.mkdirSync(CACHE, { recursive: true });
fs.copyFileSync(path.join(RAIZ, 'portiv-sector-rating.js'), motorCjs);
const { _sectorProfileOf, _SECTOR_PROFILES, _CAT } = require(motorCjs);

// Las métricas DERIVADAS (runway, posición en el ciclo, payout sobre flujo) no son
// campos de Finnhub: hay que calcularlas empresa a empresa para poder medir sus
// percentiles. Sin esto el motor las pide, no encuentra ancla y las salta en silencio
// — que es peor que no tenerlas, porque baja la cobertura sin decir por qué.
const DERIVADAS = Object.entries(_CAT).filter(([, d]) => d.deriva && !d.escalaFija);

// ── Universo de tickers, leído del propio index.html ─────────────────────────
const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
const TICKERS = [...new Set(
  [...html.matchAll(/\['([A-Z][A-Z.\-]{0,5})','[^']*','[^']*'\]/g)].map(m => m[1])
)].slice(0, LIMITE);
console.log(`universo: ${TICKERS.length} tickers`);

// ── Proxy de Finnhub, con la misma clave anónima que usa la app ──────────────
const ANON = (html.match(/PV_SB_ANON = '([^']*)'/) || [])[1];
const BASE = 'https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/finnhub-proxy';
const H = { apikey: ANON, Authorization: 'Bearer ' + ANON };

async function fh(ruta) {
  const r = await fetch(`${BASE}?path=${encodeURIComponent(ruta)}`, { headers: H });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const dormir = ms => new Promise(r => setTimeout(r, ms));

// ── Descarga con caché en disco: reejecutar no vuelve a pedir nada ───────────
async function datosDe(tk) {
  const f = path.join(CACHE, tk + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  if (SOLO_CACHE) return null;
  const [perfil, metrica] = await Promise.all([
    fh(`/stock/profile2?symbol=${tk}`).catch(() => null),
    fh(`/stock/metric?symbol=${tk}&metric=all`).catch(() => null),
  ]);
  if (!perfil || !metrica?.metric) return null;
  const d = { ticker: tk, industria: perfil.finnhubIndustry || '', metric: metrica.metric };
  fs.writeFileSync(f, JSON.stringify(d));
  return d;
}

// ── Recolección ─────────────────────────────────────────────────────────────
const porPerfil = {};                 // perfilId → { campo → [valores] }
let ok = 0, fallo = 0, noFundamentales = 0, sinPerfil = {};

for (let i = 0; i < TICKERS.length; i++) {
  const tk = TICKERS[i];
  let d = null;
  try { d = await datosDe(tk); } catch (e) { /* se cuenta como fallo */ }
  if (!d) { fallo++; if (!SOLO_CACHE) await dormir(900); continue; }

  // Los ETF y los tickers inválidos llegan sin industria y con ~19 campos (solo precio):
  // no tienen fundamentales que promediar y contaminarían el cubo genérico.
  if (!d.industria || Object.keys(d.metric).length < 40) { noFundamentales++; continue; }
  // Mismo clasificador que en producción, para que las anclas correspondan exactamente
  // a los cubos que el motor asigna en vivo.
  const { id } = _sectorProfileOf(tk, { sector: d.industria, industry: d.industria });
  if (id === 'ETF') { noFundamentales++; continue; }
  if (id === 'MERCADO') sinPerfil[d.industria] = (sinPerfil[d.industria] || 0) + 1;

  porPerfil[id] = porPerfil[id] || {};
  for (const [k, v] of Object.entries(d.metric)) {
    if (typeof v !== 'number' || !isFinite(v)) continue;
    (porPerfil[id][k] = porPerfil[id][k] || []).push(v);
  }
  // Derivadas: se guardan bajo su clave del catálogo, que es como las busca el motor.
  const infoSint = { __m: d.metric };
  for (const [clave, def] of DERIVADAS) {
    let v = null;
    try { v = def.deriva(infoSint); } catch (e) { v = null; }
    if (typeof v === 'number' && isFinite(v)) (porPerfil[id][clave] = porPerfil[id][clave] || []).push(v);
  }
  ok++;
  if (ok % 50 === 0) console.log(`  ${i + 1}/${TICKERS.length} · ${ok} con datos`);
  if (!fs.existsSync(path.join(CACHE, tk + '.json'))) await dormir(900);
}
console.log(`descarga: ${ok} con fundamentales · ${noFundamentales} sin fundamentales (ETF/inválidos) · ${fallo} sin respuesta`);

// ── Percentiles ─────────────────────────────────────────────────────────────
// Se winsoriza al 2%/98% antes de tomar los percentiles: un solo dato corrupto del
// feed (un P/E de 40.000) desplazaría la mediana de un sector pequeño.
function percentiles(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const q = p => {
    const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
  };
  const bajo = q(0.02), alto = q(0.98);
  const w = a.filter(v => v >= bajo && v <= alto);
  if (w.length < 3) return null;
  const qw = p => {
    const i = (w.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? w[lo] : w[lo] + (w[hi] - w[lo]) * (i - lo);
  };
  const r = v => Math.round(v * 10000) / 10000;
  return { p10: r(qw(0.10)), p25: r(qw(0.25)), p50: r(qw(0.50)),
           p75: r(qw(0.75)), p90: r(qw(0.90)), n: w.length };
}

const salida = {
  _meta: {
    generado: new Date().toISOString().slice(0, 10),
    universo: TICKERS.length,
    conDatos: ok,
    nMinimo: N_MINIMO,
    unidades: 'nativas de Finnhub: los porcentajes vienen 0-100 (roeTTM=17.81 → 17,81%), '
            + 'los múltiplos en veces. El catálogo del motor declara la escala de cada métrica.',
    fuente: '/stock/metric?metric=all vía finnhub-proxy',
  },
  perfiles: {},
};

for (const [id, campos] of Object.entries(porPerfil)) {
  const nEmpresas = Math.max(...Object.values(campos).map(a => a.length));
  const dst = salida.perfiles[id] = { nEmpresas, suficiente: nEmpresas >= N_MINIMO, anclas: {} };
  for (const [campo, vals] of Object.entries(campos)) {
    if (vals.length < 3) continue;
    const p = percentiles(vals);
    if (p) dst.anclas[campo] = p;
  }
}

// Mercado completo: respaldo cuando un perfil no tiene suficientes empresas.
const todo = {};
for (const campos of Object.values(porPerfil))
  for (const [k, v] of Object.entries(campos)) (todo[k] = todo[k] || []).push(...v);
salida.mercado = { nEmpresas: ok, anclas: {} };
for (const [campo, vals] of Object.entries(todo)) {
  const p = percentiles(vals);
  if (p) salida.mercado.anclas[campo] = p;
}

fs.writeFileSync(SALIDA, JSON.stringify(salida, null, 1));

// ── Informe ─────────────────────────────────────────────────────────────────
console.log('\nperfil                  empresas  métricas  ¿suficiente?');
for (const [id, d] of Object.entries(salida.perfiles).sort((a, b) => b[1].nEmpresas - a[1].nEmpresas))
  console.log(`  ${id.padEnd(20)} ${String(d.nEmpresas).padStart(6)} ${String(Object.keys(d.anclas).length).padStart(9)}   ${d.suficiente ? 'sí' : 'NO → cae al mercado'}`);
const faltan = Object.keys(_SECTOR_PROFILES).filter(k => k !== 'MERCADO' && !salida.perfiles[k]);
if (faltan.length) console.log('\nsin ninguna empresa en el universo:', faltan.join(', '));
const sp = Object.entries(sinPerfil).sort((a, b) => b[1] - a[1]).slice(0, 12);
if (sp.length) { console.log('\nindustrias sin perfil (candidatas a override):');
  for (const [ind, n] of sp) console.log(`  ${n}×  ${ind || '(vacía)'}`); }
console.log(`\n→ ${SALIDA}`);
