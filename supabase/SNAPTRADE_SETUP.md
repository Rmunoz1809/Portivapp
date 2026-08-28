# SnapTrade integration — deploy runbook (Portiv)

Linked Supabase project: **`zblhifszlhdgkhnymwjh`** (Portiv).
Everything server-side lives in `supabase/functions/` + `supabase/migrations/`.
The Consumer Key is **never** in `index.html` — only in function secrets.

## What was built (backend)

| Piece | Path | Notes |
|---|---|---|
| Shared CORS | `functions/_shared/cors.ts` | Allowlist: portivapp.com + capacitor/ionic localhost + dev localhost |
| Shared SnapTrade+admin | `functions/_shared/snaptrade.ts` | SDK client factory, service-role client, `requireUser()` JWT check |
| `snaptrade-connect` | `functions/snaptrade-connect/` | Registers user (userId = Supabase uid), returns fresh `redirectURI` |
| `snaptrade-refresh` | `functions/snaptrade-refresh/` | 60-min cache; reads daily-synced holdings; **never triggers a paid sync** |
| `snaptrade-history` | `functions/snaptrade-history/` | Daily cache; experimental balance-history; graceful `{available:false}` |
| `snaptrade-webhook` | `functions/snaptrade-webhook/` | CONNECTION_ADDED/BROKEN/DELETED → profiles |
| `snaptrade-cleanup` | `functions/snaptrade-cleanup/` | Cron horario; da de baja el enlace cuando no hay suscripción (corta el ~1 USD/mes). **v2 — ver sección abajo** |
| `revenuecat-webhook` | `functions/revenuecat-webhook/` | Extended: stamps `subscription_expired_at` on EXPIRATION/CANCELLATION |
| Schema | `migrations/20260712170000_snaptrade.sql` | profiles columns + secret hardening |
| Cron | `migrations/20260712170100_snaptrade_cron.sql` | pg_cron daily cleanup |
| Config | `config.toml` | verify_jwt flags per function |

Cost controls implemented exactly as specified: no manual/paid sync anywhere; refresh serves
cache all day (≤1 read/user/day); history cached daily; "Actualizar" only re-reads cache.

## Manual steps you must do

### 0. Install tooling (currently missing on this machine)
```bash
brew install supabase/tap/supabase   # supabase CLI — NOT installed
brew install deno                    # optional, only for local `supabase functions serve`
supabase login                       # if not already
# from Desktop/supabase (already linked to zblhifszlhdgkhnymwjh):
supabase link --project-ref zblhifszlhdgkhnymwjh   # if link is lost
```

### 1. Secrets
```bash
supabase secrets set SNAPTRADE_CLIENT_ID=RAFAEL-MUNOZ-TEST-MFSJO
supabase secrets set SNAPTRADE_CONSUMER_KEY=<your consumer key>   # <-- I still need this value
# optional but recommended:
supabase secrets set SNAPTRADE_WEBHOOK_SECRET=<random>            # verify webhook posts
supabase secrets set SNAPTRADE_CRON_SECRET=<random>              # verify cron posts
# (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
```

#### `SNAPTRADE_IBKR_SLUG` — identidad de Interactive Brokers

```bash
supabase secrets set SNAPTRADE_IBKR_SLUG=INTERACTIVE-BROKERS-FLEX
```

Es el `slug` con el que SnapTrade presenta a Interactive Brokers en
`referenceData.listAllBrokerages()`. Se usa para dos cosas:

* `snaptrade-connect` lo manda como parámetro `broker` para que el portal entre
  **directo** al flujo de IBKR (pegar Query ID + Token) en vez de a la pantalla
  de selección, donde el usuario no sabe qué elegir.
* `snaptrade-refresh` se lo pasa al cliente en `brokerSlugs` para que la app
  reconozca una conexión de IBKR **por slug y nunca por nombre** — y con ello
  enseñe la guía del engranaje, el aviso de que esa conexión no entrega
  histórico y la detección de conexión dormida.

**No es obligatorio y no puede quedarse desactualizado.** `resolveIbkrSlugs()`
(en `_shared/snaptrade.ts`) valida el valor contra el catálogo real de SnapTrade
y, si no existe o el secreto no está, lo **descubre** — dejando además un
`console.error` con el valor equivocado. Si SnapTrade publicara IBKR con varios
slugs, se envían todos: la app reconoce cualquiera de ellos y se conecta por el
primero. Un slug mal escrito no daba ningún error visible: apagaba en silencio
toda la lógica de IBKR y dejaba el portal en blanco. Por eso ya no se cree a
ciegas.

### 2. Migrations
```bash
supabase db push    # applies both 20260712170000_snaptrade.sql and _cron.sql
```

### 3. Deploy functions
```bash
supabase functions deploy snaptrade-connect
supabase functions deploy snaptrade-refresh
supabase functions deploy snaptrade-history
supabase functions deploy snaptrade-webhook  --no-verify-jwt
supabase functions deploy snaptrade-cleanup  --no-verify-jwt
supabase functions deploy revenuecat-webhook --no-verify-jwt
```

