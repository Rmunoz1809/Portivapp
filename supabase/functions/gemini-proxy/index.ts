// gemini-proxy — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Why: gemelo de `anthropic-proxy` para todo lo que migró a Gemini. El cliente
// (index.html) NO cambia de contrato: sigue mandando el MISMO body con forma
// Anthropic (`{ model, max_tokens, system?, prompt|messages, allowed_tools?, tools? }`)
// y sigue leyendo la MISMA forma de respuesta. Aquí se traduce a la API de Gemini
// (generateContent) y se normaliza la respuesta de vuelta, para que _aiFetch,
// _aiFetchVision, _visionCall y _tokAdd no necesiten ningún cambio de parsing.
//
// El split es a propósito: el análisis por acción (AI_MODELS.narrative,
// claude-sonnet-5) SIGUE yendo a `anthropic-proxy`. Esta función nunca lo ve.
//
// Client contract: POST /functions/v1/gemini-proxy
//   body = { model, max_tokens, temperature?, system?, messages, tools? }   (visión → respuesta con FORMA Anthropic)
//        | { model, max_tokens, system?, prompt, allowed_tools?, tools? }   (texto  → { text, usage, model })
// La key nunca sale del servidor: GEMINI_API_KEY se lee del entorno de la función
// (Edge Functions → Secrets), mismo patrón que ANTHROPIC_API_KEY.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

// Aliases → id válido, para reintentar si el id pedido no existe (mismo patrón que
// MODEL_FALLBACK en anthropic-proxy). `-lite` cae al lite GA; el resto al flash GA.
const MODEL_FALLBACK: Record<string, string> = {
  lite: "gemini-3.5-flash-lite",
  flash: "gemini-3.7-flash",
};

function familyOf(model: string): string {
  const m = String(model || "").toLowerCase();
  if (m.includes("lite")) return "lite";
  return "flash";
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── GATE DE IDENTIDAD ────────────────────────────────────────────────────────
// `verify_jwt: true` de la plataforma solo comprueba que el JWT esté FIRMADO por este
// proyecto. La ANON KEY lo está — y viaja en el bundle público de portivapp.com, a la
// vista de cualquiera que abra "ver código fuente". Resultado: esta función era un proxy
// ABIERTO a Gemini pagado con nuestra key, sin techo de gasto y sin forma de saber quién
// lo usaba. El cliente ya manda el access token del usuario cuando hay sesión
// (_pvAccessToken en _aiFetch/_aiFetchVision); lo único que faltaba era EXIGIRLO.
//
// No hace falta llamar a auth.getUser(): la plataforma ya validó la FIRMA antes de
// entrar aquí, así que leer el claim `role` del payload es suficiente y no cuesta un
// round trip por petición. Un token falsificado nunca llega a este punto.
function roleOfJwt(tok: string): string {
  try {
    const p = tok.split(".")[1];
    if (!p) return "";
    const b = atob(p.replace(/-/g, "+").replace(/_/g, "/"));
    return String((JSON.parse(b) || {}).role || "");
  } catch {
    return "";
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

// ── Traducción de bloques de contenido Anthropic → parts de Gemini ────────────
// text  → { text }
// image → { inlineData: { mimeType, data } }   (base64 sin prefijo data:)
function partsFromAnthropicContent(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];
  const parts: Record<string, unknown>[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as any;
    if (blk.type === "text" && typeof blk.text === "string") {
      parts.push({ text: blk.text });
    } else if (blk.type === "image" && blk.source) {
      const src = blk.source;
      // Solo base64 inline: es lo único que manda _prepImagesForOCR.
      if (src.type === "base64" && src.data) {
        parts.push({ inlineData: { mimeType: src.media_type || "image/jpeg", data: src.data } });
      } else if (src.type === "url" && src.url) {
        // No soportado por inlineData; se ignora en vez de romper el request entero.
        continue;
      }
    }
  }
  return parts;
}

// BUG EVITADO — mapeo de rol: Anthropic usa 'assistant' para el turno del modelo,
// Gemini usa 'model'. Copiar el rol tal cual rompe el request (rol inválido).
function roleFor(role: unknown): string {
  return String(role || "user") === "assistant" ? "model" : "user";
}

async function callGemini(model: string, apiBody: Record<string, unknown>) {
  const res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      // Header en vez de ?key= : la key no acaba en la URL (ni en logs ni en referers).
      "x-goog-api-key": GEMINI_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(apiBody),
  });
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { error: { message: text || ("Error " + res.status) } }; }
  return { status: res.status, json: j };
}

