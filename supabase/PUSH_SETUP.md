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

## 3.bis · Estado real comprobado el 2026-09-09  ⚠️

Se verificó contra el proyecto (`zblhifszlhdgkhnymwjh`) y **no había nada del
lado servidor**, pese a darse por hecho:

| Pieza | Estado |
|---|---|
| Tablas `device_tokens`, `push_selection_log`, `push_portfolio` | no existen |
| RPC `registrar_device_token` | no existe |
| Funciones `apns-push`, `push-morning`, `push-close` | no desplegadas (hay 17 funciones, ninguna de estas) |
| Secreto `push_cron_secret` en Vault | no existe (Vault sólo tiene `snaptrade_cron_secret`) |
| Cron `push-morning` / `push-close` | no existen |

O sea: las migraciones nunca se aplicaron y las funciones nunca se subieron.
`scripts/push-desplegar.sh` hace los cinco pasos en orden y deja un solo pegado
manual (el secreto de Vault).

De paso quedó a la vista que los cuatro cron `gen-*` fallan por lo mismo:
`pv_run_generate: faltan secretos en Vault (project_url / gen_shared_secret)`.
Es un problema aparte, del pipeline de noticias, no del push.

## 4 · Cron

| Función | Cron (UTC) | Por qué |
|---|---|---|
| `push-morning` | `30 * * * *` | Cada hora al minuto 30. La función actúa sólo cuando en **ET** son las 8, así que sale a las **8:30 ET**: una hora antes de la apertura, la misma hora absoluta para todos. |
| `push-close` | `5 * * * *` | Cada hora al minuto 5. Actúa sólo cuando en **ET** son las 16:05–16:59, o sea apenas cierra. El cierre es un instante único: no se agenda por hora local. |

Ambas se llaman con `x-cron-secret`. `?force=1` salta las ventanas, para probar.

Los dos jobs los crea la migración `20260909160000_push_cron.sql`. El minuto del
cron **es** el minuto de envío: la función sólo decide la hora, no el minuto.

El secreto vive **sólo en Vault**. La migración `20260909170000` lo genera ahí
dentro (dos uuid concatenados) y la función lo valida con el RPC
`public.push_cron_ok(text)`, que devuelve un booleano y nunca el valor. No hay
dos copias que sincronizar ni nada que pegar a mano.

Antes estaba en dos sitios y era una fuente de fallo silencioso: si se
desincronizaban, las funciones respondían 403 cada hora sin que nada pareciera
roto. `PUSH_CRON_SECRET` se sigue poniendo como red de seguridad —`autorizado()`
acepta cualquiera de los dos— pero no es la fuente de verdad.

## 5 · Prueba de humo, en este orden

1. Build de desarrollo. En este Mac sirve el simulador: es Apple silicon con macOS 26
   y Xcode 26, y desde Xcode 14 el simulador **sí** obtiene token de APNs y recibe
   push de verdad. Un iPhone físico también vale, claro.
2. Entrar, conectar el broker o cargar posiciones → aparece la pantalla de
   pre-permiso → aceptar → el diálogo nativo de iOS.
3. Comprobar que hay fila en `device_tokens` con `environment` y `timezone`.
4. `curl` a `apns-push` con `{"user_id":"…","titulo":"Prueba","cuerpo":"Prueba"}`.
5. Recién entonces, activar los cron.

> El `environment` que manda el cliente es una conjetura: iOS no le dice al JS si el
> token es de sandbox o de producción. Si Apple responde `BadDeviceToken`, el servidor
> reintenta solo en el otro host y **corrige la fila**. No hay que tocar nada a mano.

## 6 · Decisión tomada: la matutina es DIARIA  (2026-09-22)

El `dryRun` avisaba de **0.9 – 1.6 notificaciones por semana** frente a las 2 – 4
del diseño, y se dejó sin decidir. En producción salió peor de lo previsto: el
`push_selection_log` real muestra **cero matutinas**, con estos motivos:

| Día | `motivo_no_envio` |
|---|---|
| 2026-09-21 | `sin_eventos_elegibles` (esa semana no tenía macro el lunes) |
| 2026-09-22 | `bajo_umbral(31.53<45)` |

El cron, el token y APNs estaban bien — la de cierre llegaba. El que callaba era
el motor. Se resolvió así:

- **Umbral fuera.** `push-morning` pasa `umbral: 0` (`UMBRAL_MATUTINO`). El ranking
  ya no decide SI se manda, sólo QUÉ. `umbralPara()` y `UMBRAL_BASE` siguen en el
  motor para el arnés de calibración; no los borres creyendo que son código muerto.
- **Respaldo para los días sin calendario.** `proximoMacro()` +
  `textoMatutinoSinEventos()`: en vez de callar, se cuenta qué viene
  ("El calendario económico de EE.UU. no publica datos hoy. Mañana: IPC, 8:30 AM ET.").
  Mira 6 días como mucho, para que el nombre del día no sea ambiguo.
- El respaldo guarda un id **sintético** `sinev_<fecha>`, nunca el id del próximo
  evento: el anti-duplicado de 7 días lo daría por enviado y lo tacharía el día
  que de verdad toca.

Cobertura comprobada sobre los 251 días hábiles de NYSE de 2026 × 7 perfiles de
cartera (`push-cobertura-test.mjs`): **1757 de 1757 casos con notificación**.
El reparto es 71 % por evento y **29 % de respaldo** — o sea unas **77 veces al año**
el aviso dice "hoy no hay datos". Es contenido flojo y sigue siendo una decisión de
producto abierta: si molesta, la salida natural es que esos días compita la cartera
del usuario (pista B) en vez del calendario.

Reproducir:

```bash
cd /Users/rafael/Portiv
TZ=America/New_York node supabase/functions/_shared/push-dryrun.mjs
```

