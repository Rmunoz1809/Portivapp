// snaptrade-activities — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Flujos de efectivo EXTERNOS de la cartera: lo que el usuario ha metido y sacado.
//
// Para qué hace falta. El valor de la cartera sube por dos motivos que no se parecen en
// nada: porque tus inversiones han ido bien, o porque has ingresado más dinero. Sin
// separar lo segundo, cualquier "rendimiento" que enseñemos es mentira —alguien que mete
// 1.000 € al mes ve una curva preciosa que no dice nada de si invierte bien o mal.
// getAccountActivities es la única fuente de SnapTrade que distingue las dos cosas.
//
// Qué cuenta como flujo (y qué NO):
//   CONTRIBUTION / WITHDRAWAL → SÍ. Dinero que entra o sale de la cuenta por decisión tuya.
//   DIVIDEND, INTEREST, FEE, TAX, BUY, SELL… → NO. Son el RESULTADO de invertir, no
//     aportaciones. Meter un dividendo en "lo que has aportado" hundiría tu rendimiento
//     justo por haber cobrado el dividendo.
//   TRANSFER / EXTERNAL_ASSET_TRANSFER_IN|OUT → NO se suman, pero SÍ se declaran aparte.
//     Traspasar una cartera de 50.000 € desde otro broker mueve tu patrimonio igual que
//     una aportación, pero no llega como efectivo. Ignorarlo en silencio convertiría ese
//     traspaso en un "+50.000 € de beneficio". Se cuenta y se avisa; inventar su valor en
//     efectivo, no.
//
// El campo `type` NO es un enum cerrado —la doc de SnapTrade dice literalmente "some of the
// most popular values"—, así que cualquier tipo desconocido con importe se acumula en
// `unknownTypes` en vez de desaparecer. Si mañana un broker emite `ACH_DEPOSIT`, saldrá en
// la respuesta y lo veremos, en lugar de faltar dinero sin que nadie se entere.
//
//  • Caché DIARIA: getAccountActivities sirve datos diarios (SnapTrade los refresca una vez
//    al día), así que volver a pedirlos el mismo día no trae una fila nueva. Se guarda ya
//    agregado, no en crudo: años de historial en `profiles` son megabytes por usuario.
//
//  • Las cuentas CERRADAS **no** se filtran aquí, al revés que en refresh/history. Una
//    cuenta cerrada no tiene posiciones que enseñar, pero el dinero que metiste y sacaste
//    de ella es parte de tu historial real. Filtrarla haría desaparecer aportaciones y
//    dispararía el rendimiento calculado.
//
// Request  (POST): { userId?: string, force?: boolean, startDate?: string, endDate?: string }
// Response (200):  { available, reason?, currencies, byMonth, transfers, unknownTypes,
//                    signMismatches, undated, unusable, truncated, partial, accounts,
//                    accountsMissing, updatedAt, fromCache }
// Response (4xx/5xx): { available:false, reason:"error", error } — al contrario que
//   snaptrade-history, aquí un fallo NO se disfraza de 200: la gráfica aguanta un hueco,
//   pero una cifra de aportaciones sin garantías no se enseña como si la tuviera.

import { preflight, jsonResponse } from "../_shared/cors.ts";
import {
  snaptrade,
  adminClient,
  requireUser,
  loadProfile,
  requireEntitlement,
} from "../_shared/snaptrade.ts";

const todayUTC = () => new Date().toISOString().slice(0, 10);

