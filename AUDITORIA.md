# Auditoría final Portiv — 4 de agosto de 2026

Rama: `auditoria-final-prelanzamiento` (creada desde `main` @ `90f5d4f`).
Copia de seguridad: `index.html.pre-auditoria.bak` (2 091 471 bytes, idéntica al `main` de GitHub).
**No se ha hecho push. No se ha hecho merge a `main`. No se ha tocado ningún dashboard.**

---

## 0. Divergencia repo ↔ local

**Entre `/Users/rafael/Desktop/index.html` y `raw.githubusercontent.com/Rmunoz1809/Portivapp/main/index.html`: SIN DIVERGENCIA.**
Ambos: 2 091 471 bytes, 32 182 líneas, `diff` vacío (0 líneas de diferencia). Verificado antes de tocar nada.

**Pero hay una divergencia real, y no es la que se esperaba: el bundle que se envía a iOS NO es este archivo.**

| Archivo | Tamaño | Estado |
|---|---|---|
| `~/Desktop/index.html` (web / GitHub Pages) | 2 091 471 B | el auditado |
| `~/Desktop/portiv-cap/www/index.html` (bundle iOS) | 2 093 265 B | **+34 líneas, −3 líneas** |
| `~/Desktop/portiv-cap/ios/App/App/public/index.html` | 2 093 265 B | idéntico a `www/` (md5 `8eed1491…`) |

Origen: el commit **`c501038` "fix(chat): teclado ancla el chat al viewport visible; quita el pie legal del input"** tocó **únicamente** `portiv-cap/www/index.html`. Nunca se aplicó al `index.html` de la raíz.

Contenido de la diferencia (verificado línea a línea):

1. **Solo en iOS:** CSS `body.pv-kb-open` — el chat se ancla al viewport visible con el teclado abierto (`--vvh`), oculta la barra de pestañas.
2. **Solo en iOS:** `html.pv-ipad .ai-chat-header { padding-top: max(26px, …safe-area-inset-top + 14px) }` y su variante con teclado.
3. **Solo en iOS:** guard `inChat` en el script de viewport del final (limita la clase al foco dentro del chat).
4. **Solo en web:** el pie legal del chat `<div class="pv-ai-foot">Análisis generado por IA con fines educativos. No es asesoría financiera…</div>` y su CSS. **En el build de iOS ese pie fue eliminado a propósito** (así lo dice el mensaje del commit).

Consecuencias, sin resolverlas:

- La **web no tiene** el arreglo de teclado del chat ni el del header en iPad.
- El **binario que revisa Apple no muestra** ese descargo concreto bajo el input del chat. Quedan otras 8 apariciones de "No es asesoría financiera" en el bundle de iOS (verificado con `grep -c`), así que la app no se queda sin descargo — pero el del chat, que es donde la IA responde, ya no está.
- Los dos archivos evolucionan por separado. Un cambio futuro en el `index.html` de la raíz **no llega a iOS** (`cap sync` copia `www/` → `ios/`, no la raíz), y un cambio en `www/` no llega a la web.

**No lo he resuelto.** Unificar los dos archivos es una decisión de arquitectura, no un arreglo de bug, y la eliminación del pie legal fue deliberada.

---

## 1. Resumen ejecutivo

- **Fases completadas: 13,5 / 14.** La 10 (UI/responsive/i18n/tema) está incompleta a propósito: no se puede verificar sin ejecutar la app en dispositivos. Ver §7.
- **P0 encontrados: 0.** No se ha hallado ningún fallo que cause pérdida de datos, pérdida de dinero, cifras financieras erróneas persistentes, brecha de seguridad explotable sin cadena, app inutilizable, ni rechazo seguro de Apple.
- **P1: 7** — 4 arreglados, 3 pendientes (documentados con parche propuesto).
- **P2: 9** · **P3: 8**.
- **Veredicto de lanzamiento: LISTO CON RESERVAS.**

### Bloqueantes reales para enviar a App Store

Ninguno en el código de esta rama. Los tres bloqueantes son operativos y están fuera del archivo:

1. **Verificar en Supabase que las políticas RLS del SQL versionado están realmente aplicadas en producción** (§5.2). El SQL es correcto; no puedo ejecutar `select` para comprobar que está desplegado.
2. **Confirmar en Paddle que `pri_01kxps87qstgex009vr5w6z1sn` y `pri_01kxpseeyhn7d9yw29fxc6rvse` son precios LIVE** y no de sandbox (§5.1). Desde el archivo son indistinguibles.
3. **Decidir qué se hace con la divergencia web ↔ iOS** (§0). No bloquea el envío, pero cualquier arreglo que hagas ahora en `index.html` no llega al binario.

Aparte: **el checkout web no funciona** (`PADDLE_CLIENT_TOKEN` sigue con el placeholder). Esto **no** bloquea el envío a App Store —en iOS el pago va por StoreKit y Paddle ni se inicializa— pero sí significa que en portivapp.com nadie puede suscribirse. El código degrada de forma honesta (§6.4).

---

## 2. Bloqueantes (P0)

**Ninguno.**

Esta sección se deja vacía a propósito. Las cinco hipótesis de P0 que traía el encargo se comprobaron y **cuatro son falsas en esta versión del archivo**:

| Hipótesis del encargo | Realidad verificada |
|---|---|
| Falta `Purchases.logIn(session.user.id)` tras `SIGNED_IN` | **Ya está.** `_cloudLoadAndGateInner` llama a `window.PortivIAP.login(uid)` y deja `__pvPendingIapUid` para el arranque en frío. `PortivIAP.login()` → `Purchases.logIn` (`portiv-cap/src/iap.js`), idempotente por uid |
| El entitlement puede estar en minúscula (`pro`) | `ENTITLEMENT_ID = 'Portiv Pro'`, una sola aparición en el bundle enviado. Verificado en `src/iap.js` y en `www/portiv-iap.js` |
| Series sintéticas que parecen historial real | `_densifyDaily` y `_expandIntraday` **no tienen un solo call-site**. El propio archivo lo documenta. `_periodAvailable` bloquea los períodos sin datos reales |
| Claves de API en el cliente | Un solo JWT en todo el archivo: la `anon key` de Supabase (`role: anon`, pública por diseño). Cero `sk_`, `service_role`, `Bearer` literal o clave de Finnhub |
| Claves de otra cuenta sobreviven al logout | `_pvWipeLocal` **borra todo por defecto** y conserva solo una lista blanca de 3 claves. Ninguna clave de portafolio/broker/perfil puede sobrevivir por omisión |

---

## 3. Importantes (P1)

### P1-1 · ARREGLADO · El Enter en el monto saltaba la validación de efectivo insuficiente

- **Qué falla:** el resumen de compra prometía una operación distinta de la que se ejecutaba.
- **Dónde:** `requestTrade` (llamada desde el `onkeydown` del input `amt-${idx}` que genera `renderTable`).
- **Cómo reproducirlo:** portafolio con $100 de efectivo → abrir el cajón de una posición → modo Comprar → escribir `1000` → **pulsar Enter** (no el botón).
- **Impacto:** `updatePreview` sí detectaba el exceso y dejaba el botón `disabled`, pero el Enter llamaba a `requestTrade` directamente. El modal se abría mostrando *"Cash restante: −$900.00"*. Al confirmar, `buyAsset` hace `toPay = Math.min(amt, cashAvail)` y compra solo $100. El efectivo **nunca** quedaba negativo (eso está bien resuelto), pero el usuario veía cifras que no correspondían a la operación. Vender por Enter no tenía el problema: `requestTrade` ya recortaba con `Math.min(shares, h.qty)`.
- **Estado:** ARREGLADO — commit `8c6202d`. Dos líneas: `requestTrade` respeta el mismo veredicto que `updatePreview` ya calculó.

### P1-2 · ARREGLADO · Inyección de atributos en el enlace markdown del chat

- **Qué falla:** una URL en la respuesta del modelo podía cerrar el atributo `href` e inyectar atributos propios.
- **Dónde:** `_chatMarkdown`.
- **Cómo reproducirlo:** que el modelo emita `[texto](https://a.com/" onmouseover="…)`. `_chatEscape` escapa `& < >` pero **no comillas**, y la captura era `[^)]+`, que acepta `"`. El resultado se inyecta con `innerHTML` en `_aiChatAddMsg`.
- **Impacto:** ejecución de JS dentro del WebView, con acceso al `localStorage` donde vive el token de sesión de Supabase. No es directamente controlable por un atacante (hace falta que el modelo emita esa cadena), pero el contexto del chat incluye titulares de noticias de terceros — es exactamente la cadena de inyección de prompt que describe la Fase 8.6.
- **Estado:** ARREGLADO — commit `9192b5d`. Se restringe la clase de caracteres de la URL a `[^)"'\`<>\s]+`. Ninguna URL legítima usa esos caracteres.

