/* ════════════════════════════════════════════════════════════════════════════
   PORTIV · MOTOR DE EVALUACIÓN SECTORIAL v1.0
   ────────────────────────────────────────────────────────────────────────────
   Reemplaza el scoring de umbrales absolutos (_computeGeneralRating) por un
   modelo que puntúa cada métrica CONTRA LA DISTRIBUCIÓN DE SU PROPIO SECTOR.

   Devuelve DOS números:
     · nota      1.0–10.0  → qué tan buena es la empresa como inversión
                             (normalizada por sector → comparable entre sectores)
     · percentil 0–100     → qué tan buena es DENTRO de su sector

   Anclas sectoriales calibradas con Damodaran (NYU Stern), datos US enero 2026.
   ════════════════════════════════════════════════════════════════════════════ */

// ── 1. ANCLAS BASE (mercado completo, 5.994 empresas US) ────────────────────
// Formato: clave: [p25, mediana, p75].  Cada perfil sectorial sobrescribe
// SOLO lo que difiere del mercado. Así la tabla se mantiene legible.
const _MKT = {
  grossMargins:       [0.24, 0.37, 0.55],
  profitMargins:      [0.01, 0.08, 0.19],
  operatingMargins:   [0.04, 0.13, 0.25],
  returnOnEquity:     [0.05, 0.14, 0.26],
  returnOnCapital:    [0.03, 0.10, 0.20],
  returnOnAssets:     [0.02, 0.055, 0.11],
  revenueGrowth:      [-0.01, 0.06, 0.17],
  earningsGrowth:     [-0.08, 0.08, 0.25],
  forwardPE:          [13, 22, 34],
  trailingPE:         [15, 26, 42],
  pegRatio:           [0.9, 1.8, 3.2],
  enterpriseToEbitda: [9, 16, 25],
  priceToSales:       [0.9, 2.5, 6.0],
  priceToBook:        [1.2, 2.8, 6.0],
  debtToEquity:       [0.25, 0.75, 1.70],
  currentRatio:       [1.0, 1.6, 2.6],
  fcfYield:           [0.005, 0.030, 0.058],   // derivada: freeCashflow / marketCap
  fcfMargin:          [0.01, 0.07, 0.16],      // derivada: freeCashflow / ingresos
  dividendYield:      [0.000, 0.012, 0.028],
};

// ── 2. PILARES ──────────────────────────────────────────────────────────────
// P1 rentabilidad · P2 crecimiento · P3 solidez · P4 valoración · P5 mercado
// Cada métrica: [pilar, dirección(+1 mejor alto / -1 mejor bajo), peso]
const _METRIC_DEF = {
  grossMargins:       ['rent', +1, 0.8],
  operatingMargins:   ['rent', +1, 1.2],
  profitMargins:      ['rent', +1, 1.0],
  returnOnEquity:     ['rent', +1, 1.2],
  returnOnCapital:    ['rent', +1, 1.1],

  revenueGrowth:      ['crec', +1, 1.4],
  earningsGrowth:     ['crec', +1, 1.0],
  revenueGrowthQ:     ['crec', +1, 0.7],   // usa anclas de revenueGrowth
  epsAccel:           ['crec', +1, 0.6],   // derivada: 1 - forwardPE/trailingPE

  returnOnAssets:     ['soli', +1, 0.9],
  debtToEquity:       ['soli', -1, 1.2],
  currentRatio:       ['soli', +1, 0.7],
  fcfMargin:          ['soli', +1, 1.1],
  fcfPositive:        ['soli', +1, 0.8],   // binaria

  forwardPE:          ['valo', -1, 1.3],
  trailingPE:         ['valo', -1, 0.6],
  pegRatio:           ['valo', -1, 0.9],
  enterpriseToEbitda: ['valo', -1, 1.1],
  priceToSales:       ['valo', -1, 0.6],
  priceToBook:        ['valo', -1, 0.4],
  fcfYield:           ['valo', +1, 1.0],
  dividendYield:      ['valo', +1, 0.3],

  consenso:           ['merc', +1, 1.4],   // derivada de recommendationMean × nº analistas
  upside:             ['merc', +1, 0.8],   // targetMeanPrice / precio - 1
  pos52w:             ['merc', +1, 0.7],   // precio / máximo 52 semanas
};

