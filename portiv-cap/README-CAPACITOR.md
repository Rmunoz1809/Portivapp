# Portiv — Capacitor iOS + RevenueCat

Wrapper de Capacitor para empaquetar `www/index.html` (JS vanilla) como app iOS,
con suscripciones vía RevenueCat.

## Identificadores
- **Bundle ID:** `com.portivapp.portafolio`
- **Entitlement:** `Portiv Pro` · **Offering:** `default` · **Packages:** `$rc_monthly`, `$rc_annual`
- **Custom URL Scheme (RevenueCat):** `rc-6a0a627631`
- **RevenueCat API Key (iOS):** en `src/iap.js` → `REVENUECAT_IOS_API_KEY`
  - ⚠️ **Ahora es la TEST key** `test_Qu0SkuEiywERIEaFurpQhZlKIoQ`.
    **CÁMBIALA por la API key de iOS de PRODUCCIÓN antes de lanzar** y recompila (`npm run build:iap`).

## Estructura
- `www/index.html` — tu app (copia de Desktop/index.html) + safe-area CSS + scripts de RevenueCat.
- `src/iap.js` — wrapper de RevenueCat; esbuild lo empaqueta a `www/portiv-iap.js`.
- `capacitor.config.json` — appId + `webDir: www`.
- `ios/` — proyecto Xcode (generado por `npx cap add ios`).
- `supabase/functions/revenuecat-webhook/` — Edge Function (NO desplegada).

## Comandos
```bash
npm run build:iap     # recompila www/portiv-iap.js desde src/iap.js
npm run sync          # build:iap + npx cap sync ios (tras cambiar www/ o plugins)
npm run open:ios      # build:iap + abre Xcode
# o directo:
npx cap open ios
```
Tras editar `www/` o `src/iap.js`: `npm run sync` (o al menos `npm run build:iap && npx cap copy ios`).

## API de compras (`window.PortivIAP`)
Disponible en la app. Métodos:
- `PortivIAP.loadOfferings()` → localiza `$rc_monthly` / `$rc_annual` del offering `default`.
- `PortivIAP.getPackagesInfo()` → `{ monthly:{priceString,…}, annual:{…} }` para pintar precios.
- `PortivIAP.purchaseMonthly()` / `PortivIAP.purchaseAnnual()` → compra el package.
- `PortivIAP.restore()` → restaurar compras.
- `PortivIAP.isPro()` → `true` si el entitlement `Portiv Pro` está activo.
- `PortivIAP.onChange(cb)` → callback cuando cambia el estado Pro.
- Evento global: `window.addEventListener('portiv-pro-change', e => e.detail.isPro)`.
- Cuando hay Pro, se añade la clase `portiv-pro` a `<html>` y `window.PORTIV_PRO = true`.

### Cablear tu pantalla Pro (opcional, sin JS)
Añade atributos `data-*` a tu paywall y se auto-cablean:
```html
<button data-iap-buy="monthly">Suscribirme mensual <span data-iap-price="monthly"></span></button>
<button data-iap-buy="annual">Suscribirme anual  <span data-iap-price="annual"></span></button>
<button data-iap-restore>Restaurar compras</button>
```
Los `<span data-iap-price>` se rellenan con el precio localizado de la App Store.

El login con RevenueCat usa el `user.id` de Supabase automáticamente (ver bloque al
final de `index.html`), para que el webhook actualice al usuario correcto.

## Custom URL Scheme
`rc-6a0a627631` queda registrado en `ios/App/App/Info.plist` (CFBundleURLTypes).

## Webhook (Supabase Edge Function) — NO desplegado
Archivo: `supabase/functions/revenuecat-webhook/index.ts`.
Actualiza `profiles.subscription_status`: INITIAL_PURCHASE/RENEWAL→`active`,
CANCELLATION→`cancelled`, EXPIRATION→`expired`.

Requisito de datos: tabla `profiles` con PK `id` = `auth.users.id` y columna
`subscription_status text`.

Para desplegar (cuando quieras):
```bash
supabase functions deploy revenuecat-webhook --no-verify-jwt
supabase secrets set REVENUECAT_WEBHOOK_SECRET=<secreto-fuerte>
```
En RevenueCat → Integrations → Webhooks:
- URL: `https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/revenuecat-webhook`
- Authorization header: el mismo valor que `REVENUECAT_WEBHOOK_SECRET`.

