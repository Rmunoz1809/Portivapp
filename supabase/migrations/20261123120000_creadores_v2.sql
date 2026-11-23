-- ═══════════════════════════════════════════════════════════════════════════
-- Creadores / afiliados v2 (reemplaza el esquema en español de 20261122120000).
--
-- Modelo de negocio:
--   · Cada creador tiene un Offer Code de Apple (p. ej. GASTON) = 1 semana gratis que se suma
--     a la prueba de 14 días (21 en total).
--   · El creador gana commission_rate (20 % por defecto) de lo que Portiv recibe NETO
--     (precio sin impuestos × parte que deja Apple) por cada cobro de los usuarios que llegaron
--     con su código, durante commission_months (12) desde el PRIMER PAGO de ese usuario.
--   · Solo cuenta el Offer Code. La encuesta «¿Cómo conociste Portiv?» es analítica.
--   · Reembolso → se revierte la comisión de ese cobro (o se descuenta si ya se pagó).
--   · Lo ganado en el mes M (hora de Panamá) se puede pagar el día 15 de M+2. Mínimo $20;
--     si no llega, se acumula.
--
-- Seguridad: todas las tablas tienen RLS activo y NINGUNA política para anon/authenticated:
-- ningún cliente las lee ni escribe directo. Todo pasa por funciones:
--   · creators_process_event()       → solo service_role (el webhook).
--   · creator_dashboard()            → el creador logueado; solo números agregados suyos.
--   · set_acquisition_source()       → el usuario logueado; solo su propio perfil.
--   · admin_* / creators_month_close → solo el dueño (access_grants.kind = 'owner').
--
-- Las tablas viejas (creadores, creador_*) se borran en una migración posterior, cuando
-- rc-webhook deje de escribir en ellas.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1 · Tablas
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.creators (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) between 1 and 120),
  instagram_handle  text check (instagram_handle is null or length(instagram_handle) <= 60),
  youtube_handle    text check (youtube_handle is null or length(youtube_handle) <= 100),
  email             text unique check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  auth_user_id      uuid unique,                -- cuenta de Supabase con la que entra al dashboard
  offer_code        text not null unique check (offer_code ~ '^[A-Z0-9]{3,64}$'),
  commission_rate   numeric(5,4) not null default 0.20 check (commission_rate >= 0 and commission_rate <= 1),
  commission_months int not null default 12 check (commission_months between 1 and 120),
  payout_method     text check (payout_method in ('wise', 'paypal', 'usdt', 'ach')),
  payout_details    jsonb,                      -- solo admin (cuenta, wallet, etc.)
  asc_offer_id      text,                       -- oferta de App Store Connect
  notes             text,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Evento crudo de RevenueCat tal como llega al webhook de creadores. Idempotente por id.
-- (public.subscription_events es de rc-webhook: lo usa para su propia idempotencia y no se
-- puede compartir, porque el primero que insertara bloquearía al otro.)
create table if not exists public.creator_events (
  event_id                text primary key,
  type                    text not null,
  environment             text,
  is_sandbox              boolean not null default false,
  app_user_id             text,
  store                   text,
  offer_code              text,
  transaction_id          text,
  original_transaction_id text,
  period_type             text,
  price_usd               numeric(12,4),
  event_at                timestamptz,
  payload                 jsonb not null,
  result                  text,
  received_at             timestamptz not null default now(),
  processed_at            timestamptz
);
create index if not exists creator_events_user_idx on public.creator_events (app_user_id);
create index if not exists creator_events_otx_idx  on public.creator_events (original_transaction_id);

-- Qué usuario (app_user_id de RevenueCat = uid de Supabase) llegó con qué creador.
-- source = 'offer_code' → genera comisión. source = 'survey' → solo analítica.
create table if not exists public.attributions (
  id                bigserial primary key,
  app_user_id       text not null,
  is_sandbox        boolean not null default false,
  source            text not null check (source in ('offer_code', 'survey')),
  creator_id        uuid references public.creators (id) on delete restrict,
  offer_code        text,
  survey_source     text,
  survey_creator    text,
  attributed_at     timestamptz not null default now(),
  first_paid_at     timestamptz,                -- inicio de la ventana de comisión
  commission_rate   numeric(5,4),               -- condiciones fijadas al atribuir
  commission_months int,
  event_id          text,
  created_at        timestamptz not null default now(),
  unique (app_user_id, is_sandbox),
  check (source <> 'offer_code' or (creator_id is not null and commission_rate is not null and commission_months is not null))
);
create index if not exists attributions_creator_idx on public.attributions (creator_id);

create table if not exists public.payouts (
  id            bigserial primary key,
  creator_id    uuid not null references public.creators (id) on delete restrict,
  period_month  date not null check (extract(day from period_month) = 1),  -- mes M cerrado
  amount_usd    numeric(12,2) not null,
  method        text,
  reference     text,
  status        text not null default 'pending' check (status in ('pending', 'paid')),
  created_at    timestamptz not null default now(),
  paid_at       timestamptz,
  unique (creator_id, period_month)
);

