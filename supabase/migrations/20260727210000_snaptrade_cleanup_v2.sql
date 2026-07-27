-- ─────────────────────────────────────────────────────────────────────────────
-- Portiv · Baja automática de SnapTrade cuando NO hay suscripción activa (v2)
-- ─────────────────────────────────────────────────────────────────────────────
-- Qué arregla respecto a la v1:
--
--  1. El cron llamaba a la Edge Function con el timeout por defecto de pg_net
--     (5 s). TODAS las ejecuciones morían con "Timeout of 5000 ms reached"
--     (net._http_response.status_code = NULL) → el arranque en frío de la
--     función ya se come ~5 s, así que la limpieza jamás se confirmaba y nadie
--     se enteraba. Ahora: timeout 120 s.
--
--  2. La v1 sólo miraba filas de `subscriptions` con `expires_at NOT NULL`.
--     Un usuario enlazado a SnapTrade SIN fila de suscripción (o con
--     expires_at NULL: cancelación de Paddle sin periodo, fila legacy, enlace
--     previo al candado) era INVISIBLE para la limpieza → 1 USD/mes para
--     siempre. Ahora el barrido parte de `profiles` (todos los enlazados) y
--     usa `snaptrade_connected_at` como ancla de gracia para esos huérfanos.
--
--  3. No había NINGUNA traza de si la limpieza corrió. Ahora cada ejecución
--     escribe en `snaptrade_cleanup_runs` y un health-check horario levanta
--     una alerta si no hubo ejecución OK en 6 h.
--
-- Idempotente: se puede aplicar varias veces sin efecto secundario.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Ancla temporal del enlace ─────────────────────────────────────────────
-- Necesaria para dar ventana de gracia a un usuario enlazado que NO tiene fila
-- de suscripción: sin esto no hay forma de saber si lleva 2 minutos o 2 meses
-- conectado, y desconectar "al instante" rompería el hueco entre el pago y el
-- webhook (el usuario conecta, el webhook aún no escribió → falso positivo).
alter table public.profiles
  add column if not exists snaptrade_connected_at timestamptz;

comment on column public.profiles.snaptrade_connected_at is
  'Momento en que se registró el usuario en SnapTrade (lo sella snaptrade-connect). Ancla de la ventana de gracia para enlaces sin fila de suscripción.';

-- Backfill: los ya enlazados reciben un ancla razonable (último refresh o ahora)
-- para que el primer barrido tras el deploy NO los corte de golpe.
update public.profiles
   set snaptrade_connected_at = coalesce(snaptrade_last_refresh, now())
 where snaptrade_user_id is not null
   and snaptrade_connected_at is null;

-- Índice parcial: el barrido lee sólo los enlazados (hoy son pocos, pero esta
-- consulta corre cada hora y la tabla profiles crece con cada registro).
create index if not exists profiles_snaptrade_linked_idx
  on public.profiles (snaptrade_cleanup_last_attempt_at nulls first)
  where snaptrade_user_id is not null;

-- ── 2. Bitácora de ejecuciones ───────────────────────────────────────────────
create table if not exists public.snaptrade_cleanup_runs (
  id            bigserial primary key,
  ran_at        timestamptz not null default now(),
  ok            boolean     not null,
  scanned       integer     not null default 0,  -- enlazados examinados
  disconnected  integer     not null default 0,  -- bajas confirmadas por SnapTrade
  skipped       integer     not null default 0,  -- con derecho, o dentro de gracia
  failed        integer     not null default 0,  -- fallo transitorio → reintento
  pending       integer     not null default 0,  -- quedaron fuera del lote
  dry_run       boolean     not null default false,
  detail        jsonb
);

create index if not exists snaptrade_cleanup_runs_ran_at_idx
  on public.snaptrade_cleanup_runs (ran_at desc);

-- Sólo service role. Ningún cliente debe leer esto (expone ids de usuarios).
alter table public.snaptrade_cleanup_runs enable row level security;

-- ── 3. Cron: horario, con timeout suficiente ─────────────────────────────────
-- pg_net por defecto aborta a los 5 s. La limpieza hace N borrados contra la
-- API de SnapTrade (además del arranque en frío de la función), así que
-- necesita minutos, no segundos.
select cron.unschedule('snaptrade-hourly-cleanup')
 where exists (select 1 from cron.job where jobname = 'snaptrade-hourly-cleanup');

select cron.schedule(
  'snaptrade-hourly-cleanup',
  '7 * * * *',                 -- minuto 7: fuera del pico :00 del resto de jobs
  $cron$
    select net.http_post(
      url     := 'https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/snaptrade-cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', coalesce(
          (select decrypted_secret from vault.decrypted_secrets where name = 'snaptrade_cron_secret'),
          ''
        )
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);

-- ── 4. Health-check: la limpieza silenciosa es la que cuesta dinero ──────────
-- Si en 6 h no hubo NINGUNA ejecución OK, deja constancia en la misma bitácora
-- (ok=false, detail.alert). Consultable con:
--   select * from public.snaptrade_cleanup_runs where ok = false order by ran_at desc;
select cron.unschedule('snaptrade-cleanup-health')
 where exists (select 1 from cron.job where jobname = 'snaptrade-cleanup-health');

select cron.schedule(
  'snaptrade-cleanup-health',
  '37 */6 * * *',
  $cron$
    insert into public.snaptrade_cleanup_runs (ok, detail)
    select false, jsonb_build_object('alert', 'no_ok_run_6h', 'checked_at', now())
     where not exists (
       select 1 from public.snaptrade_cleanup_runs
        where ok and ran_at > now() - interval '6 hours'
     );
  $cron$
);
