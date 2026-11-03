// anthropic-proxy — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Why: production is served from GitHub Pages (static), so the API key has to live
// server-side (Supabase secret ANTHROPIC_API_KEY). Mirror of netlify/functions/anthropic.js.
//
// Client contract: POST /functions/v1/anthropic-proxy
//   body = { model, max_tokens, system?, messages, tools? }        (messages API → raw response)
//        | { model, system?, prompt, allowed_tools? }              (cli style → { text })
//
// 3 nov 2026 — hasta la v25 esta función no tenía puerta: la ANON key (pública, en el HTML)
// bastaba para usar Claude con la key de Portiv, con cualquier modelo y cualquier tool.
// Ahora pasa por _shared/ai-guard.ts (sesión obligatoria, cupo por usuario, registro de
// consumo), sólo acepta Sonnet/Haiku y sólo la tool de búsqueda web, con tope de usos.

import { guardAi, logUsage, modelAllowed } from "../_shared/ai-guard.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// Aliases sin fecha → familia, para reintentar con un id válido si el pedido falla.
const MODEL_FALLBACK: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

// Sólo lo que usa la app (AI_MODELS.narrative = Sonnet; Haiku en extracción). Opus no.
const MODEL_ALLOW = [/^claude-sonnet-[\w.-]+$/, /^claude-haiku-[\w.-]+$/];

// La narrativa por acción se genera 1× por ticker y se cachea en la nube: un uso normal son
// unas pocas llamadas al día. El tope sólo frena bucles y abuso.
const LIMITS = { perMinute: 12, perDay: 150 };

// Techo de búsquedas web por petición (el cliente pide 1–2; el chat hasta _webN).
const MAX_WEB_USES = 3;

function familyOf(model: string): string {
  const m = String(model || "").toLowerCase();
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function callAnthropic(apiBody: Record<string, unknown>, useWebSearch: boolean) {
  const headers: Record<string, string> = {
    "x-api-key": ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (useWebSearch) headers["anthropic-beta"] = "web-search-2025-03-05";
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(apiBody),
  });
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { error: { message: text || ("Error " + res.status) } }; }
  return { status: res.status, json: j };
}

// Sólo la tool de búsqueda web, con max_uses acotado. Cualquier otra tool se descarta.
function webSearchTool(uses: unknown) {
  const n = Math.min(Math.max(1, Number(uses) || 1), MAX_WEB_USES);
  return { type: "web_search_20250305", name: "web_search", max_uses: n };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: { message: "Method Not Allowed" } }, 405);

  // La puerta va ANTES de mirar el body o la key: nada de trabajo para quien no debería estar.
  const g = await guardAi(req, "anthropic", LIMITS);
  if (!g.ok) return json(g.body, g.status);

  if (!ANTHROPIC_KEY) {
    return json({ error: { message: "ANTHROPIC_API_KEY no está configurada en Supabase (Edge Functions → Secrets)." } }, 500);
  }

  let payload: any;
  try { payload = await req.json(); } catch { payload = {}; }

  const isMessages = Array.isArray(payload.messages);
  const isCli = typeof payload.prompt === "string" && payload.prompt.length > 0;
  if (!isMessages && !isCli) {
    return json({ error: { message: 'Body inválido: se esperaba "messages" o "prompt".' } }, 400);
  }

  const model = String(payload.model || "claude-sonnet-5-5");
  if (!modelAllowed(model, MODEL_ALLOW)) {
    return json({ error: { message: "Modelo no permitido." }, error_code: "model_not_allowed" }, 400);
  }
  // Techo duro server-side (anti-abuso de costo desde un cliente manipulado). 8192 cubre
  // holgado visión/chat/análisis; nada legítimo lo excede.
  const _maxTok = Math.min(Math.max(1, Number(payload.max_tokens) || 4096), 8192);

  let useWebSearch = false;
  let apiBody: Record<string, unknown>;

  if (isMessages) {
    apiBody = { model, max_tokens: _maxTok, messages: payload.messages };
    if (payload.temperature != null) apiBody.temperature = payload.temperature;
    if (payload.system) apiBody.system = [{ type: "text", text: String(payload.system), cache_control: { type: "ephemeral" } }];
    const ws = Array.isArray(payload.tools)
      ? payload.tools.find((t: any) => t && /web_search/.test(String(t.type || "")))
      : null;
    if (ws) {
      apiBody.tools = [webSearchTool(ws.max_uses)];
      useWebSearch = true;
    }
  } else {
    apiBody = { model, max_tokens: _maxTok, messages: [{ role: "user", content: payload.prompt }] };
    if (payload.temperature != null) apiBody.temperature = payload.temperature;
    if (payload.system) apiBody.system = [{ type: "text", text: String(payload.system), cache_control: { type: "ephemeral" } }];
    if (Array.isArray(payload.allowed_tools) && payload.allowed_tools.some((t: any) => /websearch|webfetch/i.test(String(t)))) {
      apiBody.tools = [webSearchTool(1)];
      useWebSearch = true;
    }
  }

  try {
    let { status, json: j } = await callAnthropic(apiBody, useWebSearch);

    // Reintento con modelo fallback si el id pedido no existe.
    let errMsg = (j && j.error && j.error.message) || "";
    if (status >= 400 && /model/i.test(errMsg)) {
      const fb = MODEL_FALLBACK[familyOf(model)];
      if (fb && fb !== model) {
        apiBody.model = fb;
        ({ status, json: j } = await callAnthropic(apiBody, useWebSearch));
        errMsg = (j && j.error && j.error.message) || "";
      }
    }

    // Si la búsqueda web no está disponible en la cuenta/plan, reintentar SIN ella.
    if (status >= 400 && useWebSearch && /(web.?search|tool|beta)/i.test(errMsg) && apiBody.tools) {
      delete apiBody.tools;
      ({ status, json: j } = await callAnthropic(apiBody, false));
    }

    if (status >= 400) {
      return json({ error: { message: (j.error && j.error.message) || ("Error " + status) } }, status);
    }

    logUsage("anthropic-proxy", g.userId, String(apiBody.model), j.usage);

    if (isCli) {
      let out = "";
      (j.content || []).forEach((b: any) => { if (b && b.type === "text") out += b.text; });
      return json({ text: out.trim(), usage: j.usage || null, model: apiBody.model }, 200);
    }
    // Modo messages → respuesta cruda de Anthropic.
    return json(j, 200);
  } catch (e) {
    return json({ error: { message: String((e && (e as Error).message) || e) } }, 502);
  }
});
