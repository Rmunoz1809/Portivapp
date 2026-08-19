// snaptrade-connect — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Registers the user on SnapTrade (first time only) and returns a fresh
// Connection Portal redirectURI. The redirectURI expires in ~5 min, so it is
// generated on every request.
//
// The SnapTrade userId IS the Supabase auth user.id (immutable UUID) — never the
// email. userSecret is generated once by SnapTrade and stored server-side only.
//
// Request  (POST): { userId?: string, mode?: 'add', connectionId?: string, broker?: 'ibkr' }
//   userId opcional (se toma del JWT). `broker` es un ALIAS, no un slug: ver BROKER_ALIASES.
// Response (200):  { redirectURI: string }

import { preflight, jsonResponse } from "../_shared/cors.ts";
import {
  snaptrade,
  adminClient,
  requireUser,
  loadProfile,
  requireEntitlement,
} from "../_shared/snaptrade.ts";

// ── Entrada directa al flujo de un broker concreto ───────────────────────────────
// `loginSnapTradeUser` acepta `broker` (el slug del brokerage): con él, el portal se salta
// la pantalla de selección y entra directo al flujo de ese broker. Con IBKR importa más
// que con nadie, porque ese flujo no es un OAuth sino pegar un Query ID y un Token que el
// usuario tiene que haber generado antes en el portal web de IBKR.
//
// El cliente NO manda el slug: manda un ALIAS ('ibkr'). Dos razones:
//   1. El slug real vive en un único sitio —el secreto SNAPTRADE_IBKR_SLUG—, así que
//      corregirlo no toca código ni en el servidor ni en el cliente.
//   2. Nada que venga del cliente llega a `loginSnapTradeUser` sin pasar por este mapa.
//      Un slug basura rompe el portal y el error que devuelve SnapTrade no dice qué pasó:
//      el usuario ve una pantalla muerta y nosotros no vemos nada.
// Un alias desconocido es 400 aquí mismo, con nombre.
const BROKER_ALIASES: Record<string, string> = {
  ibkr: (Deno.env.get("SNAPTRADE_IBKR_SLUG") ?? "").trim().toUpperCase(),
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* body optional */ }

    const userId = await requireUser(req, admin, body?.userId);
    // gate: only entitled users may link a broker.
    // failClosed: enlazar un broker es lo ÚNICO de este servicio que crea un coste NUEVO y
    // recurrente (~$1/mes por conexión activa, mientras exista). Si el RPC del candado falla
    // y dejamos pasar, ese cobro ya está hecho y no se deshace solo. Las rutas de lectura
    // (-refresh, -history) siguen fallando abiertas a propósito: ahí equivocarse solo le
    // quita datos a alguien que sí paga. Aquí el error correcto es 503, no 403: no decimos
    // "no tienes suscripción" (no lo sabemos), decimos "no pudimos comprobarlo".
    await requireEntitlement(admin, userId, { failClosed: true });
    // Where SnapTrade's Connection Portal returns the user after "Done".
    const redirect = typeof body?.redirect === "string" && body.redirect ? body.redirect : undefined;
    const st = snaptrade();

    let profile = await loadProfile(admin, userId);
    let snapUserId = profile?.snaptrade_user_id ?? null;
    let userSecret = profile?.snaptrade_user_secret ?? null;

    // ── SnapTrade error helpers ────────────────────────────────────────────
    const _sd = (e: any) => e?.response?.data ?? e?.responseBody ?? e?.body ?? e?.data ?? null;
    const _detail = (e: any) => {
      const sd = _sd(e);
      return (((sd && (sd.detail ?? sd.message)) ?? e?.message ?? "") + "");
    };
    // Code 1010 = "User with the following userId already exist" (orphaned user:
    // SnapTrade has the user but we lost/never stored its secret).
    const _isAlreadyExists = (e: any) => {
      const sd = _sd(e);
      const code = (sd && typeof sd === "object") ? (sd.code ?? sd.status_code) : null;
      return String(code) === "1010" || /already exist/i.test(_detail(e));
    };
    // Stored secret unusable (signature/secret/user mismatch) → heal & retry login.
    //
    // ⚠ CUIDADO AL TOCAR ESTO. `healOrphan()` llama a deleteSnapTradeUser(), y eso BORRA
    // EN SNAPTRADE TODAS LAS CONEXIONES DE BROKER DEL USUARIO. Es irreversible desde aquí:
    // el usuario tiene que volver a pasar por el portal de cada broker. Sólo puede
    // dispararse cuando el secreto guardado está REALMENTE muerto.
    //
    // La versión anterior tenía `|invalid` suelto en la alternancia, y además `not found`
    // y `does not exist` sin sujeto. SnapTrade responde 400 con "Invalid ..." a errores de
    // validación que no tienen NADA que ver con el secreto — connectionType no soportado
    // por el broker, customRedirect no permitido en el proyecto, cuerpo mal formado — y
    // cualquiera de ellos borraba las conexiones del usuario. También matcheaba el
    // "not found" de un recurso cualquiera. Un error de validación NUESTRO no puede
    // costarle al usuario sus conexiones: ahora el mensaje tiene que hablar explícitamente
    // del secreto, de la firma o de la inexistencia DEL USUARIO.
    const _isAuthish = (e: any) => {
      const s = e?.response?.status ?? e?.status ?? 0;
      if (s !== 400 && s !== 401) return false;
      const d = _detail(e);
      const hit =
        /user\s?secret|usersecret/i.test(d) ||                                  // "userSecret is invalid"
        /signature|unable to verify/i.test(d) ||                                 // firma HMAC del SDK
        /secret[^.]{0,30}(invalid|incorrect|mismatch|expired)/i.test(d) ||
        /(invalid|incorrect|bad)[^.]{0,30}secret/i.test(d) ||
        /user[^.]{0,30}(does not exist|not found|no longer)/i.test(d) ||
        /no.?such.?user/i.test(d);
      if (hit) {
        // Se deja rastro: si esto aparece con un mensaje que no es de secreto muerto,
        // el regex se ha vuelto a abrir de más y hay que estrecharlo otra vez.
        console.warn("[snaptrade-connect] secreto inservible → se recrea el usuario y se PIERDEN las conexiones. detalle:", d.slice(0, 200));
      }
      return hit;
    };

    // Al sellar el enlace se guarda TAMBIÉN el momento (`snaptrade_connected_at`):
    // es el ancla de la ventana de gracia que usa snaptrade-cleanup cuando el
    // usuario aún no tiene fila en `subscriptions` (el webhook de la tienda puede
    // tardar). Y se borran los marcadores de una baja anterior, para que la UI no
    // siga mostrando "tu suscripción terminó" sobre una conexión ya viva.
    const persist = async (uid: string, secret: string) => {
      const { error } = await admin
        .from("profiles")
        .update({
          snaptrade_user_id: uid,
          snaptrade_user_secret: secret,
          snaptrade_connected_at: new Date().toISOString(),
          snaptrade_disconnected_reason: null,
          snaptrade_disconnected_at: null,
          snaptrade_cleanup_retry_count: 0,
        })
        .eq("id", userId);
      if (error) throw { status: 500, message: error.message };
    };
    const register = async () => {
      const reg = (await st.authentication.registerSnapTradeUser({ userId })).data as any;
      const uid = reg.userId ?? userId;
      const secret = reg.userSecret ?? null;
      if (!secret) throw { status: 502, message: "SnapTrade no devolvió userSecret." };
      await persist(uid, secret);
      snapUserId = uid; userSecret = secret;
    };
    // Recover an ORPHANED SnapTrade user: its secret can't be fetched back (SnapTrade
    // only returns it at creation), so delete the user and re-register to mint a fresh
    // secret we can store. Deletion is asynchronous on SnapTrade's side, so re-register
    // is retried with backoff until the old user clears.
    const healOrphan = async () => {
      try { await st.authentication.deleteSnapTradeUser({ userId }); } catch (_) { /* best-effort */ }
      let lastErr: any = null;
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, i < 2 ? 1500 : 2500));
        try { await register(); return; }
        catch (e) {
          lastErr = e;
          // Keep waiting only while SnapTrade still reports the user as existing/deleting.
          if (!_isAlreadyExists(e) && !/deleti|in progress|queued/i.test(_detail(e))) throw e;
        }
      }
      throw lastErr ?? { status: 502, message: "No se pudo re-registrar en SnapTrade." };
    };

    // Ensure we hold a usable (userId, secret).
    if (!snapUserId || !userSecret) {
      try { await register(); }
      catch (e) { if (_isAlreadyExists(e)) { await healOrphan(); } else throw e; }
    }

    // ── ¿Reconectar, añadir, o ya está conectado? ────────────────────────────────
    // Antes esto no existía: cada pulsación de "Conectar/Reconectar" abría el portal en
    // modo ALTA. Con una conexión ya viva, el portal lleva al usuario a crear un DUPLICADO
    // del mismo broker — el broker o SnapTrade lo rechazan y la pantalla vuelve igual que
    // estaba: "le doy a conectar y no conecta". Y con una conexión CAÍDA era todavía peor,
    // porque el arreglo real exige el parámetro `reconnect` con el id de esa conexión
    // (https://docs.snaptrade.com/docs/fix-broken-connections); sin él SnapTrade nunca
    // renueva el token de la conexión rota y el usuario se queda igual para siempre.
    //
    //   mode 'add'  → el usuario pidió explícitamente enlazar OTRO broker: alta normal.
    //   conexión deshabilitada → portal en modo `reconnect` (el único que la arregla).
    //   conexión sana          → no se abre nada: se responde alreadyConnected.
    const mode = typeof body?.mode === "string" ? body.mode : "";
    let conns: any[] = [];
    if (mode !== "add") {
      try {
        conns = ((await st.connections.listBrokerageAuthorizations({
          userId: snapUserId!, userSecret: userSecret!,
        })).data as any[]) ?? [];
      } catch (e: any) {
        console.warn("[snaptrade-connect] no se pudo listar conexiones:", _detail(e).slice(0, 200));
      }
    }
    // El cliente puede pedir una conexión CONCRETA ("Reconectar Fidelity" cuando hay dos
    // brokers caídos). Sin esto, find() cogía siempre la primera de la lista: el usuario
    // arreglaba esa y no tenía ninguna forma de llegar a la otra —el botón repetía el mismo
    // broker una y otra vez—. El id se valida contra SU propia lista y sólo vale si esa
    // conexión está de verdad deshabilitada: uno de fuera no abre nada.
    const askedId = typeof body?.connectionId === "string" ? body.connectionId : "";
    // Alias de broker → slug (ver BROKER_ALIASES arriba). Sin `broker` en el cuerpo, todo
    // sigue exactamente igual que antes: portal con su pantalla de selección.
    const brokerAlias = typeof body?.broker === "string" ? body.broker.trim().toLowerCase() : "";
    let brokerSlug: string | null = null;
    if (brokerAlias) {
      if (!Object.prototype.hasOwnProperty.call(BROKER_ALIASES, brokerAlias)) {
        return jsonResponse(req, { error: `Broker no reconocido: ${brokerAlias}` }, 400);
      }
      brokerSlug = BROKER_ALIASES[brokerAlias] || null;
      if (!brokerSlug) {
        // El alias es válido pero su slug no está configurado. Es un fallo NUESTRO de
        // despliegue, no del usuario, y se dice como tal: mandarlo al portal genérico sin
        // avisar le dejaría buscando IBKR en una lista larguísima sin saber por qué.
        console.error(`[snaptrade-connect] falta el secreto del slug para el alias '${brokerAlias}'`);
        return jsonResponse(req, { error: "broker_not_configured" }, 503);
      }
    }
    const disabledConn =
      (askedId ? conns.find((c: any) => c?.id === askedId && c?.disabled === true) : null) ??
      conns.find((c: any) => c?.disabled === true && c?.id) ?? null;
    const liveConn = conns.find((c: any) => c && c.disabled !== true && c.id) ?? null;

    if (mode !== "add" && !disabledConn && liveConn) {
      // Ya hay broker enlazado y sano. Mandarlo al portal no arregla nada; lo que quiere
      // es ver sus datos al día, y de eso se encarga snaptrade-refresh con force.
      await admin
        .from("profiles")
        .update({ snaptrade_connection_id: liveConn.id, snaptrade_connection_broken: false })
        .eq("id", userId);
      return jsonResponse(req, {
        alreadyConnected: true,
        connectionId: liveConn.id,
        brokerage: liveConn?.brokerage?.name ?? liveConn?.brokerage?.slug ?? null,
      });
    }
    const reconnectId: string | null = disabledConn?.id ?? null;
    if (reconnectId) {
      await admin
        .from("profiles")
        .update({ snaptrade_connection_id: reconnectId, snaptrade_connection_broken: true })
        .eq("id", userId);
    }

    // Generate a fresh Connection Portal link (read-only). If the stored secret is
    // stale (auth failure), heal once and retry.
    const doLogin = async (withReconnect = !!reconnectId) => {
      const l = (await st.authentication.loginSnapTradeUser({
        userId: snapUserId!,
        userSecret: userSecret!,
        // Prefer read-only where the broker supports it; fall back to the broker's
        // standard connection otherwise. Forcing "read" makes SnapTrade's portal throw
        // "Unexpected Error" for brokers that don't offer a pure read-only connection.
        // Portiv still only READS data — it never places trades.
        // IBKR no ofrece trading vía SnapTrade. NO se le manda "read" a secas: la doc del
        // SDK dice que "trade-if-available" cae automáticamente a solo-lectura cuando el
        // broker no soporta trading, que es justo este caso, y forzar "read" es lo que
        // hacía reventar el portal para otros brokers (ver arriba). Si alguna vez se
        // comprueba con una conexión IBKR real que esta combinación falla, el arreglo es
        // enviar "read" SÓLO cuando `brokerSlug` sea el de IBKR — nunca cambiar el global.
        connectionType: "trade-if-available",
        // Salta la pantalla de selección y entra directo al flujo de ese broker.
        // `broker` NO se manda junto a `reconnect`: reconectar ya sabe de qué conexión —y por
        // tanto de qué broker— se trata, y mandar los dos es una petición contradictoria que
        // SnapTrade rechaza con 400 (comprobado). Hoy no coinciden nunca desde el cliente (el
        // botón de IBKR va en modo 'add', que ni siquiera lista conexiones), pero el 400
        // sería mudo y el usuario sólo vería que "no conecta": se descarta aquí.
        ...(brokerSlug && !(withReconnect && reconnectId) ? { broker: brokerSlug } : {}),
        ...(redirect ? { customRedirect: redirect } : {}),
        // El portal entra directo al flujo de reconexión de ESA conexión y renueva su token.
        ...(withReconnect && reconnectId ? { reconnect: reconnectId } : {}),
      } as any)).data as any;
      // The SDK model field is `redirectURI` (some versions: `redirectUri`).
      return l?.redirectURI ?? l?.redirectUri ?? null;
    };
    let redirectURI: string | null = null;
    try { redirectURI = await doLogin(); }
    catch (e) {
      if (_isAuthish(e)) {
        await healOrphan();
        // healOrphan() BORRA el usuario en SnapTrade y crea uno nuevo: con el viejo se fueron
        // TODAS sus autorizaciones, así que `reconnectId` apunta a una conexión que ya no
        // existe. Reintentar el login con ese `reconnect` era pedirle a SnapTrade que reparase
        // algo inexistente → error. Y este brazo, a diferencia del de abajo, no tenía plan B:
        // el usuario recibía el mismo fallo en CADA pulsación de "Reconectar", sin ninguna
        // salida dentro de la app. Tras recrear el usuario el único flujo válido es el alta.
        await admin
          .from("profiles")
          .update({ snaptrade_connection_id: null, snaptrade_connection_broken: false })
          .eq("id", userId);
        redirectURI = await doLogin(false);
      }
      else if (reconnectId) {
        // La conexión a reconectar puede haber desaparecido en SnapTrade (el usuario la
        // borró desde el broker, o se depuró). Reintentar como alta normal es mejor que
        // devolverle un error a alguien que sólo quiere volver a enlazar su cuenta.
        console.warn("[snaptrade-connect] reconnect falló, se reintenta como alta:", _detail(e).slice(0, 200));
        redirectURI = await doLogin(false);
      }
      else throw e;
    }
    if (!redirectURI) {
      return jsonResponse(req, { error: "SnapTrade no devolvió redirectURI." }, 502);
    }

    return jsonResponse(req, { redirectURI, mode: reconnectId ? "reconnect" : "new" });
  } catch (e: any) {
    // Surface the REAL SnapTrade error (the SDK hides it behind an axios
    // "Request failed with status code 400" message). The useful detail lives in
    // the response body: check every field the SDK/axios might use.
    const sd = e?.response?.data ?? e?.responseBody ?? e?.body ?? e?.data ?? null;
    const detail =
      (sd && typeof sd === "object" ? (sd.detail ?? sd.message ?? JSON.stringify(sd))
       : (typeof sd === "string" ? sd : null)) ?? null;
    const code = (sd && typeof sd === "object") ? (sd.code ?? sd.status_code ?? null) : null;
    const status = e?.response?.status ?? e?.status ?? (sd ? 502 : 500);
    const message = detail ?? e?.message ?? String(e) ?? "Error desconocido";
    console.error("[snaptrade-connect] fail", JSON.stringify({ status, code, detail, raw: e?.message }));
    return jsonResponse(req, { error: message, detail, code }, status);
  }
});