// Sólo estos dos son flujo externo de efectivo. Ver la cabecera: la lista corta es
// deliberada, no un olvido.
const IN_TYPES = new Set(["CONTRIBUTION"]);
const OUT_TYPES = new Set(["WITHDRAWAL"]);
// Mueven patrimonio pero no efectivo → se declaran, no se suman.
const TRANSFER_TYPES = new Set([
  "TRANSFER",
  "EXTERNAL_ASSET_TRANSFER_IN",
  "EXTERNAL_ASSET_TRANSFER_OUT",
]);
// Actividad INTERNA de la cartera: ni entra ni sale dinero del bolsillo del usuario. Se
// enumeran para poder distinguir "tipo conocido que no es flujo" de "tipo que no habíamos
// visto nunca" — sin esta lista, todo lo que no fuera aportación caería en `unknownTypes`
// y el aviso perdería todo su valor.
const INTERNAL_TYPES = new Set([
  "BUY", "SELL", "DIVIDEND", "REI", "STOCK_DIVIDEND", "INTEREST", "FEE", "TAX",
  "OPTIONEXPIRATION", "OPTIONASSIGNMENT", "OPTIONEXERCISE", "SPLIT", "ADJUSTMENT",
]);

const PAGE = 1000;      // máximo que admite el endpoint
const MAX_PAGES = 20;   // 20.000 movimientos por cuenta; más que eso se marca `truncated`
const CONCURRENCY = 4;  // mismo techo que snaptrade-refresh: rate limits por clientId

