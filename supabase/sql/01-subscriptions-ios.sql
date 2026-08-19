-- ═══════════════════════════════════════════════════════════════════════════
-- PORTIV · Suscripción iOS — esquema, RLS e idempotencia
-- Proyecto: zblhifszlhdgkhnymwjh  ·  Ejecutar en Supabase → SQL Editor
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- ADAPTADO AL ESQUEMA REAL (no al del prompt):
--   · `subscriptions` YA existe y `rc-webhook` ya le escribe `environment` y
--     `last_event`. Esas columnas se declaran aquí para que un entorno nuevo
--     no se quede corto.
--   · El drop de policies es DINÁMICO. El prompt sólo borraba las llamadas
--     `sub_*`; si la tabla tuviera una policy de escritura con otro nombre
--     ("Users can update own subscription", etc.) habría sobrevivido y el
--     agujero seguiría abierto. Se borran TODAS y se recrea una sola.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1 · Tabla `subscriptions` — una fila por usuario, fuente de verdad única
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  entitlement_active boolean not null default false,
  status text not null default 'never',
  expires_at timestamptz,
  will_renew boolean,
  created_at timestamptz not null default now()
);

alter table public.subscriptions
  -- 'app_store' | 'mac_app_store' | 'paddle' | 'play_store' | 'promotional'
  -- CRÍTICO para el cruce iOS/web: un EXPIRATION que llega desde App Store
  -- NO puede revocar el acceso de alguien que pagó por Paddle. La revocación
  -- sólo se aplica si el evento viene de la MISMA tienda que dueña la fila.
  add column if not exists store                   text,
  add column if not exists product_id              text,
  add column if not exists rc_app_user_id          text,
  add column if not exists original_transaction_id text,
  -- 'PRODUCTION' | 'SANDBOX'. rc-webhook ignora SANDBOX salvo RC_ACCEPT_SANDBOX=true.
  add column if not exists environment             text,
  -- Último tipo de evento aplicado. Diagnóstico puro, pero es lo primero que
  -- se mira cuando un usuario dice "pagué y no entro".
  add column if not exists last_event              text,
  -- Fin de la ventana de gracia por fallo de cobro (BILLING_ISSUE).
  -- Apple reintenta hasta ~16 días; mientras tanto el acceso se conserva.
  add column if not exists grace_until             timestamptz,
  add column if not exists revoked_at              timestamptz,
  add column if not exists revoked_reason          text,
  add column if not exists updated_at              timestamptz not null default now();

create index if not exists subscriptions_rc_uid_idx
  on public.subscriptions (rc_app_user_id);

-- Índice del barrido diario: filas activas que ya vencieron.
create index if not exists subscriptions_sweep_idx
  on public.subscriptions (expires_at)
  where entitlement_active = true;

-- Normalización de vocabulario: la versión anterior de rc-webhook escribía
-- 'grace' para BILLING_ISSUE. El muro del cliente sólo conoce 'past_due' y
-- 'expired' (ver _pvSubGate en index.html), así que 'grace' caía al copy
-- genérico. Se unifica en 'past_due' y el webhook nuevo ya sólo escribe eso.
update public.subscriptions set status = 'past_due' where status = 'grace';

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · RLS — la protección MÁS importante del sistema
--     La anon key viaja en un index.html público. Sin esto, cualquiera
--     escribe entitlement_active = true en su propia fila y entra gratis.
--     Verificado: el cliente SÓLO hace SELECT sobre esta tabla
--     (index.html:27601, _pvSubStatus). Quitar las policies de escritura no
--     rompe ningún camino del front.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;   -- ni el owner se salta la RLS

-- Borrado DINÁMICO de todas las policies existentes, se llamen como se llamen.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'subscriptions'
  loop
    execute format('drop policy %I on public.subscriptions', p.policyname);
  end loop;
end $$;

-- LECTURA de la propia fila: sí (es lo que consume _pvSubStatus()).
create policy "sub_select_own" on public.subscriptions
  for select to authenticated
  using (user_id = auth.uid());

-- ESCRITURA: ninguna policy para authenticated/anon.
-- service_role ignora la RLS por diseño → sólo los webhooks escriben.

-- ─────────────────────────────────────────────────────────────────────────
-- 3 · Idempotencia de webhooks
--     RevenueCat reintenta un evento hasta que reciba 2xx. Sin esta tabla,
--     un reintento de EXPIRATION después de que el usuario ya re-suscribió
--     le vuelve a quitar el acceso.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.subscription_events (
  event_id     text primary key,
  user_id      uuid,
  type         text,
  store        text,
  event_ms     bigint,
  payload      jsonb,
  processed_at timestamptz not null default now()
);
alter table public.subscription_events enable row level security;
-- Sin policies: sólo service_role. Nadie más lee ni escribe.

create index if not exists subscription_events_user_idx
  on public.subscription_events (user_id, processed_at desc);

