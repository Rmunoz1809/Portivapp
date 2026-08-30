/* ════════════════════════════════════════════════════════════════════════════
   PORTIV · MOTOR DE EVALUACIÓN SECTORIAL v2.0
   ────────────────────────────────────────────────────────────────────────────
   Cambio respecto a la v1: cada sector tiene AHORA SU PROPIA LISTA DE MÉTRICAS,
   no solo sus propios umbrales. En la v1 a un banco se le medía con las mismas
   26 métricas genéricas que a una tecnológica (margen bruto, current ratio,
   deuda/capital…) y lo único sectorial eran los cortes. Aquí un banco se evalúa
   por precio/valor contable tangible, ROE de 5 años y crecimiento del book
   value; un REIT por cobertura del dividendo y precio/flujo de caja; una
   biotech por meses de caja. Las métricas que no dicen nada de un sector no
   se apagan: directamente no forman parte de su modelo.

   Las anclas [p10..p90] NO están escritas a mano: se miden sobre el universo
   real con scripts/calibrar-anclas.mjs y viven en portiv-anclas-sectoriales.json.
   Cualquiera reejecuta ese script y obtiene los mismos números.

   Devuelve:
     · nota      1.0–10.0  → qué tan buena es la empresa como inversión
     · percentil 0–100     → qué tan buena es DENTRO de su sector
   ════════════════════════════════════════════════════════════════════════════ */

// ── 0. LECTURA DE MÉTRICAS ──────────────────────────────────────────────────
// El motor lee de `info.__m`, el objeto `metric` crudo de Finnhub (112–130
// campos), en SUS unidades: los porcentajes vienen 0-100 (roeTTM = 17.81 son
// 17,81%) y los múltiplos en veces. Las anclas se miden en esas mismas unidades,
// así que no hay conversión en ningún punto y no hay dónde equivocarse de escala.
//
// Cuando `__m` no está (llamadas viejas que pasan el `info` ya normalizado de la
// app, o la sonda de calibración), se cae a los campos equivalentes multiplicando
// por 100 los que la app dividió.
const _ALIAS = {
  peTTM:'trailingPE', forwardPE:'forwardPE', pegTTM:'pegRatio',
  evEbitdaTTM:'enterpriseToEbitda', psTTM:'priceToSales', pbQuarterly:'priceToBook',
  pbAnnual:'priceToBook', beta:'beta', marketCapitalization:null,
  roeTTM:['returnOnEquity',100], roaTTM:['returnOnAssets',100], roiTTM:['returnOnCapital',100],
  netProfitMarginTTM:['profitMargins',100], grossMarginTTM:['grossMargins',100],
  operatingMarginTTM:['operatingMargins',100],
  revenueGrowthTTMYoy:['revenueGrowth',100], epsGrowthTTMYoy:['earningsGrowth',100],
  revenueGrowthQuarterlyYoy:['revenueGrowthQ',100],
  currentDividendYieldTTM:['dividendYield',100],
  'totalDebt/totalEquityQuarterly':'debtToEquity', 'totalDebt/totalEquityAnnual':'debtToEquity',
  currentRatioQuarterly:'currentRatio', currentRatioAnnual:'currentRatio',
  '52WeekHigh':'fiftyTwoWeekHigh',
};

function _leer(info, campo) {
  if (!info) return null;
  const m = info.__m;
  if (m) { const v = m[campo]; if (typeof v === 'number' && isFinite(v)) return v; }
  const a = _ALIAS[campo];
  if (a) {
    const [k, esc] = Array.isArray(a) ? a : [a, 1];
    if (k) { const v = info[k]; if (typeof v === 'number' && isFinite(v)) return v * esc; }
  }
  return null;
}