type Bucket = { in: number; out: number; net: number };
const emptyBucket = (): Bucket => ({ in: 0, out: 0, net: 0 });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method Not Allowed" }, 405);

  const admin = adminClient();

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* optional */ }

    const userId = await requireUser(req, admin, body?.userId);
    // Camino de LECTURA: fail-open por defecto, igual que refresh/history. Esta función no
    // crea ningún recurso facturable en SnapTrade, así que un fallo del RPC de entitlement
    // no debe dejar sin sus datos a alguien que sí paga.
    await requireEntitlement(admin, userId);
    const profile = await loadProfile(admin, userId);

    if (!profile?.snaptrade_user_id || !profile?.snaptrade_user_secret) {
      return jsonResponse(req, { available: false, reason: "not_connected" });
    }

    // ── Caché diaria ──────────────────────────────────────────────────────────
    // Con consulta propia y NO desde loadProfile: ese select viaja dentro de todas las
    // funciones snaptrade, así que meterle esta columna las rompería todas a la vez si la
    // migración aún no está aplicada. Aquí, si la columna no existe, se pierde la caché y
    // nada más: la función sigue devolviendo datos correctos, sólo que más despacio.
    // Por eso ninguna de las dos operaciones puede tumbar la petición.
    const readCache = async (): Promise<any> => {
      try {
        const { data, error } = await admin
          .from("profiles").select("snaptrade_activities").eq("id", userId).maybeSingle();
        if (error) throw new Error(error.message);
        return (data as any)?.snaptrade_activities ?? null;
      } catch (e) {
        console.warn("[snaptrade-activities] caché no disponible (¿migración sin aplicar?):",
          String(e).slice(0, 160));
        return null;
      }
    };
    const writeCache = async (payload: unknown) => {
      try {
        const { error } = await admin
          .from("profiles").update({ snaptrade_activities: payload }).eq("id", userId);
        if (error) throw new Error(error.message);
      } catch (e) {
        console.warn("[snaptrade-activities] no se pudo cachear:", String(e).slice(0, 160));
      }
    };

    const cached: any = body?.force ? null : await readCache();
    if (
      cached && cached.updatedAt &&
      String(cached.updatedAt).slice(0, 10) === todayUTC()
    ) {
      return jsonResponse(req, { ...cached, fromCache: true });
    }

    const st = snaptrade();
    const sid = {
      userId: profile.snaptrade_user_id,
      userSecret: profile.snaptrade_user_secret,
    };
    const ai: any = st.accountInformation;

    // ── Cuentas ───────────────────────────────────────────────────────────────
    // Sin filtrar las cerradas (ver cabecera). Si el listado falla se cae a la cuenta
    // guardada en el perfil, para no quedarnos sin nada por un 429.
    let accountIds: string[] = [];
    try {
      const accts = ((await ai.listUserAccounts(sid)).data as any[]) ?? [];
      accountIds = accts.map((a: any) => a?.id ?? a?.account_id).filter((x: any): x is string => !!x);
    } catch (e) {
      console.warn("[snaptrade-activities] listUserAccounts falló:", String(e).slice(0, 200));
    }
    if (accountIds.length === 0 && profile.snaptrade_account_id) {
      accountIds = [profile.snaptrade_account_id];
    }
    if (accountIds.length === 0) {
      return jsonResponse(req, { available: false, reason: "no_account" });
    }

    // ── Lectura paginada de UNA cuenta ────────────────────────────────────────
    // Devuelve { rows, truncated } o null si la cuenta no se pudo leer ENTERA.
    //
    // Si falla una página intermedia se descarta la cuenta COMPLETA en lugar de quedarnos
    // con las páginas que sí llegaron: media historia de movimientos no es un dato
    // incompleto, es una cifra de aportaciones más baja que la real, que es peor que no
    // enseñar ninguna. La cuenta se reporta en `accountsMissing`.
    const readAccountActivities = async (accountId: string) => {
      const rows: any[] = [];
      let offset = 0;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) {
          console.warn(`[snaptrade-activities] ${accountId}: tope de ${MAX_PAGES} páginas alcanzado`);
          return { rows, truncated: true };
        }
        let batch: any[] | null = null;
        // Dos intentos, igual que readAcct en snaptrade-refresh: un 429 puntual no debe
        // costar el historial entero de una cuenta.
        for (let attempt = 0; attempt < 2 && batch === null; attempt++) {
          try {
            const d = (await ai.getAccountActivities({
              ...sid,
              accountId,
              offset,
              limit: PAGE,
              ...(body?.startDate ? { startDate: String(body.startDate) } : {}),
              ...(body?.endDate ? { endDate: String(body.endDate) } : {}),
            })).data;
            // El endpoint devuelve { data, pagination }, pero se acepta también un array
            // pelado por si algún broker o versión responde en la forma antigua.
            batch = Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []);
          } catch (e: any) {
            if (attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
            console.warn(
              `[snaptrade-activities] ${accountId} página ${page} falló:`,
              (e?.response?.data?.detail ?? e?.message ?? String(e)).toString().slice(0, 160),
            );
            return null;
          }
        }
        rows.push(...(batch ?? []));
        if ((batch?.length ?? 0) < PAGE) return { rows, truncated: false };
        offset += batch!.length;
      }
    };

    // ── Todas las cuentas en paralelo, con el mismo techo de 4 que refresh ─────
    const slots: (Awaited<ReturnType<typeof readAccountActivities>>)[] =
      new Array(accountIds.length).fill(null);
    let nextIdx = 0;
    const worker = async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= accountIds.length) return;
        slots[i] = await readAccountActivities(accountIds[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, accountIds.length) }, () => worker()),
    );

    // ── Agregación ────────────────────────────────────────────────────────────
    const currencies: Record<string, Bucket> = {};
    const months: Record<string, Record<string, Bucket>> = {};
    const transfers: Record<string, number> = {};
    const unknownTypes: Record<string, number> = {};
    const accountsMissing: string[] = [];
    let truncated = false;
    let signMismatches = 0;   // el importe contradice a su tipo (ver abajo)
    let undated = 0;          // sin fecha utilizable: cuenta en el total, no en byMonth
    let unusable = 0;         // sin importe numérico: no se puede sumar, pero se declara

    // El SDK declara `amount` como `number | null`, y Number(null) es 0 —que es FINITO. Sin
    // este filtro, una aportación cuyo importe el broker no informó se sumaba como 0 € sin
    // dejar rastro: la fila existía, su dinero no, y el total salía por debajo del real sin
    // un solo aviso. Number("") cae en la misma trampa. Lo que no sea un número de verdad
    // pasa a NaN y se declara en `unusable` en vez de fingir un cero.
    const money = (v: unknown): number =>
      (v === null || v === undefined || v === "") ? NaN : Number(v);

    const add = (bucket: Bucket, amount: number) => {
      bucket.net += amount;
      if (amount >= 0) bucket.in += amount; else bucket.out += amount;
    };

    for (let i = 0; i < slots.length; i++) {
      const r = slots[i];
      if (!r) { accountsMissing.push(accountIds[i]); continue; }
      if (r.truncated) truncated = true;

      for (const act of r.rows) {
        const type = String(act?.type ?? "").trim().toUpperCase();
        const isIn = IN_TYPES.has(type);
        const isOut = OUT_TYPES.has(type);

        if (TRANSFER_TYPES.has(type)) {
          transfers[type] = (transfers[type] ?? 0) + 1;
          continue;
        }
        if (!isIn && !isOut) {
          // Tipo que no conocemos: si mueve dinero, hay que decirlo. Los tipos internos
          // conocidos (compras, dividendos, comisiones…) se ignoran en silencio a propósito.
          if (!INTERNAL_TYPES.has(type) && Number.isFinite(money(act?.amount))) {
            unknownTypes[type || "(vacío)"] = (unknownTypes[type || "(vacío)"] ?? 0) + 1;
          }
          continue;
        }

        const amount = money(act?.amount);
        if (!Number.isFinite(amount)) { unusable++; continue; }

        // Convenio de signo: la doc dice que `amount` es positivo cuando el dinero ENTRA y
        // negativo cuando SALE, así que net = CONTRIBUTION + WITHDRAWAL ya es
        // "aportado menos retirado". Se respeta ese contrato en vez de forzar el signo por
        // el tipo: forzarlo daría la vuelta a las correcciones y reversiones legítimas.
        // Pero si un broker etiquetase una retirada con importe positivo el resultado
        // saldría al revés y del doble, así que las contradicciones se CUENTAN y se
        // publican en vez de arreglarse a ciegas. Un signMismatches > 0 en la fase de
        // verificación por broker señala exactamente ese caso.
        if ((isIn && amount < 0) || (isOut && amount > 0)) signMismatches++;

        const ccy = String(act?.currency?.code ?? "").toUpperCase() || "???";
        // NUNCA se suman divisas distintas en una sola cifra: 1.000 € y 1.000 $ no son
        // 2.000 de nada. Mismo criterio que _SNAP_FX en el cliente.
        currencies[ccy] ??= emptyBucket();
        add(currencies[ccy], amount);

        const raw = act?.trade_date ?? act?.settlement_date ?? null;
        const month = typeof raw === "string" && raw.length >= 7 ? raw.slice(0, 7) : null;
        if (!month) { undated++; continue; }   // ya sumado al total; sólo se queda sin mes
        months[month] ??= {};
        months[month][ccy] ??= emptyBucket();
        add(months[month][ccy], amount);
      }
    }

    const byMonth = Object.keys(months).sort().map((m) => ({ month: m, currencies: months[m] }));
    const partial = accountsMissing.length > 0;
    // `available` = hay al menos un movimiento de flujo que enseñar. Sin esto, un usuario
    // recién conectado vería "has aportado 0 €" —que suena a dato, no a "aún no lo sabemos".
    const available = Object.keys(currencies).length > 0;

    const payload = {
      updatedAt: new Date().toISOString(),
      available,
      ...(available ? {} : { reason: partial ? "unavailable" : "empty" }),
      currencies,
      byMonth,
      transfers,
      unknownTypes,
      signMismatches,
      undated,
      unusable,
      truncated,
      partial,
      accounts: accountIds.length,
      accountsMissing,
    };

    // Una foto PARCIAL no se cachea: se sirve marcada como parcial, pero sellarla un día
    // entero dejaría al usuario con unas aportaciones más bajas que las reales hasta
    // mañana. Es el mismo criterio que usa snaptrade-refresh con las cuentas rotas.
    if (!partial) await writeCache(payload);

    return jsonResponse(req, { ...payload, fromCache: false });
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    const message = e?.message ?? String(e);
    // A diferencia de snaptrade-history, aquí un error SÍ sale como error: la gráfica
    // aguanta un hueco, pero una cifra de aportaciones que no sabemos si es correcta no se
    // enseña como si lo fuera.
    return jsonResponse(req, { available: false, reason: "error", error: message }, status);
  }
});
