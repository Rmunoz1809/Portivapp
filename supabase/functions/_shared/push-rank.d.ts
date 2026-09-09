// Tipos para push-rank.js. El motor se escribe en JS plano a propósito: lo importan
// Deno (Edge Functions) y Node (arnés de calibración) sin ningún paso de build.
export interface EventoPush {
  id: string; key: string; fecha: string;
  titulo: string; push_titulo?: string; push_linea: string;
  tickers?: string[]; ticker?: string;
  imp?: "high" | "medium" | "low";
  tipoHolding?: string;
  time: string;
  pista: "A" | "B";
  categoria: "macro" | "earnings";
  dayIdx?: number;
}
export interface Holding {
  ticker: string; qty: number; price: number; dayChgPct?: number;
}
export interface Candidato {
  id: string; titulo: string; pista: "A" | "B";
  score: number; base: number;
  desglose: Record<string, number>;
  penalizaciones: [string, number][];
}
export interface Ganador {
  evento: EventoPush; pista: "A" | "B";
  base: number; score: number; exposicion: number;
  desglose: Record<string, number>;
  penalizaciones: [string, number][];
}
export interface FilaLog {
  fecha: string; enviado: boolean;
  ganador_id?: string | null; ganador_tickers?: string[] | null;
  ganador_tipo?: string | null; ganador_pista?: "A" | "B" | null;
  abierto?: boolean | null;
}
export interface Resultado {
  ganador: Ganador | null; enviado: boolean;
  motivo: string | null; candidatos: Candidato[];
}

export function iso(d: Date): string;
export function fromISO(s: string): Date;
export function mondayOf(d: Date): Date;
export function minutosDe(hora: string): number;
export function macroEventsForWeek(monday: Date): EventoPush[];
export function macroEventsForDay(fechaISO: string): EventoPush[];
export function eventoDeResultados(o: { ticker: string; fechaISO: string; cuando?: string }): EventoPush;
export function pesosDeCartera(h: Holding[]): { pesos: Map<string, number>; top3: Set<string>; total: number };
export function exposicionEfectiva(tickers: string[], pesos: Map<string, number>): number;
export function exposicionCruda(tickers: string[], pesos: Map<string, number>): number;
export function pvNewsRank(o: {
  fechaISO: string; eventos: EventoPush[]; holdings: Holding[];
  historial?: FilaLog[]; umbral?: number;
}): Resultado;
export function umbralPara(historial: FilaLog[]): number;
export function textoMatutino(g: Ganador, h: Holding[]): { titulo: string; cuerpo: string };
export function textoCierre(h: Holding[]): { titulo: string; cuerpo: string; ticker: string } | null;
export function listaTickers(t: string[]): string;
export function violacionesDeCopy(texto: string): string[];
export const UMBRAL_BASE: number;
export const UMBRAL_ADAPTATIVO: number;
export const ETF_AMPLIOS: Set<string>;
export const FACTOR_ETF_AMPLIO: number;
export const RAREZA: Record<string, number>;
export const PROHIBIDOS: string[];