// ── 1. CATÁLOGO DE MÉTRICAS ─────────────────────────────────────────────────
// Qué es cada métrica y cómo se obtiene. Sin pilar ni peso: eso lo decide cada
// sector, porque la misma métrica no pesa igual en una utility que en una biotech.
//   campo  → nombre del campo en /stock/metric
//   deriva → función (info) → número, para las que hay que calcular
//   dir    → +1 mejor cuanto más alto · −1 mejor cuanto más bajo
//   lbl    → etiqueta para el usuario
//   prox   → si es una APROXIMACIÓN, qué está sustituyendo (va en la UI y en el
//            prompt de IA para no presentar un proxy como si fuera el dato real)
const _CAT = {
  // ── Rentabilidad y eficiencia ──
  roe5Y:            { campo:'roe5Y',              dir:+1, lbl:'ROE (media 5 años)' },
  roeTTM:           { campo:'roeTTM',             dir:+1, lbl:'ROE' },
  roa5Y:            { campo:'roa5Y',              dir:+1, lbl:'ROA (media 5 años)' },
  roaTTM:           { campo:'roaTTM',             dir:+1, lbl:'ROA' },
  roi5Y:            { campo:'roi5Y',              dir:+1, lbl:'Retorno sobre el capital (5 años)' },
  roiTTM:           { campo:'roiTTM',             dir:+1, lbl:'Retorno sobre el capital' },
  margenNeto5Y:     { campo:'netProfitMargin5Y',  dir:+1, lbl:'Margen neto (media 5 años)' },
  margenNetoTTM:    { campo:'netProfitMarginTTM', dir:+1, lbl:'Margen neto' },
  margenOper5Y:     { campo:'operatingMargin5Y',  dir:+1, lbl:'Margen operativo (media 5 años)' },
  margenOperTTM:    { campo:'operatingMarginTTM', dir:+1, lbl:'Margen operativo' },
  margenBrutoTTM:   { campo:'grossMarginTTM',     dir:+1, lbl:'Margen bruto' },
  margenPreTax5Y:   { campo:'pretaxMargin5Y',     dir:+1, lbl:'Margen antes de impuestos (5 años)' },
  rotActivos:       { campo:'assetTurnoverTTM',   dir:+1, lbl:'Rotación de activos' },
  rotInventario:    { campo:'inventoryTurnoverTTM', dir:+1, lbl:'Rotación de inventario' },
  rotCobros:        { campo:'receivablesTurnoverTTM', dir:+1, lbl:'Rotación de cobros' },
  ingresoEmpleado:  { campo:'revenueEmployeeAnnual', dir:+1, lbl:'Ingreso por empleado',
                      prox:'índice de eficiencia' },
  utilidadEmpleado: { campo:'netIncomeEmployeeAnnual', dir:+1, lbl:'Utilidad por empleado',
                      prox:'índice de eficiencia' },

  // ── Crecimiento ──
  crecIngr5Y:       { campo:'revenueGrowth5Y',    dir:+1, lbl:'Crecimiento de ingresos (5 años)' },
  crecIngr3Y:       { campo:'revenueGrowth3Y',    dir:+1, lbl:'Crecimiento de ingresos (3 años)' },
  crecIngrTTM:      { campo:'revenueGrowthTTMYoy', dir:+1, lbl:'Crecimiento de ingresos (12 meses)' },
  crecIngrQ:        { campo:'revenueGrowthQuarterlyYoy', dir:+1, lbl:'Crecimiento de ingresos (trimestre)' },
  crecEps5Y:        { campo:'epsGrowth5Y',        dir:+1, lbl:'Crecimiento del EPS (5 años)' },
  crecEps3Y:        { campo:'epsGrowth3Y',        dir:+1, lbl:'Crecimiento del EPS (3 años)' },
  crecEpsTTM:       { campo:'epsGrowthTTMYoy',    dir:+1, lbl:'Crecimiento del EPS (12 meses)' },
  crecBookValue5Y:  { campo:'bookValueShareGrowth5Y', dir:+1, lbl:'Crecimiento del valor contable (5 años)' },
  crecTBV5Y:        { campo:'tbvCagr5Y',          dir:+1, lbl:'Crecimiento del valor tangible (5 años)' },
  crecEbitda5Y:     { campo:'ebitdaCagr5Y',       dir:+1, lbl:'Crecimiento del EBITDA (5 años)' },
  crecDividendo5Y:  { campo:'dividendGrowthRate5Y', dir:+1, lbl:'Crecimiento del dividendo (5 años)' },
  crecMargen5Y:     { campo:'netMarginGrowth5Y',  dir:+1, lbl:'Mejora del margen (5 años)' },

  // ── Solidez ──
  deudaLPCapital:   { campo:'longTermDebt/equityQuarterly', dir:-1, lbl:'Deuda a largo plazo / capital' },
  deudaTotalCapital:{ campo:'totalDebt/totalEquityQuarterly', dir:-1, lbl:'Deuda total / capital' },
  liquidezCorriente:{ campo:'currentRatioQuarterly', dir:+1, lbl:'Razón corriente' },
  liquidezRapida:   { campo:'quickRatioQuarterly', dir:+1, lbl:'Razón rápida' },
  cobInteres:       { campo:'netInterestCoverageTTM', dir:+1, lbl:'Cobertura de intereses' },
  payout:           { campo:'payoutRatioTTM',     dir:-1, lbl:'Payout del dividendo' },
  flujoCajaAccion:  { campo:'cashFlowPerShareTTM', dir:+1, lbl:'Flujo de caja por acción' },
  capexCagr5Y:      { campo:'capexCagr5Y',        dir:-1, lbl:'Crecimiento del capex (5 años)' },
  volatilidad:      { campo:'3MonthADReturnStd',  dir:-1, lbl:'Volatilidad (3 meses)' },

  // ── Valoración ──
  peAdelantado:     { campo:'forwardPE',          dir:-1, lbl:'P/E adelantado' },
  peTTM:            { campo:'peTTM',              dir:-1, lbl:'P/E' },
  peNormalizado:    { campo:'peNormalizedAnnual', dir:-1, lbl:'P/E normalizado' },
  peg:              { campo:'pegTTM',             dir:-1, lbl:'PEG' },
  evEbitda:         { campo:'evEbitdaTTM',        dir:-1, lbl:'EV / EBITDA' },
  evIngresos:       { campo:'evRevenueTTM',       dir:-1, lbl:'EV / Ingresos' },
  evFcf:            { campo:'currentEv/freeCashFlowTTM', dir:-1, lbl:'EV / Flujo de caja libre' },
  ps:               { campo:'psTTM',              dir:-1, lbl:'Precio / Ventas' },
  pb:               { campo:'pbQuarterly',        dir:-1, lbl:'Precio / Valor contable' },
  ptbv:             { campo:'ptbvQuarterly',      dir:-1, lbl:'Precio / Valor contable tangible' },
  pFlujoCaja:       { campo:'pcfShareTTM',        dir:-1, lbl:'Precio / Flujo de caja',
                      prox:'P/FFO' },
  pFcf:             { campo:'pfcfShareTTM',       dir:-1, lbl:'Precio / Flujo de caja libre' },
  dividendo:        { campo:'currentDividendYieldTTM', dir:+1, lbl:'Rentabilidad por dividendo' },

  // ── Mercado ──
  fuerzaRel13s:     { campo:'priceRelativeToS&P50013Week', dir:+1, lbl:'Frente al S&P 500 (13 semanas)' },
  fuerzaRel26s:     { campo:'priceRelativeToS&P50026Week', dir:+1, lbl:'Frente al S&P 500 (26 semanas)' },
  fuerzaRel52s:     { campo:'priceRelativeToS&P50052Week', dir:+1, lbl:'Frente al S&P 500 (52 semanas)' },

  // ── Derivadas ──
  // Posición en el ciclo: margen de hoy contra su propia media de 5 años. Un
  // margen muy por encima de su media no es excelencia, es pico de ciclo — y el
  // dato lo dice sin que nadie tenga que decidir a mano cuándo hay pico.
  cicloMargen: { dir:-1, lbl:'Margen frente a su media de 5 años',
    deriva: i => { const a = _leer(i,'operatingMarginTTM'), b = _leer(i,'operatingMargin5Y');
                   return (a != null && b != null && Math.abs(b) > 1) ? a / b : null; } },

  // Meses de caja: la métrica que define a una biotech sin ingresos. Solo tiene
  // sentido si la empresa QUEMA caja; si la genera, no hay runway que medir.
  runwayMeses: { dir:+1, lbl:'Meses de caja', prox:'runway',
    deriva: i => { const caja = _leer(i,'cashPerSharePerShareQuarterly'),
                         flujo = _leer(i,'cashFlowPerShareTTM');
                   if (caja == null || flujo == null || flujo >= 0) return null;
                   return Math.min(120, caja / (Math.abs(flujo) / 12)); } },

  // Payout sobre FLUJO DE CAJA, no sobre utilidad. El payoutRatio de Finnhub divide el
  // dividendo entre el EPS, y en un REIT el EPS está aplastado por la depreciación
  // contable de inmuebles que en realidad se revalorizan: Realty Income sale al 236%
  // de payout cuando sobre su flujo de caja está en torno al 77%. Con este cociente la
  // pregunta vuelve a ser la de verdad: ¿el negocio genera la caja que reparte?
  payoutFlujo: { dir:-1, lbl:'Payout sobre flujo de caja', prox:'payout sobre FFO',
    deriva: i => { const div = _leer(i,'dividendPerShareTTM'), cf = _leer(i,'cashFlowPerShareTTM');
                   return (div != null && cf != null && cf > 0.01) ? 100 * div / cf : null; } },

  // Consenso de analistas, ponderado por cuántos cubren la empresa: una sola
  // opinión no vale lo que treinta.
  consenso: { dir:+1, lbl:'Consenso de analistas', escalaFija:true,
    deriva: i => { const rm = i?.recommendationMean, n = i?.numberOfAnalystOpinions || 0;
                   if (typeof rm !== 'number' || !isFinite(rm)) return null;
                   const bruto = Math.max(0.5, Math.min(9.8, 11.2 - 2.6 * rm));
                   const conf = n >= 30 ? 1 : n >= 20 ? 0.9 : n >= 12 ? 0.75 : n >= 5 ? 0.55 : 0.3;
                   return 5 + (bruto - 5) * conf; } },
};

// ── 2. MODELOS SECTORIALES ──────────────────────────────────────────────────
//  w   → peso de cada pilar (suman 100)
//  m   → LAS MÉTRICAS DE ESTE SECTOR: clave del catálogo → [pilar, peso]
//  cap → techo estructural de la nota (economía del sector)
//  cyc → sector cíclico
//
// Ocho sectores tienen modelo propio porque son donde una vara genérica se
// equivoca más. El resto usa _GEN, que también mejoró: promedios de 5 años en
// vez de fotos TTM, crecimiento plurianual y fuerza relativa contra el S&P.

// Modelo genérico. Sirve para cualquier empresa que venda algo y tenga utilidades.
const _GEN = {
  margenOper5Y:['rent',1.2], margenNeto5Y:['rent',1.0], margenBrutoTTM:['rent',0.7],
  roe5Y:['rent',1.1], roi5Y:['rent',1.1],
  crecIngr3Y:['crec',1.3], crecEps3Y:['crec',1.0], crecIngrTTM:['crec',0.6], crecIngrQ:['crec',0.5],
  roa5Y:['soli',0.8], deudaTotalCapital:['soli',1.1], liquidezCorriente:['soli',0.7],
  cobInteres:['soli',0.9], flujoCajaAccion:['soli',0.8],
  peAdelantado:['valo',1.3], peTTM:['valo',0.5], peg:['valo',0.8], evEbitda:['valo',1.1],
  ps:['valo',0.5], pb:['valo',0.4], pFcf:['valo',0.9], dividendo:['valo',0.3],
  consenso:['merc',1.3], fuerzaRel26s:['merc',0.9], fuerzaRel52s:['merc',0.6],
};
const _W_GEN = { rent:26, crec:22, soli:18, valo:24, merc:10 };
const _g = (label, cap, extra) => Object.assign({ label, cap, w:_W_GEN, m:_GEN }, extra || {});

