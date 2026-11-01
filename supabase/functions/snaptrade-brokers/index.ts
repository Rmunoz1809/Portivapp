// snaptrade-brokers — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Lista de brokers que el usuario puede enlazar, para el selector PROPIO de Portiv
// («Elige tu broker»). Con el slug elegido, snaptrade-connect abre el portal de SnapTrade
// directo en el flujo de ese broker: el usuario no ve la pantalla de selección de SnapTrade.
//
// Es reference data del catálogo (sin usuario, sin coste por conexión), así que no pide
// sesión: basta la anon key (verify_jwt). Cacheada por isolate en brokerCatalog().
//
// Request  (POST): {}
// Response (200):  { brokers: [{ slug, name, logo, maintenance, degraded, type }] }

import { preflight, jsonResponse } from "../_shared/cors.ts";
import { snaptrade, brokerCatalog } from "../_shared/snaptrade.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);
  try {
    const brokers = await brokerCatalog(snaptrade());
    if (!brokers.length) return jsonResponse(req, { error: "catalog_unavailable", brokers: [] }, 503);
    return jsonResponse(req, { brokers });
  } catch (e: any) {
    console.error("[snaptrade-brokers] fail", e?.message ?? String(e));
    return jsonResponse(req, { error: e?.message ?? "Error desconocido", brokers: [] }, 500);
  }
});