// ── Normalización de la respuesta de Gemini → forma que ya lee el cliente ─────
function textOf(j: any): string {
  const parts = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  let out = "";
  for (const p of parts) if (p && typeof p.text === "string") out += p.text;
  return out;
}

// usage con las MISMAS claves que Anthropic, porque _tokAdd lee input_tokens,
// output_tokens, cache_*_input_tokens y server_tool_use.web_search_requests.
//   input  ← promptTokenCount (que YA incluye el cacheado) menos la parte cacheada,
//            + tokens de prompt de uso de herramienta (grounding).
//   output ← candidatesTokenCount + thoughtsTokenCount: el precio de salida de
//            Gemini incluye los tokens de "thinking", y candidatesTokenCount los
//            reporta aparte. Sin sumarlos, el badge subestima el gasto real.
//   web_search_requests ← nº de queries de grounding realmente ejecutadas.
function usageOf(j: any) {
  const u = (j && j.usageMetadata) || {};
  const cached = u.cachedContentTokenCount || 0;
  const prompt = u.promptTokenCount || 0;
  const tool = u.toolUsePromptTokenCount || 0;
  const cands = u.candidatesTokenCount || 0;
  const thoughts = u.thoughtsTokenCount || 0;

  let web = 0;
  const cs = (j && j.candidates) || [];
  for (const c of cs) {
    const q = c && c.groundingMetadata && c.groundingMetadata.webSearchQueries;
    if (Array.isArray(q)) web += q.length;
  }

  return {
    input_tokens: Math.max(0, prompt - cached) + tool,
    output_tokens: cands + thoughts,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    server_tool_use: { web_search_requests: web },
  };
}

