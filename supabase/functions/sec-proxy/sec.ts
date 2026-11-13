// sec-proxy · núcleo puro: sin Deno, sin base de datos y con `fetch` inyectado. Así se prueba
// tal cual en Node 24 (que ejecuta .ts quitando los tipos) contra la SEC real. index.ts le pone
// encima Deno.serve y la caché compartida fh_cache.

// Tags us-gaap del gasto por intereses BRUTO, en el mismo orden de preferencia que la app
// (_PV_FIN_TAGS.interestExpense en index.html).
export const INTEREST_TAGS = [
  "InterestExpense",
  "InterestExpenseNonoperating",
  "InterestExpenseDebt",
  "InterestAndDebtExpense",
];

export type Fact = {
  tag: string; val: number; start: string; end: string;
  form: string; filed: string; accn: string;
};
export type Get = (url: string) => Promise<Response>;

const CONCEPT_BASE = "https://data.sec.gov/api/xbrl/companyconcept";
const DAY_MS = 86_400_000;

// company_tickers.json → { TICKER: cik } (~10.400 emisores). Varias clases de una empresa
// comparten CIK (GOOGL y GOOG).
export function tickerMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const e of Object.values(raw as Record<string, any>)) {
    const t = String(e?.ticker ?? "").toUpperCase().trim();
    const cik = Number(e?.cik_str);
    if (t && Number.isInteger(cik) && cik > 0 && !(t in out)) out[t] = cik;
  }
  return out;
}

// La SEC escribe las clases con guion (BRK-B) y Finnhub con punto (BRK.B).
export function cikFor(map: Record<string, number>, symbol: string): number | null {
  const s = String(symbol || "").toUpperCase().trim();
  return map[s] ?? map[s.replace(/\./g, "-")] ?? null;
}

// Hechos ANUALES de un concepto (respuesta de companyconcept): solo 10-K o 10-K/A, y solo
// duraciones de un ejercicio (350–380 días, caben los de 52/53 semanas): un 10-K también
// puede traer trimestres. Cada 10-K repite dos ejercicios anteriores como comparativos; por
// fecha de cierre gana el presentado más tarde, que recoge una reexpresión si la hubo.
export function annualFacts(concept: any, tag: string): Fact[] {
  const usd = concept?.units?.USD;
  if (!Array.isArray(usd)) return [];
  const byEnd = new Map<string, Fact>();
  for (const x of usd) {
    if (!x || !/^10-K/i.test(String(x.form ?? "")) || typeof x.val !== "number" || !isFinite(x.val)) continue;
    const start = String(x.start ?? ""), end = String(x.end ?? "");
    const days = (Date.parse(end) - Date.parse(start)) / DAY_MS;
    if (!(days >= 350 && days <= 380)) continue;
    const filed = String(x.filed ?? "");
    const prev = byEnd.get(end);
    if (prev && prev.filed >= filed) continue;
    byEnd.set(end, { tag, val: x.val, start, end, form: String(x.form), filed, accn: String(x.accn ?? "") });
  }
  return [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end));
}

// Una cifra por ejercicio: la del primer tag de INTEREST_TAGS que lo reporta. Se elige por
// fecha de cierre y no por tag a secas porque las empresas cambian de tag: MSFT usó
// InterestExpense hasta el 10-K de FY2024 y desde FY2025 usa InterestExpenseNonoperating
// ($3,051 M en FY2026). Con el orden a secas saldría el gasto de FY2024 como si fuera el último.
export function interestByYear(byTag: Record<string, Fact[]>, max = 5): Fact[] {
  const out = new Map<string, Fact>();
  for (const tag of INTEREST_TAGS) {
    for (const f of byTag[tag] ?? []) if (f.val > 0 && !out.has(f.end)) out.set(f.end, f);
  }
  return [...out.values()].sort((a, b) => b.end.localeCompare(a.end)).slice(0, max);
}

