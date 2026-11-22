-- Códigos de creador (Offer Codes de Apple) y comisiones.
--
-- Flujo: el creador comparte su código (p. ej. JUAN7). El usuario lo canjea en la App Store
-- (link directo o «¿Tienes un código de creador?» en el muro). RevenueCat manda el evento con
-- `offer_code`; rc-webhook guarda a qué creador pertenece ese usuario (creador_usuarios) y,
-- desde ahí, cada cobro de ese usuario durante `meses` genera una fila en creador_ventas con la
-- comisión: comision_pct % del precio SIN impuestos. Reembolsos restan.
--
-- Todo es solo para service_role (RLS activo, sin políticas): ningún cliente lo lee.

create table if not exists public.creadores (
  codigo         text primary key check (codigo = upper(codigo) and codigo ~ '^[A-Z0-9]{3,40}$'),
  nombre         text not null,
  contacto       text,
  comision_pct   numeric(5,2) not null default 20 check (comision_pct >= 0 and comision_pct <= 100),
  meses          int not null default 12 check (meses > 0),
  activo         boolean not null default true,
  asc_offer_id   text,          -- id de la oferta en App Store Connect
  creado_at      timestamptz not null default now()
);

-- Usuario → creador. El primer código canjeado gana (no se pisa).
create table if not exists public.creador_usuarios (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  codigo         text not null references public.creadores(codigo) on update cascade,
  desde          timestamptz not null default now(),
  rc_app_user_id text
);
create index if not exists creador_usuarios_codigo_idx on public.creador_usuarios(codigo);

-- Canjes de compras anónimas ($RCAnonymousID): se reclaman cuando llega un evento con uid
-- cuyo alias coincide.
create table if not exists public.creador_pendientes (
  rc_app_user_id text primary key,
  codigo         text not null references public.creadores(codigo) on update cascade,
  desde          timestamptz not null default now()
);

create table if not exists public.creador_ventas (
  event_id       text primary key,
  codigo         text not null references public.creadores(codigo) on update cascade,
  user_id        uuid,
  tipo           text not null,
  producto       text,
  tienda         text,
  fecha          timestamptz not null,
  precio_usd     numeric(12,4) not null,     -- lo facturado (RevenueCat `price`, con impuestos)
  impuesto_pct   numeric(6,4) not null default 0,
  base_usd       numeric(12,4) not null,     -- facturado sin impuestos
  comision_pct   numeric(5,2) not null,
  comision_usd   numeric(12,4) not null,
  creado_at      timestamptz not null default now()
);
create index if not exists creador_ventas_codigo_fecha_idx on public.creador_ventas(codigo, fecha);

alter table public.creadores          enable row level security;
alter table public.creador_usuarios   enable row level security;
alter table public.creador_pendientes enable row level security;
alter table public.creador_ventas     enable row level security;
revoke all on public.creadores, public.creador_usuarios, public.creador_pendientes, public.creador_ventas from anon, authenticated;

-- Reporte mensual por creador (mes en hora de Ciudad de México).
create or replace view public.creador_reporte_mensual
with (security_invoker = true) as
select
  c.codigo,
  c.nombre,
  to_char(date_trunc('month', v.fecha at time zone 'America/Mexico_City'), 'YYYY-MM') as mes,
  count(*) filter (where v.base_usd > 0)                  as cobros,
  count(*) filter (where v.base_usd < 0)                  as reembolsos,
  round(sum(v.precio_usd), 2)                             as facturado_usd,
  round(sum(v.base_usd), 2)                               as sin_impuestos_usd,
  round(sum(v.comision_usd), 2)                           as comision_usd
from public.creador_ventas v
join public.creadores c using (codigo)
group by 1, 2, 3;

-- Resumen por creador: usuarios que trajo y totales.
create or replace view public.creador_resumen
with (security_invoker = true) as
select
  c.codigo, c.nombre, c.comision_pct, c.meses, c.activo, c.creado_at,
  (select count(*) from public.creador_usuarios u where u.codigo = c.codigo)        as usuarios,
  (select count(distinct v.user_id) from public.creador_ventas v
     where v.codigo = c.codigo and v.base_usd > 0)                                   as usuarios_que_pagaron,
  coalesce((select round(sum(v.precio_usd), 2) from public.creador_ventas v where v.codigo = c.codigo), 0)   as facturado_usd,
  coalesce((select round(sum(v.comision_usd), 2) from public.creador_ventas v where v.codigo = c.codigo), 0) as comision_usd
from public.creadores c;

revoke all on public.creador_reporte_mensual, public.creador_resumen from anon, authenticated;
