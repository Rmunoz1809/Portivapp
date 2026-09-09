-- ═══════════════════════════════════════════════════════════════════════════
--  Notificaciones push — tablas base
--  ───────────────────────────────────────────────────────────────────────
--  Dos avisos diarios, ambos gratis (free tier), ambos deterministas:
--    · matutino — el evento del calendario económico más relevante para SU cartera
--    · de cierre — cómo se movió su cartera hoy
--
--  Nada de esto pasa por un modelo de IA. El push llega a la pantalla de bloqueo
--  sin contexto y sin disclaimer, así que no puede llevar prosa generada.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── device_tokens ────────────────────────────────────────────────────────────
-- Un usuario puede tener varios dispositivos; cada token es único en el mundo.
create table if not exists public.device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  token        text not null unique,
  platform     text not null default 'ios',

  -- CRÍTICO. Un token de sandbox NO funciona contra api.push.apple.com y viceversa:
  -- Apple responde 400 BadDeviceToken. Sin esta columna no hay forma de saber a qué
  -- host mandar, y el bug sólo aparece en producción (donde el TestFlight sí andaba).
  environment  text not null check (environment in ('sandbox','production')),

  -- IANA, del cliente: Intl.DateTimeFormat().resolvedOptions().timeZone
  -- El mercado objetivo (hispanos en EE.UU.) va de ET a PT. Nunca asumir ET.
  timezone     text not null,

  opt_in_am    boolean not null default true,
  opt_in_close boolean not null default true,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists device_tokens_user_idx on public.device_tokens(user_id);
-- El fan-out agenda por hora local: se recorre por timezone, no por usuario.
create index if not exists device_tokens_tz_idx   on public.device_tokens(timezone)
  where opt_in_am or opt_in_close;

alter table public.device_tokens enable row level security;

drop policy if exists device_tokens_select_own on public.device_tokens;
create policy device_tokens_select_own on public.device_tokens
  for select using (auth.uid() = user_id);

drop policy if exists device_tokens_insert_own on public.device_tokens;
create policy device_tokens_insert_own on public.device_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists device_tokens_update_own on public.device_tokens;
create policy device_tokens_update_own on public.device_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists device_tokens_delete_own on public.device_tokens;
create policy device_tokens_delete_own on public.device_tokens
  for delete using (auth.uid() = user_id);

-- El mismo token puede cambiar de dueño: si alguien cierra sesión y entra otra
-- persona en ese iPhone, iOS entrega el MISMO token de APNs. Sin reasignar el
-- user_id, el segundo usuario recibiría la cartera del primero en su pantalla de
-- bloqueo. El upsert del cliente va por `token`, no por (user_id, token).
comment on column public.device_tokens.token is
  'Token de APNs. UNIQUE global: al reinstalar o cambiar de cuenta se reasigna el user_id.';


-- ── push_selection_log ───────────────────────────────────────────────────────
-- Sin esto no se puede responder "¿por qué mandó eso y no lo otro?" ni recalibrar
-- los pesos. Se guarda el DESGLOSE por componente, no sólo el total.
create table if not exists public.push_selection_log (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  fecha           date not null,
  ganador_id      text,
  ganador_score   numeric,
  candidatos      jsonb,          -- top 5 con score y desglose I/E/R o W/T/B
  enviado         boolean not null default false,
  motivo_no_envio text,

  -- ── Campos que el motor NECESITA y que no estaban en el diseño original ──
  -- Las tres reglas de fatiga del paso 4 son consultas sobre el historial:
  --   · "ese ticker salió en los últimos 3 días"     → ganador_tickers
  --   · "ese tipo de macro se mandó en 14 días"      → ganador_tipo
  --   · "ganó la misma pista 5 días seguidos"        → ganador_pista
  -- Sin columnas propias habría que reparsear `candidatos` en cada consulta.
  ganador_tickers text[],
  ganador_tipo    text,           -- 'CPI' | 'FOMC' | 'earnings' | …
  ganador_pista   text check (ganador_pista in ('A','B')),

  -- Umbral adaptativo (paso 5): si no abre 5 matutinas seguidas, el umbral sube a
  -- 65 para ese usuario. Hace falta saber si ABRIÓ, no sólo si se envió.
  abierto         boolean not null default false,
  abierto_at      timestamptz,

  created_at      timestamptz not null default now()
);

-- Anti-duplicado (7 días) y umbral adaptativo (últimas 5) leen por usuario+fecha.
create index if not exists push_log_user_fecha_idx
  on public.push_selection_log(user_id, fecha desc);

-- Un solo cálculo por usuario y día: re-correr el motor debe ser idempotente.
-- NULLS NOT DISTINCT es obligatorio, no cosmético: la notificación de CIERRE es
-- global y se registra con user_id NULL. Con la regla normal de Postgres, dos NULL
-- nunca chocan, el índice no dedupe nada y un reintento del cron mandaría el cierre
-- por segunda vez el mismo día.
create unique index if not exists push_log_user_fecha_uniq
  on public.push_selection_log(user_id, fecha) nulls not distinct;

alter table public.push_selection_log enable row level security;

-- El usuario puede LEER su propio historial (para la pantalla de ajustes y para
-- marcar la apertura). Escribir sólo lo hace el motor con service_role, que se
-- salta RLS: si el cliente pudiera insertar, podría falsear su propia fatiga.
drop policy if exists push_log_select_own on public.push_selection_log;
create policy push_log_select_own on public.push_selection_log
  for select using (auth.uid() = user_id);

drop policy if exists push_log_mark_open on public.push_selection_log;
create policy push_log_mark_open on public.push_selection_log
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ── push_portfolio ───────────────────────────────────────────────────────────
-- HALLAZGO que obligó a esta tabla: el servidor NO tenía forma de ver la cartera.
-- snaptrade-refresh es un PROXY — pide las posiciones a SnapTrade y se las devuelve
-- al cliente; no las guarda. No existe ninguna tabla de posiciones. Pero las dos
-- notificaciones necesitan la cartera, y a las 6 AM la app no está abierta.
--
-- Alternativa descartada: llamar a SnapTrade por usuario desde el cron. Cuesta por
-- usuario conectado y rompe la regla de "fan-out por evento, no por usuario".
--
-- Lo que se guarda son PESOS, nunca dinero. Con {ticker, peso} + las cotizaciones del
-- día (una sola llamada en lote para la unión de tickers de todos los usuarios) sale
-- todo: el % de la cartera del cierre y la intersección con el calendario. El
-- patrimonio del usuario no sale nunca del teléfono.
create table if not exists public.push_portfolio (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  -- [{ "t": "NVDA", "w": 0.3012 }, …]  pesos normalizados, suman ~1
  posiciones jsonb not null default '[]'::jsonb,
  top3       text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- Datos rancios son peores que nada: la de cierre no se manda si el snapshot lleva
-- más de 7 días sin refrescarse (broker desconectado).
create index if not exists push_portfolio_fresh_idx on public.push_portfolio(updated_at desc);

alter table public.push_portfolio enable row level security;

drop policy if exists push_portfolio_own on public.push_portfolio;
create policy push_portfolio_own on public.push_portfolio
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
