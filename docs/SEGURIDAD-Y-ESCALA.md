# Seguridad y escala — revisión del 3 de noviembre de 2026

Objetivo: que Portiv aguante unos mil usuarios y que no se pueda abusar de ella. Todo lo de
abajo se comprobó contra producción (proyecto Supabase `zblhifszlhdgkhnymwjh`) desde fuera,
con la anon key pública, o leyendo la configuración; nada de esto es teórico.

## Lo que estaba abierto

| # | Hallazgo | Gravedad | Arreglo |
|---|---|---|---|
| 1 | `anthropic-proxy` aceptaba la **anon key** (va en el HTML público): cualquiera podía usar Claude con la key de Portiv, con cualquier modelo y cualquier tool. Comprobado con una petición de 1 token. | Crítica | `_shared/ai-guard.ts`: sesión obligatoria, sólo Sonnet/Haiku, sólo la búsqueda web (máx. 3 usos) |
| 2 | `has_active_entitlement()` regalaba Pro a `rafa10pro3@gmail.com`, que **no estaba registrado**; con «Confirm email» apagado cualquiera podía crear esa cuenta y tener Pro en el servidor (IA y SnapTrade, ~$1/mes por conexión). | Crítica | Acceso de dueño/demo por **uid** en la tabla `access_grants`; el correo sale también de `OWNER_EMAILS` |
| 3 | Capacitor 8.4.1 — **CVE-2026-103922** (9.3): un enlace podía cargar contenido remoto con el origen de la app (sesión, plugins) vía la ruta interna del proxy HTTP. | Crítica | Capacitor 8.4.3 exacto, xcframeworks regenerados con `rebuild.sh` y firmados |
| 4 | `acquire_shared_lock`, `release_shared_lock`, `bump_rate_limit`, `pv_run_generate` (SECURITY DEFINER) se podían llamar con la anon key por `/rest/v1/rpc/…`. `acquire_shared_lock(key, x, 0)` sobrescribía cualquier fila de `shared_analysis` (noticias y análisis de todos). | Alta | `revoke execute … from public, anon, authenticated` (sólo service role y pg_cron) |
| 5 | Sin tope de IA por usuario: un usuario gratis podía hacer un bucle o pedir un modelo caro a `gemini-proxy`. | Alta | Cupo por minuto y por día por usuario + tope **global** diario por proxy + lista de modelos Flash |
| 6 | `fh_cache` = 311 de 340 MB de la base y creciendo (plan gratis: 500 MB, luego sólo lectura). Las claves de noticias y barras llevan la fecha: nadie las vuelve a leer. | Alta (escala) | Purga diaria (`fh_cache_purge`, 04:17 UTC) + índice por `fetched_at` |
| 7 | `rate_limits` y `client_errors` sin purga. | Media | Purgas diarias |
| 8 | TRUNCATE/TRIGGER/REFERENCES concedidos a anon/authenticated (TRUNCATE no pasa por RLS). | Baja (PostgREST no lo expone) | Retirados |
| 9 | `_pvSubStatus` leía `subscriptions` en cada gate y en cada llamada de IA: dos iPhones hacían ~2.500 lecturas al día cada uno. | Media (escala) | Una lectura cada 10 s por usuario; la sync con la tienda la invalida |

Bien hecho ya y verificado: RLS activa en las 19 tablas; perfiles, suscripciones, objetivos de
precio y errores no se leen con la anon key; columnas sensibles de `profiles` sólo lectura;
webhooks con firma (Paddle, SnapTrade) o secreto (RevenueCat); crons con `x-cron-secret`;
`shared-write` valida forma, tamaño y cupo; ningún secreto en el historial de git (sólo la
anon key, que es pública por diseño).

## Capacidad para mil usuarios (medido el 3 nov con ~11 usuarios activos al día)

| Recurso | Hoy | Mil usuarios (~300 activos/día) | Plan gratis |
|---|---|---|---|
| Llamadas a Edge Functions | ~7.100/día (≈650 por usuario activo) | ~6 M/mes | 500 k/mes |
| Base de datos | 340 MB | estable tras la purga | 500 MB |
| Emails de Auth (reset, magic link) | — | insuficiente | 2 por hora |

## Lo que queda en manos del dueño

1. **Plan Pro de Supabase** (~$25/mes) antes de pasar de ~50 usuarios activos al día: 2 M de
   invocaciones, 8 GB de base, logs de 7 días, protección de contraseñas filtradas (HIBP).
2. **SMTP propio** (p. ej. Resend) en Auth → SMTP: con el servicio integrado sólo salen 2
   correos por hora en todo el proyecto.
3. Con el SMTP listo, **activar «Confirm email»**: hoy cualquiera crea cuentas con correos
   ajenos. El tope global de IA limita el daño, pero no lo evita.
4. Subir la contraseña mínima de 6 a 8 caracteres y activar CAPTCHA (Turnstile) en Auth.
5. Activar en GitHub *secret scanning* y *push protection* (el repo es público).

## Cómo se despliega

```
npx supabase login
npx supabase functions deploy anthropic-proxy --project-ref zblhifszlhdgkhnymwjh --use-api
npx supabase functions deploy gemini-proxy   --project-ref zblhifszlhdgkhnymwjh --use-api
```
Y la migración `supabase/migrations/20261103120000_seguridad_rpc_y_cache.sql` en el SQL Editor
(es idempotente; si no encuentra la cuenta del dueño aborta sin aplicar nada). Orden: primero
las funciones, luego la migración.