### P1-3 · ARREGLADO · La URL de las fuentes web se interpolaba sin ningún escape

- **Qué falla:** `s.url` se metía cruda dentro de `href="${s.url}"`.
- **Dónde:** `_aiChatAddMsg`, construcción de `srcHtml`.
- **Cómo reproducirlo:** una respuesta con `sources` cuya `url` contenga una comilla doble.
- **Impacto:** igual que P1-2, pero peor: aquí **no había escape de ningún tipo**. El título sí pasaba por `_chatEscape`; la URL no.
- **Estado:** ARREGLADO — commit `34ae59e`. Se envuelve en `pvEsc()`, que sí escapa comillas.

### P1-4 · ARREGLADO · Eliminar la cuenta no desvinculaba RevenueCat

- **Qué falla:** `_acctDeleteAccount` no llamaba a `_pvIapLogout()`.
- **Dónde:** `_acctDeleteAccount`.
- **Cómo reproducirlo:** en un iPhone, cuenta A con suscripción activa → Ajustes → Eliminar cuenta → registrarse como cuenta B en el mismo dispositivo.
- **Impacto:** la identidad del SDK de RevenueCat vive en el lado nativo, así que el `localStorage.clear()` de esa función no la toca. El dispositivo seguía identificado como la cuenta borrada hasta que el gate de B ejecutase `PortivIAP.login(uidB)`. El comentario del propio `_pvIapLogout` dice que se llama "en TODO cierre de sesión: manual, cuenta eliminada y la salida del muro" — pero en la rama de cuenta eliminada **desde Ajustes** faltaba. Sí estaba en `_authLogout` y en la detección de cuenta borrada del arranque.
- **Estado:** ARREGLADO — commit `c789de7`. Una línea, calcada de `_authLogout`.

### P1-5 · PENDIENTE · El candado del cliente ignora `expires_at`

- **Qué falla:** `_pvSubStatus` decide el acceso solo con `entitlement_active === true`; nunca compara `expires_at` con la fecha actual.
- **Dónde:** `_pvSubStatus` y `_pvSubGate`.
- **Cómo reproducirlo:** fila en `subscriptions` con `entitlement_active = true`, `status = 'canceled'`, `expires_at` en el pasado (webhook de expiración perdido o retrasado; `entitlement-sweeper` aún no ha pasado).
- **Impacto:** `_pvSubGate` entra en la rama `st.active && STATUS_WARN[st.status]` → llama a `_unblock()` y pinta *"Conservas el acceso hasta el \<fecha ya pasada\>"*. El usuario ve la app desbloqueada, pero **el servidor sí comprueba la fecha**: `has_active_entitlement()` devuelve `false` pasadas 48 h de `expires_at`, así que SnapTrade y la IA responden `403 subscription_required`. Resultado: la app parece funcionar y nada funciona, y el mensaje que explica por qué nunca aparece porque `snapConnect` deriva el 403 a `_pvSubGate()`, que vuelve a leer la misma fila y a desbloquear. Bucle sin salida ni explicación.
  La cuenta cancelada-pero-vigente (el caso que sí quería el diseño) **funciona correctamente**: `expires_at` futuro, acceso conservado, banner con la fecha.
- **Estado:** PENDIENTE. **No lo he tocado** porque el arreglo cambia comportamiento visible (empieza a bloquear usuarios) y hay dos criterios posibles: replicar el colchón de 48 h del servidor, o cortar en seco en `expires_at`. Esa decisión es tuya.
  Parche propuesto (replicando el criterio del servidor, dentro de `_pvSubStatus`, justo después de construir `srv`):
  ```js
  // Mismo criterio que has_active_entitlement(): la fecha manda aunque el webhook de
  // expiración no haya llegado. 48 h de colchón por desfase de reloj y retraso de Apple.
  if (srv.active && srv.expiresAt) {
    var _exp = Date.parse(srv.expiresAt);
    if (isFinite(_exp) && _exp < Date.now() - 48*3600*1000) srv.active = false;
  }
  ```

### P1-6 · PENDIENTE · El candado del servidor falla ABIERTO si el RPC falla

- **Qué falla:** `requireEntitlement` e `isEntitled` devuelven "con derecho" cuando la llamada a `has_active_entitlement` da error.
- **Dónde:** `supabase/functions/_shared/snaptrade.ts`, funciones `requireEntitlement` (línea con el comentario `rpc failed (fail-open)`) e `isEntitled`.
- **Cómo reproducirlo:** provocar un error del RPC (Postgres saturado, la función SQL sin `grant execute`, migración a medias) y llamar a `snaptrade-connect` sin suscripción.
- **Impacto:** un usuario sin pagar puede enlazar un broker. Cada conexión activa cuesta ~$1/mes de forma indefinida — no es un fallo puntual, es un coste recurrente. La Fase 4 del encargo pide explícitamente fallo CERRADO para las funciones de coste. El cliente también falla abierto (`_pvSubStatus` devuelve `null` → `_pvSubGate` no bloquea), así que **no hay ninguna capa que falle cerrado**.
- **Estado:** PENDIENTE. Está documentado en el código como decisión consciente ("don't punish the user for our outage"), y cambiarlo es un cambio de política de producto, no un arreglo de bug. Mi recomendación: **fallo cerrado solo en `snaptrade-connect`** (crear una conexión nueva es lo único que genera coste nuevo y no tiene urgencia; refresh/history pueden seguir abiertos para no cortar a quien ya paga). Un `throw { status: 503, message: 'entitlement_check_unavailable' }` en el `if (error)` de `requireEntitlement`, invocado solo desde `snaptrade-connect`, resolvería la fuga sin afectar a nadie que ya esté conectado.

### P1-7 · PENDIENTE · Contenido de noticias sin escapar en `innerHTML`

- **Qué falla:** títulos, resúmenes y descripciones de noticias se interpolan en `innerHTML` sin escape HTML.
- **Dónde:** al menos 18 puntos distintos. Los más claros: `${ev.description||ev.summary||'Sin descripción disponible.'}` en el modal de evento del outlook; `${t.title||''}` en `_renderWeeklyOutlook`; `${n.summary}`; `${e.title}` / `${e.description||''}` en el render de catalizadores.
- **Cómo reproducirlo:** que Finnhub (o el modelo que genera el feed) entregue un titular con `<img src=x onerror=…>`. `_cleanNewsText` limpia `<cite>`, artefactos de tooling y fences de markdown, pero **no escapa HTML**, y `_mergeNews` tampoco sanea al ingerir.
- **Impacto:** mismo alcance que P1-2/P1-3 (XSS en el WebView). Probabilidad baja —hace falta que entre por el feed de un tercero— pero la superficie es amplia.
- **Estado:** PENDIENTE. **No lo he tocado**: el arreglo correcto toca ~18 funciones de render y cambiaría el comportamiento en los sitios donde hoy se inyecta HTML a propósito (negritas, enlaces). Un `pvEsc()` a ciegas rompería esos.
  Parche propuesto, en dos pasos y en este orden:
  1. Sanear **al ingerir**, no al renderizar: en `_mergeNews`, dentro de `add(item)`, pasar `item.title`, `item.summary`, `item.description` por `pvEsc()` una sola vez. Es un punto único y todo el feed pasa por ahí.
  2. Revisar después los 4-5 sitios donde un título saneado se muestre con entidades visibles (`&amp;` en vez de `&`) y ajustar solo esos.

---

## 4. Menores (P2) y cosméticos (P3)

### P2