### 4. Cron secret (Vault) — for the daily cleanup
In the Supabase SQL editor:
```sql
select vault.create_secret('<same value as SNAPTRADE_CRON_SECRET>', 'snaptrade_cron_secret');
```

### 5. SnapTrade dashboard
- **Webhook URL to paste** (Webhooks / Notifications):
  `https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/snaptrade-webhook`
  If you set `SNAPTRADE_WEBHOOK_SECRET`, configure the same value as the webhook shared secret.

### 6. Experimental history endpoint (optional, off by default)
`getAccountBalanceHistory` (1-year lookback) is disabled per-account until you email SnapTrade to
enable it. Until then `snaptrade-history` returns `{available:false}` and the frontend shows the
"performance history coming soon" state — this is expected, not an error.

## Frontend contract (how index.html calls these)
`verify_jwt = true` on connect/refresh/history → the browser MUST send the user's session token:
```js
const { data:{ session } } = await sb.auth.getSession();
await fetch('https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/snaptrade-refresh', {
  method:'POST',
  headers:{ 'content-type':'application/json',
            'apikey': SUPABASE_ANON,
            'Authorization':'Bearer ' + session.access_token },  // <-- user token, NOT anon
  body: JSON.stringify({})
});
```

## Frontend changes (done + verified)
Edited both copies (backups written as `index.html.pre-snaptrade.bak` next to each):
- `Desktop/index.html` (web / GitHub Pages source)
- `portiv-cap/www/index.html` (Capacitor iOS/Android build — kept its native `_IS_NATIVE` routing)

What changed in each: injected a self-contained SnapTrade `<script>`+`<style>` module (connect / refresh / history / holdings→portfolio mapping / Value-Performance toggle / reconnect banner); replaced the Settings "screenshot" card with `#snapConnectCard`; repointed onboarding hand-off + paywall confirm/restore to `snapConnect()`; removed the entire photo/OCR analyzer (vision calls, prompts, upload handlers) while keeping the shared portfolio editor + `_applyValueChart`/`PERF_MASTER` chart it now reuses.
Verified live in a browser: both files boot with **0 console errors**; `snapMapHoldings()` → `aiPortImportData()` proven with a sample holdings payload (cash, total, positions all populate correctly).

## Native / Capacitor follow-ups (not code — verify when wiring the native build)
1. **Return from the portal:** on web, `snapConnect` does `window.location.href = redirectURI` and detects the return via a `pv_snap_pending` flag on next load. In the Capacitor WebView you likely want to open the portal in an in-app browser / handle the redirect back via a deep link, then call `window.snapRefresh()`. The web flow works as-is.
2. **RevenueCat app_user_id:** the native paywall (IAP) must call `Purchases.logIn(session.user.id)` so RevenueCat webhook events carry `app_user_id == Supabase user.id` — the `revenuecat-webhook` matches on that.

## Housekeeping
- The old `portiv-cap/supabase/functions/revenuecat-webhook/` is now **superseded** by the linked-project
  copy here. Safe to delete once you confirm the linked one is deployed.

---

# Baja automática del broker sin suscripción — v2 (27 jul 2026)

Auditoría contra el proyecto en vivo. La v1 **no cortaba a nadie**. Cuatro fallos, los cuatro
corregidos y verificados end-to-end contra producción.

## Fallos encontrados

| # | Fallo | Cómo se detectó | Corrección |
|---|---|---|---|
| 1 | El cron nunca completaba la llamada: `pg_net` aborta a los 5 s y el arranque en frío de la función ya se los come | `net._http_response` → `status_code: NULL`, `"Timeout of 5000 ms reached"` en el 100 % de las ejecuciones | `timeout_milliseconds := 120000` en `net.http_post` |
| 2 | Un enlazado **sin fila** en `subscriptions`, o con `expires_at NULL`, era invisible para el barrido → 1 USD/mes eterno | La v1 filtraba `subscriptions … .not("expires_at","is",null)` | El barrido parte de `profiles` (todos los enlazados) + ancla en cascada |
| 3 | `snaptrade-disconnect` no reconocía "usuario ya inexistente": SnapTrade devuelve un 400 genérico, no un 404 → la fila se reintentaba cada hora **para siempre** y el enlace local nunca se limpiaba | Prueba real: borrar un userId inexistente responde `"Please provide valid clientId and userId in query params"` | Ante ese 400 se consulta `listSnapTradeUsers()`: si la lista responde y el userId no está, es baja idempotente; si la lista falla, se reintenta |
| 4 | Cero observabilidad: una limpieza que fallaba en silencio no la veía nadie | — | Tabla `snaptrade_cleanup_runs` + health-check cada 6 h |

## Cómo decide a quién cortar

