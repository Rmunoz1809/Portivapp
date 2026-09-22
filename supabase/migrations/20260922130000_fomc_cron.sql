-- fomc-sync: día 3 de cada mes a las 12:00 UTC. La Fed publica el calendario del
-- año siguiente a mediados de año; con una corrida mensual, 2027 entra solo
-- muchos meses antes de hacer falta. Mismo secreto de Vault que el resto del push.
select cron.schedule(
  'fomc-sync', '0 12 3 * *',
  $$ select net.http_post(
       url     := 'https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/fomc-sync',
       headers := jsonb_build_object(
         'content-type',  'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                            where name = 'push_cron_secret' limit 1))
     ) $$
);
