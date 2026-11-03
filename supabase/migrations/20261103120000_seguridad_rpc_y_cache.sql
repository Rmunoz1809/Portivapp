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
