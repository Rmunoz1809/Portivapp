// ═══════════════════════════════════════════════════════════════════════════
//  push-rank — motor de selección de la notificación matutina + plantilla de cierre
//  ───────────────────────────────────────────────────────────────────────────
//  100% DETERMINISTA. Mismo input → mismo output, siempre. Sin Math.random, sin
//  Date.now() dentro del cálculo (la fecha entra por parámetro), y sin una sola
//  llamada a un modelo de IA. Eso no es una limitación técnica: el push llega a la
//  pantalla de bloqueo sin contexto y sin disclaimer, así que no puede llevar prosa
//  generada.
//
//  Lo usan la Edge Function (Deno) y el arnés de calibración (Node). Un solo archivo
//  para que no haya dos motores que se separen con el tiempo.
// ═══════════════════════════════════════════════════════════════════════════

// ── Utilidades de fecha, todas en UTC ────────────────────────────────────────
// A propósito en UTC y no en hora local: `new Date(y,m,d).toISOString()` en un
// huso POSITIVO (Europa) devuelve el día ANTERIOR, y el calendario se desfasaría
// un día. En el servidor (UTC) y en EE.UU. (offset negativo) coinciden, pero
// depender de eso es frágil.
export const iso = (d) => d.toISOString().slice(0, 10);
export const fromISO = (s) => new Date(s + 'T00:00:00Z');
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** Lunes (UTC) de la semana que contiene `d`. Domingo cuenta como semana siguiente. */
export function mondayOf(d) {
  const dow = d.getUTCDay();                 // 0=Dom … 6=Sáb
  const back = dow === 0 ? 6 : dow - 1;      // Dom → retrocede 6 para caer en el lunes previo
  return addDays(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), -back);
}

/** '8:30 AM ET' → 510 (minutos desde medianoche). Sólo para desempatar. */
export function minutosDe(hora) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(hora || ''));
  if (!m) return 24 * 60;                    // sin hora → al final del desempate
  let h = +m[1] % 12;
  if (/PM/i.test(m[3])) h += 12;
  return h * 60 + (+m[2]);
}

// ── Rareza (paso 2, término R) ───────────────────────────────────────────────
// Un FOMC ocurre 8 veces al año; un jobless claims, 52. Sin este término lo
// rutinario gana por acumulación y la app se vuelve "el boletín semanal del paro".
export const RAREZA = {
  FOMC: 100, FOMC_MIN: 100,
  CPI: 80, NFP: 80,
  PCE: 65, GDP: 65,
  ISM_MFG: 45, ISM_SVC: 45,
  PMI_PRELIM: 35, RETAIL: 35,
  CLAIMS: 20,
};
// Todo lo no listado cae a 20 ("resto semanal"). ADP, PPI, OPEX, Michigan y
// Conference Board caen aquí: son recurrentes y rara vez mueven una cartera solos.
export const RAREZA_DEFAULT = 20;
export const rarezaDe = (key) => (key in RAREZA ? RAREZA[key] : RAREZA_DEFAULT);

// ── ETFs de mercado amplio (paso 3) ──────────────────────────────────────────
// Si el usuario tiene VOO, TODO macro lo toca al 100% y los macro ganarían todos
// los días: los resultados de sus posiciones individuales nunca aparecerían.
// Los SECTORIALES (XLF, SMH, XLE…) NO llevan descuento: su exposición a un macro
// concreto sí es informativa.
export const ETF_AMPLIOS = new Set(['VOO','SPY','VTI','IVV','QQQ','SCHB','ITOT','VT','VXUS']);
export const FACTOR_ETF_AMPLIO = 0.3;

// ── Pesos del scoring ────────────────────────────────────────────────────────
export const W_MACRO   = { I: 0.40, E: 0.35, R: 0.25 };
export const W_HOLDING = { W: 0.55, T: 0.35, B: 0.10 };
export const IMPACTO_BASE = { high: 100, medium: 55, low: 20 };
export const TIPO_HOLDING = { earnings: 100, guidance: 60, investor_day: 60, ex_dividendo: 40, split: 35 };