// Las tres métricas que el genérico añade a los sectores cíclicos: dónde está el
// margen respecto a su propia media, para no premiar un pico como si fuera calidad.
const _GEN_CIC = Object.assign({}, _GEN, { cicloMargen:['rent',0.7] });
const _gc = (label, cap) => ({ label, cap, cyc:true, w:_W_GEN, m:_GEN_CIC });

const _SECTOR_MODELS = {

  // ═══ MODELOS PROPIOS ══════════════════════════════════════════════════════

  // BANCA · El margen bruto y la deuda/capital no significan nada aquí: la deuda
  // de un banco son los depósitos de sus clientes. Lo que define a un banco es
  // cuánto retorno saca de su capital y a qué precio cotiza su valor tangible.
  BANCO: {
    label:'Banca', cap:9.0,
    w:{ rent:28, crec:18, soli:20, valo:24, merc:10 },
    m:{
      roe5Y:['rent',1.5], roaTTM:['rent',1.2], margenNeto5Y:['rent',1.0],
      ingresoEmpleado:['rent',0.4],                    // proxy débil de eficiencia
      crecBookValue5Y:['crec',1.4],                    // un banco crece componiendo book value
      crecEps5Y:['crec',1.1], crecIngr5Y:['crec',0.6],
      deudaLPCapital:['soli',1.0],                     // la de largo plazo sí informa
      payout:['soli',1.0], crecTBV5Y:['soli',0.7],
      ptbv:['valo',1.6],                               // LA métrica de valoración bancaria
      peAdelantado:['valo',0.9], peNormalizado:['valo',0.5], dividendo:['valo',0.6],
      consenso:['merc',1.2], fuerzaRel26s:['merc',0.9],
    },
  },

  // SEGUROS · Misma familia que banca. El margen neto de 5 años hace de proxy del
  // resultado técnico: una aseguradora que suscribe mal no lo sostiene un lustro.
  SEGUROS: {
    label:'Seguros', cap:9.0,
    w:{ rent:26, crec:16, soli:22, valo:26, merc:10 },
    m:{
      roe5Y:['rent',1.5], margenNeto5Y:['rent',1.3], roaTTM:['rent',0.9],
      crecBookValue5Y:['crec',1.4], crecEps5Y:['crec',1.0], crecIngr5Y:['crec',0.7],
      deudaLPCapital:['soli',1.0], payout:['soli',1.0], crecTBV5Y:['soli',0.8],
      ptbv:['valo',1.5], pb:['valo',0.8], peAdelantado:['valo',0.9], dividendo:['valo',0.6],
      consenso:['merc',1.2], fuerzaRel26s:['merc',0.9],
    },
  },

  // REIT · El P/E de un REIT no informa: la depreciación contable de un edificio
  // que se revaloriza tapa la utilidad. Lo que importa es el flujo de caja, si el
  // dividendo está cubierto, y cuánto aguanta la deuda si suben las tasas.
  REIT: {
    label:'REIT · bienes raíces', cap:8.6,
    w:{ rent:18, crec:16, soli:26, valo:30, merc:10 },
    m:{
      rotActivos:['rent',1.0],                         // proxy débil de ocupación
      margenOper5Y:['rent',1.2], roi5Y:['rent',0.8],
      crecDividendo5Y:['crec',1.4], crecIngr3Y:['crec',1.0], crecEbitda5Y:['crec',0.8],
      payoutFlujo:['soli',1.6],                        // la pregunta central de un REIT
      payout:['soli',0.4],                             // sobre EPS: ruidoso aquí, peso bajo
      cobInteres:['soli',1.4],                         // exposición a tasas
      deudaTotalCapital:['soli',0.8],
      pFlujoCaja:['valo',1.6],                         // proxy de P/FFO
      pb:['valo',0.9], evEbitda:['valo',1.0], dividendo:['valo',0.9],
      consenso:['merc',1.1], fuerzaRel26s:['merc',0.9],
    },
  },

  // UTILITY · El producto es la previsibilidad, no el crecimiento. Se premia la
  // baja volatilidad y la cobertura del dividendo; crecer rápido no es la meta.
  UTILITY: {
    label:'Servicios públicos', cap:8.7,
    w:{ rent:20, crec:14, soli:30, valo:26, merc:10 },
    m:{
      roi5Y:['rent',1.3], margenOper5Y:['rent',1.2], margenNeto5Y:['rent',0.9],
      crecDividendo5Y:['crec',1.3], crecEps5Y:['crec',1.0], crecIngr5Y:['crec',0.7],
      payoutFlujo:['soli',1.4], payout:['soli',0.6],
      cobInteres:['soli',1.3], deudaTotalCapital:['soli',0.9],
      capexCagr5Y:['soli',0.5], volatilidad:['soli',0.8],
      peAdelantado:['valo',1.2], pb:['valo',0.8], evEbitda:['valo',1.0], dividendo:['valo',1.1],
      consenso:['merc',1.1], fuerzaRel52s:['merc',0.8],
    },
  },

  // BIOTECH EN FASE CLÍNICA · No hay utilidades, así que ningún múltiplo de
  // utilidades aplica. La única pregunta real es cuánto le queda de caja antes de
  // tener que diluir a sus accionistas, y si alguien la cubre.
  BIOTECH_CLINICO: {
    label:'Biotech en fase clínica', cap:8.5,
    w:{ rent:5, crec:15, soli:45, valo:15, merc:20 },
    m:{
      margenBrutoTTM:['rent',0.6],
      crecIngr3Y:['crec',1.0], crecIngrQ:['crec',0.6],
      runwayMeses:['soli',1.8],                        // LA métrica del sector
      liquidezCorriente:['soli',1.2], flujoCajaAccion:['soli',1.0],
      deudaTotalCapital:['soli',0.8],
      pb:['valo',1.2], ps:['valo',0.6],
      consenso:['merc',1.4],                           // que la cubran ya es validación
      fuerzaRel26s:['merc',0.7],
    },
  },

  // TRANSPORTE Y AEROLÍNEAS · Capital-intensivo y cíclico. Castigarlo por
  // apalancamiento es castigarlo por existir: lo que importa es si el flujo cubre
  // los intereses y si el margen de hoy es sostenible o es pico de ciclo.
  TRANSPORTE: {
    label:'Transporte y aerolíneas', cap:7.8, cyc:true,
    w:{ rent:28, crec:12, soli:28, valo:24, merc:8 },
    m:{
      margenOper5Y:['rent',1.5],                       // a través del ciclo
      cicloMargen:['rent',1.0],                        // ¿pico o fondo? lo dice el dato
      rotActivos:['rent',1.0], ingresoEmpleado:['rent',0.5],
      crecIngr3Y:['crec',1.1], crecEbitda5Y:['crec',0.9],
      cobInteres:['soli',1.6],                         // mejor que deuda/capital aquí
      deudaTotalCapital:['soli',0.7], capexCagr5Y:['soli',0.9], flujoCajaAccion:['soli',0.9],
      evEbitda:['valo',1.5],                           // el múltiplo correcto con deuda alta
      evFcf:['valo',1.0], peAdelantado:['valo',0.7], pb:['valo',0.5],
      consenso:['merc',1.1], fuerzaRel26s:['merc',0.8],
    },
  },

  // ENERGÍA · Los ingresos los mueve el precio del crudo, no la gestión. Por eso
  // el crecimiento pesa poco y pesa mucho el retorno del capital a través del ciclo
  // y la disciplina de inversión.
  ENERGIA_EP: {
    label:'Energía · exploración y producción', cap:8.4, cyc:true,
    w:{ rent:26, crec:10, soli:24, valo:30, merc:10 },
    m:{
      margenOper5Y:['rent',1.4], cicloMargen:['rent',1.1], roi5Y:['rent',1.2],
      crecEbitda5Y:['crec',1.0], crecIngr5Y:['crec',0.5],
      cobInteres:['soli',1.3], deudaTotalCapital:['soli',1.1],
      capexCagr5Y:['soli',1.0], flujoCajaAccion:['soli',0.9],
      evEbitda:['valo',1.4], evFcf:['valo',1.2], pFcf:['valo',1.0],
      payout:['valo',0.5], dividendo:['valo',0.8],
      consenso:['merc',1.1], fuerzaRel26s:['merc',0.8],
    },
  },

  // RETAIL · Un margen bruto del 13% es el modelo de negocio de Costco, no una
  // debilidad. Lo que separa a un buen minorista de uno malo es la rotación.
  RETAIL: {
    label:'Retail', cap:8.8,
    w:{ rent:30, crec:18, soli:18, valo:26, merc:8 },
    m:{
      rotInventario:['rent',1.5],                      // la métrica operativa del sector
      rotActivos:['rent',1.2], margenOper5Y:['rent',1.3],
      margenBrutoTTM:['rent',0.3],                     // peso mínimo: es el modelo, no la calidad
      roi5Y:['rent',1.0],
      crecIngr3Y:['crec',1.4],                         // proxy de ventas comparables
      crecEps3Y:['crec',1.0], crecIngrQ:['crec',0.6],
      deudaTotalCapital:['soli',1.0], liquidezCorriente:['soli',0.8],
      cobInteres:['soli',1.0], flujoCajaAccion:['soli',0.9],
      evEbitda:['valo',1.3], peAdelantado:['valo',1.2], pFcf:['valo',0.9],
      peg:['valo',0.6], dividendo:['valo',0.3],
      consenso:['merc',1.2], fuerzaRel26s:['merc',0.8],
    },
  },

  // ═══ MODELO GENÉRICO MEJORADO ═════════════════════════════════════════════
  SEMI:              _gc('Semiconductores', 9.6),
  SEMI_EQUIP:        _gc('Equipos de semiconductores', 9.4),
  HARDWARE:          _gc('Hardware y equipos', 9.2),
  MATERIALES:        _gc('Materiales básicos', 8.2),
  CONSUMO_DISC:      _gc('Consumo discrecional', 8.9),
  INDUSTRIAL:        _gc('Industrial', 9.0),
  AUTOS:             _gc('Automotriz', 8.0),
  ENERGIA_INTEGRADA: { label:'Energía integrada', cap:8.6, cyc:true,
                       w:{ rent:26, crec:10, soli:24, valo:30, merc:10 },
                       m:null },   // comparte modelo con ENERGIA_EP (se resuelve abajo)
  SOFTWARE:          _g('Software', 9.6),
  SAAS_GROWTH:       _g('SaaS · alto crecimiento', 9.3,
                        { w:{ rent:16, crec:34, soli:20, valo:20, merc:10 } }),
  INTERNET_PLAT:     _g('Plataformas de internet', 9.6),
  PAGOS:             _g('Pagos y fintech', 9.5),
  GESTOR_ACTIVOS:    _g('Gestión de activos y brokers', 9.0),
  FARMA:             _g('Farmacéutica', 9.3),
  DISPOSITIVOS:      _g('Dispositivos médicos', 9.2),
  SALUD_SERVICIOS:   _g('Servicios de salud', 8.9),
  CONSUMO_BASICO:    _g('Consumo básico', 9.0),
  AEROESPACIAL_DEF:  _g('Aeroespacial y defensa', 9.0),
  TELECOM_MEDIOS:    _g('Telecom y medios', 8.7),
  MERCADO:           _g('Mercado general', 9.2),
};
_SECTOR_MODELS.ENERGIA_INTEGRADA.m = _SECTOR_MODELS.ENERGIA_EP.m;

