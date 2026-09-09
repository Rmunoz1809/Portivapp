// ═══════════════════════════════════════════════════════════════════════════
//  apns.ts — firma del JWT de APNs y envío a Apple
//  Secrets: APNS_KEY_P8 (contenido del .p8), APNS_KEY_ID, APNS_TEAM_ID
// ═══════════════════════════════════════════════════════════════════════════
export const APNS_TOPIC = "com.portivapp.portafolio";

const KEY_P8  = Deno.env.get("APNS_KEY_P8")  ?? "";
const KEY_ID  = Deno.env.get("APNS_KEY_ID")  ?? "";
const TEAM_ID = Deno.env.get("APNS_TEAM_ID") ?? "";

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pkcs8(pem: string): ArrayBuffer {
  const raw = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

// Apple RECHAZA un token nuevo si se regenera más de una vez cada 20 minutos, y lo
// acepta hasta 1 hora. 40 min queda cómodamente entre los dos límites. El caché vive
// en el módulo: sobrevive a las invocaciones calientes de la misma instancia.
let _jwt: { token: string; at: number } | null = null;
const JWT_TTL_MS = 40 * 60 * 1000;

export async function apnsJwt(): Promise<string> {
  const now = Date.now();
  if (_jwt && now - _jwt.at < JWT_TTL_MS) return _jwt.token;
  if (!KEY_P8 || !KEY_ID || !TEAM_ID) throw new Error("APNs sin configurar (APNS_KEY_P8/KEY_ID/TEAM_ID)");

  const key = await crypto.subtle.importKey(
    "pkcs8", pkcs8(KEY_P8), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header  = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: KEY_ID })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ iss: TEAM_ID, iat: Math.floor(now / 1000) })));
  // ECDSA en WebCrypto devuelve r||s crudo (IEEE P1363), que es exactamente lo que
  // pide JWS ES256. No hay que desenvolver ningún DER.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`));
  const token = `${header}.${payload}.${b64url(sig)}`;
  _jwt = { token, at: now };
  return token;
}

export type Envio = {
  token: string;
  environment: "sandbox" | "production";
  titulo: string;
  cuerpo: string;
  /** Deep link: el tap abre el destino concreto, nunca el home. */
  deeplink: string;
  /** Id de la fila de push_selection_log, para marcar la apertura. */
  logId?: string;
  /** Título largo del evento. El cliente lo usa para posicionar el calendario. */
  tituloEvento?: string;
  collapseId?: string;
};

export type Resultado =
  | { ok: true; status: number }
  | { ok: false; status: number; reason: string; borrarToken: boolean };

/** Envía UN push. No lanza: devuelve el resultado para que el caller decida. */
export async function enviarPush(e: Envio): Promise<Resultado> {
  const host = e.environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const jwt = await apnsJwt();

  const body = {
    aps: {
      alert: { title: e.titulo, body: e.cuerpo },
      sound: "default",
      "interruption-level": "active",
    },
    // El cliente lee esto en el listener pushNotificationActionPerformed.
    deeplink: e.deeplink,
    log_id: e.logId ?? null,
    titulo_evento: e.tituloEvento ?? null,
  };

  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": APNS_TOPIC,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(Date.now() / 1000) + 3 * 3600),
    "content-type": "application/json",
  };
  if (e.collapseId) headers["apns-collapse-id"] = e.collapseId.slice(0, 64);

  let res: Response;
  try {
    res = await fetch(`https://${host}/3/device/${e.token}`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, reason: String(err), borrarToken: false };
  }

  if (res.status === 200) { await res.body?.cancel(); return { ok: true, status: 200 }; }

  const txt = await res.text().catch(() => "");
  let reason = txt;
  try { reason = JSON.parse(txt)?.reason ?? txt; } catch { /* cuerpo no-JSON */ }

  // 410 Unregistered → el usuario desinstaló. BadDeviceToken → token de OTRO entorno
  // (el error clásico de sandbox vs producción). En ambos casos el token es basura y
  // se borra: reintentarlo sólo suma latencia y ruido en los logs para siempre.
  const borrarToken = res.status === 410 ||
    reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic";
  return { ok: false, status: res.status, reason, borrarToken };
}
