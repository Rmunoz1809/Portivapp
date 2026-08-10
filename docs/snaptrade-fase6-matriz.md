# SnapTrade — Fase 6: matriz de verificación por broker

Estado de las fases 1–5: código desplegado y verificado con datos sintéticos. Lo que
**no** se ha podido comprobar es el comportamiento contra brokers reales, porque exige
una sesión iniciada de un usuario con broker enlazado. Esta matriz es esa comprobación.

Hay **2 perfiles con broker enlazado** en producción y 1 con posiciones guardadas.

## Cómo capturar la evidencia de una celda

Con la app abierta y sesión iniciada, en la consola del navegador:

```js
copy(JSON.stringify({
  fx: window._SNAP_FX, opciones: window._SNAP_OPTIONS, otras: window._SNAP_OTHER,
  sinPrecio: window._SNAP_NO_PRICE, sinCoste: window._SNAP_NO_COST,
  descartadas: window._SNAP_DROPPED, parcial: window._SNAP_PARTIAL,
  caidas: window._SNAP_STALE_CONNS, sinSync: window._SNAP_NO_SYNC,
  instituciones: window._SNAP_INSTITUTIONS,
  flujos: window._SNAP_FLOWS, huecosFlujos: window._SNAP_FLOW_GAPS
}, null, 2))
```

Eso más una captura de la tarjeta de broker (Ajustes → conexión) es la evidencia de la
fila. Guardar ambas por broker.

## Matriz

Una fila por broker real (Schwab, Interactive Brokers, Fidelity, Robinhood, tastytrade…).

| # | Qué se comprueba | Cómo saber que está bien | Si falla, apunta |
|---|---|---|---|
| 1 | Valor total | La cifra de la tarjeta cuadra con la del broker (±redondeo) | La diferencia exacta y en qué divisa |
| 2 | Efectivo | El saldo en metálico está dentro del total | Si `balances` llegó vacío |
| 3 | Multi-cuenta | Todas tus cuentas del broker aparecen | Cuántas ves vs cuántas tienes |
| 4 | Divisas | `_SNAP_FX.excluded` lista lo que NO se sumó, y el aviso lo dice | Si mezcla divisas en una sola cifra |
| 5 | Opciones | `_SNAP_OPTIONS.count` = las que tienes; hay aviso | Si salen sumadas al total |
| 6 | Futuros / CFD | `_SNAP_OTHER` los declara por número y clase | Si aparecen valorados en dinero |
| 7 | Coste medio | El rendimiento por posición coincide con el del broker | Símbolos con coste raro o ausente |
| 8 | Posiciones en corto | Con una posición corta, `avg_cost` sale y es correcto | Si queda en blanco o sale disparado |
| 9 | Cuentas cerradas | No aparecen en posiciones, **sí** cuentan en lo aportado | Si desaparecen aportaciones al cerrar una cuenta |
| 10 | Antigüedad del dato | "Datos de hace X" corresponde a la cuenta **más vieja**, no a la más fresca | El `lastSync` por institución |
| 11 | Identidad del broker | El chip dice tu broker de verdad, con su nº de cuentas | El nombre que sale vs el real |
| 12 | Mantenimiento | Si el broker está en mantenimiento, el chip lo dice | Si SnapTrade lo reporta y no se ve |
| 13 | Aportado neto | La cifra cuadra con tus ingresos menos retiradas | La diferencia y de qué mes |
| 14 | Signo de los importes | `signMismatches` = 0 en la consola del servidor | **El broker y el valor** — significa que informa el signo al revés |
| 15 | Traspasos | Un traspaso de activos se declara y **no** se suma como aportación | Si lo cuenta como dinero nuevo |
| 16 | Tipos desconocidos | `huecosFlujos.unknown` vacío | **Los tipos que salgan** — hay que añadirlos a la clasificación |
| 17 | Sin truncar | `truncated`, `partial`, `unusable`, `undated` a 0 | Cuál no lo está |
| 18 | Conexión rota | Al romperla, la tarjeta **nombra** ese broker | Si dice "tu broker" a secas |
| 19 | Reconectar el correcto | Con dos brokers caídos, cada botón lleva al suyo | Si ambos abren el mismo |

Las celdas 14 y 16 son las importantes: son las dos únicas que pueden hacer que la cifra
de aportaciones sea **falsa en vez de incompleta**, y sólo se detectan con datos reales.

## Webhook — ya verificado

Contra producción (`snaptrade-webhook` desplegado):

| Caso | Esperado | Resultado |
|---|---|---|
| `GET` | 405 | ✅ 405 Method Not Allowed |
| POST sin cabecera `Signature` | 401 | ✅ `{"ok":false,"error":"unauthorized"}` |
| POST con firma inválida | 401 | ✅ igual |
| POST con firma pero JSON roto | 400 | ✅ `{"ok":false,"error":"bad json"}` |
| Cabecera `signature` en minúsculas | se lee igual (401 por firma mala, no por ausencia) | ✅ |

Que devuelva **401 y no 503** demuestra que `SNAPTRADE_CONSUMER_KEY` está configurado y
no vacío en producción: sin clave, el handler corta antes con 503.

Los caminos que exigen una firma **válida** no se pueden ejercitar desde fuera sin el
consumer key. Se verificaron reproduciendo la cadena de comprobación con el código real
(`canonicalJson`, `asciiEscape`, `hmacB64`, `safeEqual` extraídos del fichero) y una clave
sintética — 18 casos, todos correctos:

- claves desordenadas → mismo JSON canónico → misma firma
- las tres variantes de firma aceptadas (canónica, ASCII-escapada, cuerpo crudo)
- `safeEqual` en tiempo constante, y corta por longitud distinta
- ventana anti-réplica: 1 h y 23 h se aceptan; 25 h y 48 h → `{ok:true, skipped:"stale"}`
- un evento **del futuro** (reloj desincronizado) también se descarta
- sin `eventTimestamp` no se descarta nada

`ACCOUNT_HOLDINGS_UPDATED` deja `snaptrade_last_refresh` a null, que es lo que invalida la
caché de 60 min.

## Secretos — verificado

Presentes en el proyecto: `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`,
`SNAPTRADE_CRON_SECRET`, más `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_URL`.
No hace falta un `SNAPTRADE_WEBHOOK_SECRET`: la firma se valida con el consumer key.

Observación menor, sin impacto: `RC_WEBHOOK_SECRET` y `REVENUECAT_WEBHOOK_SECRET` tienen
el mismo valor bajo dos nombres. Conviene saber cuál lee el código y retirar el otro.

## Pendiente que no depende de esta matriz

- **`getUserAccountPositions` y `listOptionHoldings` están marcados como *deprecated*** en
  el SDK, ambos apuntando a `getAllAccountPositions`. El camino de equity —del que cuelga
  toda la cartera— sigue en el deprecado. Migrarlo es una fase propia: cambia de forma
  (`instrument` es una unión discriminada, `units`/`price` llegan como cadena).
- **`listUserAccounts` sirve datos *daily* sea cual sea el plan.** De ahí sale
  `sync_status.holdings.last_successful_sync`, que es lo que alimenta "datos de hace X".
  Si esa metadata va con la caché diaria, la antigüedad mostrada podría ir hasta 24 h por
  detrás. La celda 10 de la matriz lo resuelve: comparar con la hora real del broker.
- **Historial de migraciones descuadrado**: 18 migraciones remotas sin fichero local y 3
  locales sin registrar (ya aplicadas a mano en el esquema). `supabase db push` no
  funciona hasta repararlo, y repararlo arrastraría `snaptrade_cleanup_v2`.
