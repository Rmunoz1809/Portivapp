-- Dueño de cada cuenta de bróker (9 nov 2026).
--
-- Bug: una misma sesión de bróker con dos cuentas (p. ej. «Individual» y «IRA»), la cuenta 1
-- conectada en la cuenta de Portiv A y la cuenta 2 en la cuenta de Portiv B. Al conectar B,
-- el bróker actualiza el permiso que tiene SnapTrade sobre ESE login y la conexión de A
-- empieza a recibir también (o sólo) la cuenta 2: al volver a A, la app enseñaba las
-- posiciones de B sin que nadie lo pidiera.
--
-- Cada cuenta de bróker queda ligada a la cuenta de Portiv que la conectó primero. Las
-- Edge Functions de SnapTrade (refresh, history, activities) ocultan en A una cuenta que es
-- de B y que apareció en la conexión de A DESPUÉS de crearse (ver ownedAccounts en
-- functions/_shared/snaptrade.ts).
--
-- account_key = sha256 de (institución | número de cuenta), o del id de SnapTrade si el
-- bróker no da número. Nunca se guarda el número en claro.
-- account_created = cuándo apareció esa cuenta en SnapTrade para este dueño: decide quién
-- la tuvo primero si dos cuentas de Portiv la reclaman (el dato de antes de este arreglo
-- está mezclado y se corrige solo con esta fecha).
create table if not exists public.snaptrade_account_owners (
  account_key     text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  account_created timestamptz,
  claimed_at      timestamptz not null default now()
);
create index if not exists snaptrade_account_owners_user_idx
  on public.snaptrade_account_owners (user_id);

-- Sólo la usan Edge Functions con service role: sin políticas, ningún cliente la lee.
alter table public.snaptrade_account_owners enable row level security;
revoke all on public.snaptrade_account_owners from public, anon, authenticated;
grant select, insert, update, delete on public.snaptrade_account_owners to service_role;