1. **`fh_api_key` sobrevive al cambio de cuenta.** `_PV_KEEP_EXACT = { portiv_lang, portiv_theme, fh_api_key }`. No es dato de portafolio/broker/perfil, así que no es P0, pero es una credencial de A que B hereda en el mismo dispositivo: las llamadas de B se facturarían a la cuenta Finnhub de A. Decidir si se queda en la lista blanca.
2. **Mensaje de error de login dirigido al desarrollador.** `_authSignin`, rama de correo no confirmado: *"Desactiva \"Confirm email\" en Supabase o confírmalo desde el correo."* Un usuario final no tiene acceso al panel de Supabase.
3. **`usd()` no protege contra `NaN`.** `Math.abs(NaN).toLocaleString()` → `"$NaN"`. Los llamadores principales pasan valores ya pasados por `round2` (que sí neutraliza `NaN`), pero cualquier llamada directa con un valor crudo puede pintar `$NaN`.
4. **`_renderWeeklyOutlook` / `_renderOutlookEmpty` no pintan nada.** Ambas hacen `getElementById('weekOutlookContent')` y `if (!wrap) return`. Ese id **no existe en ningún sitio del documento** (verificado sobre los 367 ids, incluidos los generados por JS). Lo mismo con `weekOutlookVolBadge` y `weekOutlookDate`. La función que sí funciona es `_renderNextWeekOutlook`, que escribe en `#nextWeekNews` (ese sí existe). Los efectos colaterales de `_buildWeeklyOutlook` (sembrar `weekly_outlook_<wk>` en localStorage) siguen ocurriendo, así que la funcionalidad no se pierde — pero hay una ruta de render entera muerta. **No borrada**, según las reglas.
5. **`r-projections` / `r-projections-card` tampoco existen.** La tarjeta de proyecciones nunca se pinta (`if (!card || !el) return`). Ruta muerta, protegida con guard. **No borrada.**
6. **`snapBanner` no existe en el DOM** pero tiene 5 reglas CSS y dos funciones que lo buscan. El banner de "conecta tu broker" en el portafolio nunca aparece; la tarjeta de Ajustes sí. **No borrado.**
7. **`_isWeekend()` / `_isWeekday()` usan la hora del dispositivo, no ET.** `new Date().getDay()`. En Panamá (UTC−5) frente a ET de verano (UTC−4) hay una hora de desfase: viernes 23:30 en Panamá ya es sábado en ET. Se usan en dos sitios del outlook (líneas de `_runDailyOutlookRefresh` y del constructor de semana), no en el cálculo del cambio del día. Efecto acotado a una ventana de 60 minutos al día.
8. **El bundle de iOS contiene la clave `test_` de RevenueCat como string muerto.** `RC_KEYS = { test: 'test_…', prod: 'appl_…' }` se empaqueta entero. En ejecución se usa la de producción (`RC_ENV_DEFAULT = 'prod'`, verificado en el bundle). No es un fallo funcional, pero significa que el bundle enviado se generó con `npm run build:iap` y **no** con `build:iap:prod` — cuyo guard, según su propia documentación, rechaza un bundle que contenga `test_`. Ese guard nunca corrió.
9. **`window.prompt()` para confirmar el borrado de cuenta.** `_acctDeleteAccount` pide escribir "ELIMINAR" con `window.prompt`. Funciona en WKWebView, pero es un diálogo del sistema sin estilo dentro de una app que cuida mucho la presentación, y algunos contextos de WebView lo suprimen (si lo suprimiera, `typed == null` → la función retorna y **no** borra nada: degrada de forma segura).

### P3

1. **Verde decorativo, posible violación de la regla 6.** Cuatro casos concretos: `#12d18e` en el botón "Reintentar" del panel de arranque fallido; `var(--green, #16a34a)` en el toast *"¡Listo! Tu suscripción Portiv Pro está activa."*; `'#0A7A52'` en la barra "Capacidad (objetiva)" del cuestionario de perfil; `var(--green,#0A7A52)` en el texto *"API key configurada ✓"* de Ajustes. Ninguno es un dato financiero. **Reportados, no cambiados.**
2. **`PV_SYNTHETIC_DENSIFY = true`.** El interruptor que habilita los puntos inventados está en `true`. Hoy da igual porque `_densifyDaily` no se llama desde ningún sitio, pero deja armada una trampa para quien la conecte en el futuro.
3. **`rel="noopener"` sin `noreferrer`** en los enlaces del chat y de las fuentes.
4. **`renderTxLog()` no oculta la sección cuando el log queda vacío** (`if (TX_LOG.length === 0) return;` sale antes de tocar el DOM).
5. **`_todayET()` cae a la fecha UTC** si `PORTIV_NEWS.nyParts()` falla (`new Date().toISOString().slice(0,10)`). Solo es fallback; después de las 20:00 ET daría el día siguiente.
6. **`exportPortfolioReport` no está definida.** El botón "Exportar Reporte" usa `(typeof exportPortfolioReport==='function') ? … : window.print()` → siempre cae a `window.print()`. Funciona, pero el nombre sugiere una función que no existe.
7. **`currEUR` / `currUSD` no existen**; `document.getElementById('currEUR')?.…` hace que la divisa sea siempre `'USD'`. Protegido con `?.`, sin error.
8. **El pie legal de la IA del chat solo está en web** (ver §0).

---

## 5. Acciones manuales para Rafael

### 5.1 Paddle

1. **Token client-side.** `window.PADDLE_CLIENT_TOKEN = 'PADDLE_LIVE_CLIENT_TOKEN'` (placeholder). Obtenerlo en **vendors.paddle.com → Developer Tools → Authentication → Client-side tokens**, copiar el que empieza por `live_` y sustituir esa cadena. Es el único sitio del archivo donde vive. Hasta entonces el checkout web queda deshabilitado con un mensaje honesto (verificado, §6.4). **No he inventado ningún valor.**
2. **Verificar que los priceIds son de producción.** En **Paddle → Catalog → Products → \<producto\> → Prices**, confirmar que existen y están *Active* en el entorno **Production**:
   - `pri_01kxps87qstgex009vr5w6z1sn` — USD 4.99/mes con 30 días de prueba
   - `pri_01kxpseeyhn7d9yw29fxc6rvse` — USD 49.99/año
   Los IDs de sandbox tienen exactamente el mismo formato: desde el archivo es imposible distinguirlos.
3. **Verificación de negocio y dominio.** Paddle no libera checkout en producción hasta aprobar la cuenta y verificar el dominio (**Checkout → Website approval**, añadir `portivapp.com`).
4. **Webhook.** Confirmar que `paddle-webhook` está suscrito a `transaction.completed`, `subscription.updated`, `subscription.canceled` y que el secreto de firma coincide con el de Supabase.

### 5.2 Supabase — verificación de RLS (lo más importante de esta lista)

El SQL versionado es correcto: `supabase/sql/01-subscriptions-ios.sql` activa `enable row level security` + `force row level security` sobre `subscriptions`, borra cualquier policy previa, crea **solo** `sub_select_own` (SELECT) y **no crea ninguna policy de escritura** para `authenticated`/`anon`. Lo que no puedo comprobar es que esté **desplegado**. Ejecuta esto en **Supabase → SQL Editor**:

```sql
-- 1) Debe devolver EXACTAMENTE una fila: sub_select_own / SELECT.
--    Si aparece cualquier INSERT/UPDATE/ALL para authenticated o anon, cualquiera
--    puede regalarse la suscripción escribiendo su propio entitlement_active.
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'subscriptions';

-- 2) RLS activada Y forzada (rowsecurity y relforcerowsecurity ambos true).
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('subscriptions','profiles','profile_caches','shared_analysis');

-- 3) La función del candado existe, es SECURITY DEFINER y no la puede ejecutar anon.
select p.proname, p.prosecdef,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_puede
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'has_active_entitlement';
-- Esperado: prosecdef = true, anon_puede = false, auth_puede = true.

-- 4) Comprobación de que la fecha manda (P1-5): debe devolver false.
--    Sustituye <UID> por un usuario de prueba y pon expires_at en el pasado antes.
-- select has_active_entitlement('<UID>'::uuid);
```

Además, documentar/verificar las políticas de las otras tablas que toca el cliente:

| Tabla | Lectura | Escritura | Qué debería tener |
|---|---|---|---|
| `subscriptions` | propia fila | **ninguna** | SELECT `user_id = auth.uid()`; escritura solo `service_role` |
| `profiles` | propia fila | propia fila | SELECT/UPDATE/DELETE `id = auth.uid()`; el cliente hace `upsert` y `delete` |
| `profile_caches` | propia fila | propia fila | SELECT/UPSERT `user_id = auth.uid()` |
| `shared_analysis` | **todos** (autenticados) | autenticados | Caché compartida por diseño: cualquier usuario autenticado escribe. Es el único sitio donde un usuario puede afectar lo que ven los demás — si algún día se abusa, la salida es mover la escritura a una Edge Function |

### 5.3 App Store Connect

