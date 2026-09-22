-- ═══════════════════════════════════════════════════════════════════════════
--  fomc_calendar — las reuniones de la Fed, sincronizadas solas
--  ───────────────────────────────────────────────────────────────────────────
--  La lista de reuniones estaba escrita a mano en push-rank.js y sólo llegaba a
--  2026: desde enero de 2027 el evento de mayor impacto del calendario habría
--  desaparecido en silencio. `fomc-sync` rellena esta tabla desde el calendario
--  que publica la propia Fed, y el motor la usa por encima de su lista de respaldo.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.fomc_calendar (
  decision   date primary key,          -- día del anuncio de tasas (2:00 PM ET)
  minutes    date not null,             -- actas: tres semanas después, regla fija de la Fed
  fuente     text not null default 'federalreserve.gov',
  updated_at timestamptz not null default now()
);

-- Nadie la lee desde el cliente: sólo la Edge Function, con service_role.
alter table public.fomc_calendar enable row level security;

create table if not exists public.fomc_sync_runs (
  id         uuid primary key default gen_random_uuid(),
  corrio_at  timestamptz not null default now(),
  ok         boolean not null,
  reuniones  int,
  anios      text[],
  detalle    text
);
alter table public.fomc_sync_runs enable row level security;

-- Semilla: las de 2026, las mismas que ya estaban en el código. Si la Fed no
-- responde nunca, el comportamiento es idéntico al de antes.
insert into public.fomc_calendar (decision, minutes, fuente) values
  ('2026-01-28','2026-02-18','semilla'), ('2026-03-18','2026-04-08','semilla'),
  ('2026-04-29','2026-05-20','semilla'), ('2026-06-17','2026-07-08','semilla'),
  ('2026-07-29','2026-08-19','semilla'), ('2026-09-16','2026-10-07','semilla'),
  ('2026-10-28','2026-11-18','semilla'), ('2026-12-09','2026-12-30','semilla')
on conflict (decision) do nothing;
