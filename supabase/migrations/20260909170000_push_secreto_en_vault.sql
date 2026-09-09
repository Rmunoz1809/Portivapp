-- ═══════════════════════════════════════════════════════════════════════════
--  El secreto del cron deja de vivir en dos sitios
--  ───────────────────────────────────────────────────────────────────────
--  Antes el mismo valor tenía que estar en los secretos de las Edge Functions
--  (para validar) y en Vault (para que pg_cron lo mandara). Mantener dos copias
--  sincronizadas a mano es una fuente de fallo silencioso: si se desincronizan,
--  las funciones responden 403 cada hora y nada parece roto.
--
--  Ahora la única copia vive en Vault. Se genera aquí dentro, así que no la
--  escribe nadie ni pasa por ningún portapapeles, y la función la valida por
--  RPC sin llegar a leerla.
-- ═══════════════════════════════════════════════════════════════════════════

-- 64 hex a partir de dos uuid: no necesita pgcrypto ni saber en qué esquema está.
-- Tiene que ir por `vault.create_secret`: el insert directo en `vault.secrets`
-- muere con «permission denied for function _crypto_aead_det_noncegen», porque
-- el cifrado lo hace la propia función y el rol de las migraciones no lo alcanza.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'push_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'push_cron_secret'
    );
  end if;
end $$;

-- Devuelve un booleano, NUNCA el secreto: si esta función se filtrara, no se
-- puede sacar el valor de ella, sólo comprobar uno que ya se tenga.
create or replace function public.push_cron_ok(p_secreto text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
     where name = 'push_cron_secret'
       and decrypted_secret = p_secreto
       and length(coalesce(p_secreto, '')) > 0
  );
$$;

revoke all on function public.push_cron_ok(text) from public, anon, authenticated;
grant execute on function public.push_cron_ok(text) to service_role;
