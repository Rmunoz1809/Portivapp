// snaptrade-refresh — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Serves the user's holdings. COST-OPTIMIZED: never triggers a paid manual sync.
// It only READS the data SnapTrade already synced in its free daily cycle.
//
//  • 60-minute cache: if snaptrade_last_refresh is < 60 min old, returns the
//    cached snaptrade_holdings without touching SnapTrade (saves rate-limited
//    read calls; the "Actualizar" button hits this and serves cache all day).
//  • On cache miss: rebuilds holdings from the per-account READ endpoints
//    (getUserAccountPositions + getUserAccountBalance) — the old aggregate
//    getAllUserHoldings/getUserHoldings endpoints are DEPRECATED (HTTP 410). These
//    are included reads, not a paid sync. Persists the result + stamps last_refresh.
//  • Captures the primary snaptrade_account_id on first success (needed by
//    snaptrade-history).
//
//  • `force: true` (botón "Sincronizar ahora") SALTA la caché y, si hace falta, pide a
//    SnapTrade una sincronización real con el broker. Ver el bloque SINCRONIZACIÓN MANUAL.
//
// Request  (POST): { userId?: string, force?: boolean }
// Response (200):  { holdings, accountId, connected, fromCache, lastSync, syncQueued, disabled }

import { preflight, jsonResponse } from "../_shared/cors.ts";
import {
  snaptrade,
  adminClient,
  requireUser,
  loadProfile,
  isEntitled,
} from "../_shared/snaptrade.ts";

const CACHE_MS = 60 * 60 * 1000; // 60 minutes

// ── SINCRONIZACIÓN MANUAL (facturada) ────────────────────────────────────────────
// Las conexiones con `data_freshness_mode: "delayed"` (nuestro plan) sólo refrescan sus
// posiciones UNA VEZ AL DÍA. Comprobado en producción: una compra del día 29 no aparecía
// en SnapTrade el día 31 — no era un fallo nuestro de lectura, es que SnapTrade todavía
// no había vuelto a preguntarle al broker. La única palanca es
// connections.refreshBrokerageAuthorization, que SnapTrade FACTURA por llamada.
//
// Por eso: sólo a petición explícita del usuario (`force`), sólo si los datos que ya
// tenemos son viejos (STALE_MS) y como mucho una vez cada MANUAL_SYNC_MIN_MS por usuario.
// El límite vive en el servidor: el cliente podría pulsar el botón en bucle.
const MANUAL_SYNC_MIN_MS = 30 * 60 * 1000; // 1 sincronización facturada / 30 min / usuario
const STALE_MS = 15 * 60 * 1000;           // datos con < 15 min no se pagan por refrescar

