// Base de datos Postgres en memoria (PGlite) con lo mínimo de Supabase para probar las
// migraciones de creadores: roles anon/authenticated/service_role, auth.uid(), y las tablas
// de producción que la migración toca (profiles, subscriptions, access_grants, subscription_events).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.resolve(here, '../../migrations');

const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- Como en Supabase: lo nuevo en public se concede por defecto a los tres roles.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.profiles (
  id uuid primary key, email text, portfolio jsonb, updated_at timestamptz default now(),
  subscription_status text, subscription_expired_at timestamptz
);
alter table public.profiles enable row level security;
create policy profiles_own on public.profiles for select to authenticated using (id = auth.uid());

create table public.subscriptions (
  user_id uuid primary key, rc_app_user_id text, entitlement_active boolean not null default false,
  status text not null default 'never', product_id text, store text, environment text,
  expires_at timestamptz, will_renew boolean, last_event text, updated_at timestamptz not null default now(),
  original_transaction_id text, grace_until timestamptz, revoked_at timestamptz, revoked_reason text
);
alter table public.subscriptions enable row level security;
create table public.access_grants (user_id uuid primary key, kind text not null, created_at timestamptz not null default now());
alter table public.access_grants enable row level security;
revoke all on public.access_grants from anon, authenticated;
create table public.subscription_events (
  event_id text primary key, user_id uuid, type text, store text, event_ms bigint, payload jsonb,
  processed_at timestamptz not null default now()
);
alter table public.subscription_events enable row level security;
`;

export async function freshDb({ withLegacy = true } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  if (withLegacy) {
    // Esquema anterior (22 nov) con su único creador real, para probar la migración de datos.
    await db.exec(readFileSync(path.join(MIG, '20261122120000_codigos_creadores.sql'), 'utf8'));
    await db.exec(`insert into public.creadores (codigo, nombre, comision_pct, meses, asc_offer_id)
                   values ('PORTIV7', 'Portiv (propio)', 0, 12, '1ca65d7d-d205-4453-be1c-13388ef6b78e')`);
  }
  await db.exec(readFileSync(path.join(MIG, '20261123120000_creadores_v2.sql'), 'utf8'));
  return db;
}

// ── Identidades ────────────────────────────────────────────────────────────
export const ADMIN = '00000000-0000-4000-8000-00000000ad01';
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export async function asRole(db, role, uid, fn) {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await fn(); }
  finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
export const asUser = (db, uid, fn) => asRole(db, 'authenticated', uid, fn);
export const asAdmin = (db, fn) => asRole(db, 'authenticated', ADMIN, fn);

export async function setupAdmin(db) {
  await db.query(`insert into auth.users (id, email) values ($1, 'owner@portiv.test') on conflict do nothing`, [ADMIN]);
  await db.query(`insert into public.access_grants (user_id, kind) values ($1, 'owner') on conflict do nothing`, [ADMIN]);
}

export async function addCreator(db, fields) {
  await setupAdmin(db);
  const r = await asAdmin(db, () => db.query(`select public.admin_upsert_creator($1::jsonb) as c`, [JSON.stringify(fields)]));
  return r.rows[0].c;
}

// ── Eventos de RevenueCat ─────────────────────────────────────────────────
// Campos con los nombres reales de los payloads guardados en producción (subscription_events).
let seq = 0;
export function ev(o) {
  seq++;
  const at = o.at instanceof Date ? o.at : new Date(o.at || '2026-12-01T15:00:00Z');
  return {
    id: o.id || `evt-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    type: o.type || 'RENEWAL',
    app_user_id: o.user,
    original_app_user_id: o.originalUser || o.user,
    aliases: o.aliases || [o.user],
    environment: o.env || 'PRODUCTION',
    store: o.store || 'APP_STORE',
    product_id: o.product || 'com.portivapp.portafolio.mensual',
    period_type: o.period || 'NORMAL',
    price: o.price ?? 0,
    price_in_purchased_currency: o.price ?? 0,
    currency: 'USD',
    tax_percentage: o.tax ?? 0,
    commission_percentage: o.commission === undefined ? 0.15 : o.commission,
    ...(o.takehome === null ? {} : { takehome_percentage: o.takehome ?? 0.85 }),
    offer_code: o.code ?? null,
    transaction_id: o.tx || `tx-${seq}`,
    original_transaction_id: o.otx || `otx-${o.user}`,
    purchased_at_ms: at.getTime(),
    event_timestamp_ms: at.getTime() + 1000,
    expiration_at_ms: at.getTime() + 30 * 86400000,
    is_trial_conversion: o.trialConversion ?? null,
    cancel_reason: o.cancelReason ?? null,
    entitlement_ids: ['Portiv Pro'],
  };
}

export async function send(db, event, { sandbox = false, now } = {}) {
  const r = await db.query(
    `select public.creators_process_event($1::jsonb, $2, $3::timestamptz) as r`,
    [JSON.stringify(event), sandbox, (now || new Date(event.purchased_at_ms + 60000)).toISOString()],
  );
  return r.rows[0].r;
}

export async function rows(db, sql, params = []) {
  return (await db.query(sql, params)).rows;
}

export const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000);
export const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
