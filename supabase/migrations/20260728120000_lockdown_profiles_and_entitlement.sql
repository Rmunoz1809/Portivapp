-- ═══════════════════════════════════════════════════════════════════════════
-- PORTIV · Cierre de dos agujeros de escritura/lectura sobre datos ajenos
-- Proyecto: zblhifszlhdgkhnymwjh  ·  Idempotente: se puede correr varias veces.
--
--   1. CORRECCIÓN: la versión anterior de este archivo revocaba y volvía a
--      conceder los privilegios de `profiles` porque la auditoría se hizo sobre
--      los archivos de migración, donde el GRANT es de tabla entera. La base de
--      producción NO está así — se comprobó con has_column_privilege antes de
--      aplicar nada, y ya tiene el candado por columna:
--        · authenticated INSERT/UPDATE → sólo (email, id, portfolio, updated_at)
--        · authenticated SELECT        → todo menos snaptrade_user_secret
--        · authenticated DELETE        → ninguno
--        · anon                        → ninguno
--      Es decir: `snaptrade_user_secret` no es legible y `snaptrade_connected_at`
--      / `snaptrade_user_id` no son escribibles desde el cliente. El revoke+grant
--      habría QUITADO lecturas que el cliente sí usa y AÑADIDO un DELETE que hoy
--      no tiene. Se elimina. Sólo queda el endurecimiento que no rompe nada.
--
--   2. ESTE SÍ SIGUE ABIERTO (verificado en producción): `has_active_entitlement(uid)`
--      es SECURITY DEFINER, está concedida a
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

-- FORCE: hoy es un no-op y conviene saberlo. El dueño de la tabla es `postgres`,
-- que tiene el atributo BYPASSRLS, y BYPASSRLS gana sobre FORCE. Se deja porque
-- el día que la tabla cambie de dueño a un rol sin ese atributo, la RLS seguirá
-- aplicándosele. Comprobado que no hay triggers en auth.users que pudieran
-- quedar atrapados por la RLS al insertarse el perfil de un alta nueva.
alter table public.profiles force row level security;

-- REFERENCES sobre TODAS las columnas está concedido a anon y a authenticated.
-- No permite leer datos, pero sí crear una FK que apunte a cualquier columna, lo
-- que impide borrarlas o cambiarlas de tipo, y confirma la existencia de valores.
-- No lo usa nadie: se revoca. Es lo único de esta sección que cambia algo.
revoke references on table public.profiles from anon, authenticated;

-- NO se tocan SELECT/INSERT/UPDATE: ya están limitados por columna en producción.
-- NO se concede DELETE: hoy `authenticated` no lo tiene y la app funciona, así que
-- el borrado de cuenta va por la Edge Function `delete-account` (service role).
-- Concederlo sería ampliar privilegios, no restringirlos.

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
-- 3 · Verificación BLOQUEANTE, dentro de la propia migración
--
--     Se usa has_*_privilege en vez de information_schema porque esas vistas
--     sólo muestran lo que el rol actual puede ver; las funciones responden
--     igual sea quien sea el que aplica la migración. Si algo no queda como
--     debe, esto lanza excepción y la transacción entera se deshace: es
--     preferible no aplicar nada a aplicar un candado a medias.
-- ─────────────────────────────────────────────────────────────────────────
do $verify$
declare
  fallos text[] := '{}';
begin
  -- (a) NO debe quedar privilegio de TABLA sobre profiles salvo DELETE: si
  --     sobrevive uno, los GRANTs por columna son decorativos.
  if has_table_privilege('authenticated', 'public.profiles', 'SELECT') then
    fallos := fallos || 'authenticated conserva SELECT a nivel de tabla';
  end if;
  if has_table_privilege('authenticated', 'public.profiles', 'UPDATE') then
    fallos := fallos || 'authenticated conserva UPDATE a nivel de tabla';
  end if;
  if has_table_privilege('authenticated', 'public.profiles', 'INSERT') then
    fallos := fallos || 'authenticated conserva INSERT a nivel de tabla';
  end if;

  -- (b) Lo que el cliente SÍ necesita debe seguir funcionando.
  if not has_column_privilege('authenticated', 'public.profiles', 'portfolio', 'SELECT') then
    fallos := fallos || 'falta SELECT(portfolio): rompe la carga del portafolio';
  end if;
  if not has_column_privilege('authenticated', 'public.profiles', 'portfolio', 'UPDATE') then
    fallos := fallos || 'falta UPDATE(portfolio): rompe la sincronización a la nube';
  end if;
  if not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE') then
    fallos := fallos || 'falta UPDATE(id): PostgREST lo necesita en el on-conflict del upsert';
  end if;
  if not has_column_privilege('authenticated', 'public.profiles', 'email', 'INSERT') then
    fallos := fallos || 'falta INSERT(email): rompe la creación del perfil';
  end if;

  -- (b2) El gate de has_active_entitlement: el motivo real de esta migración.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'has_active_entitlement'
       and p.prosrc like '%auth.uid()%'
  ) then
    fallos := fallos || 'has_active_entitlement sigue sin comprobar el uid del llamante';
  end if;

  -- (c) El motivo de todo esto: las columnas de SnapTrade quedan server-only.
  if has_column_privilege('authenticated', 'public.profiles', 'snaptrade_user_secret', 'SELECT') then
    fallos := fallos || 'snaptrade_user_secret sigue siendo legible por el cliente';
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'snaptrade_connected_at', 'UPDATE') then
    fallos := fallos || 'snaptrade_connected_at sigue siendo escribible: evade snaptrade-cleanup';
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'snaptrade_user_id', 'UPDATE') then
    fallos := fallos || 'snaptrade_user_id sigue siendo escribible: permite romper la conexión de un tercero';
  end if;

  -- (d) anon viaja en el bundle público: no debe poder ni leer.
  if has_any_column_privilege('anon', 'public.profiles', 'SELECT') then
    fallos := fallos || 'anon conserva lectura sobre profiles';
  end if;

  -- (e) RLS activa y forzada.
  if not (select relrowsecurity and relforcerowsecurity
            from pg_class where oid = 'public.profiles'::regclass) then
    fallos := fallos || 'RLS no está enable+force en profiles';
  end if;

  if array_length(fallos, 1) is not null then
    raise exception E'Verificación del candado de profiles FALLIDA:\n  - %',
      array_to_string(fallos, E'\n  - ');
  end if;

  raise notice 'profiles: candado por columna verificado OK';
end
$verify$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4 · Comprobación manual restante (no automatizable desde aquí)
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
