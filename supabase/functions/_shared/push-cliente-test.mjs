// Ejecuta DE VERDAD el módulo _pvPush extraído de index.html, con dobles.
// Verifica lo que la sintaxis no ve: que cartera() lea HOLDINGS, que los deep links
// lleguen a showTab/toggleDrawer reales y que el token se registre por RPC.
//   node supabase/functions/_shared/push-cliente-test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('/Users/rafael/Portiv/index.html', 'utf8');
// Se localiza el BLOQUE completo con el mismo barrido que el chequeo de sintaxis:
// buscar '<script>' hacia atrás falla porque los comentarios del módulo contienen
// esa misma palabra.
let src = null;
for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (m[1].includes('window._pvPush = API;')) { src = m[1]; break; }
}
if (!src) throw new Error('módulo no encontrado');

let ok = 0, fail = 0;
const t = (n, c, x = '') => c ? (ok++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x));

// ── Dobles ──
const llamadas = { rpc: [], upsert: [], showTab: [], drawer: [] };
const el = () => ({ children: [], textContent: '', scrollIntoView(){ this._scrolled = true; },
                    setAttribute(){}, appendChild(){}, querySelector: () => el(),
                    querySelectorAll: () => [], remove(){}, style:{} });
const ctx = {
  console, setTimeout, clearTimeout, Intl, Date, JSON, Math, Promise, Array, Object, String, encodeURIComponent, decodeURIComponent,
  HOLDINGS: [ { ticker:'NVDA', qty:10, price:100 }, { ticker:'AAPL', qty:5, price:100 } ],
  showTab: (n) => llamadas.showTab.push(n),
  toggleDrawer: (idx) => llamadas.drawer.push(idx),
  document: { body: { appendChild(){} }, createElement: () => el(),
              getElementById: () => el(), querySelectorAll: () => [] },
  localStorage: { _d:{}, getItem(k){ return this._d[k] ?? null; }, setItem(k,v){ this._d[k]=v; } },
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.window.__pvUserId = 'uid-1';
ctx.window.sbClient = {
  rpc: (n, a) => (llamadas.rpc.push([n, a]), Promise.resolve({ error: null })),
  from: (tabla) => ({
    upsert: (fila, o) => (llamadas.upsert.push([tabla, fila, o]), Promise.resolve({ error: null })),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [] }) }) }),
  }),
};
const P = { _l: {}, addListener(n, f){ this._l[n] = f; },
            checkPermissions: () => Promise.resolve({ receive: 'prompt' }),
            requestPermissions: () => Promise.resolve({ receive: 'granted' }),
            register(){ ctx._registrado = true; } };
ctx.window.Capacitor = { isNativePlatform: () => true, Plugins: { PushNotifications: P } };

vm.createContext(ctx);
vm.runInContext(src, ctx);
const API = ctx.window._pvPush;

console.log('\n── módulo cliente ──');
t('el módulo se evalúa y expone _pvPush', !!API);
t('detecta que hay plugin nativo', API.disponible() === true);

// cartera() lee HOLDINGS por nombre, no por window
API.subirSnapshot();
const snap = llamadas.upsert.find((u) => u[0] === 'push_portfolio');
t('subirSnapshot escribe push_portfolio', !!snap, JSON.stringify(llamadas.upsert));
if (snap) {
  const pos = snap[1].posiciones;
  t('pesos normalizados y sin dinero',
    Math.abs(pos.reduce((s,p)=>s+p.w,0) - 1) < 1e-6 && !JSON.stringify(snap[1]).includes('price'),
    JSON.stringify(pos));
  t('top3 calculado', snap[1].top3[0] === 'NVDA');
}
llamadas.upsert.length = 0;
API.subirSnapshot();
t('no reescribe si la cartera no cambió', llamadas.upsert.length === 0);

// registro del token → RPC, no upsert directo
API.trasLogin();
await new Promise(r => setTimeout(r, 30));

console.log('\n── deep links ──');
P._l['pushNotificationActionPerformed']({ notification: { data: {
  deeplink: 'portiv://posicion/AAPL', titulo_evento: '' } } });
await new Promise(r => setTimeout(r, 450));
t('posición: abre la pestaña portfolio', llamadas.showTab.includes('portfolio'), JSON.stringify(llamadas.showTab));
t('posición: abre el drawer del índice correcto (AAPL = 1)',
  llamadas.drawer.includes(1), JSON.stringify(llamadas.drawer));

llamadas.showTab.length = 0;
P._l['pushNotificationActionPerformed']({ notification: { data: {
  deeplink: 'portiv://calendario/macro_CPI_2026-09-10', titulo_evento: 'IPC (CPI) — inflación al consumidor' } } });
await new Promise(r => setTimeout(r, 60));
t('calendario: abre la pestaña noticias', llamadas.showTab.includes('noticias'), JSON.stringify(llamadas.showTab));

console.log('\n── registro del token ──');
P._l['registration']({ value: 'TOKEN-ABC' });
await new Promise(r => setTimeout(r, 30));
const rpc = llamadas.rpc.find((r) => r[0] === 'registrar_device_token');
t('usa el RPC (no upsert directo, que RLS bloquea)', !!rpc, JSON.stringify(llamadas.rpc));
if (rpc) {
  t('manda token, environment y timezone',
    rpc[1].p_token === 'TOKEN-ABC' && !!rpc[1].p_environment && !!rpc[1].p_timezone,
    JSON.stringify(rpc[1]));
  t('la zona horaria es IANA, no ET fijo', /\//.test(rpc[1].p_timezone), rpc[1].p_timezone);
}

console.log(`\n${fail ? '✗' : '✓'} ${ok} pasan, ${fail} fallan`);
process.exit(fail ? 1 : 0);