export const UMBRAL_BASE      = 45;
export const UMBRAL_ADAPTATIVO = 65;   // usuario que no abrió las últimas 5 matutinas
export const PENA_TICKER_3D   = 15;
export const PENA_TIPO_14D    = 10;
export const PENA_PISTA_5D    = 12;

// ═══════════════════════════════════════════════════════════════════════════
//  Calendario macro — PORT de _macroEventsForWeek() de index.html
//  Verificado contra el original por supabase/functions/_shared/push-drift-test.mjs,
//  que corre ambas implementaciones sobre 260 semanas y compara evento por evento.
//  Si alguien toca el calendario en index.html, ese test falla. No lo ignores:
//  significa que el push y la app estarían mostrando calendarios distintos.
// ═══════════════════════════════════════════════════════════════════════════
const FOMC_2026 = [
  { decision: '2026-01-28', minutes: '2026-02-18' },
  { decision: '2026-03-18', minutes: '2026-04-08' },
  { decision: '2026-04-29', minutes: '2026-05-20' },
  { decision: '2026-06-17', minutes: '2026-07-08' },
  { decision: '2026-07-29', minutes: '2026-08-19' },
  { decision: '2026-09-16', minutes: '2026-10-07' },
  { decision: '2026-10-28', minutes: '2026-11-18' },
  { decision: '2026-12-09', minutes: '2026-12-30' },
];

/**
 * Eventos macro de la semana del `monday` dado (UTC).
 * Devuelve el mismo conjunto que la app, más `key` (para rareza y anti-repetición)
 * y `push_linea` (la línea corta y factual que va al push).
 */