// Compatibilidad: el resto del código (y el clasificador) sigue hablando de
// _SECTOR_PROFILES. Es el mismo objeto con otro nombre.
const _SECTOR_PROFILES = _SECTOR_MODELS;

// ── 3. ANCLAS MEDIDAS ───────────────────────────────────────────────────────
// Los percentiles reales de cada métrica dentro de cada sector, medidos sobre el
// universo con scripts/calibrar-anclas.mjs. NO hay números escritos a mano: si
// un sector no tiene suficientes empresas para sostener un ancla, se cae al
// mercado completo antes que inventar un corte.
//
// En el navegador las inyecta el <script> anterior como window.PORTIV_ANCLAS.
// En Node, el arnés de pruebas asigna globalThis.PORTIV_ANCLAS.
function _anclasRaiz() {
  return (typeof globalThis !== 'undefined' && globalThis.PORTIV_ANCLAS) || null;
}

// Sector hermano al que caer cuando un perfil no tiene suficientes empresas. Es
// preferible comparar una fintech de pagos contra software que contra el mercado
// entero: se pierde precisión, no el sentido de la comparación.
const _HERMANO = {
  ENERGIA_INTEGRADA:'ENERGIA_EP', SEMI_EQUIP:'SEMI', HARDWARE:'SEMI',
  SAAS_GROWTH:'SOFTWARE', PAGOS:'SOFTWARE', SOFTWARE:'INTERNET_PLAT',
  DISPOSITIVOS:'SALUD_SERVICIOS', GESTOR_ACTIVOS:'BANCO',
};

// Devuelve [p25, p50, p75, p10, p90] del campo: primero su sector, luego el hermano,
// y solo si no hay nada, el mercado entero. `origen` dice de dónde salió, para poder
// auditar cada nota.
function _ancla(pid, campo) {
  const A = _anclasRaiz();
  if (!A) return null;
  const _de = (id) => {
    const p = A.perfiles && A.perfiles[id];
    if (p && p.suficiente && p.anclas && p.anclas[campo]) {
      const a = p.anclas[campo];
      if (a.n >= 8) return { v:[a.p25, a.p50, a.p75, a.p10, a.p90], n:a.n };
    }
    return null;
  };
  const propio = _de(pid);
  if (propio) return Object.assign(propio, { origen:'sector' });
  // Cadena de hermanos, con tope para no dar vueltas si alguien encadena mal.
  let h = _HERMANO[pid];
  for (let i = 0; h && i < 3; i++) {
    const r = _de(h);
    if (r) return Object.assign(r, { origen:'hermano', hermano:h });
    h = _HERMANO[h];
  }
  const m = A.mercado && A.mercado.anclas && A.mercado.anclas[campo];
  if (m) return { v:[m.p25, m.p50, m.p75, m.p10, m.p90], origen:'mercado', n:m.n };
  return null;
}

