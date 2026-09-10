-- ═══════════════════════════════════════════════════════════════════════════
--  Precio objetivo propio del usuario  (Feature 2)
--  ───────────────────────────────────────────────────────────────────────
--  El número lo fija el USUARIO, no Portiv. No es una recomendación ni un
--  consenso: es una referencia personal que la app compara con el precio actual
--  y marca cuando el precio la cruza.
--
--  Reglas:
--    · Máximo dos objetivos por ticker: uno "al alza" (above) y uno "a la baja"
--      (below). Lo garantiza el UNIQUE (user_id, ticker, direction); el cliente
--      hace upsert sobre esa clave, así que editar = reemplazar.
--    · `triggered_at` lo escribe el cliente la PRIMERA vez que ve el cruce
--      (above: precio >= objetivo; below: precio <= objetivo). Al editar el
--      objetivo se vuelve a poner en NULL.
--    · Cero IA en esta ruta. El push (fuera de alcance por ahora) leería de aquí.
--
--  Re-ejecutable: create if not exists / drop policy if exists + create policy.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.user_price_targets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  ticker        text not null,
  target_price  numeric not null check (target_price > 0),
  direction     text not null check (direction in ('above','below')),
  note          text null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  triggered_at  timestamptz null,
  unique (user_id, ticker, direction)
);

comment on table  public.user_price_targets is
  'Precio objetivo fijado por el propio usuario por ticker y dirección. No es una recomendación de Portiv.';
comment on column public.user_price_targets.direction is
  'above = al alza (avisa cuando precio >= objetivo); below = a la baja (precio <= objetivo).';
comment on column public.user_price_targets.triggered_at is
  'Primera vez que el precio cruzó el objetivo. NULL = todavía no. Se reinicia al editar el objetivo.';

-- Todas las lecturas del cliente son "mis objetivos": por usuario.
create index if not exists user_price_targets_user_idx on public.user_price_targets(user_id);

-- ── updated_at automático ────────────────────────────────────────────────────
create or replace function public.user_price_targets_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_price_targets_touch_trg on public.user_price_targets;
create trigger user_price_targets_touch_trg
  before update on public.user_price_targets
  for each row execute function public.user_price_targets_touch();

-- ── RLS: cada usuario ve y toca SÓLO lo suyo ─────────────────────────────────
alter table public.user_price_targets enable row level security;
alter table public.user_price_targets force row level security;

drop policy if exists user_price_targets_select_own on public.user_price_targets;
create policy user_price_targets_select_own on public.user_price_targets
  for select using (auth.uid() = user_id);

drop policy if exists user_price_targets_insert_own on public.user_price_targets;
create policy user_price_targets_insert_own on public.user_price_targets
  for insert with check (auth.uid() = user_id);

drop policy if exists user_price_targets_update_own on public.user_price_targets;
create policy user_price_targets_update_own on public.user_price_targets
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists user_price_targets_delete_own on public.user_price_targets;
create policy user_price_targets_delete_own on public.user_price_targets
  for delete using (auth.uid() = user_id);

-- ── Grants: sólo lo que el cliente autenticado necesita; nada para anon ──────
revoke all on table public.user_price_targets from anon;
revoke all on table public.user_price_targets from authenticated;
grant select, insert, update, delete on table public.user_price_targets to authenticated;
