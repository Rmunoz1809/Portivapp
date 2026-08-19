-- ═══════════════════════════════════════════════════════════════════════════
-- PORTIV · snaptrade_orphans — usuarios de SnapTrade que sobrevivieron al borrado
--
-- delete-account desvincula al usuario en SnapTrade ANTES de borrar su fila de
-- `profiles`, porque esa fila es lo único que guarda el snaptrade_user_id. Si esa
-- llamada falla (SnapTrade caído, 5xx, timeout) el borrado NO se aborta —el usuario
-- pidió irse y tiene derecho a irse— pero entonces queda en SnapTrade un usuario
-- vivo, con sus conexiones de broker activas, que ya nadie puede identificar ni
-- borrar: se factura ~1 $/mes por conexión indefinidamente y quedan enlaces de
-- solo-lectura contra cuentas de broker REALES de alguien que pidió que se le
-- borrara todo.
--
-- Esta tabla es el único sitio donde ese id sobrevive. Sin ella el fallo sólo deja
-- un console.error en los logs de la Edge Function, que caducan.
--
-- Idempotente: se puede correr varias veces.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.snaptrade_orphans (
  id                  bigint generated always as identity primary key,
  snaptrade_user_id   text        not null,
  -- Sin FK a auth.users: la fila se escribe JUSTO ANTES de borrar ese usuario, así que
  -- una FK haría fallar el insert o se lo llevaría por delante en cascada — que es
  -- exactamente el dato que hay que conservar. Se guarda suelto, como referencia
  -- histórica de a quién perteneció.
  supabase_user_id    uuid,
  reason              text,
  created_at          timestamptz not null default now(),
  -- Se rellenan cuando alguien (o un cron) consiga por fin borrarlo en SnapTrade.
  resolved_at         timestamptz,
  resolution          text
);

-- El reaper sólo busca pendientes; el índice parcial se mantiene pequeño.
create index if not exists snaptrade_orphans_pending_idx
  on public.snaptrade_orphans (created_at)
  where resolved_at is null;

-- Un mismo usuario puede fallar en varios intentos de borrado: se guarda uno.
create unique index if not exists snaptrade_orphans_uid_uidx
  on public.snaptrade_orphans (snaptrade_user_id)
  where resolved_at is null;

-- ─────────────────────────────────────────────────────────────────────────
-- Acceso: SÓLO service_role.
--
-- Contiene identificadores de usuarios de SnapTrade, que son la llave para operar
-- contra sus conexiones de broker. Ningún cliente tiene por qué leer esto, y quien
-- aparece aquí ya no tiene cuenta con la que autenticarse. RLS activada y SIN
-- políticas: con RLS puesta y cero políticas, anon/authenticated no ven nada aunque
-- alguien conceda un GRANT por error más adelante. service_role la ignora por diseño.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.snaptrade_orphans enable row level security;
alter table public.snaptrade_orphans force row level security;

revoke all on table public.snaptrade_orphans from anon, authenticated;
revoke all on sequence public.snaptrade_orphans_id_seq from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Verificación BLOQUEANTE. Igual criterio que la migración del candado de
-- `profiles`: si el resultado no es el esperado, se deshace todo en vez de dejar
-- una tabla de identificadores a medio proteger.
-- ─────────────────────────────────────────────────────────────────────────
do $verify$
declare
  fallos text[] := '{}';
begin
  if has_any_column_privilege('anon', 'public.snaptrade_orphans', 'SELECT') then
    fallos := fallos || 'anon puede leer snaptrade_orphans';
  end if;
  if has_any_column_privilege('authenticated', 'public.snaptrade_orphans', 'SELECT') then
    fallos := fallos || 'authenticated puede leer snaptrade_orphans';
  end if;
  if has_any_column_privilege('authenticated', 'public.snaptrade_orphans', 'INSERT') then
    fallos := fallos || 'authenticated puede escribir snaptrade_orphans';
  end if;
  if not (select relrowsecurity and relforcerowsecurity
            from pg_class where oid = 'public.snaptrade_orphans'::regclass) then
    fallos := fallos || 'RLS no está enable+force en snaptrade_orphans';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'snaptrade_orphans') then
    fallos := fallos || 'snaptrade_orphans tiene políticas: debe quedarse sin ninguna';
  end if;

  if array_length(fallos, 1) is not null then
    raise exception E'Verificación de snaptrade_orphans FALLIDA:\n  - %',
      array_to_string(fallos, E'\n  - ');
  end if;

  raise notice 'snaptrade_orphans: creada y cerrada a todo lo que no sea service_role';
end
$verify$;

comment on table public.snaptrade_orphans is
  'Usuarios de SnapTrade que siguieron vivos tras borrarse la cuenta en Portiv. '
  'Los escribe delete-account cuando deleteSnapTradeUser falla. Pendiente = resolved_at is null. '
  'Cada fila pendiente es una conexión de broker facturándose sin dueño: hay que borrarla en SnapTrade.';