// ── 4. CLASIFICADOR ─────────────────────────────────────────────────────────
// Overrides por ticker donde la industria del proveedor de datos no basta.
const _PROFILE_OVERRIDE = {
  NVDA:'SEMI', AMD:'SEMI', MU:'SEMI', TSM:'SEMI', INTC:'SEMI', QCOM:'SEMI',
  AVGO:'SEMI', MRVL:'SEMI', TXN:'SEMI', NXPI:'SEMI', ADI:'SEMI', ON:'SEMI',
  ASML:'SEMI_EQUIP', AMAT:'SEMI_EQUIP', LRCX:'SEMI_EQUIP', KLAC:'SEMI_EQUIP', TER:'SEMI_EQUIP',
  MSFT:'SOFTWARE', ORCL:'SOFTWARE', CRM:'SOFTWARE', ADBE:'SOFTWARE', NOW:'SOFTWARE',
  INTU:'SOFTWARE', SAP:'SOFTWARE', PANW:'SOFTWARE', FTNT:'SOFTWARE', WDAY:'SOFTWARE',
  CRWD:'SAAS_GROWTH', ZS:'SAAS_GROWTH', SNOW:'SAAS_GROWTH', DDOG:'SAAS_GROWTH',
  MDB:'SAAS_GROWTH', NET:'SAAS_GROWTH', OKTA:'SAAS_GROWTH', GTLB:'SAAS_GROWTH',
  CFLT:'SAAS_GROWTH', S:'SAAS_GROWTH', TEAM:'SAAS_GROWTH', HUBS:'SAAS_GROWTH',
  GOOGL:'INTERNET_PLAT', GOOG:'INTERNET_PLAT', META:'INTERNET_PLAT', AMZN:'INTERNET_PLAT',
  NFLX:'INTERNET_PLAT', UBER:'INTERNET_PLAT', ABNB:'INTERNET_PLAT', BKNG:'INTERNET_PLAT',
  SPOT:'INTERNET_PLAT', PLTR:'SOFTWARE', RDDT:'INTERNET_PLAT', APP:'INTERNET_PLAT',
  TTD:'INTERNET_PLAT', SHOP:'INTERNET_PLAT', SE:'INTERNET_PLAT', MELI:'INTERNET_PLAT',
  AAPL:'HARDWARE', DELL:'HARDWARE', HPQ:'HARDWARE', ANET:'HARDWARE', CSCO:'HARDWARE',
  SMCI:'HARDWARE', WDC:'HARDWARE', STX:'HARDWARE',
  JPM:'BANCO', BAC:'BANCO', WFC:'BANCO', C:'BANCO', USB:'BANCO', PNC:'BANCO',
  TFC:'BANCO', COF:'BANCO', HSBC:'BANCO', RY:'BANCO', NU:'BANCO',
  GS:'GESTOR_ACTIVOS', MS:'GESTOR_ACTIVOS', SCHW:'GESTOR_ACTIVOS', BLK:'GESTOR_ACTIVOS',
  BX:'GESTOR_ACTIVOS', KKR:'GESTOR_ACTIVOS', APO:'GESTOR_ACTIVOS', HOOD:'GESTOR_ACTIVOS',
  IBKR:'GESTOR_ACTIVOS', COIN:'GESTOR_ACTIVOS',
  'BRK-B':'SEGUROS', 'BRK.B':'SEGUROS', PGR:'SEGUROS', CB:'SEGUROS', TRV:'SEGUROS',
  ALL:'SEGUROS', AIG:'SEGUROS', MET:'SEGUROS', PRU:'SEGUROS',
  V:'PAGOS', MA:'PAGOS', AXP:'PAGOS', PYPL:'PAGOS', FI:'PAGOS', FIS:'PAGOS',
  GPN:'PAGOS', SQ:'PAGOS', XYZ:'PAGOS', AFRM:'PAGOS', SOFI:'PAGOS', TOST:'PAGOS',
  LLY:'FARMA', JNJ:'FARMA', PFE:'FARMA', MRK:'FARMA', ABBV:'FARMA', BMY:'FARMA',
  AMGN:'FARMA', GILD:'FARMA', NVO:'FARMA', AZN:'FARMA', VRTX:'FARMA', REGN:'FARMA',
  MRNA:'BIOTECH_CLINICO', BNTX:'BIOTECH_CLINICO', CRSP:'BIOTECH_CLINICO',
  NTLA:'BIOTECH_CLINICO', BEAM:'BIOTECH_CLINICO', SRPT:'BIOTECH_CLINICO',
  ISRG:'DISPOSITIVOS', ABT:'DISPOSITIVOS', MDT:'DISPOSITIVOS', SYK:'DISPOSITIVOS',
  BSX:'DISPOSITIVOS', DXCM:'DISPOSITIVOS', TMO:'DISPOSITIVOS', DHR:'DISPOSITIVOS',
  UNH:'SALUD_SERVICIOS', CVS:'SALUD_SERVICIOS', CI:'SALUD_SERVICIOS',
  ELV:'SALUD_SERVICIOS', MCK:'SALUD_SERVICIOS', HCA:'SALUD_SERVICIOS',
  XOM:'ENERGIA_INTEGRADA', CVX:'ENERGIA_INTEGRADA', SHEL:'ENERGIA_INTEGRADA',
  BP:'ENERGIA_INTEGRADA', TTE:'ENERGIA_INTEGRADA',
  COP:'ENERGIA_EP', EOG:'ENERGIA_EP', OXY:'ENERGIA_EP', DVN:'ENERGIA_EP',
  FANG:'ENERGIA_EP', PXD:'ENERGIA_EP', HES:'ENERGIA_EP', SLB:'ENERGIA_EP',
  NEE:'UTILITY', DUK:'UTILITY', SO:'UTILITY', D:'UTILITY', AEP:'UTILITY',
  EXC:'UTILITY', XEL:'UTILITY', ED:'UTILITY', CEG:'UTILITY', VST:'UTILITY',
  ETR:'UTILITY', SRE:'UTILITY', PCG:'UTILITY',
  PLD:'REIT', AMT:'REIT', EQIX:'REIT', CCI:'REIT', SPG:'REIT', O:'REIT',
  PSA:'REIT', DLR:'REIT', WELL:'REIT', VICI:'REIT', IRM:'REIT',
  PG:'CONSUMO_BASICO', KO:'CONSUMO_BASICO', PEP:'CONSUMO_BASICO', PM:'CONSUMO_BASICO',
  MO:'CONSUMO_BASICO', MDLZ:'CONSUMO_BASICO', CL:'CONSUMO_BASICO', KMB:'CONSUMO_BASICO',
  GIS:'CONSUMO_BASICO', KHC:'CONSUMO_BASICO', STZ:'CONSUMO_BASICO', MNST:'CONSUMO_BASICO',
  WMT:'RETAIL', COST:'RETAIL', TGT:'RETAIL', HD:'RETAIL', LOW:'RETAIL',
  DG:'RETAIL', DLTR:'RETAIL', TJX:'RETAIL', ROST:'RETAIL', KR:'RETAIL',
  MCD:'CONSUMO_DISC', SBUX:'CONSUMO_DISC', NKE:'CONSUMO_DISC', CMG:'CONSUMO_DISC',
  LULU:'CONSUMO_DISC', YUM:'CONSUMO_DISC', MAR:'CONSUMO_DISC', HLT:'CONSUMO_DISC',
  DIS:'TELECOM_MEDIOS', CMCSA:'TELECOM_MEDIOS', T:'TELECOM_MEDIOS', VZ:'TELECOM_MEDIOS',
  TMUS:'TELECOM_MEDIOS', WBD:'TELECOM_MEDIOS', PARA:'TELECOM_MEDIOS',
  CAT:'INDUSTRIAL', DE:'INDUSTRIAL', HON:'INDUSTRIAL', GE:'INDUSTRIAL', MMM:'INDUSTRIAL',
  EMR:'INDUSTRIAL', ETN:'INDUSTRIAL', PH:'INDUSTRIAL', ITW:'INDUSTRIAL', CMI:'INDUSTRIAL',
  RTX:'AEROESPACIAL_DEF', LMT:'AEROESPACIAL_DEF', NOC:'AEROESPACIAL_DEF',
  GD:'AEROESPACIAL_DEF', BA:'AEROESPACIAL_DEF', LHX:'AEROESPACIAL_DEF',
  AXON:'AEROESPACIAL_DEF', RKLB:'AEROESPACIAL_DEF', LDOS:'AEROESPACIAL_DEF',
  UPS:'TRANSPORTE', FDX:'TRANSPORTE', UNP:'TRANSPORTE', CSX:'TRANSPORTE',
  NSC:'TRANSPORTE', DAL:'TRANSPORTE', UAL:'TRANSPORTE', LUV:'TRANSPORTE', AAL:'TRANSPORTE',
  TSLA:'AUTOS', GM:'AUTOS', F:'AUTOS', RIVN:'AUTOS', LCID:'AUTOS', STLA:'AUTOS',
  LIN:'MATERIALES', SHW:'MATERIALES', APD:'MATERIALES', FCX:'MATERIALES',
  NEM:'MATERIALES', NUE:'MATERIALES', DOW:'MATERIALES', ECL:'MATERIALES',
};