-- ─────────────────────────────────────────────────────────────────────────
-- 4 · Eventos huérfanos (app_user_id anónimo de RevenueCat)
--     Compra hecha antes de que PortivIAP.login(uid) corriera → el evento
--     llega con $RCAnonymousID:… y no hay a quién atribuirlo. Se guarda en
--     vez de descartarse: entitlement-sync lo reclama cuando el usuario
--     entra con sesión y RevenueCat resuelve el alias.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.subscription_orphans (
  id             bigserial primary key,
  rc_app_user_id text not null,
  event_id       text,
  payload        jsonb,
  claimed_by     uuid,
  created_at     timestamptz not null default now()
);
alter table public.subscription_orphans enable row level security;

create index if not exists subscription_orphans_rc_idx
  on public.subscription_orphans (rc_app_user_id) where claimed_by is null;

-- ─────────────────────────────────────────────────────────────────────────
-- 5 · has_active_entitlement(uid) — el candado del servidor
--     La usan snaptrade-connect / -refresh / -history (403 subscription_required)
--     y snaptrade-cleanup (revalidación antes de desconectar). Se reescribe
--     para incluir la ventana de gracia y el bypass del dueño.
--     SECURITY DEFINER: lee la tabla saltándose RLS.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.has_active_entitlement(uid uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  r  public.subscriptions%rowtype;
  em text;
begin
  if uid is null then return false; end if;

  -- Bypass del dueño (mismo criterio que OWNER_EMAILS en index.html:27568).
  select lower(email) into em from auth.users where id = uid;
  if em in ('rafaelmunozanselmi@icloud.com', 'rafa10pro3@gmail.com') then
    return true;
  end if;

  select * into r from public.subscriptions where user_id = uid;
  if not found then return false; end if;
  if r.entitlement_active is not true then return false; end if;

  -- Ventana de gracia por fallo de cobro: Apple sigue reintentando y el
  -- usuario conserva el acceso aunque expires_at ya haya pasado.
  if r.grace_until is not null and r.grace_until > now() then
    return true;
  end if;

  -- Cinturón y tirantes: si el webhook de EXPIRATION nunca llegó, la fecha
  -- manda igual. 48 h de colchón por desfase de reloj y por el retraso real
  -- con el que Apple emite la notificación de renovación.
  if r.expires_at is not null and r.expires_at < now() - interval '48 hours' then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.has_active_entitlement(uuid) from public, anon;
grant execute on function public.has_active_entitlement(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 6 · Motivo de desconexión de SnapTrade
--     El cliente ya lee profiles.snaptrade_disconnected_reason y pinta la
--     tarjeta "Tu broker se desconectó" cuando el motivo casa con
--     /trial_expired|subscription_/i y no es 'manual'
--     (ver _isSubReason en index.html:28561).
--     Los motivos nuevos de iOS ('subscription_ended_appstore:…') lo cumplen.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists snaptrade_disconnected_reason text,
  add column if not exists snaptrade_disconnected_at     timestamptz;

-- ─────────────────────────────────────────────────────────────────────────
-- 7 · Barrido diario (red de seguridad ante webhooks perdidos)
--     Requiere pg_cron + pg_net habilitados (Database → Extensions).
--     entitlement-sweeper SÓLO apaga las filas vencidas; la desconexión del
--     broker la sigue haciendo snaptrade-cleanup (cron horario ya existente),
--     que revalida has_active_entitlement antes de borrar nada. Dos funciones
--     borrando usuarios de SnapTrade a la vez sería pedir una carrera.
--
--     ⚠️  Sustituye <SERVICE_ROLE_KEY> antes de ejecutar este bloque.
--     ⚠️  Alternativa sin clave en pg_cron: Supabase → Edge Functions → Schedules.
-- ─────────────────────────────────────────────────────────────────────────
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.unschedule('portiv-entitlement-sweep')
--   where exists (select 1 from cron.job where jobname = 'portiv-entitlement-sweep');
--
-- select cron.schedule(
--   'portiv-entitlement-sweep',
--   '17 7 * * *',                    -- 07:17 UTC ≈ 02:17 Panamá, tráfico mínimo
--   $$
--   select net.http_post(
--     url     := 'https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/entitlement-sweeper',
--     headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
--     body    := '{}'::jsonb
--   );
--   $$
-- );

-- ─────────────────────────────────────────────────────────────────────────
-- 8 · Verificación (BLOQUEANTE — no sigas si no da esto)
-- ─────────────────────────────────────────────────────────────────────────
-- Debe devolver EXACTAMENTE 1 fila: sub_select_own / SELECT
--   select policyname, cmd from pg_policies where tablename = 'subscriptions';
--
-- Debe devolver true en ambas columnas:
--   select relrowsecurity, relforcerowsecurity
--     from pg_class where relname = 'subscriptions';
--
-- Debe devolver true (bypass del dueño):
--   select public.has_active_entitlement(
--     (select id from auth.users where lower(email)='rafaelmunozanselmi@icloud.com'));
