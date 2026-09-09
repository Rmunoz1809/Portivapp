-- ═══════════════════════════════════════════════════════════════════════════
--  registrar_device_token — alta del token de APNs sorteando el choque con RLS
--  ───────────────────────────────────────────────────────────────────────
--  BUG que arregla: el cliente hacía upsert sobre device_tokens con
--  onConflict:'token'. Cuando ese token YA existía a nombre de OTRO usuario (el
--  mismo iPhone, otra cuenta: iOS entrega el MISMO token), el camino de UPDATE
--  chocaba con la policy `using (auth.uid() = user_id)` y fallaba en silencio.
--  Justo el caso que había que cubrir: sin esto, el segundo usuario del teléfono
--  se queda sin notificaciones, o peor, sigue recibiendo las del primero.
--
--  SECURITY DEFINER para poder borrar la fila del dueño anterior. El user_id sale
--  SIEMPRE de auth.uid(), nunca de un parámetro: el cliente no puede registrar un
--  token a nombre de otro.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.registrar_device_token(
  p_token text, p_environment text, p_timezone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'no autenticado';
  end if;
  if p_token is null or length(trim(p_token)) = 0 then
    raise exception 'token vacío';
  end if;
  if p_environment not in ('sandbox','production') then
    raise exception 'environment inválido: %', p_environment;
  end if;

  -- El teléfono cambió de dueño: la fila anterior se va con sus preferencias.
  delete from device_tokens where token = p_token and user_id <> auth.uid();

  -- Mismo usuario re-registrando: se conservan sus opt_in.
  insert into device_tokens (user_id, token, platform, environment, timezone)
  values (auth.uid(), p_token, 'ios', p_environment, p_timezone)
  on conflict (token) do update
    set user_id     = auth.uid(),
        environment = excluded.environment,
        timezone    = excluded.timezone,
        updated_at  = now();
end;
$$;

revoke all on function public.registrar_device_token(text,text,text) from public, anon;
grant execute on function public.registrar_device_token(text,text,text) to authenticated;


-- ── Endurecer push_selection_log ─────────────────────────────────────────────
-- La policy de UPDATE existe sólo para que el usuario marque una notificación como
-- abierta. RLS no limita COLUMNAS, así que sin esto el mismo permiso deja reescribir
-- `enviado`, `ganador_score` o `ganador_tipo`: un usuario podría falsear su propio
-- historial de fatiga y forzarse notificaciones. El permiso se acota por columna.
revoke update on public.push_selection_log from authenticated;
grant  update (abierto, abierto_at) on public.push_selection_log to authenticated;

-- El motor escribe con service_role, que se salta RLS: no necesita INSERT aquí.
revoke insert, delete on public.push_selection_log from authenticated;