// Mensaje de error legible: Gemini puede fallar con error.message, o completar sin
// candidatos por filtro de seguridad (promptFeedback.blockReason / finishReason).
function errMsgOf(j: any, status: number): string {
  if (j && j.error && j.error.message) return String(j.error.message);
  const bf = j && j.promptFeedback && j.promptFeedback.blockReason;
  if (bf) return "Solicitud bloqueada por el filtro de contenido (" + bf + ").";
  const fr = j && j.candidates && j.candidates[0] && j.candidates[0].finishReason;
  if (fr && fr !== "STOP" && fr !== "MAX_TOKENS") return "Generación detenida (" + fr + ").";
  return "Error " + status;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: { message: "Method Not Allowed" } }, 405);

  // El gate va ANTES de mirar el body o la key: nada de trabajo para quien no debería estar.
  {
    const _auth = req.headers.get("authorization") || "";
    const _tok = _auth.replace(/^Bearer\s+/i, "").trim();
    const _role = roleOfJwt(_tok);
    // service_role queda permitido para un futuro uso server-side; la ANON key, no: es la
    // que va en el bundle público y la que abría la puerta.
    if (_role !== "authenticated" && _role !== "service_role") {
      return json({
        error: { message: "Inicia sesión para usar las funciones de IA." },
        error_code: "auth_required",
      }, 401);
    }
  }

  if (!GEMINI_KEY) {
    return json({ error: { message: "GEMINI_API_KEY no está configurada en Supabase (Edge Functions → Secrets)." } }, 500);
  }

  let payload: any;
  try { payload = await req.json(); } catch { payload = {}; }

  const isMessages = Array.isArray(payload.messages);
  const isCli = typeof payload.prompt === "string" && payload.prompt.length > 0;
  if (!isMessages && !isCli) {
    return json({ error: { message: 'Body inválido: se esperaba "messages" o "prompt".' } }, 400);
  }

  let model = payload.model || "gemini-3.5-flash-lite";
  // Mismo clamp que anthropic-proxy: techo duro server-side (anti-abuso de costo desde
  // un cliente manipulado). 8192 cubre holgado visión/chat/análisis.
  const _maxTok = Math.min(Math.max(1, payload.max_tokens || 4096), 8192);

  let useWebSearch = false;
  const generationConfig: Record<string, unknown> = { maxOutputTokens: _maxTok };
  if (payload.temperature != null) generationConfig.temperature = payload.temperature;

  const apiBody: Record<string, unknown> = { generationConfig };

  if (isMessages) {
    apiBody.contents = payload.messages.map((m: any) => ({
      role: roleFor(m && m.role),
      parts: partsFromAnthropicContent(m && m.content),
    }));
    // Mismo criterio que anthropic-proxy en modo messages: si el caller manda tools
    // con web_search, se activa la búsqueda.
    if (Array.isArray(payload.tools) && payload.tools.length) {
      useWebSearch = payload.tools.some((t: any) => t && /web_search/.test(t.type || ""));
    }
  } else {
    apiBody.contents = [{ role: "user", parts: [{ text: payload.prompt }] }];
    // Mismo criterio que anthropic-proxy en modo prompt: dispara por allowed_tools.
    // NOTA: allí el tope era max_uses:1 fijo (el proxy IGNORA el max_uses del cliente).
    // Gemini no expone un cap de nº de búsquedas por request → ver reporte de riesgo.
    if (Array.isArray(payload.allowed_tools) && payload.allowed_tools.some((t: any) => /websearch|webfetch/i.test(String(t)))) {
      useWebSearch = true;
    }
  }

  // systemInstruction: Content (solo texto). El cliente manda `system` como string.
  if (payload.system) {
    apiBody.systemInstruction = { parts: [{ text: String(payload.system) }] };
  }
  if (useWebSearch) apiBody.tools = [{ google_search: {} }];

  try {
    let { status, json: j } = await callGemini(model, apiBody);

    // Reintento con modelo fallback si el id pedido no existe (mismo patrón que
    // anthropic-proxy: un id retirado no debe tumbar la feature entera).
    let errMsg = (j && j.error && j.error.message) || "";
    if (status >= 400 && /model|not found|NOT_FOUND/i.test(errMsg)) {
      const fb = MODEL_FALLBACK[familyOf(model)];
      if (fb && fb !== model) {
        model = fb;
        ({ status, json: j } = await callGemini(model, apiBody));
        errMsg = (j && j.error && j.error.message) || "";
      }
    }

    // Si el grounding no está disponible para el modelo/plan, reintentar SIN él
    // (mismo comportamiento que anthropic-proxy con web_search).
    if (status >= 400 && useWebSearch && /(search|tool|grounding|unsupported)/i.test(errMsg) && apiBody.tools) {
      delete apiBody.tools;
      ({ status, json: j } = await callGemini(model, apiBody));
    }

    if (status >= 400) {
      // Passthrough del status (incluye 429 de cuota) con el MISMO shape de error que
      // ya maneja _aiFetch / _aiFetchVision.
      return json({ error: { message: errMsgOf(j, status) } }, status);
    }

    const out = textOf(j);
    const usage = usageOf(j);

    if (isCli) {
      return json({ text: out.trim(), usage, model }, 200);
    }
    // Modo messages (visión): el cliente lee resp.content[0].text, NO resp.text.
    // Se devuelve con FORMA Anthropic para no tocar _visionCall ni su parser.
    return json({
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: out }],
      stop_reason: ((j.candidates || [])[0] || {}).finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
      usage,
    }, 200);
  } catch (e) {
    return json({ error: { message: String((e && (e as Error).message) || e) } }, 502);
  }
});