// ── 3. PERFILES SECTORIALES ─────────────────────────────────────────────────
//  w    → pesos de los 5 pilares (suman 100)
//  a    → anclas que difieren del mercado
//  off  → métricas que NO aplican en este sector (se ignoran, no penalizan)
//  mw   → ajustes de peso de métricas concretas dentro de su pilar
//  cap  → techo estructural de la nota (economía del sector)
//  cyc  → sector cíclico → activa el ajuste de pico/fondo de ciclo
const _SECTOR_PROFILES = {

  SEMI: { label:'Semiconductores', cap:9.6, cyc:true,
    w:{rent:25, crec:30, soli:12, valo:18, merc:15},
    a:{ grossMargins:[0.35,0.59,0.72], profitMargins:[0.08,0.28,0.42],
        operatingMargins:[0.12,0.34,0.48], returnOnEquity:[0.08,0.26,0.42],
        returnOnCapital:[0.05,0.18,0.32], revenueGrowth:[-0.05,0.15,0.42],
        earningsGrowth:[-0.10,0.22,0.60], forwardPE:[24,35,52],
        enterpriseToEbitda:[16,28,45], priceToSales:[4,8,15], priceToBook:[3,7,14],
        debtToEquity:[0.10,0.35,0.75], currentRatio:[1.5,2.6,4.0],
        fcfYield:[0.005,0.025,0.045], fcfMargin:[0.03,0.18,0.32] } },

  SEMI_EQUIP: { label:'Equipos de semiconductores', cap:9.4, cyc:true,
    w:{rent:27, crec:26, soli:13, valo:19, merc:15},
    a:{ grossMargins:[0.38,0.46,0.55], profitMargins:[0.12,0.21,0.30],
        operatingMargins:[0.16,0.28,0.36], returnOnEquity:[0.15,0.30,0.45],
        returnOnCapital:[0.08,0.20,0.30], revenueGrowth:[-0.08,0.10,0.30],
        forwardPE:[22,32,45], enterpriseToEbitda:[15,23,33],
        debtToEquity:[0.10,0.40,0.85], fcfMargin:[0.08,0.18,0.28] } },

  SOFTWARE: { label:'Software', cap:9.6,
    w:{rent:25, crec:32, soli:10, valo:18, merc:15},
    a:{ grossMargins:[0.60,0.72,0.82], profitMargins:[0.02,0.20,0.34],
        operatingMargins:[0.05,0.28,0.42], returnOnEquity:[0.05,0.22,0.40],
        returnOnCapital:[0.04,0.14,0.26], revenueGrowth:[0.05,0.13,0.25],
        forwardPE:[22,32,45], enterpriseToEbitda:[15,23,34], priceToSales:[4,7,12],
        priceToBook:[3,7,15], debtToEquity:[0.10,0.45,1.00],
        fcfYield:[0.015,0.032,0.055], fcfMargin:[0.08,0.22,0.34] },
    mw:{ priceToBook:0.15 } },     // el book value no dice nada de un intangible

  SAAS_GROWTH: { label:'SaaS · alto crecimiento', cap:9.3,
    w:{rent:18, crec:38, soli:14, valo:15, merc:15},
    a:{ grossMargins:[0.55,0.70,0.80], profitMargins:[-0.20,0.02,0.15],
        operatingMargins:[-0.10,0.08,0.22], returnOnEquity:[-0.15,0.03,0.18],
        returnOnCapital:[-0.06,0.03,0.12], revenueGrowth:[0.12,0.22,0.38],
        forwardPE:[35,60,95], priceToSales:[5,10,18],
        fcfYield:[0.000,0.018,0.035], fcfMargin:[-0.05,0.10,0.24],
        currentRatio:[1.4,2.4,4.0] },
    off:['trailingPE','pegRatio','priceToBook'],
    mw:{ fcfMargin:1.6, currentRatio:1.2 } },   // el runway manda

  INTERNET_PLAT: { label:'Plataformas de internet', cap:9.6,
    w:{rent:27, crec:27, soli:11, valo:20, merc:15},
    a:{ grossMargins:[0.45,0.58,0.72], profitMargins:[0.10,0.22,0.32],
        operatingMargins:[0.14,0.28,0.40], returnOnEquity:[0.12,0.25,0.38],
        returnOnCapital:[0.08,0.18,0.28], revenueGrowth:[0.05,0.13,0.24],
        forwardPE:[17,26,36], enterpriseToEbitda:[11,17,24], priceToSales:[3,6,10],
        debtToEquity:[0.10,0.35,0.75], fcfYield:[0.020,0.035,0.055],
        fcfMargin:[0.10,0.22,0.33] } },

  HARDWARE: { label:'Hardware y equipos', cap:9.2, cyc:true,
    w:{rent:26, crec:24, soli:14, valo:21, merc:15},
    a:{ grossMargins:[0.28,0.38,0.50], profitMargins:[0.05,0.14,0.24],
        operatingMargins:[0.08,0.20,0.30], returnOnEquity:[0.10,0.25,0.45],
        forwardPE:[15,26,37], enterpriseToEbitda:[12,20,28], priceToSales:[1.5,3.5,7] } },

  // ── FINANCIERO ────────────────────────────────────────────────────────────
  BANCO: { label:'Banca', cap:9.0,
    w:{rent:30, crec:12, soli:28, valo:20, merc:10},
    a:{ profitMargins:[0.18,0.26,0.34], returnOnEquity:[0.07,0.11,0.15],
        returnOnAssets:[0.007,0.011,0.016], revenueGrowth:[0.00,0.05,0.11],
        earningsGrowth:[-0.05,0.08,0.20], forwardPE:[8,11.5,15],
        trailingPE:[9,13,18], priceToBook:[0.8,1.3,2.0],
        dividendYield:[0.018,0.030,0.045] },
    off:['grossMargins','operatingMargins','debtToEquity','currentRatio',
         'enterpriseToEbitda','fcfYield','fcfMargin','fcfPositive','priceToSales',
         'pegRatio','returnOnCapital'],
    mw:{ priceToBook:2.2, returnOnEquity:2.0, returnOnAssets:2.4 } },

  SEGUROS: { label:'Seguros', cap:9.0,
    w:{rent:32, crec:12, soli:26, valo:20, merc:10},
    a:{ profitMargins:[0.05,0.11,0.18], returnOnEquity:[0.08,0.13,0.19],
        returnOnAssets:[0.005,0.012,0.022], revenueGrowth:[0.00,0.06,0.13],
        forwardPE:[8,13,19], trailingPE:[9,14,21], priceToBook:[0.9,1.4,2.2],
        dividendYield:[0.012,0.022,0.035] },
    off:['grossMargins','operatingMargins','debtToEquity','currentRatio',
         'enterpriseToEbitda','fcfYield','fcfMargin','fcfPositive','priceToSales',
         'pegRatio','returnOnCapital'],
    mw:{ priceToBook:2.0, returnOnEquity:2.0, returnOnAssets:2.2 } },

  PAGOS: { label:'Pagos y fintech', cap:9.5,
    w:{rent:30, crec:25, soli:12, valo:20, merc:13},
    a:{ grossMargins:[0.45,0.65,0.80], profitMargins:[0.10,0.22,0.40],
        operatingMargins:[0.15,0.30,0.50], returnOnEquity:[0.12,0.25,0.45],
        returnOnCapital:[0.08,0.18,0.30], revenueGrowth:[0.05,0.12,0.22],
        forwardPE:[15,26,36], enterpriseToEbitda:[10,18,28], priceToSales:[3,7,14],
        debtToEquity:[0.20,0.70,1.60], fcfYield:[0.020,0.038,0.060],
        fcfMargin:[0.10,0.24,0.40] } },

  GESTOR_ACTIVOS: { label:'Gestión de activos y brokers', cap:9.0,
    w:{rent:30, crec:15, soli:22, valo:21, merc:12},
    a:{ profitMargins:[0.08,0.14,0.25], returnOnEquity:[0.09,0.16,0.24],
        returnOnAssets:[0.008,0.025,0.055], forwardPE:[11,17,24], priceToBook:[1.0,1.8,3.0] },
    off:['grossMargins','debtToEquity','currentRatio','enterpriseToEbitda',
         'fcfYield','fcfMargin','fcfPositive'],
    mw:{ priceToBook:1.6 } },

  // ── SALUD ─────────────────────────────────────────────────────────────────
  FARMA: { label:'Farmacéutica', cap:9.3,
    w:{rent:28, crec:22, soli:15, valo:20, merc:15},
    a:{ grossMargins:[0.60,0.71,0.80], profitMargins:[0.05,0.17,0.28],
        operatingMargins:[0.12,0.28,0.40], returnOnEquity:[0.08,0.20,0.34],
        returnOnCapital:[0.05,0.12,0.22], revenueGrowth:[0.00,0.06,0.14],
        forwardPE:[12,20,30], enterpriseToEbitda:[9,14,20], priceToSales:[2,4,8],
        debtToEquity:[0.30,0.80,1.50], fcfYield:[0.030,0.055,0.085],
        dividendYield:[0.010,0.025,0.040] } },

  BIOTECH_CLINICO: { label:'Biotech en fase clínica', cap:8.5,
    w:{rent:10, crec:15, soli:35, valo:10, merc:30},
    a:{ profitMargins:[-1.50,-0.30,0.10], returnOnEquity:[-0.40,-0.08,0.10],
        revenueGrowth:[-0.10,0.15,0.60], forwardPE:[25,55,100],
        currentRatio:[2.0,4.0,8.0], debtToEquity:[0.00,0.20,0.60],
        fcfYield:[-0.15,-0.04,0.010], fcfMargin:[-2.0,-0.40,0.05] },
    off:['grossMargins','operatingMargins','trailingPE','pegRatio',
         'enterpriseToEbitda','priceToSales','returnOnCapital','earningsGrowth'],
    mw:{ currentRatio:2.2, debtToEquity:1.6 } },   // runway = supervivencia

  DISPOSITIVOS: { label:'Dispositivos médicos', cap:9.2,
    w:{rent:28, crec:22, soli:15, valo:20, merc:15},
    a:{ grossMargins:[0.42,0.54,0.66], profitMargins:[0.02,0.10,0.20],
        operatingMargins:[0.06,0.16,0.26], returnOnEquity:[0.04,0.11,0.20],
        returnOnCapital:[0.03,0.08,0.15], revenueGrowth:[0.02,0.07,0.15],
        forwardPE:[20,32,48], enterpriseToEbitda:[12,18,26], priceToSales:[2,4,7] } },

  SALUD_SERVICIOS: { label:'Servicios de salud', cap:8.9,
    w:{rent:27, crec:20, soli:20, valo:22, merc:11},
    a:{ grossMargins:[0.06,0.13,0.25], profitMargins:[-0.01,0.02,0.055],
        operatingMargins:[0.01,0.035,0.07], returnOnEquity:[0.03,0.10,0.19],
        forwardPE:[11,18,28], enterpriseToEbitda:[8,13,19], priceToSales:[0.2,0.6,1.4] } },

  // ── ENERGÍA Y MATERIALES ──────────────────────────────────────────────────
  ENERGIA_EP: { label:'Energía · exploración y producción', cap:8.4, cyc:true,
    w:{rent:25, crec:8, soli:28, valo:27, merc:12},
    a:{ grossMargins:[0.35,0.55,0.70], profitMargins:[0.02,0.13,0.25],
        operatingMargins:[0.08,0.25,0.38], returnOnEquity:[0.03,0.11,0.20],
        returnOnCapital:[0.02,0.08,0.15], revenueGrowth:[-0.20,0.00,0.18],
        forwardPE:[8,14,21], enterpriseToEbitda:[3.2,5.2,8.0],
        priceToBook:[0.8,1.4,2.2], debtToEquity:[0.15,0.45,0.85],
        fcfYield:[0.02,0.07,0.13], fcfMargin:[0.03,0.14,0.26],
        dividendYield:[0.020,0.038,0.060] },
    off:['pegRatio','priceToSales'],
    mw:{ revenueGrowth:0.5, fcfYield:1.6, enterpriseToEbitda:1.5 } },

  ENERGIA_INTEGRADA: { label:'Energía integrada', cap:8.6, cyc:true,
    w:{rent:25, crec:10, soli:26, valo:26, merc:13},
    a:{ grossMargins:[0.20,0.36,0.50], profitMargins:[0.03,0.08,0.13],
        operatingMargins:[0.05,0.12,0.19], returnOnEquity:[0.05,0.10,0.15],
        revenueGrowth:[-0.15,0.00,0.14], forwardPE:[10,15,21],
        enterpriseToEbitda:[5,8,11], priceToBook:[0.9,1.5,2.3],
        fcfYield:[0.03,0.06,0.10], dividendYield:[0.025,0.040,0.060] },
    off:['pegRatio'], mw:{ revenueGrowth:0.5 } },

  MATERIALES: { label:'Materiales básicos', cap:8.2, cyc:true,
    w:{rent:24, crec:14, soli:26, valo:24, merc:12},
    a:{ grossMargins:[0.11,0.22,0.34], profitMargins:[-0.02,0.045,0.10],
        operatingMargins:[0.03,0.10,0.19], returnOnEquity:[0.01,0.08,0.17],
        returnOnCapital:[0.01,0.06,0.13], revenueGrowth:[-0.10,0.01,0.13],
        forwardPE:[10,17,25], enterpriseToEbitda:[7,11,16],
        priceToBook:[0.9,1.5,2.5], debtToEquity:[0.30,0.70,1.40],
        priceToSales:[0.5,1.2,2.5], dividendYield:[0.010,0.025,0.042] },
    mw:{ revenueGrowth:0.7 } },

  // ── REGULADO Y DEFENSIVO ──────────────────────────────────────────────────
  UTILITY: { label:'Servicios públicos', cap:8.7,
    w:{rent:25, crec:10, soli:30, valo:25, merc:10},
    a:{ grossMargins:[0.30,0.44,0.58], profitMargins:[0.07,0.14,0.21],
        operatingMargins:[0.15,0.24,0.32], returnOnEquity:[0.06,0.10,0.14],
        returnOnCapital:[0.03,0.05,0.08], returnOnAssets:[0.018,0.030,0.045],
        revenueGrowth:[-0.02,0.04,0.10], earningsGrowth:[0.00,0.06,0.12], forwardPE:[14,18,23],
        enterpriseToEbitda:[10,13.5,17], priceToBook:[1.1,1.8,2.6],
        debtToEquity:[1.00,1.60,2.40], fcfYield:[-0.030,0.000,0.030],
        fcfMargin:[-0.15,0.00,0.12], dividendYield:[0.025,0.035,0.048] },
    off:['currentRatio','pegRatio','priceToSales','fcfPositive'],
    mw:{ dividendYield:1.5, debtToEquity:1.5, fcfYield:0.5 } },

  REIT: { label:'REIT · bienes raíces', cap:8.6,
    w:{rent:25, crec:12, soli:30, valo:23, merc:10},
    a:{ profitMargins:[0.05,0.13,0.28], operatingMargins:[0.15,0.26,0.38],
        returnOnEquity:[0.02,0.05,0.09], returnOnCapital:[0.01,0.035,0.06],
        returnOnAssets:[0.008,0.022,0.040],
        revenueGrowth:[0.00,0.05,0.11], forwardPE:[25,40,60],
        enterpriseToEbitda:[14,19,26], priceToBook:[0.9,1.6,2.6],
        debtToEquity:[0.80,1.30,2.00], dividendYield:[0.030,0.043,0.060] },
    off:['grossMargins','currentRatio','pegRatio','priceToSales',
         'fcfYield','fcfMargin','fcfPositive','trailingPE'],
    mw:{ dividendYield:2.0, enterpriseToEbitda:1.8, forwardPE:0.4, debtToEquity:1.6 } },

  CONSUMO_BASICO: { label:'Consumo básico', cap:9.0,
    w:{rent:30, crec:12, soli:22, valo:24, merc:12},
    a:{ grossMargins:[0.25,0.42,0.55], profitMargins:[0.03,0.09,0.15],
        operatingMargins:[0.08,0.15,0.21], returnOnEquity:[0.08,0.17,0.30],
        returnOnCapital:[0.05,0.10,0.18], revenueGrowth:[-0.01,0.035,0.08],
        forwardPE:[14,19,25], enterpriseToEbitda:[9,13,17], priceToSales:[0.8,1.8,3.5],
        debtToEquity:[0.40,1.00,1.90], fcfYield:[0.030,0.050,0.075],
        dividendYield:[0.015,0.026,0.038] },
    mw:{ dividendYield:1.3 } },

  // ── CÍCLICO DE CONSUMO E INDUSTRIA ────────────────────────────────────────
  RETAIL: { label:'Retail', cap:8.8,
    w:{rent:25, crec:20, soli:20, valo:22, merc:13},
    a:{ grossMargins:[0.24,0.34,0.45], profitMargins:[0.015,0.045,0.085],
        operatingMargins:[0.03,0.075,0.12], returnOnEquity:[0.10,0.22,0.36],
        returnOnCapital:[0.06,0.13,0.22], revenueGrowth:[0.00,0.05,0.11],
        forwardPE:[12,20,29], enterpriseToEbitda:[7,12,18], priceToSales:[0.4,0.9,1.8],
        debtToEquity:[0.40,1.10,2.20], currentRatio:[0.9,1.3,1.9],
        fcfYield:[0.020,0.040,0.065], fcfMargin:[0.01,0.035,0.065] },
    mw:{ grossMargins:0.35, returnOnCapital:1.5 } },

  CONSUMO_DISC: { label:'Consumo discrecional', cap:8.9, cyc:true,
    w:{rent:26, crec:20, soli:20, valo:22, merc:12},
    a:{ grossMargins:[0.22,0.33,0.45], profitMargins:[0.02,0.07,0.13],
        operatingMargins:[0.06,0.13,0.20], returnOnEquity:[0.08,0.18,0.34],
        returnOnCapital:[0.04,0.11,0.20], revenueGrowth:[-0.01,0.05,0.13],
        forwardPE:[15,24,34], enterpriseToEbitda:[9,14,20], priceToSales:[0.7,1.8,3.6],
        debtToEquity:[0.50,1.30,2.60] } },

  INDUSTRIAL: { label:'Industrial', cap:9.0, cyc:true,
    w:{rent:27, crec:18, soli:20, valo:22, merc:13},
    a:{ grossMargins:[0.26,0.36,0.46], profitMargins:[0.04,0.09,0.15],
        operatingMargins:[0.08,0.15,0.21], returnOnEquity:[0.08,0.15,0.24],
        returnOnCapital:[0.05,0.11,0.18], revenueGrowth:[-0.02,0.05,0.12],
        forwardPE:[15,21,29], enterpriseToEbitda:[10,15,20], priceToSales:[0.8,1.8,3.4],
        debtToEquity:[0.30,0.80,1.50], fcfYield:[0.025,0.045,0.070] } },

  AEROESPACIAL_DEF: { label:'Aeroespacial y defensa', cap:9.0,
    w:{rent:26, crec:20, soli:20, valo:21, merc:13},
    a:{ grossMargins:[0.13,0.19,0.28], profitMargins:[0.02,0.06,0.11],
        operatingMargins:[0.05,0.10,0.15], returnOnEquity:[0.07,0.15,0.26],
        returnOnCapital:[0.04,0.09,0.16], revenueGrowth:[0.00,0.06,0.14],
        forwardPE:[18,28,42], enterpriseToEbitda:[13,19,26], priceToSales:[1.0,2.0,3.8],
        debtToEquity:[0.40,1.00,2.00] } },

  TRANSPORTE: { label:'Transporte y aerolíneas', cap:7.8, cyc:true,
    w:{rent:24, crec:16, soli:26, valo:23, merc:11},
    a:{ grossMargins:[0.16,0.23,0.30], profitMargins:[0.000,0.035,0.075],
        operatingMargins:[0.02,0.065,0.11], returnOnEquity:[0.04,0.13,0.22],
        returnOnCapital:[0.02,0.07,0.13], revenueGrowth:[-0.03,0.04,0.12],
        forwardPE:[8,13,19], enterpriseToEbitda:[5,8,12], priceToSales:[0.3,0.8,1.6],
        debtToEquity:[0.60,1.50,3.00], currentRatio:[0.6,0.9,1.3] },
    mw:{ debtToEquity:1.6 } },

  AUTOS: { label:'Automotriz', cap:8.0, cyc:true,
    w:{rent:22, crec:18, soli:26, valo:22, merc:12},
    a:{ grossMargins:[0.08,0.13,0.20], profitMargins:[-0.01,0.025,0.06],
        operatingMargins:[0.01,0.045,0.09], returnOnEquity:[0.00,0.06,0.14],
        returnOnCapital:[0.00,0.04,0.10], revenueGrowth:[-0.05,0.03,0.14],
        forwardPE:[7,14,28], enterpriseToEbitda:[6,12,22], priceToSales:[0.2,0.6,1.5],
        debtToEquity:[0.50,1.40,2.80] } },

  TELECOM_MEDIOS: { label:'Telecom y medios', cap:8.7,
    w:{rent:26, crec:16, soli:24, valo:23, merc:11},
    a:{ grossMargins:[0.35,0.48,0.62], profitMargins:[-0.01,0.06,0.13],
        operatingMargins:[0.06,0.15,0.23], returnOnEquity:[0.02,0.10,0.19],
        returnOnCapital:[0.02,0.06,0.12], revenueGrowth:[-0.02,0.04,0.11],
        forwardPE:[12,22,36], enterpriseToEbitda:[7,12,18], priceToSales:[0.8,2.0,4.0],
        debtToEquity:[0.60,1.40,2.60], dividendYield:[0.008,0.025,0.045] } },

  MERCADO: { label:'Mercado general', cap:9.2,
    w:{rent:26, crec:22, soli:18, valo:21, merc:13}, a:{} },
};

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
  const [p25, med, p75] = anchors;
  const spread = Math.max(Math.abs(p75 - p25) / 1.35, 1e-9);   // ≈ σ robusta
  let z = (x - med) / spread;
  z = Math.max(-2.2, Math.min(2.2, z)) * (dir < 0 ? -1 : 1);
  return Math.max(0.4, Math.min(9.9, 5 + 2.05 * z));
}

