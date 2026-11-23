-- ═══════════════════════════════════════════════════════════════════════════
-- Creadores v2 · complementos (aplicar DESPUÉS de desplegar el rc-webhook que ya no usa las
-- tablas viejas):
--   1. creators_backfill(): red de seguridad. Si rc-webhook no pudo pasarle un evento al
--      programa de creadores, este cron horario lo recupera de subscription_events.
--   2. admin_find_auth_user(): para que creators-admin enlace la cuenta del creador.
--   3. Borra el esquema en español del 22 nov (solo tenía PORTIV7, ya migrado). Se niega si
--      hubiera atribuciones o ventas.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.creators_backfill(p_hours int default 72) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select s.payload
      from public.subscription_events s
     where s.processed_at > now() - make_interval(hours => p_hours)
       and s.payload ? 'id'
       and not exists (select 1 from public.creator_events e where e.event_id = s.event_id)
     order by coalesce(s.event_ms, 0), s.processed_at
  loop
    perform public.creators_process_event(r.payload, false);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.admin_find_auth_user(p_email text) returns uuid
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) order by u.created_at limit 1
$$;

revoke execute on function public.creators_backfill(int), public.admin_find_auth_user(text) from public, anon, authenticated;
grant execute on function public.creators_backfill(int), public.admin_find_auth_user(text) to service_role;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule('creators-backfill')
      where exists (select 1 from cron.job where jobname = 'creators-backfill');
    perform cron.schedule('creators-backfill', '7 * * * *', 'select public.creators_backfill()');
  end if;
end $$;

-- Esquema anterior.
do $$
declare v bigint;
begin
  if to_regclass('public.creadores') is null then return; end if;
  execute 'select (select count(*) from public.creador_usuarios) + (select count(*) from public.creador_pendientes)
                + (select count(*) from public.creador_ventas)' into v;
  if v > 0 then
    raise exception 'El esquema viejo de creadores tiene % filas de uso; no se borra', v;
  end if;
  if exists (select 1 from public.creadores c where not exists (select 1 from public.creators n where n.offer_code = c.codigo)) then
    raise exception 'Hay creadores viejos sin migrar; no se borra';
  end if;
  drop view if exists public.creador_reporte_mensual;
  drop view if exists public.creador_resumen;
  drop table if exists public.creador_ventas;
  drop table if exists public.creador_pendientes;
  drop table if exists public.creador_usuarios;
  drop table if exists public.creadores;
end $$;