/** Best-effort extraction of the primary account id from a holdings payload. */
function primaryAccountId(holdings: any): string | null {
  const arr = Array.isArray(holdings) ? holdings : holdings?.accounts ?? [];
  for (const h of arr) {
    const id = h?.account?.id ?? h?.account_id ?? h?.id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* optional */ }

    const userId = await requireUser(req, admin, body?.userId);
    const force = body?.force === true;   // el usuario pulsó "Sincronizar ahora"
    const entitled = await isEntitled(admin, userId);
    const profile = await loadProfile(admin, userId);
    const reason = profile?.snaptrade_disconnected_reason ?? null;

    // No active subscription → do NOT serve broker data, and tell the client WHY so the
    // UI can show "Tu prueba terminó — suscríbete para reconectar" (reason stamped by
    // snaptrade-cleanup) instead of the generic "nunca conectaste". Soft check (no throw)
    // so the client renders a clean state rather than catching a 403.
    if (!entitled) {
      // ⚠ El `|| "subscription_inactive"` de antes se aplicaba a TODO el mundo sin
      // suscripción activa, incluidos los que NUNCA conectaron un broker. El cliente
      // lo traduce con _isSubReason() a "Cerramos la conexión con tu broker porque tu
      // suscripción terminó", así que un usuario recién registrado, que jamás tuvo
      // broker, leía que le habíamos cerrado una conexión inexistente — y encima con
      // un CTA de "Reactivar suscripción" en lugar del de conectar. `reason` sólo lo
      // sella snaptrade-cleanup cuando desconecta DE VERDAD; si no hay reason ni
      // rastro alguno de una conexión pasada, no hay nada que explicar.
      const everConnected = !!(
        profile?.snaptrade_user_id ||
        profile?.snaptrade_connected_at ||
        profile?.snaptrade_disconnected_at
      );
      return jsonResponse(req, {
        connected: false,
        entitled: false,
        neverConnected: !everConnected,
        disconnectedReason: reason || (everConnected ? "subscription_inactive" : null),
        holdings: null,
        accountId: null,
        fromCache: false,
      });
    }

    // Entitled but no SnapTrade user yet → not connected. Frontend shows "Conectar broker".
    if (!profile?.snaptrade_user_id || !profile?.snaptrade_user_secret) {
      return jsonResponse(req, {
        connected: false,
        entitled: true,
        disconnectedReason: null,
        holdings: null,
        accountId: null,
        fromCache: false,
      });
    }

    // ── Serve from cache if fresh (respects rate limits, zero SnapTrade calls) ──
    const last = profile.snaptrade_last_refresh
      ? new Date(profile.snaptrade_last_refresh).getTime()
      : 0;
    const fresh = last && Date.now() - last < CACHE_MS;
    // `force` = el usuario pulsó el botón. Servirle la caché entonces era exactamente el
    // bug del que se quejaba: pulsar "Actualizar" no movía una sola cifra durante una hora
    // aunque su broker ya tuviera la operación.
    if (!force && fresh && profile.snaptrade_holdings != null) {
      return jsonResponse(req, {
        connected: true,
        broken: !!profile.snaptrade_connection_broken,
        holdings: profile.snaptrade_holdings,
        accountId: profile.snaptrade_account_id,
        fromCache: true,
      });
    }

    // ── Cache miss → read SnapTrade (included daily-synced data, never a paid sync) ──
    const st = snaptrade();
    const sid = {
      userId: profile.snaptrade_user_id,
      userSecret: profile.snaptrade_user_secret,
    };

    // ── Estado REAL de la conexión ────────────────────────────────────────────────
    // Una conexión DESHABILITADA sigue devolviendo posiciones: SnapTrade responde con el
    // último estado cacheado, sin error. Así que un usuario cuya conexión se cae (cambió la
    // contraseña del broker, caducó la sesión, revocó el acceso) veía cifras de aspecto
    // normal congeladas para siempre, y `snaptrade_connection_broken` seguía en false porque
    // el webhook CONNECTION_BROKEN era el ÚNICO camino por el que nos enterábamos — si ese
    // evento se perdía, nadie volvía a preguntar. Ahora se comprueba en cada lectura.
    let conns: any[] = [];
    try {
      conns = ((await st.connections.listBrokerageAuthorizations(sid)).data as any[]) ?? [];
    } catch (e: any) {
      console.warn("[snaptrade-refresh] listBrokerageAuthorizations falló:",
        (e?.response?.data?.detail ?? e?.message ?? String(e)).toString().slice(0, 200));
    }
    const conn =
      conns.find((c: any) => c?.id && c.id === profile.snaptrade_connection_id) ??
      conns.find((c: any) => !c?.disabled) ??
      conns[0] ?? null;
    const anyLive = conns.some((c: any) => c && c.disabled !== true);
    const allDisabled = conns.length > 0 && !anyLive;

    // La conexión que el perfil tenía apuntada puede haber cambiado (reconexión, alta nueva,
    // webhook perdido). Se re-apunta sola: snaptrade-connect necesita este id para el modo
    // `reconnect`, y sin él la reconexión degenera en "añadir otra conexión" y no arregla nada.
    if (conn?.id && conn.id !== profile.snaptrade_connection_id) {
      await admin.from("profiles").update({ snaptrade_connection_id: conn.id }).eq("id", userId);
    }

    if (allDisabled) {
      // Se sirven las ÚLTIMAS posiciones conocidas (mejor que una pantalla vacía) pero
      // marcadas como rotas y viejas, para que la UI pida reconectar en vez de dejar que
      // el usuario tome decisiones con una foto de hace días creyéndola de hoy.
      await admin
        .from("profiles")
        .update({ snaptrade_connection_broken: true })
        .eq("id", userId);
      return jsonResponse(req, {
        connected: true,
        broken: true,
        disabled: true,
        stale: true,
        disabledSince: conn?.disabled_date ?? null,
        holdings: profile.snaptrade_holdings ?? null,
        accountId: profile.snaptrade_account_id ?? null,
        lastSync: profile.snaptrade_last_refresh ?? null,
        fromCache: true,
      });
    }

    // Does a holdings array actually carry REAL data (positions, options, or cash)?
    // The aggregate endpoint can return an account object with empty positions for a
    // few minutes after connecting — that must count as "still syncing", not a live "$0".
    const carriesData = (arr: any[]): boolean =>
      Array.isArray(arr) && arr.some((h) => {
        const pos = h?.positions ?? [];
        const opt = h?.option_positions ?? h?.optionPositions ?? [];
        const bals = h?.balances ?? h?.balance ?? [];
        const cash = Array.isArray(bals)
          ? bals.reduce((s: number, b: any) => s + Number(b?.cash ?? b?.amount ?? 0), 0)
          : Number(bals?.cash ?? 0);
        const total = Number(
          h?.account?.balance?.total?.amount ??
            h?.account?.balance?.total ??
            h?.total_value?.value ??
            0,
        );
        return (Array.isArray(pos) && pos.length > 0) ||
          (Array.isArray(opt) && opt.length > 0) ||
          (Number.isFinite(cash) && cash !== 0) ||
          (Number.isFinite(total) && total !== 0);
      });

    // ── DEFINITIVE FIX ──────────────────────────────────────────────────────────
    // SnapTrade DEPRECATED the aggregate holdings endpoints: getAllUserHoldings AND
    // getUserHoldings now return HTTP 410 (Gone). That is why the app sat on
    // "Sincronizando…" forever — the old code called a dead endpoint, caught the
    // error, and always saw empty holdings even though the account was fully synced.
    //
    // listUserAccounts is the only holdings-adjacent endpoint that still works. We
    // rebuild the holdings array from the LIVE per-account reads (all included READs,
    // never a paid sync) in the exact shape the client's snapMapHoldings expects:
    //   getUserAccountPositions   → GET /accounts/{id}/positions   (positions)
    //   getUserAccountBalance     → GET /accounts/{id}/balances    (cash)
    //   options.listOptionHoldings→ option positions (best-effort)
    // El catch de aquí era `catch { accts = []; }` a secas, y esa igualación entre "SnapTrade
    // respondió que no hay cuentas" y "SnapTrade no respondió" era el bug: un 429, un 5xx o un
    // timeout salían por la misma puerta que un usuario sin broker, el endpoint devolvía
    // needsConnection:true y el cliente borraba `pv_broker_*` y pintaba el cartel de "Conecta
    // tu broker" a alguien que ACABA de conectarlo — y sin reintento, porque el poll solo se
    // reagenda con `connected && syncing`. Un 429 al volver del portal dejaba el onboarding
    // muerto hasta relanzar la app. Ahora el fallo de transporte se reporta como tal.
    let accts: any[] = [];
    let acctsErr: unknown = null;
    try {
      accts = ((await st.accountInformation.listUserAccounts(sid)).data as any[]) ?? [];
    } catch (e) { acctsErr = e; accts = []; }

    // ── Cuentas cerradas ────────────────────────────────────────────────────────────
    // SnapTrade sigue listando las cuentas cerradas y archivadas: iterarlas gasta lecturas y
    // mete en la cartera un $0 de algo que el usuario ya no tiene. `status` es opcional y sus
    // valores son 'open' | 'closed' | 'archived' | 'unavailable' — 'unavailable' NO significa
    // cerrada, significa que el broker no supo decirlo, así que sólo se filtra lo explícito:
    // filtrar de más deja al usuario sin una cuenta VIVA, que es peor que enseñarle una
    // cerrada a $0. Y si TODAS quedaran filtradas no se filtra ninguna: dejar `accts` vacío
    // convertiría al usuario en needsConnection y el cliente borraría pv_broker_* para
    // pintarle el cartel de captación a alguien que SÍ tiene un broker enlazado.
    let closedAccounts = 0;
    if (accts.length > 0) {
      const open = accts.filter((a: any) => {
        const s = String(a?.status ?? "").toLowerCase();
        return s !== "closed" && s !== "archived";
      });
      if (open.length > 0 && open.length < accts.length) {
        closedAccounts = accts.length - open.length;
        console.warn(
          `[snaptrade-refresh] ${closedAccounts}/${accts.length} cuenta(s) cerrada(s)/archivada(s) filtrada(s)`,
        );
        accts = open;
      }
    }
    const hasAccount = Array.isArray(accts) && accts.length > 0;

    // Earliest real inception across accounts (SnapTrade's first_transaction_date). The
    // client clamps its Yahoo reconstruction to this so it never projects current shares
    // to before the account existed (that caused a fake +34% "ALL" on first render).
    let inceptionDate: string | null = null;
    for (const a of accts) {
      const d = a?.sync_status?.transactions?.first_transaction_date;
      if (typeof d === "string" && d && (!inceptionDate || d < inceptionDate)) inceptionDate = d;
    }

    // Cuándo fue la última vez que SnapTrade habló DE VERDAD con el broker. Es el dato que
    // le faltaba al usuario: la app decía "Sincronizado ahora mismo" cuando lo único reciente
    // era nuestra propia lectura de una foto de ayer.
    //
    // Se toma el MÍNIMO, no el máximo. Con Schwab sincronizado hace 2 minutos e IBKR hace 3
    // días, quedarse con el más reciente hacía que _snapSyncLabel() pintara "Datos de tu
    // broker de hace un momento" y el usuario tomaba decisiones sobre una cartera cuya mitad
    // tenía tres días. La antigüedad honesta del conjunto es la de su cuenta MÁS VIEJA.
    // (Ojo: `inceptionDate`, arriba, SÍ es un mínimo por otro motivo y ya estaba bien.)
    let lastSync: string | null = null;
    let accountsWithoutSync = 0;
    for (const a of accts) {
      const s = a?.sync_status?.holdings?.last_successful_sync;
      if (typeof s === "string" && s) {
        if (!lastSync || s < lastSync) lastSync = s;
      } else {
        // Una cuenta sin marca de sync no debe hacer parecer fresco al conjunto: no sabemos
        // de cuándo son sus datos, así que se declara aparte en vez de ignorarla.
        accountsWithoutSync++;
      }
    }

    // ── ¿Terminó la sincronización INICIAL de todas las cuentas? ─────────────────────
    // Hoy `syncing` se deduce heurísticamente ("hay cuenta pero no hay datos → estará
    // sincronizando"). Para una cuenta real a $0 —recién abierta o liquidada— eso nunca deja
    // de ser cierto: la tarjeta se queda en "Sincronizando…" para siempre, el cliente agota
    // sus 14 reintentos de historial y _BROKER_HISTORY_PENDING bloquea el gráfico.
    // `initial_sync_completed` es el dato autoritativo. Si llega `undefined` (broker que no
    // lo reporta) se trata como false → comportamiento de siempre. NUNCA asumir `true` por
    // ausencia: eso convertiría un sync en curso en "cartera vacía" y pondría el portafolio
    // a $0 al conectar, que es exactamente el bug que documenta el Bloque 4 del cliente.
    const allInitialSyncDone = accts.length > 0 &&
      accts.every((a: any) => a?.sync_status?.holdings?.initial_sync_completed === true);

    // ── Rotura PARCIAL de conexión ──────────────────────────────────────────────────
    // `allDisabled` (arriba) sólo salta si se caen TODAS. Con dos brokers y uno caído seguía
    // en false, el flujo continuaba normal y las cuentas del broker muerto SEGUÍAN devolviendo
    // datos: una conexión deshabilitada sirve su último estado cacheado sin error. Resultado:
    // cifras congeladas mezcladas con cifras vivas bajo la etiqueta "Conectado", sin un aviso.
    // No se deja de servir esas posiciones —el dato viejo es mejor que una pantalla vacía—:
    // lo que faltaba era DECIR que es viejo y de qué broker.
    const staleConnections = conns
      .filter((c: any) => c?.disabled === true)
      .map((c: any) => ({
        id: c?.id ?? null,
        name: c?.brokerage?.name ?? c?.name ?? null,
        disabledSince: c?.disabled_date ?? null,
        accounts: accts.filter((a: any) => a?.brokerage_authorization === c?.id).length,
      }));

    // ── Sincronización manual (ver cabecera): sólo con `force`, sólo si hace falta ──
    let syncQueued = false;
    let syncThrottled = false;
    if (force && conn?.id && conn?.disabled !== true) {
      const realtime = /real/i.test(String(conn?.data_freshness_mode ?? ""));
      // `lastSync` es ahora el de la cuenta MÁS VIEJA (ver arriba), así que esto mide "¿le
      // queda a alguna cuenta dato viejo?" y no "¿está fresca la más reciente?". Es lo que el
      // usuario quiere decir al pulsar el botón: con Schwab de hace 2 min e IBKR de hace 3
      // días, el criterio anterior concluía "acaban de sincronizar" y no refrescaba nada.
      // El gasto sigue acotado por MANUAL_SYNC_MIN_MS, que no se toca.
      const syncAge = lastSync ? Date.now() - new Date(lastSync).getTime() : Infinity;
      const lastManual = profile.snaptrade_last_manual_sync
        ? new Date(profile.snaptrade_last_manual_sync).getTime()
        : 0;
      const throttleLeft = lastManual ? MANUAL_SYNC_MIN_MS - (Date.now() - lastManual) : 0;
      if (realtime || !(syncAge > STALE_MS)) {
        // Conexión en tiempo real, o SnapTrade acaba de sincronizar: pagar no traería
        // ni un dato nuevo. La lectura de abajo ya devuelve lo último.
      } else if (throttleLeft > 0) {
        syncThrottled = true;
      } else {
        try {
          await (st as any).connections.refreshBrokerageAuthorization({
            authorizationId: conn.id,
            ...sid,
          });
          syncQueued = true;
          await admin
            .from("profiles")
            .update({ snaptrade_last_manual_sync: new Date().toISOString() })
            .eq("id", userId);
          // SnapTrade encola el sync y avisa por webhook (ACCOUNT_HOLDINGS_UPDATED, que
          // invalida la caché). Esta espera corta basta para que muchos brokers ya
          // devuelvan lo nuevo en la lectura de abajo; si no, el cliente reintenta.
          await new Promise((r) => setTimeout(r, 6000));
        } catch (e: any) {
          console.warn("[snaptrade-refresh] refreshBrokerageAuthorization falló:",
            (e?.response?.data?.detail ?? e?.message ?? String(e)).toString().slice(0, 200));
        }
      }
    }

    const ai: any = st.accountInformation;

    // ── Una cuenta que no responde NO es una cuenta vacía ─────────────────────────
    // Los `catch { /* not ready yet */ }` mudos de antes emitían esa cuenta con
    // positions:[] y balances:[]. Con más de una cuenta el resultado pasaba igualmente
    // el filtro carriesData (gracias a las que SÍ respondieron), así que esa foto
    // TRUNCADA se guardaba en profiles.snaptrade_holdings y se sellaba last_refresh:
    // el usuario veía su cartera sin una cuenta entera —o sin su efectivo— durante los
    // 60 minutos siguientes, con el total y el donut cuadrando entre ellos y con la
    // realidad no, y sin un solo aviso. Un 429 puntual bastaba. Ahora cada lectura
    // reintenta una vez y, si vuelve a fallar, la cuenta se cuenta como ROTA.
    const readAcct = async (fn: () => Promise<any>): Promise<{ ok: boolean; data: any[] }> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return { ok: true, data: (await fn()).data ?? [] }; }
        catch (e) {
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
          console.warn("[snaptrade-refresh] lectura de cuenta falló:",
            ((e as any)?.response?.data?.detail ?? (e as any)?.message ?? String(e)).toString().slice(0, 160));
        }
      }
      return { ok: false, data: [] };
    };

    let holdings: any[] = [];
    let brokenAccounts = 0;
    for (const a of accts) {
      const accountId = a?.id ?? a?.account_id;
      if (!accountId) continue;
      const pos = await readAcct(() => ai.getUserAccountPositions({ ...sid, accountId }));
      const bal = await readAcct(() => ai.getUserAccountBalance({ ...sid, accountId }));
      let optionPositions: any[] = [];
      // Las opciones sí son best-effort: el cliente no las valora, sólo las declara aparte.
      try { optionPositions = (await (st as any).options.listOptionHoldings({ ...sid, accountId })).data ?? []; } catch { /* optional */ }
      if (!pos.ok || !bal.ok) brokenAccounts++;
      const total = a?.balance?.total?.amount ?? a?.balance?.total ?? null;
      holdings.push({
        account: { id: accountId, ...(total != null ? { balance: { total } } : {}) },
        balances: bal.data,
        positions: pos.data,
        option_positions: optionPositions,
      });
    }
    const holdArr = holdings;

    // Foto incompleta → jamás se persiste ni se sirve como si fuera la cartera entera.
    if (brokenAccounts > 0) {
      console.error(
        `[snaptrade-refresh] ${brokenAccounts}/${accts.length} cuenta(s) sin responder — no se persiste la foto parcial`,
      );
      if (profile.snaptrade_holdings != null) {
        // La última foto COMPLETA conocida, marcada como vieja: mejor un dato entero de hace
        // un rato que uno de ahora al que le falta una cuenta.
        return jsonResponse(req, {
          connected: true,
          broken: !!profile.snaptrade_connection_broken,
          holdings: profile.snaptrade_holdings,
          accountId: profile.snaptrade_account_id ?? null,
          inceptionDate,
          lastSync: lastSync ?? profile.snaptrade_last_refresh ?? null,
          stale: true,
          partial: true,
          staleConnections,
          accountsWithoutSync,
          closedAccounts,
          fromCache: true,
        });
      }
      // Sin foto previa no hay nada íntegro que servir. `unavailable` = el cliente conserva
      // su estado local y reintenta con backoff (nunca borra pv_broker_* ni pinta el CTA).
      return jsonResponse(req, {
        connected: false,
        needsConnection: false,
        unavailable: true,
        holdings: null,
        accountId: null,
        fromCache: false,
      });
    }

    const hasHoldings = carriesData(holdArr);

    if (!hasHoldings) {
      if (!hasAccount) {
        // No sabemos si tiene broker: la llamada falló. NO es needsConnection.
        // `unavailable` le dice al cliente: conserva el estado local y vuelve a intentar.
        if (acctsErr) {
          const d = (acctsErr as any);
          const st2 = d?.response?.status ?? d?.status ?? 0;
          console.error("[snaptrade-refresh] listUserAccounts falló:", st2,
            (d?.response?.data?.detail ?? d?.message ?? String(acctsErr)).toString().slice(0, 200));
          return jsonResponse(req, {
            connected: false,
            needsConnection: false,
            unavailable: true,          // ← el cliente NO debe borrar pv_broker_* ni parar el poll
            upstreamStatus: st2 || null,
            holdings: null,
            accountId: null,
            fromCache: false,
          });
        }
        // Registered on SnapTrade but NO broker linked yet → not broken; needs to connect.
        return jsonResponse(req, {
          connected: false,
          needsConnection: true,
          holdings: null,
          accountId: null,
          fromCache: false,
        });
      }
      // A brokerage account exists but holdings are still empty → the INITIAL SYNC is
      // running. SnapTrade pulls holdings asynchronously after CONNECTION_ADDED (usually
      // 1–2 min, sometimes more). Report `syncing` so the client shows "Sincronizando…"
      // and keeps polling. Only a webhook-confirmed break is reported as genuinely broken.
      //
      // …salvo que SnapTrade ya haya dado por terminada la sincronización inicial de TODAS
      // las cuentas: entonces el vacío es un dato real (cuenta recién abierta o liquidada) y
      // no un sync en curso. `settled` se lo dice al cliente, cuya lógica `_settled` en
      // snapRefresh ya sabe aplicar una cartera vacía de verdad.
      const brokenFlag = !!profile.snaptrade_connection_broken;
      const settled = allInitialSyncDone && !brokenFlag;
      return jsonResponse(req, {
        connected: true,
        broken: brokenFlag,
        syncing: !brokenFlag && !allInitialSyncDone,
        settled,
        holdings: holdArr,
        accountId: profile.snaptrade_account_id ?? null,
        inceptionDate,
        lastSync,
        staleConnections,
        accountsWithoutSync,
        closedAccounts,
        syncQueued,
        syncThrottled,
        fromCache: false,
      });
    }

    // ── Have holdings → success. Resolve primary account id + clear any broken flag. ──
    let accountId = profile.snaptrade_account_id ?? primaryAccountId(holdings);
    if (!accountId && Array.isArray(accts) && accts[0]) {
      accountId = accts[0].id ?? accts[0].account_id ?? null;
    }

    const { error } = await admin
      .from("profiles")
      .update({
        snaptrade_holdings: holdings,
        snaptrade_last_refresh: new Date().toISOString(),
        snaptrade_connection_broken: false, // got live data → connection healthy
        // Live data means they're connected & paying again → clear any prior
        // "trial vencido" disconnect marker so refresh stops reporting it.
        snaptrade_disconnected_reason: null,
        snaptrade_disconnected_at: null,
        ...(accountId ? { snaptrade_account_id: accountId } : {}),
      })
      .eq("id", userId);
    if (error) return jsonResponse(req, { error: error.message }, 500);

    return jsonResponse(req, {
      connected: true,
      broken: false,
      holdings,
      accountId,
      inceptionDate,
      lastSync,
      staleConnections,
      accountsWithoutSync,
      closedAccounts,
      syncQueued,
      syncThrottled,
      fromCache: false,
    });
  } catch (e: any) {
    const status = e?.status ?? 500;
    const message = e?.message ?? e?.responseBody?.detail ?? String(e);
    return jsonResponse(req, { error: message }, status);
  }
});