export function macroEventsForWeek(monday) {
  const ev = [];
  const mk = (dayIdx, key, titulo, push_titulo, push_linea, tickers, imp, time) => {
    const d = addDays(monday, dayIdx - 1);
    ev.push({
      id: `macro_${key}_${iso(d)}`,
      key, dayIdx, fecha: iso(d),
      titulo, push_titulo, push_linea,
      tickers, imp, time,
      pista: 'A', categoria: 'macro',
    });
  };
  const domOf = (dayIdx) => addDays(monday, dayIdx - 1).getUTCDate();
  const dayInRange = (lo, hi) => {
    for (let i = 1; i <= 5; i++) { const dm = domOf(i); if (dm >= lo && dm <= hi) return i; }
    return null;
  };
  let di;

  if ((di = dayInRange(1, 3))) mk(di, 'ISM_MFG',
    'ISM Manufacturing PMI — actividad industrial',
    'ISM manufacturero',
    'Dato de actividad industrial, 10:00 AM ET.',
    ['NVDA','MU','TSM','VOO'], 'medium', '10:00 AM ET');

  if (domOf(3) <= 7) mk(3, 'ADP',
    'ADP — Empleo privado (anticipo de las nóminas)',
    'empleo privado ADP',
    'Empleo privado del mes, 8:15 AM ET.',
    ['VOO','NVDA','MSFT','AMZN'], 'medium', '8:15 AM ET');

  if (domOf(3) >= 3 && domOf(3) <= 9) mk(3, 'ISM_SVC',
    'ISM Services PMI — sector servicios',
    'ISM de servicios',
    'Dato del sector servicios, 10:00 AM ET.',
    ['AMZN','MA','AAPL','VOO'], 'medium', '10:00 AM ET');

  if (domOf(5) <= 7) mk(5, 'NFP',
    'Nóminas no agrícolas (Nonfarm Payrolls) — dato laboral del mes',
    'nóminas no agrícolas',
    'Reporte de empleo del mes, 8:30 AM ET.',
    ['VOO','NVDA','MSFT','AAPL','AMZN'], 'high', '8:30 AM ET');

  const _cpiDi = dayInRange(10, 14);
  if (_cpiDi) mk(_cpiDi, 'CPI',
    'IPC (CPI) — inflación al consumidor',
    'IPC (inflación)',
    'Inflación al consumidor, 8:30 AM ET.',
    ['VOO','NVDA','APP','TSM','MSFT'], 'high', '8:30 AM ET');

  if (_cpiDi && _cpiDi < 5) mk(_cpiDi + 1, 'PPI',
    'IPP (PPI) — inflación al productor',
    'IPP (precios al productor)',
    'Inflación al productor, 8:30 AM ET.',
    ['VOO','NVDA','TSM'], 'medium', '8:30 AM ET');

  if ((di = dayInRange(15, 17))) mk(di, 'RETAIL',
    'Ventas minoristas (Retail Sales) — consumo de EE.UU.',
    'ventas minoristas',
    'Ventas minoristas de EE.UU., 8:30 AM ET.',
    ['AMZN','MA','AAPL','VOO'], 'medium', '8:30 AM ET');

  if (domOf(5) >= 8 && domOf(5) <= 14) mk(5, 'MICHIGAN',
    'Confianza del consumidor (U. de Michigan, preliminar)',
    'confianza (Michigan)',
    'Encuesta de confianza del consumidor, 10:00 AM ET.',
    ['AMZN','MA','AAPL'], 'low', '10:00 AM ET');

  if (domOf(5) >= 15 && domOf(5) <= 21) mk(5, 'OPEX',
    'Vencimiento de opciones (OPEX mensual)',
    'vencimiento de opciones',
    'Vencimiento mensual de opciones, 4:00 PM ET.',
    ['NVDA','APP','AAPL','VOO'], 'medium', '4:00 PM ET');

  if (domOf(2) >= 22) mk(2, 'CONFBOARD',
    'Confianza del consumidor (Conference Board)',
    'confianza del consumidor',
    'Confianza del consumidor, 10:00 AM ET.',
    ['AMZN','MA','AAPL','VOO'], 'medium', '10:00 AM ET');

  if ((di = dayInRange(24, 27))) mk(di, 'DURABLE',
    'Pedidos de bienes duraderos (Durable Goods)',
    'bienes duraderos',
    'Pedidos de bienes duraderos, 8:30 AM ET.',
    ['NVDA','MU','TSM','VOO'], 'medium', '8:30 AM ET');

  // PCE: ÚLTIMO viernes del mes (el BEA publica "Personal Income & Outlays" ese día).
  {
    const fri = addDays(monday, 4);
    const diasDelMes = new Date(Date.UTC(fri.getUTCFullYear(), fri.getUTCMonth() + 1, 0)).getUTCDate();
    if (fri.getUTCDate() + 7 > diasDelMes) mk(5, 'PCE',
      'PCE subyacente — inflación favorita de la Fed',
      'PCE subyacente',
      'Inflación PCE, la que sigue la Fed. 8:30 AM ET.',
      ['VOO','NVDA','APP','MSFT','TSM'], 'high', '8:30 AM ET');
  }

  // Jobless claims: CADA jueves.
  mk(4, 'CLAIMS',
    'Solicitudes iniciales de desempleo (jobless claims)',
    'solicitudes de desempleo',
    'Solicitudes de desempleo semanales, 8:30 AM ET.',
    ['VOO','NVDA','MSFT','AMZN'], 'medium', '8:30 AM ET');

  // FOMC: fechas oficiales, no un patrón estimado.
  const dayIdxForISO = (s) => {
    for (let i = 1; i <= 5; i++) if (iso(addDays(monday, i - 1)) === s) return i;
    return null;
  };
  for (const { decision, minutes } of FOMC_2026) {
    let di2;
    if ((di2 = dayIdxForISO(decision))) mk(di2, 'FOMC',
      'Decisión de tasas de la Fed (FOMC) + conferencia de prensa',
      'decisión de la Fed',
      'Decisión de tasas de la Fed, 2:00 PM ET.',
      ['VOO','NVDA','APP','TSM','MSFT','AMZN'], 'high', '2:00 PM ET');
    if ((di2 = dayIdxForISO(minutes))) mk(di2, 'FOMC_MIN',
      'Actas de la reunión del FOMC (minutes)',
      'actas de la Fed',
      'Actas de la última reunión de la Fed, 2:00 PM ET.',
      ['VOO','NVDA','APP','TSM','MSFT'], 'high', '2:00 PM ET');
  }

  return ev;
}