// ── 6. MOTOR ────────────────────────────────────────────────────────────────
function computeSectorRating(ticker, info) {
  const { id: pid, p: prof } = _sectorProfileOf(ticker, info);
  if (pid === 'ETF') return { nota: null, esEtf: true, perfil: 'ETF' };

  const A = Object.assign({}, _MKT, prof.a || {});
  const OFF = new Set(prof.off || []);
  const MW = prof.mw || {};
  const n = k => { const v = info?.[k]; return (typeof v === 'number' && isFinite(v)) ? v : null; };

  // ── Métricas derivadas ──
  const mc = n('marketCap'), ps = n('priceToSales'), fcf = n('freeCashflow');
  const rev = (ps != null && ps > 0 && mc != null && mc > 0) ? mc / ps : null;
  const px  = n('regularMarketPrice'), tgt = n('targetMeanPrice'), w52h = n('fiftyTwoWeekHigh');
  const pe  = n('trailingPE'), fpe = n('forwardPE');
  const rm  = n('recommendationMean'), numA = n('numberOfAnalystOpinions') || 0;

  const D = {
    fcfYield:   (fcf != null && mc > 0) ? fcf / mc : null,
    fcfMargin:  (fcf != null && rev != null && rev > 0) ? fcf / rev : null,
    fcfPositive:(fcf != null) ? (fcf > 0 ? 8.5 : 2.0) : null,   // ya en escala 0-10
    epsAccel:   (fpe != null && pe != null && pe > 0 && fpe > 0) ? 1 - fpe / pe : null,
    upside:     (tgt != null && px != null && px > 0) ? tgt / px - 1 : null,
    pos52w:     (w52h != null && px != null && w52h > 0) ? px / w52h : null,
    consenso:   rm != null ? rm : null,
  };
  const _DERIVED_ANCHOR = {
    epsAccel: [-0.05, 0.12, 0.32],
    upside:   [-0.02, 0.10, 0.28],
    pos52w:   [0.72, 0.89, 0.98],
  };

  // ── Puntuar cada métrica DOS VECES: contra su sector y contra el mercado ──
  //   z_sector  → ¿es buena PARA SU SECTOR?   (→ percentil sectorial)
  //   z_mercado → ¿es buena EN ABSOLUTO?      (→ evita que el mejor de un mal
  //                                             sector puntúe como una élite real)
  const PS = { rent:[], crec:[], soli:[], valo:[], merc:[] };
  const PM = { rent:[], crec:[], soli:[], valo:[], merc:[] };
  const detalle = {};
  let usadas = 0, posibles = 0;

  const _score = (k, dir, anchors) => {
    if (k === 'fcfPositive')  return D.fcfPositive;
    if (k === 'consenso') {
      if (rm == null) return null;
      const raw  = Math.max(0.5, Math.min(9.8, 11.2 - 2.6 * rm));
      const conf = numA >= 30 ? 1 : numA >= 20 ? 0.9 : numA >= 12 ? 0.75 : numA >= 5 ? 0.55 : 0.3;
      return 5 + (raw - 5) * conf;
    }
    if (k === 'revenueGrowthQ')   return _anchorScore(n('revenueGrowthQ'), anchors.revenueGrowth, dir);
    if (_DERIVED_ANCHOR[k])       return _anchorScore(D[k], _DERIVED_ANCHOR[k], dir);
    if (D[k] !== undefined)       return _anchorScore(D[k], anchors[k], dir);
    const v = n(k);
    // Múltiplo negativo = sin utilidades. No es "barato": es no aplicable → castigo acotado.
    if (dir < 0 && v != null && v <= 0) return 2.2;
    return _anchorScore(v, anchors[k], dir);
  };

  for (const [k, [pil, dir, wBase]] of Object.entries(_METRIC_DEF)) {
    if (OFF.has(k)) continue;
    const w = wBase * (MW[k] != null ? MW[k] : 1);
    if (w <= 0) continue;
    posibles += w;

    const sSec = _score(k, dir, A);
    if (sSec == null) continue;
    const sMkt = _score(k, dir, _MKT);

    usadas += w;
    PS[pil].push([sSec, w]);
    PM[pil].push([sMkt == null ? sSec : sMkt, w]);
    detalle[k] = Math.round(sSec * 10) / 10;
  }

  // ── Pilares (eje sectorial) ──
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
  // sector (calculado por _sectorBias, no a mano). Así "ser de energía" o
  // "ser biotech" ya no suma ni resta por sí solo: solo importa la distancia
  // a tus pares. La diferenciación ENTRE sectores la carga `cap`.
  const B = _sectorBias(pid);

  // ── Expansión de spread ────────────────────────────────────────────────────
  // Promediar ~20 métricas encoge la varianza (≈ √n). GAIN la devuelve a la
  // escala que espera un usuario: élite ≈ 9, promedio ≈ 5.5, rota ≈ 2.
  const GAIN = 2.35, CENTRO = 5.55;
  const zSec = brutoSec - B.sec;
  const zMkt = (brutoMkt == null) ? zSec : (brutoMkt - B.mkt);
  let nota = CENTRO + (0.62 * zSec + 0.38 * zMkt) * GAIN;

  // ── Ajustes estructurales ──
  const flags = [];
  const revG = n('revenueGrowth'), om = n('operatingMargins'), pm = n('profitMargins');

  if (prof.cyc) {
    const omHi = A.operatingMargins ? A.operatingMargins[2] : null;
    if (revG != null && revG > 0.35 && om != null && omHi != null && om > omHi * 1.25) {
      nota -= 0.35; flags.push('pico_ciclo');
    }
    if (revG != null && revG < -0.20 && fpe != null && A.forwardPE && fpe < A.forwardPE[0]) {
      nota += 0.25; flags.push('fondo_ciclo');
    }
  }
  if (pm != null && pm < -0.20 && (revG == null || revG < 0.15)) { nota -= 0.60; flags.push('quema_caja'); }
  if (pid === 'BIOTECH_CLINICO' && (rev == null || rev < 5e7) && numA < 5) {
    nota = Math.min(nota, 6.0); flags.push('sin_cobertura');
  }
  const de = n('debtToEquity');
  if ((pid === 'REIT' || pid === 'UTILITY' || pid === 'TRANSPORTE') &&
      de != null && A.debtToEquity && de > A.debtToEquity[2] * 1.3) { nota -= 0.30; flags.push('apalancado_vs_pares'); }

  // ── Percentil sectorial (solo el eje del sector, expandido) ──
  const zTot = (zSec * GAIN) / 2.05;
  const percentil = Math.max(1, Math.min(99, Math.round(
    100 * 0.5 * (1 + _erf(zTot / Math.SQRT2))
  )));

  // ── Cobertura de datos: comprimir hacia 5.5 si faltan métricas del perfil ──
  const cobertura = posibles > 0 ? usadas / posibles : 0;
  if (cobertura < 0.45) { nota = 5.5 + (nota - 5.5) * (0.40 + cobertura); flags.push('datos_limitados'); }

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
// Para cada perfil se sintetiza la empresa que está EXACTAMENTE en la mediana
// de su sector en todas sus métricas y se mide qué bruto produce. Ese valor es
// el "cero" de ese sector. Se calcula una sola vez y se cachea.
// Ventaja: si mañana cambias un ancla, la calibración se reajusta sola.
const _BIAS_CACHE = {};
function _sectorBias(pid) {
  if (_BIAS_CACHE[pid]) return _BIAS_CACHE[pid];
  const p = _SECTOR_PROFILES[pid];
  if (!p) return (_BIAS_CACHE[pid] = { sec: 5, mkt: 5 });
  const A = Object.assign({}, _MKT, p.a || {});
  const mc = 5e10;
  const info = { __probe: 1, __forceProfile: pid, marketCap: mc,
                 regularMarketPrice: 100, recommendationMean: 2.5,
                 numberOfAnalystOpinions: 25 };
  for (const [k, v] of Object.entries(A)) {
    if (k === 'fcfYield' || k === 'fcfMargin') continue;
    info[k] = v[1];
  }
  const rev = mc / A.priceToSales[1];
  info.freeCashflow     = A.fcfMargin[1] * rev;
  info.fiftyTwoWeekHigh = 100 / 0.89;      // posición 52s típica
  info.targetMeanPrice  = 110;             // upside típico del consenso
  info.revenueGrowthQ   = A.revenueGrowth[1];
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
   ADAPTADORES PARA index.html  —  no requieren tocar los 5 call sites
   ════════════════════════════════════════════════════════════════════════════ */

// Reemplazo directo de _computeGeneralRating. Misma firma, mismo tipo de retorno
// (string con 1 decimal). Renombra la vieja a _computeGeneralRating_LEGACY y
// pega esta encima: los 5 llamados siguen funcionando igual.
function _computeGeneralRating({pe, fpe, roe, roa, revG, epsG, pm, de, beta, info}) {
  const qType = String(info?.quoteType || '').toUpperCase();
  if (qType === 'ETF' || qType === 'MUTUALFUND') return '7.5';
  const ticker = info?.symbol || info?.ticker || window?._PVX_CUR_TICKER || '';
  const r = computeSectorRating(ticker, info || {});
  if (!r || r.nota == null) return '5.5';
  window._PVX_LAST_SECTOR_RATING = r;      // la UI lee percentil/pilares de aquí
  return r.nota.toFixed(1);
}

// Etiqueta de la nota (reemplaza _ratingLabel, ahora con contexto sectorial).
function _ratingLabelSector(nota, percentil) {
  if (nota == null) return '—';
  const base = nota >= 8 ? 'Excelente' : nota >= 6.5 ? 'Buena' : nota >= 5 ? 'Neutral'
             : nota >= 3.5 ? 'Débil' : 'Evitar';
  if (percentil == null) return base;
  return base + (percentil >= 90 ? ' · líder del sector'
              : percentil >= 70 ? ' · sobre sus pares'
              : percentil <= 20 ? ' · rezagada en su sector' : '');
}

// Bloque de contexto para el prompt de IA. Sustituye el análisis genérico por uno
// que habla el idioma del sector y conoce la mediana real de cada métrica.
const _SECTOR_VOCAB = {
  BANCO:   'margen de interés neto (NIM), índice de eficiencia, calidad de cartera, capital CET1, coste del riesgo. NO hables de margen bruto ni de deuda/capital: en banca no significan nada.',
  SEGUROS: 'ratio combinado, resultado técnico vs financiero, reservas, disciplina de suscripción. NO uses margen bruto ni deuda/capital.',
  REIT:    'FFO y AFFO por acción (no utilidad neta), ocupación, spread de renovación de rentas, coste y vencimientos de deuda, cap rate. El P/E de un REIT no informa: usa P/FFO y EV/EBITDA.',
  UTILITY: 'base tarifaria (rate base), ROE autorizado por el regulador, plan de capex, cobertura del dividendo, sensibilidad a tasas. El crecimiento alto no es la meta: la previsibilidad sí.',
  ENERGIA_EP: 'coste de producción por barril (breakeven), reservas y su reposición, disciplina de capex, retorno de caja al accionista. Márgenes altos hoy pueden ser pico de ciclo.',
  ENERGIA_INTEGRADA: 'integración upstream/downstream, breakeven, cobertura del dividendo con flujo de caja, disciplina de capex a través del ciclo.',
  SEMI: 'ciclo de inventarios, capacidad y nodos, exposición a un cliente o a un tipo de chip, visibilidad del backlog. Un margen récord suele ser techo de ciclo, no la nueva normalidad.',
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
};

function buildSectorAIContext(ticker, info) {
  const r = computeSectorRating(ticker, info);
  if (!r || r.nota == null) return '';
  const p = _SECTOR_PROFILES[r.perfilId];
  const A = Object.assign({}, _MKT, p.a || {});
  const OFF = new Set(p.off || []);
  const pct = v => (v * 100).toFixed(1) + '%';
  const L = [];
  L.push(`PERFIL SECTORIAL: ${r.perfil} (${r.perfilId})`);
  L.push(`NOTA PORTIV: ${r.nota}/10 · percentil ${r.percentil} de su sector · ${r.etiqueta}`);
  const nd = v => v == null ? 'n/d' : v;
  L.push(`PILARES (1-10, vs. sus pares): rentabilidad ${nd(r.pilares.rentabilidad)} · crecimiento ${nd(r.pilares.crecimiento)} · solidez ${nd(r.pilares.solidez)} · valoración ${nd(r.pilares.valoracion)} · mercado ${nd(r.pilares.mercado)}`);
  L.push('');
  L.push('LA EMPRESA CONTRA LA MEDIANA DE SU SECTOR:');
  const show = [['profitMargins','Margen neto',1],['operatingMargins','Margen operativo',1],
                ['grossMargins','Margen bruto',1],['returnOnEquity','ROE',1],
                ['returnOnCapital','ROIC',1],['revenueGrowth','Crecimiento ingresos',1],
                ['forwardPE','P/E adelantado',0],['enterpriseToEbitda','EV/EBITDA',0],
                ['priceToBook','P/VL',0],['debtToEquity','Deuda/Capital',0],
                ['dividendYield','Dividendo',1]];
  for (const [k, lbl, isPct] of show) {
    if (OFF.has(k)) continue;
    const v = info?.[k];
    if (typeof v !== 'number' || !isFinite(v) || !A[k]) continue;
    const med = A[k][1];
    const f = x => isPct ? pct(x) : (+x).toFixed(1);
    const cmp = v > med * 1.15 ? 'POR ENCIMA' : v < med * 0.85 ? 'POR DEBAJO' : 'EN LÍNEA';
    L.push(`  • ${lbl}: ${f(v)}  |  mediana del sector ${f(med)}  → ${cmp}`);
  }
  if (r.flags?.length) L.push('', 'ALERTAS DEL MODELO: ' + r.flags.join(', '));
  L.push('');
  L.push(`CÓMO DEBES ANALIZAR ESTE SECTOR — usa estos conceptos: ${_SECTOR_VOCAB[r.perfilId] || 'márgenes, retorno sobre el capital, crecimiento y valoración frente a sus pares directos.'}`);
  L.push('REGLA: compara SIEMPRE contra sus pares del sector, nunca contra el mercado en general. No uses métricas marcadas como no aplicables. No repitas los números: interprétalos.');
  return L.join('\n');
}

if (typeof module !== 'undefined') module.exports = { computeSectorRating, _sectorProfileOf, _SECTOR_PROFILES,
                   _anchorScore, _sectorBias, buildSectorAIContext, _ratingLabelSector };