## 6-bis · ⚠️ HAY QUE VOLVER A APLICAR ESTO

Se corrigieron seis bugs después del primer despliegue. Dos de ellos cambian la base
de datos y el cliente, así que **lo ya desplegado NO funciona tal cual**:

```bash
cd /Users/rafael/Portiv
supabase db push                                 # migración 20260909150000
supabase functions deploy push-morning --no-verify-jwt
supabase functions deploy push-close   --no-verify-jwt
supabase functions deploy apns-push    --no-verify-jwt
```

Y el `index.html` nuevo tiene que llegar al dispositivo (build de iOS y, para la web,
push a `main`).

| # | Bug | Síntoma que daba |
|---|---|---|
| 1 | `window.HOLDINGS` no existe | `HOLDINGS` se declara con `let`: es visible por nombre pero nunca es propiedad de `window`. El snapshot de cartera y la pantalla de permiso **no corrían jamás**. |
| 2 | Deep links a funciones inventadas | `openDrawer`, `showTicker` y `switchTab` no existen. Los reales son `showTab()` y `toggleDrawer(idx)`. Ningún tap llegaba a ningún sitio. |
| 3 | Registro perdido en arranque en frío | El gate de sesión puede resolver antes de que el bloque del módulo se parsee. En ese arranque el token no se guardaba nunca. |
| 4 | El alta del token chocaba con RLS | El upsert por `token` necesitaba UPDATE sobre una fila de OTRO usuario (mismo iPhone, otra cuenta) y RLS lo bloqueaba en silencio. Ahora va por `registrar_device_token()`. |
| 5 | Doble notificación matutina | Un reintento del cron en la misma hora volvía a puntuar, el anti-duplicado descartaba sólo el evento ya enviado y ganaba el segundo mejor. |
| 7 | **El plugin nunca se registraba** | Con Swift Package Manager, Capacitor sólo carga las clases listadas en `ios/App/App/capacitor.config.json` → `packageClassList`. Compilar el plugin no basta. `Capacitor.Plugins.PushNotifications` era `undefined`, así que `requestPermissions()` no fallaba: se quedaba esperando para siempre, sin permiso, sin token y sin error. Se agregó `"PushNotificationsPlugin"` a mano, porque `cap sync` (que regenera esa lista) arrasa con `ios/App/App/public/`. |
| 6 | Finnhub a 60 llamadas por minuto | Sin pausa entre lotes, un 429 dejaba carteras a medias. Una notificación de cierre a medias es peor que ninguna. |

También se acotó por columna el permiso de UPDATE sobre `push_selection_log`: RLS no
limita columnas, y con el permiso abierto un usuario podía reescribir su propio
historial de fatiga para forzarse notificaciones. Ahora sólo puede tocar `abierto`.

## 6-ter · Ver las notificaciones en el SIMULADOR

En un Mac Intel o con Xcode anterior al 14, el simulador **no** obtiene token de APNs
y sólo sirve para ver los textos con `simctl push`. En este Mac (M4, macOS 26, Xcode 26)
sí lo obtiene y el camino completo se puede probar sin iPhone físico.
Lo que sí acepta es un payload local, idéntico al que manda la Edge Function. Sirve
para ver el texto, el corte de la pantalla de bloqueo y el comportamiento del tap.
El camino completo (servidor → Apple → teléfono) sólo se prueba en un iPhone real.

```bash
cd /Users/rafael/Portiv && ./scripts/push-simulador.sh
```

Los textos los genera el motor real, no están escritos a mano en el script.

Requisito: la app instalada en el simulador y con el permiso de notificaciones ya
concedido. Como el permiso se ofrece recién después de login y posiciones, la primera
vez hay que entrar a la app y aceptar la pantalla de pre-permiso.

Verificado el 2026-09-09 en un iPhone 17 Pro. Las dos se ven correctas en la pantalla
de bloqueo, dentro del límite de caracteres.

## 7 · Tests que tienen que seguir en verde

```bash
TZ=America/New_York node supabase/functions/_shared/push-tests.mjs        # 23 casos borde y copy
TZ=America/New_York node supabase/functions/_shared/push-drift-test.mjs   # calendario app vs push
node supabase/functions/_shared/push-cliente-test.mjs                     # 13 del módulo del cliente
TZ=America/New_York node supabase/functions/_shared/push-cobertura-test.mjs  # 1757: un año × 7 carteras
```

El de **cobertura** defiende la promesa de la §6: que la matutina sale todos los
días hábiles para cualquier cartera. Si alguien vuelve a poner un umbral, o toca
el respaldo, ese test lo caza.

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

## 9 · Caducidad del calendario  ⚠️ (detectado el 2026-09-22)

Dos tablas están escritas a mano y **sólo llegan hasta 2027**. No es una regresión
del cambio de la §6, pero ahora que la matutina es diaria conviene tenerlo a la vista:

| Dato | Dónde | Hasta |
|---|---|---|
| Reuniones del FOMC | `FOMC_2026` en `push-rank.js` | **2026** |
| Feriados de NYSE | `FERIADOS_NYSE` en `push-common.ts` | **2027** |

Consecuencias, comprobadas corriendo el calendario año por año:

- **Desde 2027** desaparecen los 16 eventos de FOMC del año (decisión + actas).
  El evento de mayor impacto del calendario deja de existir en silencio: no falla
  nada, simplemente gana otro candidato.
- **Desde 2028** `mercadoAbierto()` devuelve `false` para *todos* los días del año
  (año no cargado → no adivinar), así que **se apagan las dos notificaciones**,
  matutina y de cierre. Es un corte seco, no una degradación.

Hay que añadir `FOMC_2027` antes de enero de 2027 y los feriados de 2028 antes de
enero de 2028.
