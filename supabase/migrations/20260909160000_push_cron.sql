-- ═══════════════════════════════════════════════════════════════════════════
--  Cron de las dos notificaciones push
--  ───────────────────────────────────────────────────────────────────────
--  Las dos funciones corren cada hora y ELLAS deciden si es su momento mirando
--  la hora en ET. Por eso el cron no lleva hora fija: si la llevara, habría que
--  reagendarlo dos veces al año por el horario de verano de Nueva York.
--
--    push-morning → actúa cuando en ET son las 8  → sale 8:30 ET (abre 9:30)
--    push-close   → actúa cuando en ET son las 16 → sale 16:05 ET
--
--  El minuto del cron NO es decorativo: es el que fija el minuto real de envío.
--  Cambiarlo mueve la notificación.
--
--  El secreto va por Vault, no por `supabase secrets set`: eso último sólo lo ve
--  la Edge Function. pg_cron necesita el mismo valor en Vault con el nombre
--  `push_cron_secret` para poder mandarlo en la cabecera.
-- ═══════════════════════════════════════════════════════════════════════════

select cron.unschedule('push-morning')
 where exists (select 1 from cron.job where jobname = 'push-morning');

select cron.schedule(
  'push-morning',
  '30 * * * *',                -- minuto 30 → 8:30 ET cuando la función abre su ventana
  $cron$
    select net.http_post(
      url     := 'https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/push-morning',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', coalesce(
          (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'),
          ''
        )
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);

select cron.unschedule('push-close')
 where exists (select 1 from cron.job where jobname = 'push-close');

select cron.schedule(
  'push-close',
  '5 * * * *',                 -- minuto 5 → 16:05 ET: da aire a que se asiente el cierre
  $cron$
    select net.http_post(
      url     := 'https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/push-close',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', coalesce(
          (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'),
          ''
        )
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);
