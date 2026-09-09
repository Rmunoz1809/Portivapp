# Notificaciones push — lo que falta y lo hace un humano

Todo el código está escrito y probado. Lo de abajo NO lo puede hacer Claude Code:
necesita la cuenta de Apple, los secrets del proyecto y una decisión de calibración.

## 1 · Apple Developer  (nadie más puede)

- **Identifiers → App ID `com.portivapp.portafolio` → habilitar Push Notifications.**
- **Keys → nueva key con APNs habilitado.** Descargar el `.p8`
  (**se descarga UNA sola vez**, después ya no) y anotar el **Key ID**.
- Team ID: `K97579JSV7`
- Xcode → target App → Signing & Capabilities → **+ Push Notifications**.
  El `aps-environment` ya está en `App.entitlements`; esto sólo hace que el perfil
  de aprovisionamiento lo incluya.

## 2 · Base de datos

```bash
cd /Users/rafael/Portiv
supabase db push        # aplica 20260909120000_push_notifications.sql
```

Crea `device_tokens`, `push_selection_log` y `push_portfolio`, las tres con RLS.

## 3 · Secrets y despliegue de funciones

```bash
supabase secrets set APNS_KEY_P8="$(cat AuthKey_XXXXXXXXXX.p8)"
supabase secrets set APNS_KEY_ID=XXXXXXXXXX
supabase secrets set APNS_TEAM_ID=K97579JSV7
supabase secrets set PUSH_CRON_SECRET="$(openssl rand -hex 32)"
# FINNHUB_KEY ya existe (lo usa finnhub-proxy).

supabase functions deploy apns-push     --no-verify-jwt
supabase functions deploy push-close    --no-verify-jwt
supabase functions deploy push-morning  --no-verify-jwt
```

Las tres se protegen con la cabecera `x-cron-secret`, no con JWT de usuario.

## 4 · Cron

| Función | Cron (UTC) | Por qué |
|---|---|---|
| `push-morning` | `30 * * * *` | Cada hora al minuto 30. La función manda sólo a quien tenga las **7:00 locales**, así que a todos les cae a las **7:30 de su hora**. |
| `push-close` | `0 * * * *` | Cada hora. Actúa sólo cuando en **ET** son las 16:10–16:59. El cierre es un instante único: no se agenda por hora local. |

Ambas se llaman con `x-cron-secret`. `?force=1` salta las ventanas, para probar.

## 5 · Prueba de humo, en este orden

1. Build de desarrollo en un iPhone real (el simulador **no** recibe push de APNs).
2. Entrar, conectar el broker o cargar posiciones → aparece la pantalla de
   pre-permiso → aceptar → el diálogo nativo de iOS.
3. Comprobar que hay fila en `device_tokens` con `environment` y `timezone`.
4. `curl` a `apns-push` con `{"user_id":"…","titulo":"Prueba","cuerpo":"Prueba"}`.
5. Recién entonces, activar los cron.

> El `environment` que manda el cliente es una conjetura: iOS no le dice al JS si el
> token es de sandbox o de producción. Si Apple responde `BadDeviceToken`, el servidor
> reintenta solo en el otro host y **corrige la fila**. No hay que tocar nada a mano.

## 6 · Decisión pendiente antes de encender  ⚠️

El `dryRun` de 30 días × 3 carteras da **0.9 – 1.6 notificaciones por semana**.
El diseño esperaba **2 – 4**. Según los criterios del propio diseño, eso significa
que **el umbral de 45 está alto** para este calendario.

Es una decisión de producto, no un bug, y por eso no se tocó nada:

- Bajar `UMBRAL_BASE` de 45 a ~38 sube la frecuencia sin tocar los pesos.
- Subir el peso de `E` (exposición) favorece a quien tiene cartera concentrada.
- Dejarlo como está y aceptar ~1.5/semana también es una opción defendible: la
  regla era "hay que merecer la interrupción".

Reproducir la tabla:

```bash
cd /Users/rafael/Portiv
TZ=America/New_York node supabase/functions/_shared/push-dryrun.mjs
```

## 7 · Tests que tienen que seguir en verde

```bash
TZ=America/New_York node supabase/functions/_shared/push-tests.mjs       # 23 casos borde y copy
TZ=America/New_York node supabase/functions/_shared/push-drift-test.mjs  # calendario app vs push
```

El de **drift** es el importante a largo plazo: el motor del push tiene su propia
copia del calendario macro (corre en el servidor y no puede importar nada de
index.html). Ese test corre las dos implementaciones sobre 260 semanas y las
compara. Si alguien toca `_macroEventsForWeek` en `index.html` y no toca
`push-rank.js`, el test falla. Si falla, la app y el push están hablando de
calendarios distintos.

## 8 · Lo que NO se construyó, a propósito

- Nada de marketing ("vuelve a Portiv"). App Store 4.5.4 lo trata aparte y exige un
  consentimiento propio. Las alertas de cartera y calendario son contenido funcional.
- Ningún gate de `Portiv Pro`. Las dos notificaciones son gratis.
- `npx cap sync ios` **no se corrió en ningún momento**: arrasa con
  `ios/App/App/public/`. El plugin se dio de alta a mano en `CapApp-SPM/Package.swift`
  (este proyecto usa Swift Package Manager; **no existe ningún Podfile**, así que no
  hubo `pod install` que correr).