1. **App Store Server Notifications V2** → apuntar a la URL de `rc-webhook` (o a la de RevenueCat, según cómo lo tengas montado). Sin esto, las renovaciones y cancelaciones no llegan y la fila de `subscriptions` se queda vieja — que es justo el escenario de P1-5.
2. **In-App Purchase Key** (Users and Access → Integrations → In-App Purchase) cargada en RevenueCat.
3. **Productos** `com.portivapp.portafolio.mensual` / `.anual` en estado *Ready to Submit* y adjuntos a la build.
4. **Cuenta de demo para App Review:** `review@portivapp.com`, con suscripción Pro hasta 2027-08-02 y portafolio sembrado (7 posiciones). Verificar que sigue viva antes de enviar.

### 5.4 RevenueCat

1. **Entitlement:** confirmar en **Product catalog → Entitlements** que el *Identifier* es literalmente `Portiv Pro` (con espacio y mayúsculas). El código indexa `info.entitlements.active['Portiv Pro']`; cualquier otra variante devuelve `undefined` y deja bloqueado a quien pagó.
2. **Offering:** `default` con los packages `$rc_monthly` y `$rc_annual`.
3. **Transfer behavior:** revisar la política de transferencia de compras entre App User IDs (Project settings). Con el arreglo P1-4 el `logOut()` ya se hace siempre, pero esta opción decide qué pasa cuando dos cuentas comparten el mismo Apple ID.
4. **Clave del SDK:** el bundle usa `appl_zfKbgdFDEuQbqaRzGzRQQKayUSr` (pública por diseño, verificada en el binario). Si la regeneras, hay que reconstruir el bundle.

### 5.5 Build de iOS

Si vuelves a generar el bundle, usa `npm run sync:prod` (no `npm run sync`) para que corra el guard que rechaza claves `test_`. El bundle actual se generó sin él (ver P2-8).

---

## 6. Verificado y correcto

Esto se comprobó de verdad, con la evidencia entre paréntesis. No hace falta volver a auditarlo.

### 6.1 Integridad estática (Fases 0 y 1)

- **Sintaxis: 0 errores.** 18 etiquetas `<script>` (17 inline + `vendor/supabase.js`), cada bloque extraído a un archivo y pasado por `node --check`. También `vendor/supabase.js`. Repetido **después** de mis cambios: sigue en 0.
- **Inventario:** 32 200 líneas (32 182 antes de los arreglos), 2,09 MB, 664 declaraciones `function X` (654 nombres únicos).
- **Archivos hermanos:** `vendor/supabase.js` ✅, `vendor/chart.umd.min.js` ✅, `privacidad.html` ✅, `terminos.html` ✅, `reembolsos.html` ✅, `precios.html` ✅, `soporte.html` ✅, `icon.png` ✅, `fonts/fonts.css` + 2 `.woff2` ✅. **Ningún 404.** `portiv-iap.js` y `manifest.json` no están en la raíz: el primero se inyecta solo en plataforma nativa (el IIFE hace `return` si no es Capacitor) y existe en `portiv-cap/www/` ✅; el segundo no se referencia en ningún sitio.
- **Handlers inline huérfanos: 0.** 250 atributos `on*`, 97 identificadores únicos, todos con definición global alcanzable. El único sin definición (`exportPortfolioReport`) está protegido con `typeof … === 'function'` y cae a `window.print()`.
- **Funciones duplicadas: 9 nombres, todas en scopes distintos, ninguna colisión.** `apply` ×3 (IIFE del layout iPad / `_settingsBoot` / IIFE de SharedNews), `setMode` ×2 (global del cajón de operaciones vs. dentro del IIFE de auth que arranca en `(function(){` — verificado), y `_cloudGet`, `_cloudSet`, `_lockGet`, `_acquireLock`, `_releaseLock`, `_rerender`, `forceRefresh` ×2 cada una, en los IIFEs de SharedNews y de WeeklyOutlook. **Ninguna en el mismo ámbito global.**
- **IDs de DOM duplicados: 0 reales.** 367 ids únicos. Los dos candidatos son falsos positivos: `eps-` viene de `id='eps-'+ctx+'-'+ticker` dentro de una cadena JS, y los tres `snapRefreshBtn2` viven en ramas `return` mutuamente excluyentes de `_cardHTML`.
- **Referencias a ids inexistentes: 12, todas protegidas** (`?.`, `if (!el) return`, `if (el)`). Cero `TypeError` posibles. La consecuencia funcional está en P2-4/5/6.
- **Globales accidentales: 0.** 45 candidatos del escáner, los 45 resueltos a declaraciones `let`/`var` multi-nombre en el mismo scope (`let _mem = undefined, _gen = false, _failed = false, _lockId = null, _researched = false;` y similares).

### 6.2 Arranque y gate (Fase 2)

Cadena real, trazada en orden de ejecución:

```
<head> IIFE red de seguridad (arma temporizador de 10 s)
  └─ handlers globales 'error' y 'unhandledrejection' → SOLO guardan el motivo
<head> IIFE layout iPad · IIFE Paddle (return si nativo) · IIFE inyector portiv-iap.js (return si NO nativo)
<script src="vendor/supabase.js">        ← SÍNCRONO, sin defer/async. No tocado.
IIFE de auth
  ├─ sb.auth.getSession()
  │    ├─ .then sin sesión ────────────────────────────────► showLogin()            → app revelada (overlay)
  │    ├─ .then con sesión → _gatePrefetchFor(uid) ∥ getUser()
  │    │    ├─ getUser 403 / "not exist" → _pvKilled → nuke → signOut → _pvIapLogout → location.reload()
  │    │    ├─ getUser error de red ────► .catch → cloudLoadAndGate(s)              → app revelada
  │    │    └─ getUser OK ──────────────► cloudLoadAndGate(s)
  │    └─ .catch (sesión corrupta / storage en modo privado) ► showLogin()          → app revelada
  └─ onAuthStateChange → cloudLoadAndGate(s) | showLogin(purge)

cloudLoadAndGate  (guard _gateRunning: la 2ª pasada concurrente se descarta)
  └─ _cloudLoadAndGateInner
       ├─ bind distinto → _purgeAccountLocal() + location.reload()   [ÚNICO reload del gate]
       ├─ r.error (RLS/red/500) → revealApp() + 1 solo reintento a 5 s              → app revelada
       ├─ nube presente → last-writer-wins (pv_port_saved_at vs updated_at)
       ├─ rescate sin fila en la nube → sube el rescate
       ├─ cuenta nueva → EMPTY_STATE + upsert
       └─ revealApp()                                                              → app revelada
```

- **Toda ruta de salida revela la app o muestra el login.** Enumeradas las 7 ramas del diagrama: ninguna termina en pantalla en blanco.
- **Red de seguridad de 10 s: válida y vigente.** Comprueba `app-locked` **y** `overlayVisible()` (existencia + `display` + `visibility` + `opacity` + `offsetHeight > 0`). Dibuja un panel con estilos en línea y colores literales, colgado de `document.documentElement` (no de `<body>`, que puede no existir). No quita `app-locked` — decisión correcta: revelar sin gate mostraría datos de otra cuenta.
- **Bucle de recargas: imposible.** Solo queda **un** `location.reload()` en el gate (cambio de bind), y es autoextinguible: escribe `pv_bound_uid` **antes** de recargar, así que en la segunda pasada el bind coincide. Los otros dos reloads que había se sustituyeron por `_pvReinitFromLocal()`. El reload de logout va tras `signOut`, sin sesión que reactive el gate.
- **Idempotencia:** `cloudLoadAndGate` tiene `_gateRunning`; `_ensurePaddle` comparte promesa (`_paddleLoading`); `initPaddle` sale si `!window.Paddle`; `PortivIAP.login` es idempotente por uid (`_idUid`/`_idPromise`); `_aiAnalystInit` tiene `_aiAnalystReady`; `_boot` de SnapTrade tiene un solo call-site.
- **Timers con tope: todos.** `initPaddle` 100 intentos ≈ 6 s; `_pvAwaitIAP` 8 s con una sola reinyección; `go()` de `_boot` tiene `_sbTries<50`, `_authTries<10`, `_syncTries<100`, `_unavailTries<12`; `_bindIapOnChange` 20 intentos; `_pvAwaitEntitlement` 20 s; `_watchTick` se autolimpia (`clearInterval` cuando la lista queda vacía). De los 13 `setInterval`, 11 llevan guard `document.hidden` y/o `isMarketOpen()`. **Ningún timer sin tope ni sin condición de parada.**

### 6.3 Autenticación (Fase 3)