## Versión de computadora (Mac Catalyst)
El mismo target iOS genera la app de Mac. Ya activado en `ios/App/App.xcodeproj`:
`SUPPORTS_MACCATALYST = YES`, mismo bundle id `com.portivapp.portafolio`,
entitlements `ios/App/App/App.entitlements` (App Sandbox + red — obligatorio en Mac App Store).
RevenueCat/StoreKit funciona igual: **misma API key de iOS, mismos productos**.

Probar/publicar en Mac:
1. `npx cap open ios` → en la barra de destino elige **My Mac (Mac Catalyst)** → ▶ Run.
2. Signing & Capabilities → elige tu **Team** (firma automática crea el perfil de Mac).
3. Archive → Distribute App → **App Store Connect** (sube el build de Mac).
4. En App Store Connect, la app de Mac va bajo el **mismo registro** (plataforma macOS con Catalyst).
5. Los productos IAP `$rc_monthly`/`$rc_annual` se comparten con iOS (mismo app record).

Notas Catalyst:
- El paywall y "Restaurar compras" ya funcionan en Mac (StoreKit soporta Catalyst).
- El safe-area CSS no estorba en Mac (los insets son 0 en ventana de escritorio).

## Cambiar a la API key de PRODUCCIÓN de RevenueCat

Hoy el bundle se construye con la clave de sandbox (`test_…`), a propósito. Con ella la app
funciona pero **ninguna compra es real**, así que subirla al App Store por despiste es el
fallo caro: la app arranca, el paywall abre, y el pago muere en silencio. Por eso el camino
de producción está automatizado y **se niega a compilar** con una clave que no sea `appl_…`.

La clave pública de iOS está en RevenueCat → *Project settings* → *API keys*. Es pública
(viaja dentro del binario por diseño), no es un secreto que haya que ocultar.

**Camino recomendado — sin tocar código:**

```sh
export PORTIV_RC_KEY_PROD='appl_xxxxxxxxxxxxxxxxxxxxxxxxx'
npm run sync:prod        # valida la clave → build → npx cap sync ios
```

**Camino alternativo — editando el archivo:** en `src/iap.js`, bloque
`CLAVE DE API DE REVENUECAT`: pegar la clave en `RC_KEYS.prod` y cambiar
`RC_ENV_DEFAULT` a `'prod'`. Luego `npm run sync`.

Qué rechaza el build de producción (`scripts/build-iap-prod.js`):
clave vacía · clave `test_…` · prefijo que no sea `appl_` · clave demasiado corta ·
y, ya compilado, un bundle donde la clave no acabó realmente inyectada (en ese caso
borra `www/portiv-iap.js`, para que no se suba el artefacto anterior por error).

Cómo confirmar en qué modo está un build, desde la consola de Safari conectada al dispositivo:

```js
PortivIAP.env()      // → { env:'prod', testKey:false, keyPrefix:'appl_xxxx…' }
PortivIAP.appUserId()  // → el UUID de Supabase, NO '$RCAnonymousID:…'
```

Mientras la clave sea de test, cada arranque deja un aviso en consola:
`[PortivIAP] ⚠ Clave de RevenueCat de PRUEBA…`. Cuando ese aviso desaparece, el build es de producción.

**Volver a sandbox** para seguir probando: `npm run sync` (el build normal siempre usa la de test).

## Checklist antes de lanzar
- [ ] API key de iOS de PRODUCCIÓN: `export PORTIV_RC_KEY_PROD='appl_…' && npm run sync:prod`
      (ver sección anterior). Verificar con `PortivIAP.env()` → `testKey:false`.
- [ ] En App Store Connect: productos `$rc_monthly` / `$rc_annual` aprobados y ligados a RevenueCat (App Store, no Test Store).
- [ ] Capability **In-App Purchase** activada en Xcode (target App → Signing & Capabilities).
- [ ] Firma (Team) configurada en Xcode.
- [ ] Webhook desplegado y configurado en RevenueCat.
- [ ] Páginas de Términos/Privacidad enlazadas (ya en vivo).
