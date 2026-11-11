-- 11 nov 2026 · Aplicado a mano en producción desde el dashboard.
-- Los crons gen-* llamaban a /functions/v1/generate-shared, que no existe ni en el
-- repo ni desplegada, y faltaban los secretos de Vault (project_url / gen_shared_secret).
-- Fallaban desde el 21 jul 2026 sin un solo éxito. Las noticias y el resumen semanal
-- los genera la app (shared_analysis __NEWS_GENERAL_V3__ / __OUTLOOK__).
-- gen-health-check solo insertaba una alerta por hora en gen_runs.

select cron.unschedule(jobname)
  from cron.job
 where jobname in ('gen-news-am', 'gen-news-pm', 'gen-news-watchdog', 'gen-tickers', 'gen-health-check');

delete from public.gen_runs where kind = 'ALERT:no_ok_run_6h';

-- fh_cache se reescribe sin parar (upserts) y el espacio muerto no se devuelve solo:
-- 322 MB con ~39 MB de datos reales. Compactación semanal, domingo 04:47 UTC
-- (después de fh-cache-purge, 04:17). Bloquea la tabla ~15 s; es solo caché.
select cron.schedule('fh-cache-compact', '47 4 * * 0', 'VACUUM (FULL, ANALYZE) public.fh_cache');