- **Nonce de Apple: emparejamiento correcto.** `_appleGenNonce()` genera 16 bytes hex; a `ASI.authorize({ nonce: hashedNonce })` va el **SHA-256**; a `sb.auth.signInWithIdToken({ nonce: rawNonce })` va el **crudo**. Es el orden correcto y es el fallo que solo se ve en producción. Está bien.
- **Nonce de Google: correcto y documentado.** El plugin copia el nonce verbatim al claim del `id_token`, así que va el **crudo en ambos lados**. El comentario del código explica por qué difiere de Apple.
- **Bifurcación web/nativo:** los dos proveedores usan `signInWithOAuth` (redirect) en web y SDK nativo + `signInWithIdToken` en Capacitor, con el motivo documentado (Safari externo rompe el code verifier de PKCE del WKWebView).
- **Botones nunca se quedan en "cargando".** `_authSignup` y `_authSignin` restauran `disabled` y texto en un `finally`. `_authAppleSignin` y `_authGoogleSignin` los restauran tanto en la salida por éxito nativo como en el `catch` (en el camino web no se restauran a propósito: el navegador ya se fue a apple.com / accounts.google.com). `_authForgot` no toca ningún botón — solo escribe con `setMsg` en las tres salidas —, así que no tiene estado que restaurar. Las cancelaciones del diálogo nativo se detectan por código (`1001`, `12501`, `SIGN_IN_CANCELLED`, `popup_closed`) y **no** se muestran como error.
- **Limpieza de localStorage al cambiar de cuenta: correcta por construcción.** No es una lista de claves a borrar (que se puede quedar corta); `_pvWipeLocal` recorre **todo** `localStorage` y `sessionStorage` y borra todo salvo una lista blanca de 3 claves (`portiv_lang`, `portiv_theme`, `fh_api_key`) más, opcionalmente, el token de sesión (`^sb-|^supabase\.auth`), `pv_bound_uid` y `pv_port_rescue`. **Ninguna de las 40+ claves del encargo puede sobrevivir por omisión.** Verificadas contra las 32 claves literales que la app escribe. La única discutible es `fh_api_key` (P2-1).
- **`pv_bound_uid`:** versionado (`v2:<uid>`), comparado **antes** de aplicar nada de la nube; si no coincide → purga + reload. El estado de la nube no puede aplicarse a un uid distinto del que lo guardó.
- **Rescate de ediciones no sincronizadas:** `pv_port_rescue` va etiquetado con el uid dueño y solo se reclama si vuelve **ese** usuario (`_rs.uid === s.user.id`); si es de otro se descarta sin leerlo. La clave se consume siempre.
- **Borrado de cuenta: el orden es el correcto y falla seguro.** Desconecta el broker **primero** y **aborta** si falla con un error real (evita el usuario SnapTrade huérfano que sigue costando ~$1/mes); un 404 "sin usuario SnapTrade" no bloquea el borrado (Guideline 5.1.1(v)). Solo después borra la fila de perfil, llama a `delete-account`, cierra sesión y limpia. Si `delete-account` falla, salta al `catch` → alerta + reload **sin** haber limpiado local: el usuario conserva sus datos y su cuenta sigue viva. Correcto.
- **Doble confirmación de borrado:** `confirm()` + escribir "ELIMINAR" en mayúsculas.

### 6.4 Suscripción y candado (Fase 4)

- **`_pvPaddleReady()` devuelve `false` con el placeholder.** `/^live_/.test('PADDLE_LIVE_CLIENT_TOKEN') || /^test_/.test(…)` → `false`. Verificado.
- **Toda ruta al checkout comprueba el flag antes de abrir nada.** `_pvStartCheckout` lo comprueba en su tercera línea y muestra *"El pago web no está disponible en este momento. Escríbenos a rm@portivapp.com y lo resolvemos."*. `initPaddle` también sale con `console.error` si el token no es válido. **No hay overlay roto ni botón muerto.**
- **En Capacitor nativo Paddle no se inicializa nunca.** El IIFE hace `return` en su primera línea si `isNativePlatform()`, y `_pvStartCheckout` redirige al paywall nativo antes de cualquier otra cosa. Doble defensa. Sin riesgo de Guideline 3.1.1 por esta vía.
- **Cero tokens de sandbox en el archivo.** Buscado `test_3c9a0fa251a22ce22645e35a21f`, `test_`, `sandbox`: solo aparece el `test_` del regex de `_pvPaddleReady`.
- **`_pvCheckoutCompleted` se consume correctamente.** `checkout.completed` lo pone a `true`; el `checkout.closed` posterior lo detecta, lo devuelve a `false` y sale sin toast. `_pvStartCheckout` lo resetea al empezar cada intento, así que no puede quedar en `true` bloqueando un abandono posterior. **Los dos escenarios del encargo están cubiertos.**
- **`Purchases.logIn` se llama en el punto correcto.** En `_cloudLoadAndGateInner`, que es "el único punto por el que pasan las tres transiciones sin sesión → con sesión". Sin `await` (un fallo del SDK no puede retrasar la entrada) y con `__pvPendingIapUid` para el arranque en frío donde `portiv-iap.js` (defer) aún no cargó. `_pvRestorePurchases` vincula **antes** de restaurar y luego llama a `_pvEntitlementSync(true)`: orden `logIn → restore → sync` ✅.
- **`_pvIapLogout` en todos los cierres de sesión:** `_authLogout` ✅, cuenta borrada detectada en el arranque ✅, salida del muro del candado ✅, y **cuenta eliminada desde Ajustes** ✅ tras el arreglo P1-4.
- **`_pvRestorePurchases` maneja objeto y booleano.** Ninguna rama devuelve `undefined` tratado como `true`.
- **Cancelada-pero-vigente conserva el acceso.** `STATUS_OK` incluye `canceled`; `STATUS_WARN` la manda a la rama que hace `_unblock()` y pinta *"Conservas el acceso hasta el \<fecha\>"* con `_fmtDate`. Implementado de verdad, no solo comentado. (El caso con `expires_at` pasado es P1-5.)
- **`past_due` conserva el acceso** a propósito, con banner distinto en iOS (Apple reintenta; no se promete un checkout propio → evita Guideline 3.1.1).
- **`snapConnect` es inalcanzable sin entitlement por la ruta normal.** Cliente: los 3 puntos de entrada pasan por el paywall o por `_pvAwaitEntitlement` (que solo llama a `snapConnect()` si `st.active`). Servidor: `snaptrade-connect` llama a `requireEntitlement(admin, userId)` en su tercera línea, igual que `snaptrade-history`; `snaptrade-cleanup` revalida antes de actuar. (La excepción es el fallo del RPC → P1-6.)
- **El 403 se maneja como candado, no como transporte.** `stCall` adjunta `_e.status = r.status`; `snapConnect` detecta `/subscription_required/i` y deriva a `_pvSubGate()` **sin reintentar**; `snapRefresh` comprueba `_st===403 && /subscription_required/i` y hace lo mismo. Ninguno lo trata como error de red con reintento.
- **Ventana de espera tras el pago con techo y mensaje honesto.** `_pvAwaitEntitlement`: en nativo pregunta primero a `entitlement-sync` (resuelve incluso el webhook perdido), luego sondea 20 s. Si expira: *"Pago recibido. Estamos confirmando tu suscripción, puede tardar un minuto."* — **no afirma que el pago falló** — y reprograma `_pvSubGate()` a 15 s. Nunca se cobra sin dejar el camino abierto.
- **El candado real está en el servidor** y el código lo dice explícitamente: forzar el DOM desde la consola no da acceso a nada, porque las Edge Functions responden 403 igual.

### 6.5 SnapTrade (Fase 5)