-- Una fila por cobro que genera comisión (kind='charge') o por ajuste (kind='adjustment':
-- reembolso de algo ya pagado, o reembolso revertido).
create table if not exists public.commissions (
  id                      bigserial primary key,
  creator_id              uuid not null references public.creators (id) on delete restrict,
  attribution_id          bigint references public.attributions (id) on delete restrict,
  app_user_id             text not null,
  is_sandbox              boolean not null default false,
  kind                    text not null default 'charge' check (kind in ('charge', 'adjustment')),
  event_id                text not null unique,
  event_type              text,
  transaction_id          text,
  original_transaction_id text,
  product_id              text,
  store                   text,
  charged_at              timestamptz not null,
  gross_usd               numeric(12,4) not null,   -- RevenueCat `price` (USD, con impuestos)
  tax_rate                numeric(6,4) not null,
  takehome_rate           numeric(6,4) not null,
  net_usd                 numeric(12,4) not null,   -- gross × (1 − tax) × takehome
  commission_rate         numeric(5,4) not null,
  amount_usd              numeric(12,4) not null,   -- net × commission_rate
  earned_month            date not null,            -- 1.º del mes M (hora de Panamá)
  payable_on              date not null,            -- 15 de M+2
  status                  text not null check (status in ('pending', 'payable', 'paid', 'reversed')),
  payout_id               bigint references public.payouts (id) on delete set null,
  reverses_id             bigint references public.commissions (id) on delete restrict,
  reversed_at             timestamptz,
  reversed_by_event       text,
  created_at              timestamptz not null default now()
);
create unique index if not exists commissions_charge_tx_uq
  on public.commissions (transaction_id, is_sandbox) where kind = 'charge' and transaction_id is not null;
create index if not exists commissions_creator_status_idx on public.commissions (creator_id, status);
create index if not exists commissions_otx_idx on public.commissions (original_transaction_id);
create index if not exists commissions_payout_idx on public.commissions (payout_id);

-- Encuesta del onboarding (analítica).
alter table public.profiles
  add column if not exists acquisition_source  text
    check (acquisition_source is null or acquisition_source in ('instagram', 'tiktok', 'youtube', 'amigo', 'app_store', 'otro')),
  add column if not exists acquisition_creator text check (acquisition_creator is null or length(acquisition_creator) <= 80),
  add column if not exists acquisition_at      timestamptz;

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · Candado: RLS sin políticas + sin privilegios de cliente
-- ─────────────────────────────────────────────────────────────────────────
alter table public.creators       enable row level security;
alter table public.creator_events enable row level security;
alter table public.attributions   enable row level security;
alter table public.payouts        enable row level security;
alter table public.commissions    enable row level security;
revoke all on public.creators, public.creator_events, public.attributions, public.payouts, public.commissions
  from public, anon, authenticated;
revoke all on sequence public.attributions_id_seq, public.payouts_id_seq, public.commissions_id_seq
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3 · Utilidades
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.creators_touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists creators_touch on public.creators;
create trigger creators_touch before update on public.creators
  for each row execute function public.creators_touch_updated_at();

-- ¿Quien llama es el dueño? Por uid (access_grants), nunca por email.
create or replace function public.creators_is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.access_grants g where g.user_id = auth.uid() and g.kind = 'owner')
$$;

create or replace function public.creators_require_admin() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.creators_is_admin() then
    raise exception 'solo el administrador' using errcode = '42501';
  end if;
end $$;

-- Número de un campo JSON o null (nunca lanza).
create or replace function public.creators_num(v jsonb) returns numeric
language sql immutable set search_path = public, pg_temp as $$
  select case
    when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric
    when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v #>> '{}')::numeric
  end
$$;

create or replace function public.creators_today(p_now timestamptz default now()) returns date
language sql stable set search_path = public, pg_temp as $$
  select (p_now at time zone 'America/Panama')::date
$$;

-- ¿Ese usuario ya había pagado ANTES de este evento? (Los que ya eran clientes no se atribuyen.)
create or replace function public.creators_paid_before(
  p_ids text[], p_otx text, p_sandbox boolean, p_at timestamptz, p_event_id text
) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
      select 1 from public.creator_events e
       where e.is_sandbox = p_sandbox
         and e.event_id <> p_event_id
         and e.type in ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE')
         and e.price_usd > 0
         and e.event_at < p_at
         and (e.app_user_id = any (p_ids) or (p_otx is not null and e.original_transaction_id = p_otx))
    )
    or (not p_sandbox and exists (
      -- Historial de rc-webhook (desde jul 2026), solo producción.
      select 1 from public.subscription_events s
       where s.event_id <> p_event_id
         and s.type in ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE')
         and coalesce(public.creators_num(s.payload -> 'price'), 0) > 0
         and upper(coalesce(s.payload ->> 'environment', 'PRODUCTION')) <> 'SANDBOX'
         and coalesce(public.creators_num(s.payload -> 'purchased_at_ms'), s.event_ms, 0) < extract(epoch from p_at) * 1000
         and (s.user_id::text = any (p_ids)
              or s.payload ->> 'app_user_id' = any (p_ids)
              or (p_otx is not null and s.payload ->> 'original_transaction_id' = p_otx))
    ))
