# Portiv — Candado por suscripción (server-authoritative) · runbook

Rama: `feat/subscription-gate`. Proyecto Supabase: `zblhifszlhdgkhnymwjh`.
RevenueCat = fuente de verdad → espejada en Supabase por `rc-webhook` → el cliente SOLO lee.
El **candado real** está en el servidor (Edge Functions → `403 subscription_required`). Forzar la
UI no sirve: sin entitlement no hay IA de broker, ni datos de broker. **El owner
(`rafaelmunozanselmi@icloud.com`) siempre pasa** (bypass en `has_active_entitlement` + cliente).

## Qué se construyó (ya desplegado)

| Pieza | Ruta | Estado |
|---|---|---|
| Tabla `subscriptions` + RLS + `has_active_entitlement(uid)` | `migrations/20260713180000_subscriptions.sql` | ✅ aplicada |
| `rc-webhook` (RevenueCat → `subscriptions` + espejo a `profiles` + dispara baja) | `functions/rc-webhook/` | ✅ desplegada (`--no-verify-jwt`) |
| `snaptrade-disconnect` (baja del broker: interna o por JWT de usuario) | `functions/snaptrade-disconnect/` | ✅ desplegada |
| Gate en `snaptrade-connect` / `-refresh` / `-history` (`requireEntitlement`) | `functions/_shared/snaptrade.ts` | ✅ desplegadas |
| Gate cliente + paywall duro | `index.html` (web) + `portiv-cap/www/index.html` (iOS) | ✅ editado |

Secrets ya seteados: `RC_WEBHOOK_SECRET`, `REVENUECAT_WEBHOOK_SECRET` (mismo valor), `RC_ACCEPT_SANDBOX=true`.

## ⚠ Lo que TÚ debes hacer en el dashboard de RevenueCat (sin esto, nadie puede suscribirse)

1. **Entitlement**: crea/confirma el entitlement (identifier, ej. `pro`) y asócialo al producto de
   suscripción mensual del App Store (**USD 4.99, 1 mes de prueba**). En iOS el candado usa
   `PortivIAP.isPro()` (no le importa el identifier). En el fallback web JS la constante
   `ENTITLEMENT_ID='pro'` debe coincidir con el tuyo (edítala si usas otro).
2. **Webhook → apúntalo a `rc-webhook` (NO al viejo `revenuecat-webhook`)**:
   - URL: `https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/rc-webhook`
   - Header `Authorization` = **este valor exacto**:
     ```
     ZMGiE_eND_GxS1w6z9I2UnOAmeCpNWtUXfgsZmUf1yRyIo9q
     ```
   (Es el `RC_WEBHOOK_SECRET` que ya quedó guardado en Supabase. Si prefieres otro, regéneralo con
   `supabase secrets set RC_WEBHOOK_SECRET=...` y pega el mismo aquí.)
3. **App User ID**: ya se setea solo — `portiv-iap.js` llama `PortivIAP.login(session.user.id)` en cada
   login (ver `www/index.html`), así el `app_user_id` de RevenueCat == `user_id` de Supabase y el
   webhook escribe en la fila correcta. No toques nada.
4. **Key iOS de producción**: la app nativa usa la key dentro de `portiv-iap.js` (RevenueCat SDK
   nativo). Confirma que sea la de **producción** antes de lanzar. (`RC_IOS_API_KEY='appl_REEMPLAZAR'`
   en `index.html` es SOLO para el path web-JS, que no puede cobrar; opcional.)

## Al pasar a PRODUCCIÓN

```bash
# apaga la aceptación de eventos SANDBOX (ahora en true para pruebas):
supabase secrets set RC_ACCEPT_SANDBOX=false
```

## Mapeo de eventos RevenueCat → estado (en `rc-webhook`)

| event.type | entitlement_active | status | ¿baja de broker? |
|---|---|---|---|
| INITIAL_PURCHASE · RENEWAL · PRODUCT_CHANGE · UNCANCELLATION · SUBSCRIPTION_EXTENDED · NON_RENEWING | true | active | no |
| CANCELLATION (auto-renovación off, sigue con acceso) | true | canceled | no |
| BILLING_ISSUE (gracia; Apple reintenta) | true | grace | no (salvo que ya expiró) |
| EXPIRATION · SUBSCRIPTION_PAUSED | false | expired | **sí** → `snaptrade-disconnect` |

## Paddle (web) — `paddle-webhook`

En **iOS la suscripción va por RevenueCat/StoreKit**; en **web va por Paddle Billing** (no Paddle
Classic). Ambos escriben la MISMA tabla `public.subscriptions`; las filas de Paddle se distinguen por
`store='paddle'` y dejan `rc_app_user_id` en NULL. El cliente sigue leyendo sólo `subscriptions`.

### Despliegue

```bash
# El webhook NO lleva JWT de usuario: Paddle postea servidor-a-servidor y la autenticidad
# se prueba con la firma HMAC del header Paddle-Signature.
supabase functions deploy paddle-webhook --no-verify-jwt

# Secret key del destino de notificaciones (Paddle → Developer tools → Notifications →
# tu destino → "Secret key"). SIN este secreto la función responde 500 y NO escribe nada:
# nunca se acepta un evento sin verificar.
supabase secrets set PADDLE_WEBHOOK_SECRET=pdl_ntfset_...

# Sólo si Paddle no manda el header Paddle-Environment (queda en `environment` de la fila).
supabase secrets set PADDLE_ENV=sandbox     # 'production' al lanzar
```

