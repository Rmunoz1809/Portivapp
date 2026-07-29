-- ═══════════════════════════════════════════════════════════════════════════
-- PORTIV · Cierre de dos agujeros de escritura/lectura sobre datos ajenos
-- Proyecto: zblhifszlhdgkhnymwjh  ·  Idempotente: se puede correr varias veces.
--
--   1. `profiles` daba UPDATE sobre TODAS las columnas a `authenticated`. La RLS
--      limita la FILA (auth.uid() = id) pero no la COLUMNA, así que un usuario
--      podía escribir su propio `snaptrade_user_id`, `snaptrade_user_secret` o
--      `snaptrade_connected_at` con la anon key desde la consola del navegador.
--      Consecuencias reales:
--        · poner `snaptrade_connected_at` en el futuro → evade snaptrade-cleanup
--          (la baja por trial vencido nunca dispara: broker gratis para siempre).
--        · escribir el `snaptrade_user_id` de OTRO usuario en la propia fila →
--          snaptrade-webhook hace `.eq("snaptrade_user_id", …)` y aplica el
--          parche a las DOS filas: se puede romper la conexión de un tercero.
--        · borrar `snaptrade_user_secret` → deja al usuario de SnapTrade huérfano
--          y facturándose sin forma de darlo de baja.
--
--   2. `has_active_entitlement(uid)` es SECURITY DEFINER, está concedida a
--      `authenticated` y NUNCA comprueba que `uid = auth.uid()`. Cualquier usuario
--      podía consultar el estado de suscripción de cualquier otro con sólo su UUID
--      (`select public.has_active_entitlement('<uuid ajeno>')`), saltándose la RLS
--      de `subscriptions` que precisamente prohíbe eso.
--
--   3. De paso: `snaptrade_cleanup_retry_count` y `snaptrade_cleanup_last_attempt_at`
--      se leen y escriben en snaptrade-cleanup/index.ts y snaptrade-connect/index.ts
--      pero NO se declaran en ninguna migración (20260727210000 crea un índice sobre
--      la segunda sin haberla creado). Se añaden aquí para que un entorno nuevo no
--      se quede corto y para que el cron deje de fallar en silencio si faltan.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 0 · Columnas que el código ya usa pero nadie declaró
-- ─────────────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists snaptrade_cleanup_retry_count     integer not null default 0,
  add column if not exists snaptrade_cleanup_last_attempt_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────────
-- 1 · profiles — RLS forzada + privilegios A NIVEL DE COLUMNA
--
--     La RLS ya restringe la FILA. Esto restringe la COLUMNA, que es la mitad
--     que faltaba. Las cuatro columnas de abajo son EXACTAMENTE las que toca el
--     cliente (verificado en index.html):
--       · select('portfolio, updated_at')                       → línea 26686
--       · upsert({ id, email, portfolio, updated_at })           → líneas 26798, 26892
--       · delete().eq('id', uid)                                 → línea 27306
--     Todo lo demás (snaptrade_*, y cualquier columna futura) queda server-only:
--     service_role ignora estos GRANTs por diseño, así que las Edge Functions
--     siguen escribiendo sin cambios.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.profiles force  row level security;  -- ni el owner se salta la RLS

-- Se revoca en bloque y se vuelve a conceder columna por columna. Postgres NO
-- permite mezclar privilegios de tabla y de columna para el mismo comando: si
-- queda un `grant update on profiles`, el de columna es irrelevante.
revoke all on table public.profiles from anon, authenticated;

-- SELECT: sólo lo que el cliente lee. `snaptrade_user_secret` deja de ser legible
-- aunque alguien añada una policy de select permisiva por error.
grant select (id, email, portfolio, updated_at)
  on public.profiles to authenticated;

-- INSERT/UPDATE: el upsert del cliente necesita ambos sobre las mismas columnas.
grant insert (id, email, portfolio, updated_at)
  on public.profiles to authenticated;
-- `id` va TAMBIÉN en el update: PostgREST traduce .upsert() a
-- `insert … on conflict (id) do update set id = excluded.id, email = …`, o sea
-- incluye la columna de conflicto en el SET. Sin este privilegio el upsert del
-- cliente devolvería 42501 y la sincronización a la nube dejaría de funcionar.
-- Reescribirlo a un id ajeno lo sigue bloqueando la RLS: el `with check
-- (auth.uid() = id)` de profiles_update_own se evalúa sobre la fila NUEVA.
grant update (id, email, portfolio, updated_at)
  on public.profiles to authenticated;

-- DELETE: el borrado de cuenta del cliente (index.html:27306) lo necesita.
-- La RLS lo sigue limitando a la propia fila.
grant delete on public.profiles to authenticated;

-- `anon` sin nada. La anon key viaja en el bundle público: no debe poder ni leer.

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · has_active_entitlement — sólo sobre uno mismo
--
--     Se conserva la firma (uid uuid) porque snaptrade-connect / -refresh /
--     -history / -cleanup la llaman con el uid del usuario objetivo usando el
--     service_role. La regla nueva: si quien llama NO es service_role, el uid
--     debe ser el suyo. auth.uid() es null bajo service_role, así que el gate
--     distingue solo con eso — sin necesidad de pasar un flag extra.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.has_active_entitlement(uid uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  r       public.subscriptions%rowtype;
  em      text;
  caller  uuid := auth.uid();
begin
  if uid is null then return false; end if;

  -- Gate de aislamiento: un usuario autenticado sólo puede preguntar por sí mismo.
  -- Las Edge Functions usan service_role → auth.uid() es null → pasan sin problema.
  if caller is not null and caller <> uid then
    raise exception 'has_active_entitlement: solo se permite consultar el propio uid'
      using errcode = '42501';   -- insufficient_privilege
  end if;

  -- Bypass del dueño (mismo criterio que OWNER_EMAILS en index.html).
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
-- 3 · Verificación (BLOQUEANTE — no des esto por bueno sin correrlo)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) `authenticated` NO debe aparecer en privilegios de TABLA sobre profiles
--     salvo DELETE. Todo lo demás tiene que ser de columna:
--   select grantee, privilege_type from information_schema.table_privileges
--    where table_schema='public' and table_name='profiles'
--      and grantee in ('anon','authenticated');
--
-- (b) Las columnas concedidas deben ser exactamente las 4 de arriba:
--   select grantee, privilege_type, column_name
--     from information_schema.column_privileges
--    where table_schema='public' and table_name='profiles'
--      and grantee in ('anon','authenticated')
--    order by grantee, privilege_type, column_name;
--
-- (c) Debe dar true en ambas:
--   select relrowsecurity, relforcerowsecurity
--     from pg_class where relname='profiles';
--
-- (d) Prueba de fuego del punto 2 — desde una sesión de USUARIO (no SQL Editor,
--     que corre como postgres): `select public.has_active_entitlement('<uuid ajeno>')`
--     debe dar error 42501, y con el uuid propio debe devolver el booleano.
