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