/** Eventos macro de un día concreto (ISO 'YYYY-MM-DD'). */
export function macroEventsForDay(fechaISO) {
  return macroEventsForWeek(mondayOf(fromISO(fechaISO))).filter((e) => e.fecha === fechaISO);
}

// ── Eventos de posición (pista B) ────────────────────────────────────────────
// Los resultados vienen de Finnhub en tiempo de ejecución: la lista es abierta y
// no se les puede escribir una línea a mano como a los 15 macro. Se genera con
// plantilla, que es la única forma honesta de cubrir un universo abierto.
export function eventoDeResultados({ ticker, fechaISO, cuando }) {
  const linea = cuando === 'bmo' ? 'Antes de la apertura.'
              : cuando === 'amc' ? 'Después del cierre.'
              : 'Presenta resultados hoy.';
  return {
    id: `earn_${ticker}_${fechaISO}`,
    key: 'earnings', fecha: fechaISO,
    titulo: `resultados de ${ticker}`,
    push_titulo: `resultados de ${ticker}`,
    push_linea: linea,
    tickers: [ticker], ticker,
    tipoHolding: 'earnings',
    time: cuando === 'bmo' ? '8:00 AM ET' : cuando === 'amc' ? '4:15 PM ET' : '9:30 AM ET',
    pista: 'B', categoria: 'earnings',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cartera
// ═══════════════════════════════════════════════════════════════════════════
/**
 * HOLDINGS de la app → pesos normalizados.
 * La app guarda {ticker, qty, price, …} y NO un peso: hay que derivarlo.
 * @returns {{pesos: Map<string,number>, top3: Set<string>, total: number}}
 */
export function pesosDeCartera(holdings) {
  const vals = (holdings || [])
    .filter((h) => h && h.ticker && +h.qty > 0 && +h.price > 0)
    .map((h) => ({ ticker: String(h.ticker).toUpperCase(), valor: +h.qty * +h.price }));
  const total = vals.reduce((s, v) => s + v.valor, 0);
  const pesos = new Map();
  if (total > 0) for (const v of vals) pesos.set(v.ticker, (pesos.get(v.ticker) || 0) + v.valor / total);
  const top3 = new Set([...pesos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]));
  return { pesos, top3, total };
}

/** Exposición efectiva E (0–100): suma de pesos tocados, con descuento de ETF amplio. */
export function exposicionEfectiva(tickers, pesos) {
  let s = 0;
  for (const t of new Set((tickers || []).map((x) => String(x).toUpperCase()))) {
    const p = pesos.get(t);
    if (!p) continue;
    s += ETF_AMPLIOS.has(t) ? p * FACTOR_ETF_AMPLIO : p;
  }
  return Math.max(0, Math.min(100, s * 100));
}

/** Exposición CRUDA (sin descuento). Sólo para el piso de relevancia del paso 1. */
export function exposicionCruda(tickers, pesos) {
  let s = 0;
  for (const t of new Set((tickers || []).map((x) => String(x).toUpperCase()))) s += pesos.get(t) || 0;
  return Math.max(0, Math.min(1, s));
}

// ═══════════════════════════════════════════════════════════════════════════
//  El motor
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param {object} o
 * @param {string} o.fechaISO      hoy en ET
 * @param {Array}  o.eventos       candidatos del día (macro + resultados)
 * @param {Array}  o.holdings      HOLDINGS del usuario
 * @param {Array}  o.historial     filas de push_selection_log, más recientes primero
 * @param {number} [o.umbral]      por defecto 45; 65 si no abre hace 5
 * @returns {{ganador:object|null, enviado:boolean, motivo:string|null, candidatos:Array}}
 */
export function pvNewsRank({ fechaISO, eventos, holdings, historial = [], umbral = UMBRAL_BASE }) {
  const { pesos, top3 } = pesosDeCartera(holdings);

  // ── Paso 1 · Elegibilidad (filtros duros, ANTES de puntuar) ───────────────
  const enviadosRecientes = historial.filter((h) => h.enviado);
  const diasDesde = (f) => Math.round((fromISO(fechaISO) - fromISO(f)) / 86400000);
  const idsUlt7 = new Set(
    enviadosRecientes.filter((h) => diasDesde(h.fecha) <= 7 && diasDesde(h.fecha) >= 0)
                     .map((h) => h.ganador_id));

  const elegibles = (eventos || []).filter((e) => {
    if (!e || e.fecha !== fechaISO) return false;                    // sólo hoy
    if (e.categoria !== 'macro' && e.categoria !== 'earnings') return false; // nada reactivo
    if (!e.push_linea || !String(e.push_linea).trim()) return false; // sin línea, no se manda
    if (e.imp === 'low' && exposicionCruda(e.tickers, pesos) <= 0.15) return false;
    if (idsUlt7.has(e.id)) return false;                             // anti-duplicado 7 días
    return true;
  });

  if (!elegibles.length) {
    return { ganador: null, enviado: false, motivo: 'sin_eventos_elegibles', candidatos: [] };
  }

  // ── Paso 2 · Dos pistas, misma escala 0–100 ──────────────────────────────
  const puntuados = elegibles.map((e) => {
    if (e.pista === 'B') {
      const w = (pesos.get(String(e.ticker).toUpperCase()) || 0) * 100;
      const W = Math.max(0, Math.min(100, w));
      const T = TIPO_HOLDING[e.tipoHolding] ?? 0;
      const B = top3.has(String(e.ticker).toUpperCase()) ? 100 : 0;
      const base = W_HOLDING.W * W + W_HOLDING.T * T + W_HOLDING.B * B;
      return { evento: e, pista: 'B', base, desglose: { W: +W.toFixed(2), T, B }, exposicion: W };
    }
    const I = IMPACTO_BASE[e.imp] ?? 0;
    const E = exposicionEfectiva(e.tickers, pesos);
    const R = rarezaDe(e.key);
    const base = W_MACRO.I * I + W_MACRO.E * E + W_MACRO.R * R;
    return { evento: e, pista: 'A', base, desglose: { I, E: +E.toFixed(2), R }, exposicion: E };
  });

  // ── Paso 4 · Fatiga y variedad (restas, luego se re-rankea) ───────────────
  const tickersUlt3 = new Set();
  for (const h of enviadosRecientes) {
    const d = diasDesde(h.fecha);
    if (d >= 0 && d <= 3) for (const t of (h.ganador_tickers || [])) tickersUlt3.add(String(t).toUpperCase());
  }
  const tiposUlt14 = new Set(
    enviadosRecientes.filter((h) => diasDesde(h.fecha) >= 0 && diasDesde(h.fecha) <= 14)
                     .map((h) => h.ganador_tipo));
  // ¿La misma pista ganó los últimos 5 envíos seguidos?
  const ult5 = enviadosRecientes.slice(0, 5);
  const pistaMonotona = ult5.length === 5 && ult5.every((h) => h.ganador_pista === ult5[0].ganador_pista)
    ? ult5[0].ganador_pista : null;

  for (const c of puntuados) {
    const penas = [];
    const suyos = c.pista === 'B' ? [c.evento.ticker] : (c.evento.tickers || []);
    if (suyos.some((t) => tickersUlt3.has(String(t).toUpperCase()))) penas.push(['ticker_3d', PENA_TICKER_3D]);
    if (c.pista === 'A' && tiposUlt14.has(c.evento.key)) penas.push(['tipo_14d', PENA_TIPO_14D]);
    if (pistaMonotona && c.pista === pistaMonotona) penas.push(['pista_5d', PENA_PISTA_5D]);
    c.penalizaciones = penas;
    c.score = +Math.max(0, c.base - penas.reduce((s, p) => s + p[1], 0)).toFixed(2);
    c.base = +c.base.toFixed(2);
  }

  // ── Paso 6 · Desempate determinista, nunca aleatorio ─────────────────────
  puntuados.sort((a, b) =>
    (b.score - a.score) ||
    (b.exposicion - a.exposicion) ||
    (minutosDe(a.evento.time) - minutosDe(b.evento.time)) ||
    (a.evento.id < b.evento.id ? -1 : a.evento.id > b.evento.id ? 1 : 0));

  const candidatos = puntuados.slice(0, 5).map((c) => ({
    id: c.evento.id, titulo: c.evento.titulo, pista: c.pista,
    score: c.score, base: c.base, desglose: c.desglose,
    penalizaciones: c.penalizaciones,
  }));

  // ── Paso 5 · Umbral. Ganar el ranking no basta: hay que merecer la interrupción.
  const top = puntuados[0];
  if (top.score < umbral) {
    return { ganador: null, enviado: false,
             motivo: `bajo_umbral(${top.score}<${umbral})`, candidatos };
  }
  return { ganador: top, enviado: true, motivo: null, candidatos };
}

/** Umbral del usuario: sube a 65 si no abrió ninguna de las últimas 5 matutinas. */
export function umbralPara(historial) {
  const env = (historial || []).filter((h) => h.enviado).slice(0, 5);
  if (env.length < 5) return UMBRAL_BASE;
  return env.some((h) => h.abierto) ? UMBRAL_BASE : UMBRAL_ADAPTATIVO;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Redacción del push (plantillas fijas — cero prosa generada)
// ═══════════════════════════════════════════════════════════════════════════
const fmtPct = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(n === 0 ? 2 : (Math.abs(n) < 10 ? 2 : 1))}%`;

/** Lista de tickers para el cuerpo: máximo 3, luego "y N más". */
export function listaTickers(tickers) {
  const t = [...new Set((tickers || []).map((x) => String(x).toUpperCase()))];
  if (t.length <= 3) return t.length <= 1 ? (t[0] || '') : `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}`;
  return `${t.slice(0, 3).join(', ')} y ${t.length - 3} más`;
}

/** Notificación matutina. Título = el evento. Cuerpo = la exposición del usuario. */
export function textoMatutino(ganador, holdings) {
  const e = ganador.evento;
  const { pesos } = pesosDeCartera(holdings);
  const titulo = `Hoy: ${e.push_titulo || e.titulo.split(' — ')[0]}`;

  if (ganador.pista === 'B') {
    const top3 = pesosDeCartera(holdings).top3;
    const esTop = top3.has(String(e.ticker).toUpperCase());
    const mayor = [...pesos.entries()].sort((a, b) => b[1] - a[1])[0];
    const extra = (mayor && mayor[0] === String(e.ticker).toUpperCase())
      ? ' Es tu posición más grande.'
      : esTop ? ' Está entre tus tres mayores posiciones.' : '';
    return { titulo, cuerpo: `${e.push_linea}${extra}`.trim() };
  }

  const tocados = (e.tickers || []).filter((t) => pesos.has(String(t).toUpperCase()));
  // Caso borde: alto impacto que NO toca su cartera → se manda sin línea de exposición.
  if (!tocados.length) return { titulo, cuerpo: e.push_linea };
  const n = tocados.length;
  const suf = n === 1 ? 'Toca 1 de tus posiciones' : `Toca ${n} de tus posiciones`;
  return { titulo, cuerpo: `${e.push_linea} ${suf}: ${listaTickers(tocados)}.` };
}

/**
 * Notificación de cierre. Porcentajes, NUNCA dólares: la pantalla de bloqueo la ve
 * quien esté al lado, y "−$1,847" expone patrimonio; "−0.30%" no.
 * Siempre se incluye el extremo contrario cuando existe: un día rojo con un ganador
 * cuenta una historia; un día rojo con sólo la peor posición se siente como un regaño.
 * @returns {{titulo:string, cuerpo:string, ticker:string}|null}  null = no se envía
 */
export function textoCierre(holdings) {
  const vivos = (holdings || []).filter(
    (h) => h && h.ticker && +h.qty > 0 && +h.price > 0 && Number.isFinite(+h.dayChgPct));
  if (!vivos.length) return null;                       // sin posiciones → no enviar

  const total = vivos.reduce((s, h) => s + h.qty * h.price, 0);
  if (!(total > 0)) return null;
  // Ponderado por peso: el % de la cartera, no el promedio simple de los tickers.
  const carteraPct = vivos.reduce((s, h) => s + (h.qty * h.price / total) * (+h.dayChgPct), 0);

  const orden = [...vivos].sort((a, b) => (+b.dayChgPct) - (+a.dayChgPct));
  const mejor = orden[0], peor = orden[orden.length - 1];

  if (vivos.length === 1) {
    const h = vivos[0];
    return { titulo: 'Cierre del día', ticker: h.ticker,
             cuerpo: `${h.ticker} cerró en ${fmtPct(+h.dayChgPct)}. Es tu única posición.` };
  }

  const casiPlano = Math.abs(carteraPct) < 0.1;
  if (casiPlano) {
    const mov = Math.abs(+mejor.dayChgPct) >= Math.abs(+peor.dayChgPct) ? mejor : peor;
    return { titulo: 'Cierre del día', ticker: mov.ticker,
             cuerpo: `Tu cartera cerró casi sin cambio (${fmtPct(carteraPct)}). `
                   + `${mov.ticker} fue el mayor movimiento (${fmtPct(+mov.dayChgPct)}).` };
  }

  const todoBaja = (+mejor.dayChgPct) <= 0;
  let cuerpo, ticker;
  // Cartera en verde: el extremo contrario es "la más floja", aunque haya cerrado
  // en negativo. "La mayor caída" en un día al alza suena a reproche y describe mal
  // la jornada.
  if (carteraPct > 0 && !todoBaja) {
    ticker = mejor.ticker;
    cuerpo = `Tu cartera ${fmtPct(carteraPct)}. ${mejor.ticker} lideró (${fmtPct(+mejor.dayChgPct)}); `
           + `${peor.ticker} fue la más floja (${fmtPct(+peor.dayChgPct)}).`;
  } else if (todoBaja) {
    ticker = peor.ticker;
    cuerpo = `Tu cartera ${fmtPct(carteraPct)}. ${peor.ticker} fue la mayor caída (${fmtPct(+peor.dayChgPct)}); `
           + `${mejor.ticker} resistió mejor (${fmtPct(+mejor.dayChgPct)}).`;
  } else {
    ticker = peor.ticker;
    cuerpo = `Tu cartera ${fmtPct(carteraPct)}. La mayor caída fue ${peor.ticker} (${fmtPct(+peor.dayChgPct)}); `
           + `${mejor.ticker} subió ${fmtPct(+mejor.dayChgPct)}.`;
  }
  return { titulo: 'Cierre del día', cuerpo, ticker };
}

// ── Guardia de estilo (se usa en los tests) ──────────────────────────────────
// Descriptivo, no accionable. Hecho consumado, pasado verificable.
export const PROHIBIDOS = [
  'atención','cuidado','oportunidad','momento de','considera','aprovecha','revisa',
  'no te pierdas','actúa','compra','vende','mira','descubre','entra ahora',
];
export function violacionesDeCopy(texto) {
  const t = String(texto || '').toLowerCase();
  const malas = PROHIBIDOS.filter((p) => t.includes(p));
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(texto)) malas.push('emoji');
  return malas;
}
