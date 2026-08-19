// snaptrade-webhook — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Receives SnapTrade webhook events (server-to-server POST). Deploy with
// --no-verify-jwt (SnapTrade does not send a Supabase JWT).
//
//   CONNECTION_ADDED    -> store brokerageAuthorizationId as snaptrade_connection_id
//   CONNECTION_UPDATED  -> clear the "broken" flag (connection healed)
//   CONNECTION_BROKEN   -> set snaptrade_connection_broken = true (frontend asks to reconnect)
//   CONNECTION_DELETED  -> clear snaptrade_connection_id and the broken flag
//
// Autenticación por FIRMA HMAC — ver el bloque de abajo.
//
// Always returns 200 quickly so SnapTrade does not retry.

import { adminClient, isUuid } from "../_shared/snaptrade.ts";

// ── Verificación de firma: OBLIGATORIA ───────────────────────────────────────
// Antes se comprobaba un secreto compartido de forma OPCIONAL (`if (WEBHOOK_SECRET)`)
// y la variable nunca se puso en producción, así que el `if` no corría NUNCA: la
// función aceptaba POSTs anónimos. Cualquiera que conociera el UUID de un usuario podía
// escribir en su fila de `profiles` — marcarle la conexión como rota, borrarle el
// connection_id o limpiarle el marcador de desconexión — sin ninguna credencial.
// Comprobado en vivo: un POST sin cabeceras devolvía 200.
//
// El `webhookSecret` del payload está DEPRECADO por SnapTrade y ya no es configurable
// en su dashboard (la pestaña Webhooks sólo expone la Endpoint URL). El mecanismo
// vigente es la cabecera `Signature`:
//
//   Signature = base64( HMAC-SHA256( consumerKey, canonicalJson(body) ) )
//
// donde canonicalJson = JSON compacto con las claves ORDENADAS de forma recursiva
// (el ejemplo de SnapTrade usa json.dumps(separators=(",",":"), sort_keys=True)).
// La clave es el CONSUMER KEY que ya usa el SDK: no hay secreto nuevo que configurar
// ni nada que tocar en el dashboard — sólo desplegar.
//   https://docs.snaptrade.com/docs/webhooks
//
// Sin consumer key la función NO procesa nada. Fail-closed: perder eventos de estado es
// recuperable (snaptrade-refresh detecta la conexión rota en el siguiente sync);
// aceptar escrituras anónimas no lo es.
const CONSUMER_KEY = Deno.env.get("SNAPTRADE_CONSUMER_KEY") ?? "";

/** JSON canónico: claves ordenadas recursivamente, separadores compactos. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
    .join(",") + "}";
}

/**
 * Escapa todo lo no-ASCII a \uXXXX, como hace json.dumps de Python por defecto
 * (ensure_ascii=True) y NO hace JSON.stringify. Sólo importa si algún campo trae
 * acentos — hoy los eventos son uuids y timestamps — pero un fallo aquí sería un 401
 * silencioso, así que se firma también esta variante.
 */
