-- Vigía de conexiones de broker (snaptrade-health) + cadencia de avisos de reconexión.
--
-- 1. `profiles.snaptrade_broken_notified_at`: cuándo se avisó por última vez al usuario de
--    que una conexión de su broker está caída. La usa _shared/broker-alert.ts para avisar
--    al detectarlo y recordar como mucho cada 72 h mientras siga caída; se pone a NULL
--    cuando la conexión vuelve.
-- 2. Cron cada 3 h → snaptrade-health. Usa el mismo secreto de Vault que snaptrade-cleanup
--    (`snaptrade_cron_secret`). Esa función nunca borra ni desconecta nada.

alter table public.profiles
  add column if not exists snaptrade_broken_notified_at timestamptz;

comment on column public.profiles.snaptrade_broken_notified_at is
  'Último aviso push de "reconecta tu broker" (snaptrade-webhook / snaptrade-health). NULL = sin aviso pendiente.';

-- Idempotente: si el job ya existe se reprograma con la misma definición.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'snaptrade-health') then
    perform cron.unschedule('snaptrade-health');
  end if;
end $$;

select cron.schedule(
  'snaptrade-health',
  '23 */3 * * *',
  $cron$
    select net.http_post(
      url     := 'https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/snaptrade-health',
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