- **`stCall` normaliza los errores con `.status`** y con el `error` del cuerpo JSON. Sin sesión lanza *"Inicia sesión para conectar tu broker."* antes de tocar la red.
- **Cada estado tiene su tarjeta y su mensaje en español**, todos distintos y todos accionables: `unavailable` ("No pudimos consultar tu broker" + Reintentar), `offline` ("Sin conexión con Portiv"), `unknown` (comprobando), `syncing` (con variante "está tardando más de lo normal" cuando se agota el poll de ~14 min), `connected`, `broken` ("Reconecta tu broker" + aviso de que los datos no se actualizarán), `disconnected` por fin de suscripción (banner específico con "Reactivar"). **Ningún spinner eterno y ningún "algo salió mal" genérico.**
- **`snapMapHoldings` cubre los casos límite bien.** Verificado uno a uno: sin ticker → se descarta y se registra en `_dropped`; precio ausente (fondos monetarios, mutual funds, cripto en algunos brokers) → se deriva de `market_value/units` en vez de dejar la fila en 0 y hundir el total; `avg_cost` ausente → **`null`, no 0** (0 sería un coste válido aguas abajo y el rendimiento mostrado sería ficción); opciones en `option_positions`, fuera de `positions`; `_n()` normaliza `{amount}` y devuelve 0 si no es finito, así que **ningún campo puede producir `NaN`**; `_snapAssetType` mapea los códigos cortos reales de SnapTrade (`cs`, `et`, `mf`, `oef`, `cef`, `crypto`, `bnd`) — el regex anterior no matcheaba ninguno y todo caía en 'stock'.
- **Duplicados por cuenta:** se agregan por ticker **antes** de entregar a `aiPortImportData` (que descarta tickers repetidos). AAPL en brokerage + AAPL en la Roth IRA ya no pierde la segunda.
- **Divisas: no hay mezcla silenciosa.** `_ccyOf` agrupa por divisa, elige la dominante por valor y **excluye** el resto del total, avisando en la tarjeta: *"Tu total está en \<X\> y no incluye \<Y\>. No convertimos divisas: preferimos no enseñarte una cifra inventada."* Es exactamente lo contrario del P0 que buscaba el encargo.
- **Total parcial detectado:** si `balance.total` solo cubre parte de las cuentas, se descarta y se reconstruye desde `cash + Σ market_value`.
- **Doble conexión: bloqueada en dos capas.** `_setBusy(true)` deshabilita todos los `[data-snap-connect]` mientras corre, y el servidor devuelve `alreadyConnected` → el cliente no abre el portal, hace un `snapRefresh({force:true})` y avisa. No se puede duplicar el coste con doble clic.
- **`snapDisconnect` existe como acción propia** (antes la única vía era borrar la cuenta entera, y quien se iba sin borrarla seguía costando ~$1/mes).
- **`window._snapState`** lo lee `onAuthStateChange` con debounce de 30 s para resincronizar tras un login en la misma carga (`_snapAuthRefreshAt`), y solo si el estado **no** es `connected`. No queda en un estado que impida sincronizar.

### 6.6 Matemática del portafolio (Fase 6)

Los 11 casos del encargo, calculados a mano contra el código:

| Caso | Resultado |
|---|---|
| Comprar 3 acciones a $33.33 | ✅ `3 × 33.33 = 99.99000000000001` → `round2` → `99.99`. El total suma valores **ya redondeados por fila**, así que Σ(filas) == subtotales == total, al centavo |
| Vender más de lo que se tiene | ✅ `updatePreview` avisa y deshabilita; `sellAsset` recorta con `Math.min(amt/price, h.qty)`. Cantidad negativa imposible |
| Vender exactamente todo | ✅ `sellAll = amt >= mktVal - 0.01` → `newQty = 0` → `removeEmptyPosition` (umbral `qty <= 0.00001`) y destruye el donut para reconstruirlo limpio |
| Efectivo insuficiente para comprar | ⚠️ Rechazado por el botón; **por Enter no lo era** → P1-1, arreglado. El efectivo **nunca** quedaba negativo (`Math.max(0, …)` en `updateCashBalance`, `Math.min(amt, cashAvail)` en `buyAsset`) |
| Retirar más efectivo del disponible | ✅ `confirmCashOp`: `if (_cashOpType==='withdraw' && amt > cash) { _cashCalcPreview(); return; }` |
| Portafolio vacío | ✅ `calcTotals` → `{0,0,0,0}`; `reconcilePctTo100([])` → `[]` (guard `if (!(total>0))`); `calcH` protege `glPct` con `costBasis > 0`. Sin `NaN`, sin división por cero |
| Una sola posición | ✅ `reconcilePctTo100([v])` → `floored=[100.0]`, `deficit=0` → `100.0%` exacto |
| 3 posiciones de 1/3 | ✅ `[33.3, 33.3, 33.3]` = 99.9, déficit 1 décima, se asigna al mayor resto → `[33.4, 33.3, 33.3]` = **100.0** exacto (largest remainder) |
| Precio `null`/`undefined` de la API | ✅ `_validPrice(p)` exige `typeof number && isFinite && > 0`. `sanitizeHoldings()` se ejecuta **dentro de `calcTotals`** y antes de guardar: ningún precio inválido llega al total |
| 0.0001 acciones | ✅ El umbral de borrado es `0.00001`; 0.0001 sobrevive |
| $10M+ | ✅ `usd()` usa `toLocaleString('en-US')` → `$10,000,000.00`, sin notación científica |

- **`parseFloat` sobre entrada de usuario: todos guardados.** Revisados los 6 sitios que leen inputs (`buyAsset`, `sellAsset`, `requestTrade`, `updatePreview`, `_addCalcPreview`, `confirmCashOp`). Todos usan `if (!val || val <= 0) return` o `isFinite(raw) && raw > 0` — y `NaN` es *falsy*, así que el patrón `!amt` lo captura. `round2(n)` hace `(+n||0)`, que neutraliza `NaN` en la última capa. **No he encontrado ni un `parseFloat` sin protección aguas abajo.**
- **Locks: todos liberados en `finally`.** Los 2 pares `_acquireLock`/`_releaseLock` (SharedNews y WeeklyOutlook) liberan en `finally`. Además el lock es **remoto y con TTL** (`_sharedWrite('lock', …, { ttl })`), así que ni siquiera un cierre brusco de la app puede congelar los guardados para siempre.
- **Conflicto local ↔ nube: last-writer-wins con timestamp persistido.** Si local tiene cambios sin subir (`pv_port_synced === '0'`) **y** la nube no es más nueva que `pv_port_saved_at` → gana local y se empuja de inmediato. Si no, gana la nube. La comparación usa objetos **canonicalizados** (`_pvCanon`, ordena claves recursivamente) porque `jsonb` devuelve las claves en otro orden: evita reescrituras y reloads espurios.
- **Lectura fallida nunca sobrescribe la nube.** `if (r && r.error)` aborta el gate sin tocar `localStorage`, sin `upsert` y sin sembrar `EMPTY_STATE` — el fallo que habría borrado la cuenta real. Revela la app con lo que haya en local y reintenta una sola vez.
- **`QuotaExceededError` está manejado.** `_lsSet` detecta `QuotaExceededError` / `code 22` / `1014` / `/quota/i`, llama a `_lsPurgeOld()` (que borra **solo** cachés no críticas: `^news_`, `wl_cache`, `^evt:`, `^shared_`, `^ai_cache`, `_cache$`) y reintenta. `savePortfolio` usa `_lsSet`, así que el guardado del portafolio no se rompe por cuota.
- **Backup:** `portfolio_state_backup` se escribe como mucho cada 5 minutos (antes se duplicaba el blob en cada tick de 30 s, lo que en iOS Safari es escritura síncrona a disco).

### 6.7 Datos de mercado (Fase 7)

- **Zona horaria: ET real, no la del dispositivo.** `isMarketOpen`, `isExtendedHours` y `_justClosed` usan `new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))`. El DST lo resuelve la base de datos de zonas horarias del sistema, no una constante. `_pvMarketDayISO()` delega en `PORTIV_SYNC._todayET()` y el comentario cita **exactamente** el problema de Panamá (UTC−5) vs ET de verano (UTC−4) cerca de medianoche. **Correcto.** (La excepción menor es `_isWeekend()` → P2-7.)
- **Sin cierre previo no se inventa nada.** `_pvHydratePrevCloseFromCache` solo acepta el caché **del día de mercado actual** y solo lo da por bueno si **cada** posición tiene cierre previo (`hit === HOLDINGS.length`) — con una sola sin él, el cambio del día sería incompleto presentado como completo, y se descarta.
- **Períodos: no se dibuja lo que no existe.** `_periodAvailable` exige serie del broker, serie reconstruida, override etiquetado por el broker, o antigüedad real suficiente (con 10 % de tolerancia). `unlockPeriods` **oculta** los botones sin datos (antes 6M/1A estaban en el HTML y salían siempre, dibujando gráficas inventadas). `sliceFromAll` recorta a lo disponible en vez de extrapolar.
- **Cero fabricación en los gráficos.** `_densifyDaily` (puente browniano) y `_expandIntraday` (3 octavas de ruido determinista) **no se llaman desde ningún sitio**. El propio archivo lo documenta en un bloque titulado "AUDITORÍA (integridad de datos financieros)": *"QUÉ PERÍODOS LA CONSUMEN HOY: NINGUNO"*. Verificado con `grep`: cero call-sites. **No borradas**, según las reglas.
- **`_chartEmptyState`** se activa si la serie es sintética (`chartData._synthetic`) o tiene menos de 2 puntos.
- **Sin claves de API en el cliente.** `FINNHUB_KEY` sale de `localStorage` o de `window.LOCAL_CONFIG` (`config.local.js`), que **no está referenciado por `index.html`**, está en `.gitignore` (línea 4), no está trackeado por git y devuelve **404** en el repo público (verificado con `curl`). Todas las llamadas van por `finnhub-proxy`, `alpaca-proxy` y `anthropic-proxy` en Supabase.
- **Arranque: un solo origen de terceros.** `preconnect` a Supabase. Paddle se descarga perezosamente solo al abrir el checkout. `vendor/supabase.js` es **local y síncrono** (no tocado). Fuentes locales con `preload`. Antes del primer píxel: 3 recursos locales (CSS de fuentes + 2 `.woff2`) + `vendor/supabase.js`, y en red 1 `getSession` + 1 `getUser` **en paralelo** con las 2 lecturas del gate (`_gatePrefetchFor`), que van juntas en un `Promise.all`. Camino crítico: **2 round trips**, no 4.