function asciiEscape(s: string): string {
  return s.replace(/[\u0080-\uFFFF]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

async function hmacB64(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// Comparación en tiempo constante: un `!==` normal sale en el primer byte distinto y
// filtra el prefijo correcto por temporización. El coste aquí es irrelevante.
function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // La longitud sí se filtra (inevitable sin hashear); el contenido no.
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const ok = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Sin consumer key no se acepta NADA. 503 (no 401) para que quede claro en los logs
  // que el fallo es de configuración nuestra, no del emisor.
  if (!CONSUMER_KEY) {
    console.error("[snaptrade-webhook] SNAPTRADE_CONSUMER_KEY sin configurar — evento rechazado");
    return ok({ ok: false, error: "webhook not configured" }, 503);
  }

  // El cuerpo se lee como TEXTO: hay que firmar exactamente lo que llegó.
  const raw = await req.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { return ok({ ok: false, error: "bad json" }, 400); }

  const provided = req.headers.get("Signature") ?? "";   // Headers.get es case-insensitive
  if (!provided) {
    console.warn("[snaptrade-webhook] sin cabecera Signature — evento rechazado");
    return ok({ ok: false, error: "unauthorized" }, 401);
  }

  // Se aceptan las DOS formas de calcular el digest. La documentada es la canónica
  // (claves ordenadas), pero si su emisor firmase el cuerpo tal cual llegó, un
  // reordenamiento de claves nos haría rechazar eventos legítimos para siempre.
  // Ambas variantes exigen el consumer key, así que admitir las dos no debilita nada.
  const canon = canonicalJson(body);
  const candidates = await Promise.all([
    hmacB64(CONSUMER_KEY, canon),               // la documentada
    hmacB64(CONSUMER_KEY, asciiEscape(canon)),  // idem con no-ASCII escapado (json.dumps)
    hmacB64(CONSUMER_KEY, raw),                 // el cuerpo tal cual llegó
  ]);
  if (!candidates.some((c) => safeEqual(provided, c))) {
    console.warn(
      "[snaptrade-webhook] firma inválida — evento rechazado. type=", String(body?.eventType ?? ""),
      "sig_recibida=", provided.slice(0, 8) + "…",
    );
    return ok({ ok: false, error: "unauthorized" }, 401);
  }

  // Anti-replay laxo. SnapTrade recomienda 300 s, pero REINTENTA los webhooks fallidos:
  // una ventana corta convertiría un reintento tardío en un rechazo permanente. 24 h
  // corta la repetición de eventos viejos sin romper los reintentos. El impacto de un
  // replay es bajo de todos modos: los parches son idempotentes y snaptrade-refresh
  // corrige el flag `broken` en cuanto vuelve a leer datos reales.
  const ts = Date.parse(String(body?.eventTimestamp ?? ""));
  if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > 24 * 3600 * 1000) {
    console.warn("[snaptrade-webhook] eventTimestamp fuera de ventana — evento descartado");
    return ok({ ok: true, skipped: "stale" });
  }

  const type: string = body?.eventType ?? body?.type ?? "";
  // SnapTrade sends the SnapTrade userId (== our Supabase user.id) and the
  // brokerage authorization (connection) id.
  const snapUserId: string = body?.userId ?? body?.user_id ?? "";
  const connectionId: string =
    body?.brokerageAuthorizationId ?? body?.authorizationId ?? body?.connectionId ?? "";

  if (!isUuid(snapUserId)) return ok({ ok: true, skipped: "non-uuid userId", type });

  const admin = adminClient();

  // Invalidar la caché = poner `snaptrade_last_refresh` a null. La siguiente lectura de
  // snaptrade-refresh ve la caché vencida y vuelve a pedirle las posiciones a SnapTrade.
  // Sin esto, SnapTrade podía terminar de sincronizar una operación y la app seguía
  // sirviendo hasta 60 minutos la foto anterior — el usuario ve su compra "perdida"
  // aunque el dato ya estuviera disponible.
  const BUST = { snaptrade_last_refresh: null };

  let patch: Record<string, unknown> | null = null;
  switch (type) {
    // Sincronización terminada al otro lado → lo que tenemos guardado ya es viejo.
    case "ACCOUNT_HOLDINGS_UPDATED":
      patch = { ...BUST };
      break;
    // Movimientos nuevos: además de las posiciones invalidan los FLUJOS. La caché de
    // snaptrade_activities es DIARIA (el endpoint origen sirve datos diarios), así que sin
    // esto una aportación de hoy no aparecía en "has aportado" hasta mañana: el valor de la
    // cartera subía por el ingreso y las aportaciones seguían sin contarlo, o sea un
    // rendimiento inflado justo el día en que metes dinero, que es cuando más se mira.
    case "ACCOUNT_TRANSACTIONS_UPDATED":
    case "ACCOUNT_TRANSACTIONS_INITIAL_UPDATE":
    case "NEW_ACCOUNT_AVAILABLE":
    case "TRADES_PLACED":
      patch = { ...BUST, snaptrade_activities: null };
      break;
    case "CONNECTION_ADDED":
      // Fresh (re)connection → clear any prior "trial vencido" disconnect marker so
      // the client stops showing the resubscribe copy for a now-connected user.
      patch = {
        snaptrade_connection_id: connectionId || null,
        snaptrade_connection_broken: false,
        snaptrade_disconnected_reason: null,
        snaptrade_disconnected_at: null,
        ...BUST,   // recién (re)conectado: la foto guardada es de antes del enlace
      };
      break;
    case "CONNECTION_UPDATED":
    case "CONNECTION_FIXED":
      patch = {
        snaptrade_connection_broken: false,
        ...(connectionId ? { snaptrade_connection_id: connectionId } : {}),
        ...BUST,   // conexión arreglada → vuelve a haber datos nuevos que leer
      };
      break;
    case "CONNECTION_BROKEN":
      // Se invalida la caché ADEMÁS de marcar la rotura. Sin el BUST, la siguiente lectura
      // salía por el atajo de caché y devolvía la bandera sin preguntarle a SnapTrade: una
      // rotura transitoria que el propio SnapTrade repara en minutos dejaba al usuario con
      // el cartel de "Reconecta tu broker" hasta una hora, y pulsando un botón que no tenía
      // nada que arreglar. Con el BUST, la primera lectura posterior comprueba el estado
      // REAL (listBrokerageAuthorizations) y o lo confirma o baja la bandera sola.
      patch = { snaptrade_connection_broken: true, ...BUST };
      break;
    case "CONNECTION_DELETED":
      patch = { snaptrade_connection_id: null, snaptrade_connection_broken: false };
      break;
    default:
      // Cualquier otro evento de datos de cuenta también invalida la caché: es preferible
      // una lectura de más (gratis, va contra el dato ya sincronizado) que enseñar cifras
      // viejas. Los eventos ajenos a datos siguen sin tocar nada.
      if (/ACCOUNT|HOLDING|TRANSACTION|TRADE|ORDER/i.test(type)) { patch = { ...BUST }; break; }
      return ok({ ok: true, ignored: type });
  }

  const { error } = await admin
    .from("profiles")
    .update(patch)
    .eq("snaptrade_user_id", snapUserId);

  if (error) {
    console.error("webhook update failed:", error.message);
    return ok({ ok: false, error: error.message }, 200); // still 200 to avoid retries storm
  }
  return ok({ ok: true, type });
});