// Gasto por intereses anual de los últimos 10-K de un CIK: un companyconcept por tag, en
// paralelo. 404 = la empresa no usa ese tag (lo normal: cada una usa uno o dos). Cualquier
// otro fallo se lanza para que el llamador NO guarde un «no hay dato» que no es verdad.
export async function secInterest(cik: number, get: Get): Promise<{ cik: number; entity: string; interestExpense: Fact[] }> {
  const pad = String(cik).padStart(10, "0");
  let entity = "";
  const byTag: Record<string, Fact[]> = {};
  await Promise.all(INTEREST_TAGS.map(async (tag) => {
    const r = await get(`${CONCEPT_BASE}/CIK${pad}/us-gaap/${tag}.json`);
    if (r.status === 404) { await r.body?.cancel(); return; }
    if (!r.ok) { await r.body?.cancel(); throw new Error(`sec ${r.status} ${tag}`); }
    const j = await r.json();
    if (!entity && typeof j?.entityName === "string") entity = j.entityName;
    byTag[tag] = annualFacts(j, tag);
  }));
  return { cik, entity, interestExpense: interestByYear(byTag) };
}

// ═══ Estado de resultados completo desde companyfacts (13 nov 2026) ═════════════════════
// La pestaña «Resultados» lo usa como fuente principal: Finnhub /stock/financials-reported no
// tiene a los emisores extranjeros (20-F: NU, y con su ticker trae a Northeast Utilities, que
// usaba «NU» hasta 2015) y redondea el EPS de los 10-K viejos. companyfacts trae, en una sola
// petición, cada hecho XBRL con su periodo exacto: hay trimestres de 3 meses directos (sin
// restar acumulados) y el T4 sale del anual menos el acumulado a 9 meses con el mismo tag.
// Por cada campo, la lista de tags en orden de preferencia (us-gaap y NIIF/IFRS).
export const INCOME_TAGS: Record<string, string[]> = {
  rev: ["us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:SalesRevenueNet",
    "us-gaap:RevenuesNetOfInterestExpense", "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
    "ifrs-full:Revenue", "ifrs-full:RevenueFromContractsWithCustomers"],
  cost: ["us-gaap:CostOfRevenue", "us-gaap:CostOfGoodsAndServicesSold", "us-gaap:CostOfGoodsSold", "ifrs-full:CostOfSales"],
  gross: ["us-gaap:GrossProfit", "ifrs-full:GrossProfit"],
  op: ["us-gaap:OperatingIncomeLoss", "ifrs-full:ProfitLossFromOperatingActivities"],
  net: ["us-gaap:NetIncomeLoss", "us-gaap:ProfitLoss", "ifrs-full:ProfitLossAttributableToOwnersOfParent", "ifrs-full:ProfitLoss"],
  eps: ["us-gaap:EarningsPerShareDiluted", "us-gaap:EarningsPerShareBasicAndDiluted",
    "ifrs-full:DilutedEarningsLossPerShare", "ifrs-full:BasicAndDilutedEarningsLossPerShare"],
  // Antes de impuestos e impuestos (todas las empresas).
  pretax: ["us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    "ifrs-full:ProfitLossBeforeTax"],
  tax: ["us-gaap:IncomeTaxExpenseBenefit", "ifrs-full:IncomeTaxExpenseContinuingOperations"],
  // Bancos: no tienen costo de ventas, utilidad bruta ni operativa; su estado de resultados es
  // margen financiero + comisiones − reservas para créditos − gastos (BAC, JPM, NU).
  nii: ["us-gaap:InterestIncomeExpenseNet", "ifrs-full:InterestRevenueExpense"],
  nonii: ["us-gaap:NoninterestIncome"],
  prov: ["us-gaap:ProvisionForLoanLeaseAndOtherLosses", "us-gaap:ProvisionForLoanAndLeaseLosses", "us-gaap:ProvisionForLoanLossesExpensed"],
  nonie: ["us-gaap:NoninterestExpense"],
};
const ANNUAL_FORM = /^(10-K|20-F|40-F)/i;
const PERIOD_FORM = /^(10-K|10-Q|20-F|40-F)/i;
type F = { start: string; end: string; val: number; filed: string; fy: number | null; fp: string; form: string };
export type IncomeRow = {
  end: string; start: string; fy: number | null; q: number;
  rev: number | null; cost: number | null; gross: number | null; op: number | null; net: number | null; eps: number | null;
  pretax: number | null; tax: number | null; nii: number | null; nonii: number | null; prov: number | null; nonie: number | null;
  tags: Record<string, string>;
};
const days = (s: string, e: string) => (Date.parse(e) - Date.parse(s)) / DAY_MS;

// Hechos de un tag en dólares (o dólares por acción para el EPS). Otras monedas se descartan:
// la app enseña todo en USD y mezclar una cifra en reales o en dólares taiwaneses sería falso.
function factsOf(facts: any, key: string, eps: boolean): F[] {
  const [tx, tag] = key.split(":");
  const units = facts?.[tx]?.[tag]?.units;
  if (!units) return [];
  const arr = eps ? (units["USD/shares"] ?? units["USD/share"]) : units.USD;
  if (!Array.isArray(arr)) return [];
  return arr.filter((x: any) => x && typeof x.val === "number" && isFinite(x.val) && x.start && x.end && PERIOD_FORM.test(String(x.form ?? "")))
    .map((x: any) => ({ start: String(x.start), end: String(x.end), val: x.val, filed: String(x.filed ?? ""),
      fy: Number.isInteger(x.fy) ? x.fy : null, fp: String(x.fp ?? ""), form: String(x.form) }));
}

// Por periodo (inicio|fin): el valor del presentado MÁS TARDE (recoge reexpresiones) y la
// etiqueta (año y trimestre fiscal) del presentado PRIMERO, que es el informe de ese periodo:
// los comparativos de informes posteriores llevan el año fiscal de ESE informe.
function byPeriod(fs: F[]) {
  const m = new Map<string, { val: number; filedV: string; fy: number | null; fp: string; filedL: string; form: string; start: string; end: string }>();
  for (const f of fs) {
    const k = f.start + "|" + f.end, p = m.get(k);
    if (!p) { m.set(k, { val: f.val, filedV: f.filed, fy: f.fy, fp: f.fp, filedL: f.filed, form: f.form, start: f.start, end: f.end }); continue; }
    if (f.filed > p.filedV) { p.val = f.val; p.filedV = f.filed; }
    if (f.filed < p.filedL) { p.fy = f.fy; p.fp = f.fp; p.filedL = f.filed; p.form = f.form; }
  }
  return m;
}

export function incomeFromFacts(facts: any, maxA = 8, maxQ = 16): { annual: IncomeRow[]; quarterly: IncomeRow[] } {
  const A = new Map<string, IncomeRow>(), Q = new Map<string, IncomeRow>();
  const row = (map: Map<string, IncomeRow>, end: string, start: string, fy: number | null, q: number) => {
    let r = map.get(end);
    if (!r) {
      r = { end, start, fy, q, rev: null, cost: null, gross: null, op: null, net: null, eps: null,
        pretax: null, tax: null, nii: null, nonii: null, prov: null, nonie: null, tags: {} };
      map.set(end, r);
    }
    return r;
  };
  for (const [field, keys] of Object.entries(INCOME_TAGS)) {
    const isEps = field === "eps";
    for (const key of keys) {
      const per = byPeriod(factsOf(facts, key, isEps));
      // Anual: un ejercicio de 350–380 días, de un 10-K/20-F/40-F.
      const annual = new Map<string, any>();
      for (const p of per.values()) {
        const d = days(p.start, p.end);
        if (d >= 350 && d <= 380 && ANNUAL_FORM.test(p.form)) annual.set(p.end, p);
      }
      for (const p of annual.values()) {
        const r = row(A, p.end, p.start, p.fy, 0);
        if ((r as any)[field] == null) { (r as any)[field] = p.val; r.tags[field] = key; }
      }
      // Trimestres de 3 meses (80–100 días) tal cual.
      for (const p of per.values()) {
        const d = days(p.start, p.end);
        if (!(d >= 80 && d <= 100)) continue;
        const q = /^Q[1-3]$/.test(p.fp) ? +p.fp[1] : (p.fp === "FY" ? 4 : 0);
        const r = row(Q, p.end, p.start, p.fy, q);
        if ((r as any)[field] == null) { (r as any)[field] = p.val; r.tags[field] = key; }
      }
      // T4 = ejercicio − acumulado a 9 meses (mismo inicio, mismo tag). El EPS no se resta.
      if (!isEps) for (const a of annual.values()) {
        const ytd = [...per.values()].find((p) => p.start === a.start && days(p.start, p.end) >= 255 && days(p.start, p.end) <= 285);
        if (!ytd) continue;
        const r = row(Q, a.end, ytd.end, a.fy, 4);
        if ((r as any)[field] == null) { (r as any)[field] = a.val - ytd.val; r.tags[field] = key + " (anual − 9M)"; }
      }
    }
  }
  const fin = (rs: IncomeRow[]) => rs.map((r) => {
    if (r.gross == null && r.rev != null && r.cost != null) { r.gross = r.rev - r.cost; r.tags.gross = "ingresos − costo"; }
    if (r.cost == null && r.rev != null && r.gross != null) { r.cost = r.rev - r.gross; r.tags.cost = "ingresos − utilidad bruta"; }
    return r;
  }).filter((r) => r.rev != null || r.net != null).sort((a, b) => a.end.localeCompare(b.end));
  const annual = fin([...A.values()]), quarterly = fin([...Q.values()]);
  relabel(annual, quarterly);
  return { annual: annual.slice(-maxA), quarterly: quarterly.filter((r) => r.q >= 1).slice(-maxQ) };
}

// Año y trimestre fiscal calculados por FECHAS: el `fy` de la SEC (DEI) no es fiable (CRM
// pone 2025 a los ejercicios que cierran en enero de 2025 y de 2026). Ejercicio = año en que
// cierra (los de 52/53 semanas que cierran en la primera semana de enero cuentan para el año
// anterior), como lo cuentan Finnhub y las propias empresas (CRM, NVDA, MSFT). Trimestre =
// cuántos trimestres faltan para el cierre del ejercicio que lo contiene.
function relabel(annual: IncomeRow[], quarterly: IncomeRow[]) {
  const fyOf = (end: string) => { const d = new Date(end + "T12:00:00Z"); const y = d.getUTCFullYear();
    return (d.getUTCMonth() === 0 && d.getUTCDate() <= 7) ? y - 1 : y; };
  for (const a of annual) a.fy = fyOf(a.end);
  const last = annual[annual.length - 1];
  for (const q of quarterly) {
    // Cierre del ejercicio que contiene el trimestre: un anual conocido, o el aniversario del
    // último cierre anual.
    let fye = annual.find((a) => { const d = days(q.end, a.end); return d >= -5 && d <= 370; })?.end;
    if (!fye && last) {
      const e = new Date(last.end + "T12:00:00Z");
      while (days(q.end, e.toISOString().slice(0, 10)) < -5) e.setUTCFullYear(e.getUTCFullYear() + 1);
      while (days(q.end, e.toISOString().slice(0, 10)) > 370) e.setUTCFullYear(e.getUTCFullYear() - 1);
      fye = e.toISOString().slice(0, 10);
    }
    if (!fye) continue;
    const left = Math.round(days(q.end, fye) / 91.3);
    if (left >= 0 && left <= 3) { q.q = 4 - left; q.fy = fyOf(fye); }
  }
}

export async function secIncome(cik: number, get: Get) {
  const pad = String(cik).padStart(10, "0");
  const r = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad}.json`);
  if (r.status === 404) { await r.body?.cancel(); return { cik, entity: "", annual: [], quarterly: [] }; }
  if (!r.ok) { await r.body?.cancel(); throw new Error(`sec ${r.status} companyfacts`); }
  const j = await r.json();
  return { cik, entity: String(j?.entityName ?? ""), ...incomeFromFacts(j?.facts) };
}
