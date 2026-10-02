-- snaptrade-health pasa de cada 3 h a cada 6 h (4 pasadas al día).
-- La guía de SnapTrade pide repartir las tareas de fondo y no pasar de unas 4 lecturas
-- por usuario y día. El aviso inmediato lo sigue dando el webhook CONNECTION_BROKEN; este
-- cron es sólo la red de seguridad y el recordatorio, y 6 h le sobran.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'snaptrade-health'),
  schedule := '23 */6 * * *'
);
