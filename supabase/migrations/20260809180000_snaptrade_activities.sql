-- Caché de movimientos de efectivo de SnapTrade (aportaciones y retiradas).
--
-- getAccountActivities devuelve datos DIARIOS: SnapTrade los cachea y los refresca una vez
-- al día. Volver a pedirlos dentro del mismo día no trae ni una fila nueva, sólo latencia
-- —y con paginación de 1000 en 1000 sobre años de historial, un usuario con varias cuentas
-- son decenas de peticiones. Por eso la caché es DIARIA, igual que la de snaptrade_history,
-- y no de 60 minutos como la de posiciones.
--
-- Se guarda el resultado ya AGREGADO, no las transacciones en crudo: el historial completo
-- de un broker con años de operaciones son megabytes por usuario en una columna que se lee
-- entera en cada carga de perfil. Lo que la UI necesita son los flujos netos por mes y por
-- divisa, que ocupan unos pocos KB.
alter table public.profiles
  add column if not exists snaptrade_activities jsonb;

comment on column public.profiles.snaptrade_activities is
  'Flujos de efectivo agregados (aportaciones/retiradas por mes y divisa) calculados desde SnapTrade getAccountActivities. Caché diaria: el endpoint origen sirve datos diarios. No contiene transacciones en crudo.';

-- Sin GRANTs: la migración de lockdown (20260728120000) deja fuera del alcance de `anon` y
-- `authenticated` toda columna snaptrade_* presente y futura. Esta nace server-only, que es
-- lo que debe ser —son datos financieros que sólo tocan las Edge Functions con service_role.
