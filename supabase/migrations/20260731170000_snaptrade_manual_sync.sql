-- Sincronización manual de SnapTrade (botón "Sincronizar ahora").
--
-- Las conexiones en modo `delayed` (plan diario) sólo refrescan sus posiciones una vez
-- al día: un usuario que compraba o vendía veía su cartera congelada hasta 24-48 h, sin
-- ninguna palanca para forzarlo. `connections.refreshBrokerageAuthorization` sí la fuerza,
-- pero SnapTrade FACTURA cada llamada, así que se limita por usuario. Aquí se guarda el
-- sello de la última sincronización manual para poder aplicar ese límite en el servidor
-- (el cliente no es de fiar para esto: bastaría con pulsar el botón en bucle).
alter table public.profiles
  add column if not exists snaptrade_last_manual_sync timestamptz;

comment on column public.profiles.snaptrade_last_manual_sync is
  'Última llamada a SnapTrade refreshBrokerageAuthorization (sincronización manual, facturada). Se usa para limitarla por usuario.';