// Palabras clave de la industria (Finnhub `finnhubIndustry` o GICS de Yahoo) → perfil.
// El orden importa: lo más específico primero.
const _INDUSTRY_RULES = [
  [/semiconductor equip|semiconductor material/i,           'SEMI_EQUIP'],
  [/semiconductor|integrated circuit/i,                     'SEMI'],
  [/reit|real estate investment trust/i,                    'REIT'],
  [/bank|thrift|savings|mortgage finance/i,                 'BANCO'],
  [/insurance|reinsuran/i,                                  'SEGUROS'],
  [/capital market|asset management|brokerage|investment bank|diversified financ/i, 'GESTOR_ACTIVOS'],
  [/payment|credit services|transaction process/i,          'PAGOS'],
  [/biotechnolog|life sciences tools/i,                     'BIOTECH_CLINICO'],
  [/pharmaceutical|drug manufactur/i,                       'FARMA'],
  [/medical device|health care equipment|medical instrument|diagnostic/i, 'DISPOSITIVOS'],
  [/health|managed care|hospital|pharmacy/i,                'SALUD_SERVICIOS'],
  [/oil.*gas.*(e&p|exploration|production|drilling|equipment|services)|coal/i, 'ENERGIA_EP'],
  [/oil.*gas.*integrated|energy.*integrated/i,              'ENERGIA_INTEGRADA'],
  [/oil|gas|petroleum|energy/i,                             'ENERGIA_EP'],
  [/utilit|electric power|water suppl|gas distribut/i,      'UTILITY'],
  [/software|internet software|it services|information technolog/i, 'SOFTWARE'],
  [/internet content|interactive media|e-commerce|online|interactive home entertainment/i, 'INTERNET_PLAT'],
  [/computer|hardware|peripheral|electronic equipment|communications equipment|technology hardware/i, 'HARDWARE'],
  [/telecom|wireless|media|broadcast|publishing|entertainment|advertis|cable/i, 'TELECOM_MEDIOS'],
  [/aerospace|defense/i,                                    'AEROESPACIAL_DEF'],
  [/airline|air transport|trucking|railroad|marine|logistic|freight|delivery/i, 'TRANSPORTE'],
  [/auto|vehicle|tires/i,                                   'AUTOS'],
  [/machinery|industrial conglomerate|building product|construction|engineering|electrical equipment|business services|professional services/i, 'INDUSTRIAL'],
  [/chemical|metal|mining|steel|paper|forest|container|packaging|gold|copper|aluminum/i, 'MATERIALES'],
  [/beverage|food product|food processing|tobacco|household product|personal product|consumer staple|agricultur/i, 'CONSUMO_BASICO'],
  [/retail|distributor|grocery|supermarket|department store/i, 'RETAIL'],
  [/restaurant|apparel|footwear|leisure|hotel|lodging|luxury|textile|casino|travel|consumer discretionary|homebuild/i, 'CONSUMO_DISC'],
  [/real estate/i,                                          'REIT'],
];

function _sectorProfileOf(ticker, info) {
  const t = String(ticker || '').toUpperCase();
  if (info && info.__forceProfile && _SECTOR_PROFILES[info.__forceProfile])
    return { id: info.__forceProfile, p: _SECTOR_PROFILES[info.__forceProfile] };
  const qt = String(info?.quoteType || '').toUpperCase();
  if (qt === 'ETF' || qt === 'MUTUALFUND') return { id: 'ETF', p: null };

  if (_PROFILE_OVERRIDE[t]) return { id: _PROFILE_OVERRIDE[t], p: _SECTOR_PROFILES[_PROFILE_OVERRIDE[t]] };

  const txt = `${info?.industry || ''} ${info?.sector || ''}`.trim();
  for (const [re, id] of _INDUSTRY_RULES) {
    if (re.test(txt)) {
      // Un "software" que pierde plata y crece >25% es SaaS de crecimiento, no software maduro.
      if (id === 'SOFTWARE' && info?.profitMargins != null && info.profitMargins < 0.05 &&
          info?.revenueGrowth != null && info.revenueGrowth > 0.18) return { id:'SAAS_GROWTH', p:_SECTOR_PROFILES.SAAS_GROWTH };
      // Una "biotech" con ingresos y utilidades reales es farma, no clínica.
      if (id === 'BIOTECH_CLINICO' && info?.profitMargins != null && info.profitMargins > 0.10)
        return { id:'FARMA', p:_SECTOR_PROFILES.FARMA };
      return { id, p: _SECTOR_PROFILES[id] };
    }
  }
  return { id: 'MERCADO', p: _SECTOR_PROFILES.MERCADO };
}


// ── 5. NORMALIZACIÓN ROBUSTA ────────────────────────────────────────────────
// z robusto contra el sector, winsorizado, mapeado a 0–10.
// Estar EXACTAMENTE en la mediana del sector siempre da 5.0.
function _anchorScore(x, anchors, dir) {
  if (x == null || !isFinite(x) || !anchors) return null;
  const [p25, med, p75, p10, p90] = anchors;
  // σ robusta. Con 15-20 empresas por sector el rango intercuartil sale demasiado
  // estrecho y casi todo se va a los topes: un P/E adelantado de 14 en un banco no
  // puede puntuar 1,9/10. Se toma el MAYOR de los dos estimadores de σ — el
  // intercuartil y el p10-p90, que ve las colas — para no inventar precisión que
  // la muestra no tiene.
  const sIQR = Math.abs(p75 - p25) / 1.35;
  const sDec = (p10 != null && p90 != null) ? Math.abs(p90 - p10) / 2.56 : 0;
  const spread = Math.max(sIQR, sDec, 1e-9);
  let z = (x - med) / spread;
  z = Math.max(-2.2, Math.min(2.2, z)) * (dir < 0 ? -1 : 1);
  return Math.max(0.4, Math.min(9.9, 5 + 2.05 * z));
}

