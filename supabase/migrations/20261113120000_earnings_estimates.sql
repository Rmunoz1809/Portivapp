-- Estimados de los analistas por trimestre, guardados ANTES de cada reporte (13 nov 2026).
--
-- Finnhub /calendar/earnings sólo trae los reportes futuros (y el último durante ~un mes):
-- el estimado de ingresos de un trimestre ya reportado desaparece, y la gráfica «Ingresos»
-- de la pestaña Resultados no podía enseñar qué esperaban los analistas. finnhub-proxy
-- guarda aquí cada fila del calendario que todavía no tiene resultado (el último estimado
-- antes del reporte gana) y la sirve en /portiv/estimates?symbol=X.
--
-- year/quarter = trimestre FISCAL tal como lo da Finnhub (el mismo de /stock/earnings).
create table if not exists public.earnings_estimates (
  symbol            text    not null,
  year              int     not null,
  quarter           int     not null,
  report_date       date,
  eps_estimate      double precision,
  revenue_estimate  double precision,
  updated_at        timestamptz not null default now(),
  primary key (symbol, year, quarter)
);

-- Sólo la usa finnhub-proxy con service role: sin políticas, ningún cliente la lee directo.
alter table public.earnings_estimates enable row level security;
revoke all on public.earnings_estimates from public, anon, authenticated;
grant select, insert, update, delete on public.earnings_estimates to service_role;
