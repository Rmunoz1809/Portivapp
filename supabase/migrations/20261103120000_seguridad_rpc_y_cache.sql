-- Seguridad y escala (3 nov 2026).
--
-- 1 · Funciones internas fuera del alcance de la anon key.
-- Las cuatro son SECURITY DEFINER (corren con permisos del dueño, saltándose RLS) y
-- Postgres concede EXECUTE a PUBLIC por defecto, así que cualquiera con la anon key —que
-- viaja en el HTML público— podía llamarlas por /rest/v1/rpc/…:
--   · acquire_shared_lock(key, holder, 0) sobrescribía CUALQUIER fila de shared_analysis
--     (noticias, análisis por acción) con un {id, ts}: borraba el contenido de todos.
--   · release_shared_lock soltaba locks ajenos (generaciones duplicadas = gasto de IA).
--   · bump_rate_limit dejaba agotar el cupo de otro usuario conociendo su uuid.
--   · pv_run_generate disparaba el pipeline de generación (lee secretos de Vault).
-- Sólo las usan Edge Functions con service role (shared-write) y pg_cron (postgres).
revoke execute on function public.acquire_shared_lock(text, text, integer) from public, anon, authenticated;
revoke execute on function public.release_shared_lock(text, text)          from public, anon, authenticated;
revoke execute on function public.bump_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.pv_run_generate(text, jsonb)              from public, anon, authenticated;
grant  execute on function public.acquire_shared_lock(text, text, integer) to service_role;
grant  execute on function public.release_shared_lock(text, text)          to service_role;
grant  execute on function public.bump_rate_limit(uuid, text, integer, integer) to service_role;
grant  execute on function public.pv_run_generate(text, jsonb)              to service_role;

-- 2 · TRUNCATE no pasa por RLS. PostgREST no lo expone, pero ningún rol cliente lo
-- necesita: se retira (junto con TRIGGER y REFERENCES) como defensa en profundidad.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- 3 · fh_cache crecía sin límite: 311 MB de 340 MB de la base (plan gratis = 500 MB, y al
-- pasarse el proyecto queda en sólo lectura). Las claves de /company-news y de las barras
-- de Alpaca llevan la fecha dentro, así que cada día nacen filas nuevas que nadie vuelve a
-- leer. La caché vencida sólo sirve de respaldo ante un 429 de LA MISMA clave, así que:
--   · noticias y barras: fuera a los 3 días;
--   · el resto: fuera a los 60 días (los estados financieros, que cambian por trimestre, a
--     los 120).
create or replace function public.fh_cache_purge()
returns integer
language sql
security definer
set search_path = public
as $$
  with d as (
    delete from public.fh_cache
     where ((key like '/company-news%' or key like 'alpaca:%') and fetched_at < now() - interval '3 days')
        or (key like '/stock/financials-reported%' and fetched_at < now() - interval '120 days')
        or (key not like '/stock/financials-reported%' and fetched_at < now() - interval '60 days')
    returning 1
  )
  select count(*)::int from d;
$$;
revoke execute on function public.fh_cache_purge() from public, anon, authenticated;

-- Índice para que la purga (y el respaldo por antigüedad) no recorra la tabla entera.
create index if not exists fh_cache_fetched_at_idx on public.fh_cache (fetched_at);

select cron.schedule('fh-cache-purge', '17 4 * * *', $$select public.fh_cache_purge()$$);

-- 4 · Tope de IA por usuario: los proxies de IA anotan cada llamada en rate_limits
-- (bump_rate_limit, buckets ai:<proxy>:min / ai:<proxy>:day) y su consumo en ai_usage.
-- rate_limits también crecía sin purga; una fila por usuario y bucket, así que basta con
-- tirar las ventanas que vencieron hace más de 2 días.
create or replace function public.rate_limits_purge()
returns integer
language sql
security definer
set search_path = public
as $$
  with d as (delete from public.rate_limits where window_start < now() - interval '2 days' returning 1)
  select count(*)::int from d;
$$;
revoke execute on function public.rate_limits_purge() from public, anon, authenticated;
select cron.schedule('rate-limits-purge', '27 4 * * *', $$select public.rate_limits_purge()$$);

-- 5 · Acceso de dueño y de demo por CUENTA, no por email.
-- has_active_entitlement() regalaba Portiv Pro a cualquier email de una lista, y la lista
-- incluía rafa10pro3@gmail.com, que NUNCA se registró. Con «Confirm email» apagado
-- (mailer_autoconfirm) cualquiera podía crear esa cuenta con una contraseña cualquiera y
-- tener Pro gratis en el servidor: IA de pago y conexiones de SnapTrade (~$1/mes cada una).
-- Ahora el bypass sale de una tabla con los uid de las cuentas que YA existen; un email
-- nuevo, aunque coincida, no hereda nada.
create table if not exists public.access_grants (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('owner', 'demo')),
  created_at timestamptz not null default now()
);
alter table public.access_grants enable row level security;
revoke all on public.access_grants from public, anon, authenticated;

insert into public.access_grants (user_id, kind)
select id, case when lower(email) = 'review@portivapp01.com' then 'demo' else 'owner' end
  from auth.users
 where lower(email) in ('rafaelmunozanselmi@icloud.com', 'review@portivapp01.com')
   and email_confirmed_at is not null
on conflict (user_id) do nothing;

do $$
begin
  if not exists (select 1 from public.access_grants where kind = 'owner') then
    raise exception 'access_grants: no se encontró la cuenta del dueño; no se aplica nada';
  end if;
end $$;

create or replace function public.has_active_entitlement(uid uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  r       public.subscriptions%rowtype;
  caller  uuid := auth.uid();
begin
  if uid is null then return false; end if;

  -- Gate de aislamiento: un usuario autenticado sólo puede preguntar por sí mismo.
  -- Las Edge Functions usan service_role → auth.uid() es null → pasan sin problema.
  if caller is not null and caller <> uid then
    raise exception 'has_active_entitlement: solo se permite consultar el propio uid'
      using errcode = '42501';
  end if;

  -- Dueño y cuentas de DEMO/REVIEW: acceso concedido a mano, sin compra, por uid.
  if exists (select 1 from public.access_grants g where g.user_id = uid) then
    return true;
  end if;

  select * into r from public.subscriptions where user_id = uid;
  if not found then return false; end if;
  if r.entitlement_active is not true then return false; end if;

  if r.grace_until is not null and r.grace_until > now() then
    return true;
  end if;

  if r.expires_at is not null and r.expires_at < now() - interval '48 hours' then
    return false;
  end if;

  return true;
end;
$$;
revoke all on function public.has_active_entitlement(uuid) from public, anon;
grant execute on function public.has_active_entitlement(uuid) to authenticated, service_role;

-- 6 · client_errors: cualquier usuario puede insertar (es su función); sin purga crecería
-- para siempre si alguien la inunda. 30 días bastan para depurar.
select cron.schedule('client-errors-purge', '37 4 * * *',
  $$delete from public.client_errors where created_at < now() - interval '30 days'$$);