// ── 6. MOTOR ────────────────────────────────────────────────────────────────
function computeSectorRating(ticker, info) {
  const { id: pid, p: prof } = _sectorProfileOf(ticker, info);
  if (pid === 'ETF') return { nota: null, esEtf: true, perfil: 'ETF' };
  if (!prof || !prof.m) return { nota: null, perfil: pid, perfilId: pid, motivo: 'sin modelo' };
  if (!_anclasRaiz()) return { nota: null, perfil: prof.label, perfilId: pid, motivo: 'sin anclas' };

  // ── Valor de cada métrica del modelo de ESTE sector ──
  const _valor = (clave) => {
    const d = _CAT[clave]; if (!d) return null;
    const v = d.deriva ? d.deriva(info) : _leer(info, d.campo);
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  };

  // ── Puntuar cada métrica DOS VECES: contra su sector y contra el mercado ──
  //   z_sector  → ¿es buena PARA SU SECTOR?   (→ percentil sectorial)
  //   z_mercado → ¿es buena EN ABSOLUTO?      (→ evita que el mejor de un mal
  //                                             sector puntúe como una élite real)
  const PS = { rent:[], crec:[], soli:[], valo:[], merc:[] };
  const PM = { rent:[], crec:[], soli:[], valo:[], merc:[] };
  const detalle = {};
  let usadas = 0, posibles = 0, deMercado = 0;

  for (const [clave, [pil, peso]] of Object.entries(prof.m)) {
    const d = _CAT[clave]; if (!d || peso <= 0) continue;
    posibles += peso;
    const x = _valor(clave);
    if (x == null) continue;

    let sSec, sMkt;
    if (d.escalaFija) {                       // ya viene en escala 0–10 (consenso)
      sSec = sMkt = Math.max(0.4, Math.min(9.9, x));
    } else {
      const aSec = _ancla(pid, d.campo || clave);
      if (!aSec) continue;
      if (aSec.origen === 'mercado') deMercado += peso;
      sSec = _anchorScore(x, aSec.v, d.dir);
      const A = _anclasRaiz();
      const aM = A.mercado && A.mercado.anclas && A.mercado.anclas[d.campo || clave];
      sMkt = aM ? _anchorScore(x, [aM.p25, aM.p50, aM.p75, aM.p10, aM.p90], d.dir) : sSec;
    }
    if (sSec == null) continue;

    usadas += peso;
    PS[pil].push([sSec, peso]);
    PM[pil].push([sMkt == null ? sSec : sMkt, peso]);
    detalle[clave] = { v: Math.round(x * 1000) / 1000, nota: Math.round(sSec * 10) / 10,
                       lbl: d.lbl, prox: d.prox || null };
  }

  // ── Pilares ──
  const _roll = (P) => {
    const o = {};
    for (const [key, arr] of Object.entries(P)) {
      if (!arr.length) { o[key] = null; continue; }
      const sw = arr.reduce((s, [, w]) => s + w, 0);
      o[key] = arr.reduce((s, [v, w]) => s + v * w, 0) / sw;
    }
    return o;
  };
  const pilar = _roll(PS), pilarM = _roll(PM);

  const _compose = (pil) => {
    let num = 0, den = 0;
    for (const [key, peso] of Object.entries(prof.w)) {
      if (pil[key] == null) continue;
      num += pil[key] * peso; den += peso;
    }
    return den ? num / den : null;
  };
  const brutoSec = _compose(pilar), brutoMkt = _compose(pilarM);
  if (brutoSec == null) return { nota: null, perfil: prof.label, perfilId: pid, motivo: 'sin datos' };

  // ── Sonda de calibración: devuelve los brutos sin ajustar ──────────────────
  if (info && info.__probe) return { brutoSec, brutoMkt };

  // ── Neutralización del sesgo sectorial ─────────────────────────────────────
  // Se resta el bruto que obtendría una empresa EXACTAMENTE mediana de este
  // sector (calculado por _sectorBias, no a mano). Así "ser de energía" o "ser
  // biotech" ya no suma ni resta por sí solo: solo importa la distancia a tus
  // pares. La diferenciación ENTRE sectores la carga `cap`.
  const B = _sectorBias(pid);

  // ── Expansión de spread ────────────────────────────────────────────────────
  // Promediar ~20 métricas encoge la varianza (≈ √n). GAIN la devuelve a la
  // escala que espera un usuario: élite ≈ 9, promedio ≈ 5.5, rota ≈ 2.
  const GAIN = 2.35, CENTRO = 5.55;
  const zSec = brutoSec - B.sec;
  const zMkt = (brutoMkt == null) ? zSec : (brutoMkt - B.mkt);
  let nota = CENTRO + (0.62 * zSec + 0.38 * zMkt) * GAIN;

  // ── Ajustes estructurales ──
  // Mucho más cortos que en la v1: lo que antes hacía falta corregir a mano
  // (pico de ciclo, apalancamiento sectorial) ahora lo miden métricas propias
  // del modelo — cicloMargen y cobInteres — dentro del propio scoring.
  const flags = [];
  const pmTTM = _leer(info, 'netProfitMarginTTM');
  const crecTTM = _leer(info, 'revenueGrowthTTMYoy');
  if (pmTTM != null && pmTTM < -20 && (crecTTM == null || crecTTM < 15)) {
    nota -= 0.60; flags.push('quema_caja');
  }
  if (pid === 'BIOTECH_CLINICO' && (info?.numberOfAnalystOpinions || 0) < 5) {
    nota = Math.min(nota, 6.0); flags.push('sin_cobertura');
  }

  // ── Percentil sectorial ──
  const zTot = (zSec * GAIN) / 2.05;
  const percentil = Math.max(1, Math.min(99, Math.round(
    100 * 0.5 * (1 + _erf(zTot / Math.SQRT2))
  )));

  // ── Cobertura: comprimir hacia 5.5 si faltan métricas del modelo ──
  const cobertura = posibles > 0 ? usadas / posibles : 0;
  if (cobertura < 0.45) { nota = 5.5 + (nota - 5.5) * (0.40 + cobertura); flags.push('datos_limitados'); }
  // Si buena parte de las anclas vinieron del mercado y no del sector, la
  // comparación "contra sus pares" es más floja de lo que aparenta: se dice.
  if (usadas > 0 && deMercado / usadas > 0.4) flags.push('anclas_de_mercado');

  // ── Techo estructural del sector y piso global ──
  nota = Math.max(2.0, Math.min(prof.cap, nota));

  return {
    nota:      Math.round(nota * 10) / 10,
    percentil,
    perfil:    prof.label,
    perfilId:  pid,
    cap:       prof.cap,
    cobertura: Math.round(cobertura * 100) / 100,
    pilares: {
      rentabilidad: _r1(pilar.rent), crecimiento: _r1(pilar.crec),
      solidez:      _r1(pilar.soli), valoracion:  _r1(pilar.valo),
      mercado:      _r1(pilar.merc),
    },
    detalle, flags,
    etiqueta: percentil >= 90 ? 'Líder del sector' : percentil >= 70 ? 'Por encima de sus pares'
            : percentil >= 40 ? 'En línea con el sector' : percentil >= 20 ? 'Rezagada' : 'Muy rezagada',
  };
}

// ── 7. AUTO-CALIBRACIÓN DEL SESGO SECTORIAL ─────────────────────────────────
// Para cada perfil se sintetiza la empresa que está EXACTAMENTE en la mediana de
// su sector en todas las métricas de SU modelo y se mide qué bruto produce. Ese
// valor es el "cero" de ese sector. Se calcula una vez y se cachea.
// Ventaja: cuando se recalibran las anclas, esto se reajusta solo.
const _BIAS_CACHE = {};
function _sectorBias(pid) {
  if (_BIAS_CACHE[pid]) return _BIAS_CACHE[pid];
  const p = _SECTOR_MODELS[pid];
  if (!p || !p.m) return (_BIAS_CACHE[pid] = { sec: 5, mkt: 5 });

  // Empresa mediana: cada campo del modelo puesto en el p50 de su sector.
  const m = {};
  for (const clave of Object.keys(p.m)) {
    const d = _CAT[clave]; if (!d || !d.campo) continue;
    const a = _ancla(pid, d.campo);
    if (a) m[d.campo] = a.v[1];
  }
  // Las derivadas necesitan sus insumos, aunque no estén en el modelo del sector.
  for (const campo of ['operatingMarginTTM','operatingMargin5Y',
                       'cashPerSharePerShareQuarterly','cashFlowPerShareTTM']) {
    if (m[campo] == null) { const a = _ancla(pid, campo); if (a) m[campo] = a.v[1]; }
  }
  const info = { __probe:1, __forceProfile:pid, __m:m,
                 recommendationMean:2.5, numberOfAnalystOpinions:25 };
  const r = computeSectorRating('__CAL__', info) || {};
  return (_BIAS_CACHE[pid] = {
    sec: (r.brutoSec != null && isFinite(r.brutoSec)) ? r.brutoSec : 5,
    mkt: (r.brutoMkt != null && isFinite(r.brutoMkt)) ? r.brutoMkt : 5,
  });
}

const _r1 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 10) / 10 : null;

// Aproximación de la función error (Abramowitz & Stegun 7.1.26) para el percentil.
function _erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return s * y;
}


/* ════════════════════════════════════════════════════════════════════════════
   ADAPTADORES PARA index.html  —  no requieren tocar los puntos de llamada
   ════════════════════════════════════════════════════════════════════════════ */

// Reemplazo directo de _computeGeneralRating. Misma firma, mismo tipo de retorno
// (string con 1 decimal).
function _computeGeneralRating({pe, fpe, roe, roa, revG, epsG, pm, de, beta, info}) {
  const qType = String(info?.quoteType || '').toUpperCase();
  if (qType === 'ETF' || qType === 'MUTUALFUND') return '7.5';
  const ticker = info?.symbol || info?.ticker ||
                 (typeof window !== 'undefined' ? window._PVX_CUR_TICKER : '') || '';
  const r = computeSectorRating(ticker, info || {});
  if (!r || r.nota == null) return '5.5';
  if (typeof window !== 'undefined') window._PVX_LAST_SECTOR_RATING = r;
  return r.nota.toFixed(1);
}

