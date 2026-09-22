// ═══════════════════════════════════════════════════════════════════════════
//  fomc-sync — mantiene al día las reuniones de la Fed, sin que nadie las teclee
//  ───────────────────────────────────────────────────────────────────────────
//  Las fechas del FOMC estaban escritas a mano y llegaban hasta 2026. Eso no es
//  un dato que se pueda calcular (lo decide el Comité), pero sí uno que la Fed
//  publica en formato legible por máquina. Esta función lo lee y lo guarda.
//
//  La Fed anuncia el calendario del año siguiente a mediados de año, así que con
//  una corrida mensual las fechas de 2027 entran solas mucho antes de necesitarse.
//
//  Nunca borra: sólo inserta y actualiza. Si la Fed no responde, o cambia el
//  formato, la tabla se queda como estaba y el motor sigue con su lista de
//  respaldo — el calendario NO se queda sin FOMC por un fallo de red.
//
//  Deploy: supabase functions deploy fomc-sync --no-verify-jwt
//  Cron:   día 3 de cada mes.
// ═══════════════════════════════════════════════════════════════════════════
import { admin, autorizado } from "../_shared/push-common.ts";

const FUENTE = "https://www.federalreserve.gov/json/calendar.json";
const DIA = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

type Evento = { title?: string; month?: string; days?: string; time?: string; type?: string };

/** 'days' puede venir como '9', '27-28' o '27 - 28'. La decisión es el ÚLTIMO día. */
function ultimoDiaDe(days: string): number | null {
  const ns = String(days ?? "").match(/\d+/g);
  if (!ns?.length) return null;
  const n = +ns[ns.length - 1];
  return n >= 1 && n <= 31 ? n : null;
}

function fechaDe(e: Evento): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(e.month ?? ""));
  const d = ultimoDiaDe(String(e.days ?? ""));
  if (!m || !d) return null;
  return `${m[1]}-${m[2]}-${String(d).padStart(2, "0")}`;
}

Deno.serve(async (req) => {
  if (!await autorizado(req)) return new Response("forbidden", { status: 403 });

  let reuniones: { decision: string; minutes: string }[] = [];
  let detalle = "";
  try {
    const r = await fetch(FUENTE, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // El archivo llega con BOM: JSON.parse se atraganta si no se quita.
    const j = JSON.parse((await r.text()).replace(/^﻿/, ""));
    const evs: Evento[] = j?.events ?? [];
    const fomc = evs.filter((e) => String(e.type ?? "").toUpperCase() === "FOMC");

    // La decisión es la entrada 'FOMC Meeting' de las 2:00 p.m. — la conferencia
    // de prensa (2:30) es el mismo día y duplicaría. Las actas van aparte.
    const decisiones = new Set<string>();
    const actas = new Set<string>();
    for (const e of fomc) {
      const t = String(e.title ?? "").trim().toLowerCase();
      const f = fechaDe(e);
      if (!f) continue;
      if (t === "fomc minutes") actas.add(f);
      else if (t === "fomc meeting") decisiones.add(f);
    }

    const listaActas = [...actas].sort();
    reuniones = [...decisiones].sort().map((decision) => {
      const t0 = new Date(decision + "T00:00:00Z").getTime();
      // Regla fija de la Fed: las actas salen tres semanas después del anuncio.
      // Se prefiere la entrada REAL del calendario si ya está publicada; el +21
      // sólo cubre las reuniones cuyas actas la Fed todavía no ha listado.
      const real = listaActas.find((f) => {
        const d = Math.round((new Date(f + "T00:00:00Z").getTime() - t0) / DIA);
        return d >= 19 && d <= 23;
      });
      return { decision, minutes: real ?? iso(new Date(t0 + 21 * DIA)) };
    });
    if (!reuniones.length) throw new Error("el JSON de la Fed no trajo ninguna reunión");
  } catch (e) {
    detalle = String(e);
    // Fallo de red o de formato: NO se toca la tabla. Se registra y se sale en 200
    // para que el cron no entre en reintentos; la lista vieja sigue sirviendo.
    await admin.from("fomc_sync_runs").insert({ ok: false, reuniones: 0, detalle });
    return json({ ok: false, detalle });
  }

  const { error } = await admin.from("fomc_calendar")
    .upsert(reuniones.map((x) => ({ ...x, updated_at: new Date().toISOString() })),
            { onConflict: "decision" });
  const anios = [...new Set(reuniones.map((x) => x.decision.slice(0, 4)))].sort();
  await admin.from("fomc_sync_runs").insert({
    ok: !error, reuniones: reuniones.length, anios, detalle: error?.message ?? null });
  return json({ ok: !error, reuniones: reuniones.length, anios, error: error?.message ?? null });
});

const json = (o: unknown) => new Response(JSON.stringify(o), {
  headers: { "content-type": "application/json" } });