$$;

-- Recalcula el monto de un pago aún no hecho (tras una reversión).
create or replace function public.creators_recalc_payout(p_payout bigint) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.payouts p
     set amount_usd = round(coalesce((select sum(c.amount_usd) from public.commissions c
                                       where c.payout_id = p.id and c.status <> 'reversed'), 0), 2)
   where p.id = p_payout and p.status = 'pending'
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4 · Procesar un evento de RevenueCat (lo llama creators-webhook con service_role)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.creators_process_event(
  p jsonb,
  p_accept_sandbox boolean default false,
  p_now timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id       text    := nullif(p ->> 'id', '');
  v_type     text    := upper(coalesce(p ->> 'type', ''));
  v_env      text    := upper(coalesce(p ->> 'environment', ''));
  v_sandbox  boolean := upper(coalesce(p ->> 'environment', '')) = 'SANDBOX';
  v_price    numeric := public.creators_num(p -> 'price');
  v_code     text    := nullif(upper(trim(coalesce(p ->> 'offer_code', ''))), '');
  v_tx       text    := nullif(p ->> 'transaction_id', '');
  v_otx      text    := nullif(p ->> 'original_transaction_id', '');
  v_at       timestamptz;
  v_ids      text[];
  v_uid      text;
  v_att      public.attributions%rowtype;
  v_cre      public.creators%rowtype;
  v_com      public.commissions%rowtype;
  v_n        int;
  v_res      text[] := '{}';
  v_tax      numeric;
  v_take     numeric;
  v_net      numeric;
  v_month    date;
  v_payable  date;
  v_today    date := public.creators_today(p_now);
begin
  if v_id is null or v_type = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_id_or_type');
  end if;

  v_at := to_timestamp(coalesce(
            public.creators_num(p -> 'purchased_at_ms'),
            public.creators_num(p -> 'event_timestamp_ms'),
            extract(epoch from p_now) * 1000) / 1000.0);

  -- Todos los ids con los que RevenueCat conoce a este usuario; el canónico es el uid (UUID).
  select coalesce(array_agg(distinct x) filter (where x is not null and x <> ''), '{}')
    into v_ids
    from (select p ->> 'app_user_id' as x
          union all select p ->> 'original_app_user_id'
          union all select jsonb_array_elements_text(
                      case when jsonb_typeof(p -> 'aliases') = 'array' then p -> 'aliases' else '[]'::jsonb end)) s;
  select x into v_uid from unnest(v_ids) x
   where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   order by (x = p ->> 'app_user_id') desc limit 1;
  v_uid := coalesce(v_uid, nullif(p ->> 'app_user_id', ''));

  -- 1 · Guardar crudo. Si ya estaba, no se hace nada más (idempotencia).
  insert into public.creator_events (event_id, type, environment, is_sandbox, app_user_id, store, offer_code,
                                     transaction_id, original_transaction_id, period_type, price_usd, event_at, payload)
  values (v_id, v_type, nullif(v_env, ''), v_sandbox, v_uid, nullif(upper(coalesce(p ->> 'store', '')), ''), v_code,
          v_tx, v_otx, nullif(upper(coalesce(p ->> 'period_type', '')), ''), v_price, v_at, p)
  on conflict (event_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  -- 2 · Sandbox: se guarda, pero solo se procesa si se pidió explícitamente (pruebas).
  if v_sandbox and not p_accept_sandbox then
    update public.creator_events set result = 'stored_sandbox', processed_at = p_now where event_id = v_id;
    return jsonb_build_object('ok', true, 'result', 'stored_sandbox');
  end if;

  if v_type in ('TEST', 'TRANSFER') or v_uid is null then
    update public.creator_events set result = 'ignored', processed_at = p_now where event_id = v_id;
    return jsonb_build_object('ok', true, 'result', 'ignored');
  end if;

  -- 3 · Atribución existente (por cualquiera de sus ids). Si estaba bajo un id anónimo y ya
  --     conocemos el uid, se pasa al uid.
  select * into v_att from public.attributions a
   where a.app_user_id = any (v_ids) and a.is_sandbox = v_sandbox
   order by (a.source = 'offer_code') desc, (a.app_user_id = v_uid) desc
   limit 1;
  if v_att.id is not null and v_att.app_user_id <> v_uid
     and not exists (select 1 from public.attributions a where a.app_user_id = v_uid and a.is_sandbox = v_sandbox) then
    update public.attributions set app_user_id = v_uid where id = v_att.id returning * into v_att;
    update public.commissions set app_user_id = v_uid where attribution_id = v_att.id;
  end if;

  -- 4 · Atribución nueva por Offer Code (el primer código gana; pisa a la encuesta).
  if v_code is not null and (v_att.id is null or v_att.source <> 'offer_code') then
    select * into v_cre from public.creators c where c.offer_code = v_code;
    if v_cre.id is null then
      v_res := array_append(v_res, 'code_unknown'::text);
    elsif not v_cre.active then
      v_res := array_append(v_res, 'creator_inactive'::text);
    elsif public.creators_paid_before(v_ids, v_otx, v_sandbox, v_at, v_id) then
      v_res := array_append(v_res, 'already_customer'::text);
    else
      if v_att.id is null then
        insert into public.attributions (app_user_id, is_sandbox, source, creator_id, offer_code, attributed_at,
                                         commission_rate, commission_months, event_id)
        values (v_uid, v_sandbox, 'offer_code', v_cre.id, v_code, v_at,
                v_cre.commission_rate, v_cre.commission_months, v_id)
        returning * into v_att;
      else
        update public.attributions
           set source = 'offer_code', creator_id = v_cre.id, offer_code = v_code, attributed_at = v_at,
               commission_rate = v_cre.commission_rate, commission_months = v_cre.commission_months, event_id = v_id
         where id = v_att.id
        returning * into v_att;
      end if;
      v_res := array_append(v_res, 'attributed'::text);
    end if;
  end if;

  -- 5 · Cobro real → comisión.
  --     Pruebas gratis (14 días y la semana del código) llegan con price 0: no generan nada.
  --     La conversión de la prueba llega como RENEWAL (is_trial_conversion), visto en producción.
  if v_att.id is not null and v_att.source = 'offer_code'
     and v_type in ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE')
     and coalesce(v_price, 0) > 0 then
    if v_att.first_paid_at is null or v_at < v_att.first_paid_at then
      update public.attributions set first_paid_at = v_at where id = v_att.id returning * into v_att;
    end if;
    -- Ventana: commission_months desde el primer pago. Margen de 7 días porque Apple cobra la
    -- renovación hasta ~24 h antes de que venza el periodo (el cobro 13 de un plan mensual o el
    -- 2.º de un anual caerían si no, justo dentro del límite).
    if v_at >= v_att.first_paid_at + make_interval(months => v_att.commission_months) - interval '7 days' then
      v_res := array_append(v_res, 'outside_window'::text);
    else
      v_tax  := least(greatest(coalesce(public.creators_num(p -> 'tax_percentage'), 0), 0), 0.9);
      v_take := coalesce(public.creators_num(p -> 'takehome_percentage'),
                         1 - public.creators_num(p -> 'commission_percentage'),
                         0.85);
      if v_take <= 0 or v_take > 1 then v_take := 0.85; end if;
      v_net     := v_price * (1 - v_tax) * v_take;
      v_month   := date_trunc('month', v_at at time zone 'America/Panama')::date;
      v_payable := (v_month + interval '2 months')::date + 14;
      insert into public.commissions (creator_id, attribution_id, app_user_id, is_sandbox, kind, event_id, event_type,
                                      transaction_id, original_transaction_id, product_id, store, charged_at,
                                      gross_usd, tax_rate, takehome_rate, net_usd, commission_rate, amount_usd,
                                      earned_month, payable_on, status)
      values (v_att.creator_id, v_att.id, v_att.app_user_id, v_sandbox, 'charge', v_id, v_type,
              v_tx, v_otx, p ->> 'product_id', upper(coalesce(p ->> 'store', '')), v_at,
              round(v_price, 4), round(v_tax, 4), round(v_take, 4), round(v_net, 4), v_att.commission_rate,
              round(v_net * v_att.commission_rate, 4),
              v_month, v_payable, case when v_payable <= v_today then 'payable' else 'pending' end)
      on conflict do nothing;
      get diagnostics v_n = row_count;
      v_res := array_append(v_res, case when v_n = 1 then 'commission' else 'commission_duplicate_tx' end::text);
    end if;
  end if;

  -- 6 · Reembolso (RevenueCat: CANCELLATION + cancel_reason CUSTOMER_SUPPORT + price negativo;
  --     el transaction_id es el del cobro reembolsado, visto en producción).
  if v_type = 'CANCELLATION' and coalesce(v_price, 0) < 0 then
    select * into v_com from public.commissions c
     where c.kind = 'charge' and c.is_sandbox = v_sandbox and v_tx is not null and c.transaction_id = v_tx
     limit 1;
    if v_com.id is null and v_otx is not null then
      select * into v_com from public.commissions c
       where c.kind = 'charge' and c.is_sandbox = v_sandbox and c.original_transaction_id = v_otx
         and c.status <> 'reversed' and c.gross_usd = round(-v_price, 4)
       order by c.charged_at desc limit 1;
    end if;
    if v_com.id is null then
      v_res := array_append(v_res, 'refund_without_commission'::text);
    elsif v_com.status in ('pending', 'payable') then
      update public.commissions
         set status = 'reversed', reversed_at = p_now, reversed_by_event = v_id, payout_id = null
       where id = v_com.id;
      if v_com.payout_id is not null then perform public.creators_recalc_payout(v_com.payout_id); end if;
      v_res := array_append(v_res, 'reversed'::text);
    elsif v_com.status = 'paid'
          and not exists (select 1 from public.commissions a where a.reverses_id = v_com.id and a.amount_usd < 0) then
      -- Ya se le pagó: se descuenta del siguiente pago.
      insert into public.commissions (creator_id, attribution_id, app_user_id, is_sandbox, kind, event_id, event_type,
                                      transaction_id, original_transaction_id, product_id, store, charged_at,
                                      gross_usd, tax_rate, takehome_rate, net_usd, commission_rate, amount_usd,
                                      earned_month, payable_on, status, reverses_id)
      values (v_com.creator_id, v_com.attribution_id, v_com.app_user_id, v_sandbox, 'adjustment', v_id, v_type,
              v_tx, v_otx, v_com.product_id, v_com.store, v_at,
              -v_com.gross_usd, v_com.tax_rate, v_com.takehome_rate, -v_com.net_usd, v_com.commission_rate,
              -v_com.amount_usd, date_trunc('month', v_at at time zone 'America/Panama')::date, v_today, 'payable', v_com.id);
      update public.commissions set reversed_at = p_now, reversed_by_event = v_id where id = v_com.id;
      v_res := array_append(v_res, 'adjusted'::text);
    else
      v_res := array_append(v_res, 'already_reversed'::text);
    end if;
  end if;

  -- 7 · Reembolso revertido por Apple: se restituye.
  if v_type = 'REFUND_REVERSED' and v_tx is not null then
    select * into v_com from public.commissions c
     where c.kind = 'charge' and c.is_sandbox = v_sandbox and c.transaction_id = v_tx limit 1;
    if v_com.id is not null and v_com.status = 'reversed' then
      update public.commissions
         set status = case when payable_on <= v_today then 'payable' else 'pending' end,
             reversed_at = null, reversed_by_event = null
       where id = v_com.id;
      v_res := array_append(v_res, 'restored'::text);
    elsif v_com.id is not null
          and exists (select 1 from public.commissions a where a.reverses_id = v_com.id and a.amount_usd < 0)
          and not exists (select 1 from public.commissions a where a.reverses_id = v_com.id and a.amount_usd > 0) then
      insert into public.commissions (creator_id, attribution_id, app_user_id, is_sandbox, kind, event_id, event_type,
                                      transaction_id, original_transaction_id, product_id, store, charged_at,
                                      gross_usd, tax_rate, takehome_rate, net_usd, commission_rate, amount_usd,
                                      earned_month, payable_on, status, reverses_id)
      values (v_com.creator_id, v_com.attribution_id, v_com.app_user_id, v_sandbox, 'adjustment', v_id, v_type,
              v_tx, v_otx, v_com.product_id, v_com.store, v_at,
              v_com.gross_usd, v_com.tax_rate, v_com.takehome_rate, v_com.net_usd, v_com.commission_rate,
              v_com.amount_usd, date_trunc('month', v_at at time zone 'America/Panama')::date, v_today, 'payable', v_com.id);
      v_res := array_append(v_res, 'restored_adjustment'::text);
    end if;
  end if;

  if cardinality(v_res) = 0 then v_res := array['no_op']; end if;
  update public.creator_events set result = array_to_string(v_res, ','), processed_at = p_now where event_id = v_id;
  return jsonb_build_object('ok', true, 'result', array_to_string(v_res, ','), 'app_user_id', v_uid);
end $$;

-- pending → payable cuando llega el 15 de M+2 (cron diario y al cerrar el mes).
create or replace function public.creators_refresh_statuses(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.commissions set status = 'payable'
   where status = 'pending' and payable_on <= public.creators_today(p_now);
  get diagnostics n = row_count;
  return n;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5 · Encuesta del onboarding (la llama la app con la sesión del usuario)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.set_acquisition_source(p_source text, p_creator text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid     uuid := auth.uid();
  v_src     text := lower(trim(coalesce(p_source, '')));
  v_cre     text := nullif(left(trim(coalesce(p_creator, '')), 80), '');
  v_cre_id  uuid;
begin
  if v_uid is null then raise exception 'sin sesión' using errcode = '42501'; end if;
  if v_src not in ('instagram', 'tiktok', 'youtube', 'amigo', 'app_store', 'otro') then
    raise exception 'fuente no válida: %', p_source using errcode = '22023';
  end if;
  if v_src not in ('instagram', 'tiktok', 'youtube') then v_cre := null; end if;

  insert into public.profiles (id, acquisition_source, acquisition_creator, acquisition_at)
  values (v_uid, v_src, v_cre, now())
  on conflict (id) do update
     set acquisition_source = excluded.acquisition_source,
         acquisition_creator = excluded.acquisition_creator,
         acquisition_at = excluded.acquisition_at;

  if v_cre is not null then
    select c.id into v_cre_id from public.creators c
     where lower(ltrim(v_cre, '@')) in (lower(ltrim(coalesce(c.instagram_handle, ''), '@')),
                                        lower(ltrim(coalesce(c.youtube_handle, ''), '@')),
                                        lower(c.name), lower(c.offer_code))
     limit 1;
  end if;
  -- Nunca pisa una atribución por código.
  insert into public.attributions (app_user_id, is_sandbox, source, creator_id, survey_source, survey_creator)
  values (v_uid::text, false, 'survey', v_cre_id, v_src, v_cre)
  on conflict (app_user_id, is_sandbox) do update
     set creator_id = excluded.creator_id, survey_source = excluded.survey_source,
         survey_creator = excluded.survey_creator
   where public.attributions.source = 'survey';
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6 · Dashboard del creador: SOLO números agregados suyos, nada de usuarios
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.creator_dashboard(p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c       public.creators%rowtype;
  v_today date := public.creators_today(p_now);
  v_month date := date_trunc('month', p_now at time zone 'America/Panama')::date;
begin
  if auth.uid() is null then raise exception 'sin sesión' using errcode = '42501'; end if;
  select * into c from public.creators where auth_user_id = auth.uid();
  if c.id is null then return jsonb_build_object('creator', null); end if;

  return jsonb_build_object(
    'creator', jsonb_build_object(
      'name', c.name, 'offer_code', c.offer_code,
      'redeem_url', 'https://apps.apple.com/redeem?ctx=offercodes&id=6789933095&code=' || c.offer_code,
      'commission_rate', c.commission_rate, 'commission_months', c.commission_months,
      'payout_method', c.payout_method, 'active', c.active, 'since', c.created_at),
    'users_redeemed', (select count(*) from public.attributions a
                        where a.creator_id = c.id and a.source = 'offer_code' and not a.is_sandbox),
    'users_paying_now', (select count(*) from public.attributions a
                          join public.subscriptions s on s.user_id::text = a.app_user_id
                         where a.creator_id = c.id and a.source = 'offer_code' and not a.is_sandbox
                           and a.first_paid_at is not null and s.entitlement_active
                           and (s.expires_at is null or s.expires_at > p_now)),
    'users_in_trial', (select count(*) from public.attributions a
                        join public.subscriptions s on s.user_id::text = a.app_user_id
                       where a.creator_id = c.id and a.source = 'offer_code' and not a.is_sandbox
                         and a.first_paid_at is null and s.entitlement_active
                         and (s.expires_at is null or s.expires_at > p_now)),
    'earned_this_month', (select round(coalesce(sum(amount_usd), 0), 2) from public.commissions
                           where creator_id = c.id and not is_sandbox and status <> 'reversed' and earned_month = v_month),
    'pending_release', (select round(coalesce(sum(amount_usd), 0), 2) from public.commissions
                         where creator_id = c.id and not is_sandbox and status = 'pending'),
    'ready_to_pay', (select round(coalesce(sum(amount_usd), 0), 2) from public.commissions
                      where creator_id = c.id and not is_sandbox and status = 'payable'),
    'total_paid', (select round(coalesce(sum(amount_usd), 0), 2) from public.payouts
                    where creator_id = c.id and status = 'paid'),
    'next_release_on', (select min(payable_on) from public.commissions
                         where creator_id = c.id and not is_sandbox and status = 'pending'),
    'monthly', coalesce((select jsonb_agg(m order by m ->> 'month' desc) from (
                  select jsonb_build_object('month', to_char(earned_month, 'YYYY-MM'),
                                            'charges', count(*) filter (where kind = 'charge'),
                                            'amount', round(sum(amount_usd), 2)) m
                    from public.commissions
                   where creator_id = c.id and not is_sandbox and status <> 'reversed'
                     and earned_month > (v_month - interval '12 months')
                   group by earned_month) x), '[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object(
                  'period', to_char(period_month, 'YYYY-MM'), 'amount', amount_usd, 'method', method,
                  'reference', reference, 'paid_at', paid_at) order by paid_at desc)
                  from public.payouts where creator_id = c.id and status = 'paid'), '[]'::jsonb)
  );
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 7 · Admin (solo el dueño)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.admin_upsert_creator(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id   uuid := nullif(p ->> 'id', '')::uuid;
  v_code text := upper(trim(coalesce(p ->> 'offer_code', '')));
  v_mail text := nullif(lower(trim(coalesce(p ->> 'email', ''))), '');
  r      public.creators%rowtype;
begin
  perform public.creators_require_admin();
  if v_id is null then
    insert into public.creators (name, instagram_handle, youtube_handle, email, offer_code, commission_rate,
                                 commission_months, payout_method, payout_details, asc_offer_id, notes, active)
    values (trim(p ->> 'name'), nullif(trim(p ->> 'instagram_handle'), ''), nullif(trim(p ->> 'youtube_handle'), ''),
            v_mail, v_code, coalesce(public.creators_num(p -> 'commission_rate'), 0.20),
            coalesce(public.creators_num(p -> 'commission_months')::int, 12),
            nullif(p ->> 'payout_method', ''), p -> 'payout_details', nullif(p ->> 'asc_offer_id', ''),
            nullif(p ->> 'notes', ''), coalesce((p ->> 'active')::boolean, true))
    returning * into r;
  else
    update public.creators set
      name              = coalesce(nullif(trim(p ->> 'name'), ''), name),
      instagram_handle  = case when p ? 'instagram_handle' then nullif(trim(p ->> 'instagram_handle'), '') else instagram_handle end,
      youtube_handle    = case when p ? 'youtube_handle' then nullif(trim(p ->> 'youtube_handle'), '') else youtube_handle end,
      email             = case when p ? 'email' then v_mail else email end,
      offer_code        = case when v_code <> '' then v_code else offer_code end,
      commission_rate   = coalesce(public.creators_num(p -> 'commission_rate'), commission_rate),
      commission_months = coalesce(public.creators_num(p -> 'commission_months')::int, commission_months),
      payout_method     = case when p ? 'payout_method' then nullif(p ->> 'payout_method', '') else payout_method end,
      payout_details    = case when p ? 'payout_details' then p -> 'payout_details' else payout_details end,
      asc_offer_id      = case when p ? 'asc_offer_id' then nullif(p ->> 'asc_offer_id', '') else asc_offer_id end,
      notes             = case when p ? 'notes' then nullif(p ->> 'notes', '') else notes end,
      active            = coalesce((p ->> 'active')::boolean, active)
    where id = v_id
    returning * into r;
    if r.id is null then raise exception 'creador no encontrado'; end if;
  end if;
  return to_jsonb(r);
end $$;

-- La función de alta (Edge Function creators-admin) enlaza la cuenta con la que entra al dashboard.
create or replace function public.admin_link_creator_account(p_creator uuid, p_auth_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.creators_require_admin();
  update public.creators set auth_user_id = p_auth_user where id = p_creator;
end $$;

create or replace function public.admin_creators_overview(p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.creators_require_admin();
  return coalesce((select jsonb_agg(x order by x ->> 'name') from (
    select to_jsonb(c) - 'payout_details' || jsonb_build_object(
      'has_account', c.auth_user_id is not null,
      'users_redeemed', (select count(*) from public.attributions a where a.creator_id = c.id and a.source = 'offer_code' and not a.is_sandbox),
      'users_paying_now', (select count(*) from public.attributions a join public.subscriptions s on s.user_id::text = a.app_user_id
                            where a.creator_id = c.id and a.source = 'offer_code' and not a.is_sandbox and a.first_paid_at is not null
                              and s.entitlement_active and (s.expires_at is null or s.expires_at > p_now)),
      'pending',  (select round(coalesce(sum(amount_usd), 0), 2) from public.commissions where creator_id = c.id and not is_sandbox and status = 'pending'),
      'payable',  (select round(coalesce(sum(amount_usd), 0), 2) from public.commissions where creator_id = c.id and not is_sandbox and status = 'payable'),
      'paid',     (select round(coalesce(sum(amount_usd), 0), 2) from public.commissions where creator_id = c.id and not is_sandbox and status = 'paid'),
      'reversed', (select round(coalesce(sum(amount_usd), 0), 2) from public.commissions where creator_id = c.id and not is_sandbox and status = 'reversed')
    ) x from public.creators c) t), '[]'::jsonb);
end $$;

create or replace function public.admin_creator_detail(p_creator uuid, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.creators_require_admin();
  return jsonb_build_object(
    'creator', (select to_jsonb(c) from public.creators c where c.id = p_creator),
    'users', coalesce((select jsonb_agg(jsonb_build_object(
        'app_user_id', a.app_user_id, 'attributed_at', a.attributed_at, 'first_paid_at', a.first_paid_at,
        'active', coalesce(s.entitlement_active and (s.expires_at is null or s.expires_at > p_now), false),
        'product_id', s.product_id, 'is_sandbox', a.is_sandbox,
        'commission', (select round(coalesce(sum(amount_usd), 0), 2) from public.commissions m
                        where m.attribution_id = a.id and m.status <> 'reversed')) order by a.attributed_at desc)
      from public.attributions a left join public.subscriptions s on s.user_id::text = a.app_user_id
     where a.creator_id = p_creator and a.source = 'offer_code'), '[]'::jsonb),
    'commissions', coalesce((select jsonb_agg(to_jsonb(m) order by m.charged_at desc)
      from public.commissions m where m.creator_id = p_creator), '[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(to_jsonb(p) order by p.period_month desc)
      from public.payouts p where p.creator_id = p_creator), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_survey_summary() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.creators_require_admin();
  return jsonb_build_object(
    'by_source', coalesce((select jsonb_agg(jsonb_build_object('source', acquisition_source, 'users', n) order by n desc)
                  from (select acquisition_source, count(*) n from public.profiles
                         where acquisition_source is not null group by 1) s), '[]'::jsonb),
    'creators_named', coalesce((select jsonb_agg(jsonb_build_object('name', nm, 'source', src, 'users', n) order by n desc)
                  from (select lower(ltrim(acquisition_creator, '@')) nm, acquisition_source src, count(*) n
                          from public.profiles where acquisition_creator is not null group by 1, 2 limit 100) s), '[]'::jsonb),
    'answered', (select count(*) from public.profiles where acquisition_source is not null)
  );
end $$;

-- Cierre del mes M: junta por creador todo lo «payable» ganado hasta M que no esté en un pago,
-- y crea el pago si llega al mínimo. Lo que no llega se acumula. Se puede repetir sin duplicar.
create or replace function public.creators_month_close(
  p_month date, p_min numeric default 20, p_now timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_open  date := (date_trunc('month', p_month) + interval '2 months')::date + 14;
  r       record;
  v_pid   bigint;
begin
  perform public.creators_require_admin();
  if public.creators_today(p_now) < v_open then
    raise exception 'El mes % se puede cerrar desde el %', to_char(v_month, 'YYYY-MM'), v_open using errcode = '22023';
  end if;
  perform public.creators_refresh_statuses(p_now);

  for r in
    select c.id, c.payout_method, sum(m.amount_usd) as total
      from public.commissions m join public.creators c on c.id = m.creator_id
     where m.status = 'payable' and m.payout_id is null and not m.is_sandbox and m.earned_month <= v_month
       and not exists (select 1 from public.payouts p where p.creator_id = c.id and p.period_month = v_month)
     group by c.id, c.payout_method
    having sum(m.amount_usd) >= p_min
  loop
    insert into public.payouts (creator_id, period_month, amount_usd, method)
    values (r.id, v_month, round(r.total, 2), r.payout_method)
    returning id into v_pid;
    update public.commissions set payout_id = v_pid
     where creator_id = r.id and status = 'payable' and payout_id is null and not is_sandbox and earned_month <= v_month;
  end loop;

  return jsonb_build_object(
    'period', to_char(v_month, 'YYYY-MM'),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object(
        'payout_id', p.id, 'creator_id', c.id, 'name', c.name, 'email', c.email, 'offer_code', c.offer_code,
        'amount_usd', p.amount_usd, 'method', p.method, 'payout_details', c.payout_details,
        'status', p.status, 'reference', p.reference, 'paid_at', p.paid_at) order by c.name)
      from public.payouts p join public.creators c on c.id = p.creator_id where p.period_month = v_month), '[]'::jsonb),
    'carried_over', coalesce((select jsonb_agg(jsonb_build_object('creator_id', c.id, 'name', c.name, 'amount_usd', t.total))
      from (select creator_id, round(sum(amount_usd), 2) total from public.commissions
             where status = 'payable' and payout_id is null and not is_sandbox group by 1) t
      join public.creators c on c.id = t.creator_id), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_mark_payout_paid(p_payout bigint, p_reference text, p_paid_at timestamptz default now())
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform public.creators_require_admin();
  if nullif(trim(coalesce(p_reference, '')), '') is null then
    raise exception 'falta la referencia del pago' using errcode = '22023';
  end if;
  update public.payouts set status = 'paid', reference = trim(p_reference), paid_at = p_paid_at
   where id = p_payout and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'pago no encontrado o ya marcado'; end if;
  update public.commissions set status = 'paid' where payout_id = p_payout and status = 'payable';
end $$;

-- Deshacer un pago que aún no se ha hecho (las comisiones vuelven a quedar libres).
create or replace function public.admin_cancel_payout(p_payout bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform public.creators_require_admin();
  update public.commissions set payout_id = null where payout_id = p_payout
     and exists (select 1 from public.payouts where id = p_payout and status = 'pending');
  delete from public.payouts where id = p_payout and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'solo se puede deshacer un pago pendiente'; end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 8 · Quién puede ejecutar qué
-- ─────────────────────────────────────────────────────────────────────────
revoke execute on function
  public.creators_touch_updated_at(), public.creators_is_admin(), public.creators_require_admin(),
  public.creators_num(jsonb), public.creators_today(timestamptz),
  public.creators_paid_before(text[], text, boolean, timestamptz, text), public.creators_recalc_payout(bigint),
  public.creators_process_event(jsonb, boolean, timestamptz), public.creators_refresh_statuses(timestamptz),
  public.set_acquisition_source(text, text), public.creator_dashboard(timestamptz),
  public.admin_upsert_creator(jsonb), public.admin_link_creator_account(uuid, uuid),
  public.admin_creators_overview(timestamptz), public.admin_creator_detail(uuid, timestamptz),
  public.admin_survey_summary(), public.creators_month_close(date, numeric, timestamptz),
  public.admin_mark_payout_paid(bigint, text, timestamptz), public.admin_cancel_payout(bigint)
from public, anon, authenticated;

grant execute on function public.creators_process_event(jsonb, boolean, timestamptz),
                          public.creators_refresh_statuses(timestamptz)
  to service_role;

grant execute on function
  public.set_acquisition_source(text, text), public.creator_dashboard(timestamptz), public.creators_is_admin(),
  public.admin_upsert_creator(jsonb), public.admin_link_creator_account(uuid, uuid),
  public.admin_creators_overview(timestamptz), public.admin_creator_detail(uuid, timestamptz),
  public.admin_survey_summary(), public.creators_month_close(date, numeric, timestamptz),
  public.admin_mark_payout_paid(bigint, text, timestamptz), public.admin_cancel_payout(bigint)
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 9 · Datos del esquema anterior (solo existe PORTIV7) y cron diario
-- ─────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.creadores') is not null then
    execute $q$
      insert into public.creators (name, offer_code, commission_rate, commission_months, active, asc_offer_id, notes, created_at)
      select nombre, codigo, comision_pct / 100.0, meses, activo, asc_offer_id, contacto, creado_at
        from public.creadores
      on conflict (offer_code) do nothing
    $q$;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule('creators-refresh-statuses')
      where exists (select 1 from cron.job where jobname = 'creators-refresh-statuses');
    perform cron.schedule('creators-refresh-statuses', '15 11 * * *', 'select public.creators_refresh_statuses()');
  end if;
end $$;