### 6.8 Capa de IA (Fase 8)

- **`_aiExtractJson` es robusto de verdad.** Quita fences ```` ```json ````, busca el `{` de apertura, **balancea llaves y corchetes respetando cadenas y escapes** para encontrar el cierre real (descarta prosa posterior), y si la respuesta viene **truncada por `max_tokens`** recorta hasta el último elemento completo y re-cierra lo que quedó abierto. `_aiJsonEscapeControls` escapa caracteres de control dentro de cadenas (el `\n` crudo que rompe `JSON.parse`). Y el `JSON.parse` final está **dentro de un `try/catch` que devuelve `undefined`**, no lanza. Los 5 escenarios del encargo, cubiertos.
- **La caché de análisis es sensible al idioma.** `_nmLangKey(key)` antepone `getLang()` a la clave. `_analysisEarningsKey(ticker)` ata la caché al último reporte trimestral, y `_staleToday` invalida además por idioma y por día ET.
- **La importación por foto exige revisión humana.** Las dos rutas de OCR llaman a `_aiOpenReviewEditor(_posCount)` con el comentario *"revisión obligatoria — NO aplica solo"*. `aiPortApply()` solo se invoca desde el botón `.pe-apply-btn` del editor, y desde el flujo de SnapTrade — donde los datos vienen del broker, no de la IA, y no necesitan revisión. **No hay ruta que escriba un portafolio extraído por IA sin confirmación.**
- **El outlook no gasta API.** Documentado y verificado: el contenido enriquecido va como *seed* embebido por semana y el respaldo son eventos macro de Finnhub. **Nunca llama al proxy de Anthropic.** Los dos seeds embebidos (`2026-W27`, `2026-W28`) están fuera de la semana actual y el guard `if (_weekKey(0) !== wk && _weekKey(1) !== wk) return;` impide plantarlos: **no puede mostrarse contenido rancio de julio**.

### 6.9 Noticias (Fase 9)

- **Enlaces externos fuera del WebView.** `_pvOpenExternalRaw` usa `Capacitor.Plugins.Browser.open()` (SFSafariViewController) en nativo y `window.open(abs, '_blank', 'noopener')` en web. Las páginas propias se abren en un visor interno con botón de cerrar, Escape y red de seguridad por si el archivo no existiera en el build. A las URLs de noticias externas **no se les toca la URL**; solo a las propias se les añade `?app=ios` (para que las páginas legales oculten la parte de pago web dentro de la app — Guideline 3.1.1).
- **Sin bucles de `onerror` en imágenes:** cero atributos `onerror=` en todo el archivo.
- **`_invalidateStaleOutlookCaches`** borra toda clave `weekly_outlook_*` que no sea la de esta semana o la próxima, y hay una validación extra (`obj._weekKey === _weekKey(0)` → era "próxima", ahora es "esta" → regenerar).

### 6.10 UI y seguridad (Fases 10-13, lo que sí se pudo verificar estáticamente)

- **Zoom de iOS en inputs: resuelto de forma global y a prueba de futuro.** `@media (pointer: coarse) { input, select, textarea { font-size: 16px !important; } }`. Es un selector **por elemento**, no por clase, así que **cualquier input añadido después queda cubierto automáticamente**. Más `* { touch-action: manipulation }` (elimina el doble-tap-zoom y el retardo de 300 ms) y `-webkit-text-size-adjust: 100%`.
- **Restauración del scroll del body: los 5 pares están equilibrados.** `openNewsModal`/`_openOutlookEvent` → `closeNewsModal`; `_pvOpenDoc` → `_pvCloseDoc`; `_pvShowPaywall` → `_pvClosePaywall`/`_pvConfirmTrial`; `_block` → `_unblock`. **No hay ningún `overflow:hidden` huérfano.** Los otros cierres de modal (`closeModal`, `closeDrawer`, `closeAddStock`, `closeCashModal`, `closeSearchOverlay`, `closeDropdown`, `_closeQuiz`) no tocan `overflow` porque sus aperturas tampoco lo hacen.
- **Apilamiento de modales resuelto en los dos sentidos:** `_pvConfirmTrial` y `_pvClosePaywall` cierran **también** `#pqOverlay` (el cuestionario de perfil vive debajo del paywall con el mismo `z-index` 12000, y sin esto el usuario quedaba mirando la tarjeta del perfil sin salida).
- **Red anticongelación de clics:** un listener global en fase de captura detecta capas invisibles con `position:fixed/absolute` que cubren el viewport y bloquean clics, las desactiva con `pointer-events:none !important` y las **vigila** para devolverles los clics si vuelven a ser visibles (así no rompe una capa que sí funcionaba). Se barre además al volver a la app.
- **Secretos: cero.** Un único JWT en 32 200 líneas: la `anon key` de Supabase (payload `{"iss":"supabase","ref":"zblhifszlhdgkhnymwjh","role":"anon"}`), pública por diseño. Buscados y no encontrados: `sk-`, `sk_live_`, `pk_live_`, `service_role`, `xoxb-`, `AIza…`, `ghp_`, `Bearer <literal>`. Los client IDs de Google (`342943410334-…`) son públicos por diseño.
- **Logs sin PII.** 54 llamadas a `console.*`; ninguna imprime email, uid, token, saldo ni posiciones (verificado con búsqueda dirigida). El overlay de debug solo aparece con `pv_debug === '1'`, que está **desactivado por defecto** (`pvIsDebug()` devuelve `false` si la clave no existe).
- **PII a terceros: no se envía.** Todas las llamadas de mercado van por los proxies de Supabase; no hay email ni uid en ninguna URL de terceros.
- **Correos del dueño expuestos:** `OWNER_EMAILS` viaja en claro en el HTML público. **Está documentado en el código como decisión consciente** (el bypass visual del gate los necesita en cliente; el servidor valida igual, así que publicarlos no concede ningún privilegio). Lo confirmo: no es una brecha, es exposición a scraping de spam.

---

## 7. No verificado

Esta es la sección más importante del informe. Todo lo de aquí **no se comprobó** y no debe darse por bueno.

### Nada de lo que requiere ejecutar la app

Toda la auditoría es **estática**: lectura del código, `node --check`, `grep`, `diff` y aritmética a mano. **No se abrió la app, ni en navegador, ni en simulador, ni en dispositivo.** En concreto:

1. **La matriz de la Fase 10 (6 pestañas × 5 condiciones) NO se completó.** Verifiqué las reglas transversales (16px en inputs, restauración de scroll, apilamiento de modales, safe areas de iPad en CSS), pero **no** que cada pestaña renderice bien en primera carga / portafolio vacío / sin conexión / tras cambiar de idioma. Eso hay que hacerlo pestaña por pestaña con la app corriendo.
2. **La matriz de la Fase 13 (pestaña × 4 estados) NO se completó.** Localicé los estados vacíos que existen (`_chartEmptyState`, `_renderOutlookEmpty`, `_pvxPeersEmptyCard` y 264 cadenas de tipo "Sin …"/"No hay …"), pero **no** comprobé que watchlist, noticias, tx log y análisis tengan equivalente en los cuatro estados. **Es muy posible que falte alguno.**
3. **i18n: no verificado en absoluto.** El sistema no es un diccionario estático: `changeLanguage` combina `_applyI18nDom` (para `data-i18n`), `_rerenderForLang` (re-renderiza 7 vistas) y un **MutationObserver + `_translatePageToEnglish`** que traduce en caliente lo que construye el JS. Si esa capa cubre o no los cientos de literales en español de los template strings **solo se puede saber ejecutándolo**. Prueba concreta a hacer: cambiar a inglés, recorrer las 6 pestañas, volver a español, y recorrerlas otra vez buscando texto sin traducir y renders rotos. También si `portiv_lang` persiste entre arranques.
4. **Modo oscuro: no aplica.** El código lo **retiró**: `document.body.classList.remove('dark-theme')` con el comentario *"Modo oscuro retirado: se fuerza SIEMPRE modo claro"*. Quedan reglas `body.dark-theme` sin uso en el CSS. No revisé colores hardcodeados para modo oscuro porque no hay modo oscuro que revisar. `portiv_theme` sigue en la lista blanca de localStorage.
5. **iPad: verificado solo en el papel.** El IIFE fuerza el viewport a ≤899px y `PV_isMobile`/`realW`/`coversViewport`/`html.pv-ipad` son coherentes con eso en el CSS. **No se probó en un iPad ni en el simulador.** Tampoco revisé exhaustivamente todos los `position:fixed` con `z-index > 8000` frente a las safe areas — solo `#portivReviewPanel` (que ya tenía arreglo) y el header del chat.
6. **Rate limits de Alpaca/Finnhub: no medidos.** No conté las llamadas reales que dispara un arranque con 20 posiciones. Vi que existe caché (`_quoteCacheGet/Put`, `_pvSaveLastQuotes`, `_pvHydrateFromLastQuotes`) y lotes de 5 con 300 ms entre lotes, pero **no verifiqué el comportamiento ante un 429 real**.
7. **Tiempo hasta `revealApp` en 3G lento: no medido.** Estimé el camino crítico en 2 round trips por lectura del código, no con un perfilado.
8. **Coste de la IA: no estimado.** Localicé `_aiQualityModel` pero **no** tracé qué modelo usa cada ruta ni estimé el gasto de una sesión típica. El único dato firme es que el outlook no llama al proxy de Anthropic (verificado). **Queda pendiente confirmar que ninguna ruta llama al modelo caro en cada render.**
9. **Inyección de prompt (Fase 8.6): no verificada.** No tracé si los titulares de noticias llegan al prompt del sistema delimitados o en crudo. La superficie XSS relacionada sí está en P1-7. **Esto queda abierto.**
10. **Timeouts de la IA (Fase 8.3): no verificados uno a uno.** No revisé cada llamada de IA para confirmar que tiene timeout y que el estado de carga se limpia en `finally`. No busqué spinners que puedan quedarse girando en la capa de IA.
11. **Los 8 flujos de auth: trazados en el código, no ejecutados.** El emparejamiento de nonces, el orden de las llamadas y la restauración de botones se leyeron línea a línea, pero **ningún login real se hizo**: ni Apple nativo, ni Google nativo, ni los dos por web. Son justo los que solo fallan en producción.
12. **RLS: el SQL es correcto, el despliegue no está verificado.** No puedo ejecutar SQL. Por eso el §5.2 trae las consultas exactas.
13. **Edge Functions: leídas parcialmente.** Revisé `_shared/snaptrade.ts` (`requireEntitlement`/`isEntitled`), la llamada del gate en `snaptrade-connect` y `snaptrade-history`, y `has_active_entitlement` en SQL. **No auditadas:** `paddle-webhook`, `rc-webhook`, `entitlement-sync`, `entitlement-sweeper`, `snaptrade-cleanup`, `snaptrade-refresh`, `snaptrade-disconnect`, `delete-account`, `finnhub-proxy`, `alpaca-proxy`, `yh-proxy`, `anthropic-proxy`. **Es un hueco grande**: el webhook de Paddle y el de RevenueCat son quienes escriben el entitlement, y no los he mirado.
14. **`portiv-iap.js`: revisadas ~160 de sus 374 líneas.** Verifiqué la clave, el entitlement, `configure`, `login`, `logout` y `refresh`. **No auditados:** el flujo de compra (`purchase`), el paywall de RevenueCatUI, `loadOfferings`, y el manejo de `PURCHASES_ERROR_CODE`.
15. **El bundle de iOS (`portiv-cap/www/index.html`) no se auditó como tal.** Solo se hizo el `diff` contra la raíz. Las 34 líneas que solo existen ahí (CSS de teclado, header de iPad, guard `inChat`) **no han pasado por esta auditoría**.
16. **`_pvLogError` / `pvReportError` / `reportQuiet`: no tracé su destino final.** Vi que alimentan `PV_DEBUG.log` (en memoria, visible solo con `pv_debug=1`), pero **no confirmé si además salen a algún sitio** ni qué llevan dentro.
17. **Fase 1.5 (`await`/`fetch` sin `try/catch`) no se completó como lista exhaustiva.** Revisé a fondo la **ruta de arranque**, que es lo que importa (§6.2), y ahí no hay promesas sin capturar que puedan dejar la app bloqueada — salvo un hueco estrecho que sí encontré y **no** he arreglado: en `_cloudLoadAndGateInner`, las llamadas a `showOverlay()`, `_wlClearLocal()` y `_newsClearLocal()` quedan **fuera** de cualquier `try`. Si alguna lanzara, la promesa se rechaza, el `.catch` de `cloudLoadAndGate` solo lo registra, y la app se queda en el spinner "Cargando…" para siempre — y como el overlay **sí** está visible, la red de seguridad de los 10 s no lo detecta. No lo arreglé porque no encontré ninguna forma realista de que esas tres funciones lancen (las tres tienen `try/catch` internos), pero el hueco existe. Envolverlas en `try{…}catch(e){}` sería un arreglo de una línea si quieres cerrarlo. **Las promesas fuera de la ruta de arranque no se inventariaron.**

---

## 8. Cambios realizados

Cuatro commits, cuatro arreglos, **20 líneas añadidas y 2 modificadas** en total (de las cuales 13 son comentarios). Ninguna función reescrita, ningún archivo reformateado, nada borrado, ninguna dependencia nueva, ningún cambio de arquitectura.

| Commit | Función tocada | Qué cambió | Por qué | Riesgo de regresión |
|---|---|---|---|---|
| `8c6202d` | `requestTrade` | 2 líneas de código: sale antes si `#exec-${idx}` está `disabled` | El `onkeydown` del input llamaba a `requestTrade` saltándose la validación de `updatePreview`; el modal mostraba cifras que no correspondían a la operación ejecutada | **Muy bajo.** Un botón `disabled` no dispara `onclick`, así que el camino normal no cambia. Si el botón no existiera, `_execBtn` es `null` y se comporta exactamente como antes. Con "Vender todo" el botón se pinta sin `disabled`, así que ese flujo tampoco cambia |
| `9192b5d` | `_chatMarkdown` | 1 línea: la clase de caracteres de la URL pasa de `[^)]+` a `[^)"'\`<>\s]+` | Cierre de atributo `href` desde la salida del modelo | **Muy bajo.** Ninguna URL válida contiene comillas, ángulos ni espacios sin escapar. Un enlace que los llevara ya estaba roto antes |
| `34ae59e` | `_aiChatAddMsg` | 1 línea: `${s.url}` → `${pvEsc(s.url)}` | La URL de las fuentes web se interpolaba sin ningún escape dentro de `href` | **Muy bajo.** `pvEsc` solo convierte `& < > " ' \`` en entidades; el navegador las decodifica al resolver el `href`. El título de la fuente ya pasaba por `_chatEscape` |
| `c789de7` | `_acctDeleteAccount` | 1 línea: `try { await window._pvIapLogout(); } catch(e){}` antes de `signOut()` | Faltaba desvincular RevenueCat al borrar la cuenta desde Ajustes | **Muy bajo.** `_pvIapLogout` está definida antes en el mismo IIFE, nunca lanza (devuelve una promesa con `.catch` interno) y en web es un no-op porque `window.PortivIAP` no existe. Es literalmente la misma línea que ya ejecuta `_authLogout` |

**Verificación posterior a los cambios:** los 17 bloques `<script>` vuelven a pasar `node --check` sin un solo error. `git diff` contra `HEAD` vacío (árbol de trabajo == último commit). Rama `auditoria-final-prelanzamiento`, **sin push y sin merge**.