// Etiqueta de la nota, con contexto sectorial.
function _ratingLabelSector(nota, percentil) {
  if (nota == null) return '—';
  const base = nota >= 8 ? 'Excelente' : nota >= 6.5 ? 'Buena' : nota >= 5 ? 'Neutral'
             : nota >= 3.5 ? 'Débil' : 'Evitar';
  if (percentil == null) return base;
  return base + (percentil >= 90 ? ' · líder del sector'
              : percentil >= 70 ? ' · sobre sus pares'
              : percentil <= 20 ? ' · rezagada en su sector' : '');
}

// Vocabulario obligatorio por sector para el prompt de IA. No es decorativo:
// impide que el modelo hable de margen bruto a un banco o de P/E a un REIT.
const _SECTOR_VOCAB = {
  BANCO:   'margen de interés neto (NIM), índice de eficiencia, calidad de cartera, capital CET1, coste del riesgo. NO hables de margen bruto ni de deuda/capital: en banca no significan nada.',
  SEGUROS: 'ratio combinado, resultado técnico vs financiero, reservas, disciplina de suscripción. NO uses margen bruto ni deuda/capital.',
  REIT:    'FFO y AFFO por acción (no utilidad neta), ocupación, spread de renovación de rentas, coste y vencimientos de deuda, cap rate. El P/E de un REIT no informa: usa P/FFO y EV/EBITDA.',
  UTILITY: 'base tarifaria (rate base), ROE autorizado por el regulador, plan de capex, cobertura del dividendo, sensibilidad a tasas. El crecimiento alto no es la meta: la previsibilidad sí.',
  ENERGIA_EP: 'coste de producción por barril (breakeven), reservas y su reposición, disciplina de capex, retorno de caja al accionista. Márgenes altos hoy pueden ser pico de ciclo.',
  ENERGIA_INTEGRADA: 'integración upstream/downstream, breakeven, cobertura del dividendo con flujo de caja, disciplina de capex a través del ciclo.',
  SEMI: 'ciclo de inventarios, capacidad y nodos, exposición a un cliente o a un tipo de chip, visibilidad del backlog. Un margen récord suele ser techo de ciclo, no la nueva normalidad.',
  SEMI_EQUIP: 'ciclo de capex de las fundiciones, backlog, exposición a China y a controles de exportación.',
  SAAS_GROWTH: 'retención neta de ingresos (NRR), regla del 40, margen de flujo de caja libre, meses de runway, coste de adquisición. La utilidad neta contable importa poco; la caja sí.',
  SOFTWARE: 'crecimiento de ingresos recurrentes, apalancamiento operativo, retención, competencia de plataformas.',
  BIOTECH_CLINICO: 'fase de los ensayos, meses de caja (runway), catalizadores regulatorios con fecha, dependencia de un solo activo, riesgo de dilución. Ningún múltiplo de utilidades aplica.',
  FARMA: 'vencimiento de patentes (patent cliff), profundidad del pipeline, concentración en un fármaco, presión de precios y genéricos.',
  RETAIL: 'ventas comparables (same-store sales), rotación de inventario, margen por metro cuadrado, tráfico y ticket. Un margen bruto bajo puede ser el modelo de negocio, no una debilidad.',
  TRANSPORTE: 'factor de ocupación, ingreso por asiento-milla (RASM) contra coste (CASM), coste del combustible, flota y su deuda. Sector estructuralmente destructor de capital: exige un descuento.',
  AUTOS: 'volumen y mix, capacidad instalada, coste por unidad, financiera cautiva (que infla el ROE), ciclo de producto.',
  MATERIALES: 'precio del commodity subyacente, coste en la curva, apalancamiento operativo. El crecimiento de ingresos refleja el precio, no la ejecución.',
  CONSUMO_BASICO: 'poder de fijación de precios frente a inflación, volumen vs precio, marcas propias como amenaza, cobertura del dividendo.',
  INTERNET_PLAT: 'usuarios activos y monetización por usuario, mix de ingresos, capex en infraestructura, exposición regulatoria.',
  GESTOR_ACTIVOS: 'activos bajo gestión (AUM) y sus flujos, comisión media, apalancamiento operativo, sensibilidad al mercado.',
  PAGOS: 'volumen de pagos (TPV), take rate, coste por transacción, competencia de redes.',
  DISPOSITIVOS: 'base instalada y consumibles recurrentes, ciclo de aprobación regulatoria, contratos hospitalarios.',
  SALUD_SERVICIOS: 'mezcla de pagadores, coste médico (MLR), volumen de pacientes, presión regulatoria de reembolsos.',
  AEROESPACIAL_DEF: 'backlog y su duración, mezcla de programas, dependencia del presupuesto de defensa.',
  TELECOM_MEDIOS: 'ARPU, churn, capex sobre ingresos, apalancamiento y cobertura del dividendo.',
};

// Bloque de contexto para el prompt de IA: la empresa contra la mediana de SU
// sector, métrica a métrica, usando exactamente las métricas de su modelo — no
// una lista genérica. Las aproximaciones se marcan como tales.
function buildSectorAIContext(ticker, info) {
  const r = computeSectorRating(ticker, info);
  if (!r || r.nota == null) return '';
  const L = [];
  L.push(`PERFIL SECTORIAL: ${r.perfil} (${r.perfilId})`);
  L.push(`NOTA PORTIV: ${r.nota}/10 · percentil ${r.percentil} de su sector · ${r.etiqueta}`);
  const nd = v => v == null ? 'n/d' : v;
  L.push(`PILARES (1-10, vs. sus pares): rentabilidad ${nd(r.pilares.rentabilidad)} · crecimiento ${nd(r.pilares.crecimiento)} · solidez ${nd(r.pilares.solidez)} · valoración ${nd(r.pilares.valoracion)} · mercado ${nd(r.pilares.mercado)}`);
  L.push('');
  L.push('LAS MÉTRICAS QUE DEFINEN A ESTE SECTOR, COMPARADAS CON LA MEDIANA DE SUS PARES:');
  const prof = _SECTOR_MODELS[r.perfilId];
  for (const clave of Object.keys(prof.m)) {
    const d = _CAT[clave], det = r.detalle[clave];
    if (!d || !det) continue;
    const a = _ancla(r.perfilId, d.campo || clave);
    const med = a ? a.v[1] : null;
    const f = x => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3));
    const cmp = med == null ? '' :
      (det.v > med * 1.15 ? ' → POR ENCIMA' : det.v < med * 0.85 ? ' → POR DEBAJO' : ' → EN LÍNEA');
    const prox = d.prox ? `  [aproximación de ${d.prox}]` : '';
    L.push(`  • ${d.lbl}: ${f(det.v)}` + (med != null ? `  |  mediana del sector ${f(med)}` : '') +
           cmp + `  (nota ${det.nota}/10)` + prox);
  }
  if (r.flags?.length) L.push('', 'ALERTAS DEL MODELO: ' + r.flags.join(', '));
  L.push('');
  L.push(`CÓMO DEBES ANALIZAR ESTE SECTOR — usa estos conceptos: ${_SECTOR_VOCAB[r.perfilId] || 'márgenes, retorno sobre el capital, crecimiento y valoración frente a sus pares directos.'}`);
  L.push('REGLA: compara SIEMPRE contra sus pares del sector, nunca contra el mercado en general. No menciones métricas que no estén en esta lista: si no están, es porque no aplican a este sector. No repitas los números: interprétalos.');
  return L.join('\n');
}

if (typeof module !== 'undefined') module.exports = {
  computeSectorRating, _sectorProfileOf, _SECTOR_PROFILES, _SECTOR_MODELS, _CAT,
  _anchorScore, _sectorBias, _ancla, _leer, buildSectorAIContext, _ratingLabelSector,
};