La baja del broker reutiliza el mismo mecanismo interno que `snaptrade-cleanup`
(`INTERNAL_DISCONNECT_SECRET`, con fallback a `SNAPTRADE_CRON_SECRET`); ya está seteado.

### ⚠ Lo que TÚ debes hacer en el dashboard de Paddle

1. **Notification destination** (Developer tools → Notifications → New destination):
   - URL: `https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/paddle-webhook`
   - Tipo: Webhook · Versión de API: la de **Paddle Billing** (no Classic).
   - Copia la **Secret key** que te da Paddle y pégala en `PADDLE_WEBHOOK_SECRET` (comando arriba).
2. **Event types a suscribir — exactamente estos nueve** (cualquier otro se ignora con 200):
   ```
   subscription.created
   subscription.activated
   subscription.updated
   subscription.canceled
   subscription.past_due
   subscription.paused
   subscription.resumed
   transaction.completed
   transaction.payment_failed
   ```
3. **Sandbox vs producción**: el destino se crea por separado en cada entorno. Al pasar a live hay que
   rehacerlo en el dashboard de producción (secret distinto) y cambiar en `index.html`
   `Paddle.Environment.set('sandbox')` → `'production'`, el token client-side y los `PADDLE_PRICES`.
4. **`supabase_user_id`**: ya se manda solo — `_pvStartCheckout()` abre el checkout con
   `customData: { supabase_user_id: uid }`, y Paddle lo devuelve en `data.custom_data`. Si un evento
   llega sin él, el webhook intenta resolverlo por email (`profiles.email` → `auth.users`) y, si
   tampoco, responde **200** con un log de aviso: un 4xx haría que Paddle reintentara 3 días seguidos
   un evento que nunca vamos a poder mapear.

### Seguridad del webhook (firma)

`Paddle-Signature: ts=<unix_segundos>;h1=<hex>`. Se verifica HMAC-SHA256 de
`` `${ts}:${cuerpo crudo}` `` con `PADDLE_WEBHOOK_SECRET`, comparando en tiempo constante. El cuerpo se
lee con `req.text()` **antes** de parsear (reserializar el JSON rompe la firma). Además se rechazan
firmas con `ts` de más de **5 minutos** (anti-replay). Todo fallo de firma → **401**.

### Mapeo de eventos Paddle → estado (en `paddle-webhook`)

| event_type | entitlement_active | status | ¿baja de broker? |
|---|---|---|---|
| subscription.created · subscription.activated · subscription.resumed | true | active | no |
| subscription.updated | según `data.status` (active/trialing/past_due → true; paused/canceled → false) | el propio `data.status` | sólo si queda inactivo |
| subscription.canceled | true si aún queda periodo pagado; false si ya es efectiva | canceled | sólo si false |
| subscription.past_due (gracia; Paddle reintenta el cobro) | true | past_due | no |
| subscription.paused | false | paused | **sí** → `snaptrade-disconnect` |
| transaction.payment_failed (no se corta al primer fallo) | true | past_due | no |
| transaction.completed | true | active | no |
| cualquier otro | — | — | ignorado (200, sin escribir) |

`expires_at` = `data.current_billing_period.ends_at` (o `next_billed_at`) · `will_renew` = false sólo si
hay `scheduled_change.action === 'cancel'` · `product_id` = `data.items[0].price.id`.
**Idempotencia**: upsert por `user_id` + descarte de eventos cuyo `data.updated_at`/`occurred_at` es
anterior al `updated_at` de la fila (Paddle reintenta y puede entregar desordenado).

## Pruebas backend ya corridas (throwaway user, sandbox)
- Sin suscripción → `snaptrade-refresh`/`-connect` = **403 subscription_required** ✅
- INITIAL_PURCHASE → entitlement activo → refresh = **200** ✅
- Secreto de webhook incorrecto → **401** ✅
- EXPIRATION → entitlement false + `snaptrade-disconnect` corre ✅ → refresh **403** otra vez ✅
- Owner (`has_active_entitlement`) → **true** sin fila de suscripción ✅

## Pruebas que faltan (requieren device iOS + sandbox tester + dashboard configurado)
- Comprar en sandbox → app se desbloquea → SnapTrade conecta.
- Forzar EXPIRATION → al reabrir, la app se re-bloquea (resume/visibility recheck).
- Restaurar compra (botón "Restaurar compras" del paywall).

## Nota de alcance (decisión deliberada)
`anthropic-proxy` / `finnhub-proxy` / `yh-proxy` **NO** llevan gate de entitlement: hoy el cliente les
manda la anon key (no el JWT del usuario), y enrutar el token por la lógica de coste de la IA
(proxy local → pago) arriesgaba romper onboarding y el path gratis del owner. El gate de UI oculta
todo y los datos sensibles ($ real de IA de broker + datos privados) están gateados en las 3 funciones
SnapTrade. Si quieres gatear también la IA, es un follow-up acotado (adjuntar el token en `index.html`
línea ~5951 + `requireEntitlement` en `anthropic-proxy`).