1. Candidatos: **todo** `profiles` con `snaptrade_user_id` no nulo (lote de `SNAPTRADE_CLEANUP_BATCH`, 25 por defecto; el resto se recoge la hora siguiente y se reporta como `pending`).
2. `has_active_entitlement(uid)` en el momento de actuar → con derecho activo (incluido el bypass del dueño) se salta. Si la RPC falla, **no** se corta.
3. Ancla de la ventana de gracia, en cascada y siempre estable (nunca `now()`, para que un evento reenviado no reinicie el reloj):

   | Orden | Ancla | Gracia | Caso típico |
   |---|---|---|---|
   | 1 | `subscriptions.expires_at` | `SNAPTRADE_GRACE_HOURS` (36 h) | expiró o canceló y ya venció el periodo |
   | 2 | `subscriptions.updated_at` | 36 h | cancelación efectiva sin periodo restante (`expires_at` NULL) |
   | 3 | `profiles.snaptrade_connected_at` | `SNAPTRADE_ORPHAN_GRACE_HOURS` (48 h) | enlazado que nunca tuvo fila — cubre el retraso del webhook de la tienda |

   Sin ninguna de las tres **no se corta**: se sella `connected_at` y se decide al ciclo siguiente.
4. La baja la ejecuta siempre `snaptrade-disconnect` (única implementación). Sólo limpia el estado
   local cuando SnapTrade confirma; ante fallo transitorio sube `snaptrade_cleanup_retry_count` y
   el ciclo siguiente vuelve sobre la fila.

## Pruebas corridas contra producción (usuario desechable, ya borrado)

| Caso | Resultado |
|---|---|
| Suscripción expirada hace 72 h | ✅ baja, `anchor_kind: expires_at`, motivo `subscription_inactive_paddle:expired` |
| Huérfano sin fila, enlazado hace 10 días | ✅ baja, `anchor_kind: connected_at`, motivo `trial_expired_no_payment` |
| Huérfano enlazado hace 2 h | ✅ respetada la gracia (`hours_left: 46`) |
| Canceló pero le quedan 12 días pagados | ✅ intacto (`still_entitled`) |
| Cancelación efectiva con `expires_at` NULL | ✅ baja, `anchor_kind: sub_updated_at` — el punto ciego de la v1 |
| Dueño (bypass) y su segunda cuenta | ✅ intactos |
| Perfil tras la baja | `snaptrade_user_id`/`_secret` a NULL, `snaptrade_disconnected_reason` sellado, `retry_count` a 0 |

## Operación

```bash
# secreto del cron (Vault, ya existe): vault.decrypted_secrets → 'snaptrade_cron_secret'
# simulacro: dice a quién cortaría, sin cortar a nadie
curl -X POST "$SUPABASE_URL/functions/v1/snaptrade-cleanup" \
  -H "x-cron-secret: $SECRET" -H "Content-Type: application/json" -d '{"dry_run":true}'

# un solo usuario (diagnóstico)
… -d '{"user_id":"<uuid>","dry_run":true}'
```

```sql
-- ¿corrió y qué hizo?
select ran_at, ok, scanned, disconnected, skipped, failed, pending
  from public.snaptrade_cleanup_runs order by ran_at desc limit 20;

-- alertas del health-check (sin ejecución OK en 6 h)
select * from public.snaptrade_cleanup_runs where not ok order by ran_at desc;

-- ¿alguna fila atascada reintentando?
select id, snaptrade_cleanup_retry_count, snaptrade_cleanup_last_attempt_at
  from public.profiles where snaptrade_cleanup_retry_count > 3;
```

Variables de entorno opcionales: `SNAPTRADE_GRACE_HOURS` (36) · `SNAPTRADE_ORPHAN_GRACE_HOURS` (48)
· `SNAPTRADE_CLEANUP_BATCH` (25).

## Cliente (web e iOS, mismo comportamiento)

`snaptrade-refresh` ya devolvía `disconnectedReason`; nadie lo leía. Ahora la tarjeta del broker
distingue tres casos que antes pintaban el mismo CTA de captación:

- baja por suscripción (`trial_expired_no_payment`, `subscription_*`) → **"Tu broker se desconectó"** + botón *Reactivar suscripción* (abre el checkout/paywall, nunca `snapConnect()`, que devolvería 403).
- baja manual (`manual`) → CTA normal de conectar.
- nunca conectó → CTA normal de conectar.

Un `403 subscription_required` en el refresh ya no se trata como un JWT vencido (gastaba un
reintento y dejaba la tarjeta muda): pinta el estado real y levanta el candado.

**iOS**: el bundle no tenía candado de suscripción (el paywall se mostraba una vez y cerrarlo dejaba
la app entera abierta). Se portó el de la web adaptado a StoreKit/RevenueCat: banner de aviso,
bloqueo duro con *Restaurar compras* y *Cerrar sesión*, red de seguridad con `PortivIAP.isPro()`
(quien acaba de pagar no se bloquea aunque el webhook aún no haya escrito la fila) y re-chequeo en
`appStateChange` además de `visibilitychange`.

## Pendiente (requiere el dashboard de Paddle)

`paddle-webhook` está desplegada pero **falta `PADDLE_WEBHOOK_SECRET`**; sin él responde 500 y
nunca acepta un evento sin verificar. Ver `SUBSCRIPTION_SETUP.md` → "Lo que TÚ debes hacer en el
dashboard de Paddle". Hasta entonces una cancelación **en web** no llega a Supabase y la baja del
broker sólo ocurre por la vía del huérfano (48 h desde el enlace).
