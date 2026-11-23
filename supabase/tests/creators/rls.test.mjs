// Seguridad: un creador solo ve sus números agregados; nadie más que el dueño ve el resto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addCreator, ev, send, rows, uuid, addDays, asUser, asRole, asAdmin, ADMIN } from './harness.mjs';

const T0 = new Date('2026-12-01T15:00:00Z');
const CRE_A = uuid(9001), CRE_B = uuid(9002), USER = uuid(9100), STRANGER = uuid(9200);
const TABLES = ['creators', 'creator_events', 'attributions', 'commissions', 'payouts'];

async function world() {
  const db = await freshDb();
  for (const [id, email] of [[CRE_A, 'a@c.test'], [CRE_B, 'b@c.test'], [USER, 'user@secret.test'], [STRANGER, 's@x.test']]) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  }
  const a = await addCreator(db, { name: 'Creadora A', offer_code: 'AAAA', email: 'a@c.test', payout_details: { iban: 'SECRETO-A' } });
  const b = await addCreator(db, { name: 'Creador B', offer_code: 'BBBB', email: 'b@c.test' });
  await asAdmin(db, () => db.query(`select public.admin_link_creator_account($1, $2), public.admin_link_creator_account($3, $4)`, [a.id, CRE_A, b.id, CRE_B]));
  // Un usuario de A que paga hoy.
  await db.query(`insert into public.profiles (id, email) values ($1, 'user@secret.test')`, [USER]);
  await send(db, ev({ type: 'INITIAL_PURCHASE', user: USER, period: 'TRIAL', price: 0, code: 'AAAA', at: T0 }));
  await send(db, ev({ type: 'RENEWAL', user: USER, price: 4.99, at: addDays(T0, 21) }));
  await db.query(`insert into public.subscriptions (user_id, entitlement_active, status, expires_at) values ($1, true, 'active', '2099-01-01')`, [USER]);
  return { db, a, b };
}

test('authenticated y anon no pueden leer ni escribir ninguna tabla de creadores', async () => {
  const { db } = await world();
  for (const role of ['authenticated', 'anon']) {
    for (const t of TABLES) {
      await assert.rejects(asRole(db, role, CRE_A, () => db.query(`select * from public.${t}`)), /permission denied/, `${role} select ${t}`);
      await assert.rejects(asRole(db, role, CRE_A, () => db.query(`delete from public.${t}`)), /permission denied/, `${role} delete ${t}`);
    }
  }
  // Ni siquiera el dueño lee las tablas directo: todo pasa por funciones.
  await assert.rejects(asAdmin(db, () => db.query(`select * from public.commissions`)), /permission denied/);
});

test('el dashboard de A muestra solo los números de A, sin datos personales', async () => {
  const { db } = await world();
  const d = (await asUser(db, CRE_A, () => db.query(`select public.creator_dashboard('2026-12-28T12:00:00Z') d`))).rows[0].d;
  assert.equal(d.creator.offer_code, 'AAAA');
  assert.equal(d.creator.redeem_url, 'https://apps.apple.com/redeem?ctx=offercodes&id=6789933095&code=AAAA');
  assert.equal(Number(d.users_redeemed), 1);
  assert.equal(Number(d.users_paying_now), 1);
  assert.equal(Number(d.earned_this_month), 0.85);
  assert.equal(Number(d.pending_release), 0.85);
  const text = JSON.stringify(d);
  for (const secret of [USER, 'user@secret.test', 'SECRETO-A', 'payout_details', 'app_user_id', 'transaction']) {
    assert.ok(!text.includes(secret), `el dashboard no debe contener ${secret}`);
  }
});

test('B no ve nada de A; un usuario cualquiera no es creador', async () => {
  const { db } = await world();
  const b = (await asUser(db, CRE_B, () => db.query(`select public.creator_dashboard() d`))).rows[0].d;
  assert.equal(b.creator.offer_code, 'BBBB');
  assert.equal(Number(b.users_redeemed), 0);
  assert.equal(Number(b.earned_this_month), 0);
  const s = (await asUser(db, STRANGER, () => db.query(`select public.creator_dashboard() d`))).rows[0].d;
  assert.equal(s.creator, null);
});

test('crear una cuenta con el email del creador NO da acceso a su dashboard (va por uid)', async () => {
  const { db } = await world();
  const squat = uuid(9300);
  await db.query(`insert into auth.users (id, email) values ($1, 'A@C.TEST')`, [squat]);
  const d = (await asUser(db, squat, () => db.query(`select public.creator_dashboard() d`))).rows[0].d;
  assert.equal(d.creator, null);
});

test('anon no puede ejecutar el dashboard; nadie salvo service_role procesa eventos', async () => {
  const { db } = await world();
  await assert.rejects(asRole(db, 'anon', '', () => db.query(`select public.creator_dashboard()`)), /permission denied/);
  const e = JSON.stringify(ev({ type: 'RENEWAL', user: CRE_A, price: 999 }));
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asRole(db, role, CRE_A, () => db.query(`select public.creators_process_event($1::jsonb)`, [e])), /permission denied/);
    await assert.rejects(asRole(db, role, CRE_A, () => db.query(`select public.creators_refresh_statuses()`)), /permission denied/);
  }
  const ok = await asRole(db, 'service_role', '', () => db.query(`select public.creators_process_event($1::jsonb) r`, [e]));
  assert.equal(ok.rows[0].r.ok, true);
});

test('un creador no puede usar ninguna función de admin', async () => {
  const { db, a } = await world();
  const calls = [
    [`select public.admin_creators_overview()`],
    [`select public.admin_creator_detail($1)`, [a.id]],
    [`select public.admin_survey_summary()`],
    [`select public.admin_upsert_creator($1::jsonb)`, [JSON.stringify({ id: a.id, commission_rate: 1 })]],
    [`select public.admin_link_creator_account($1, $2)`, [a.id, CRE_B]],
    [`select public.creators_month_close('2026-12-01')`],
    [`select public.admin_mark_payout_paid(1, 'x')`],
    [`select public.admin_cancel_payout(1)`],
  ];
  for (const [sql, params] of calls) {
    await assert.rejects(asUser(db, CRE_A, () => db.query(sql, params || [])), /solo el administrador/, sql);
  }
  const isAdmin = (await asUser(db, CRE_A, () => db.query(`select public.creators_is_admin() x`))).rows[0].x;
  assert.equal(isAdmin, false);
});

test('el dueño sí ve el resumen y el detalle (incluidos los usuarios)', async () => {
  const { db, a } = await world();
  const ov = (await asAdmin(db, () => db.query(`select public.admin_creators_overview('2026-12-28T12:00:00Z') o`))).rows[0].o;
  const ra = ov.find((x) => x.offer_code === 'AAAA');
  assert.equal(Number(ra.users_redeemed), 1);
  assert.equal(Number(ra.users_paying_now), 1);
  assert.equal(ra.has_account, true);
  assert.equal(ra.payout_details, undefined, 'el resumen no expone datos de pago');
  const det = (await asAdmin(db, () => db.query(`select public.admin_creator_detail($1) d`, [a.id]))).rows[0].d;
  assert.equal(det.users[0].app_user_id, USER);
  assert.equal(det.commissions.length, 1);
});

test('encuesta: cada usuario solo escribe su propio perfil; valores validados', async () => {
  const { db } = await world();
  await asUser(db, USER, () => db.query(`select public.set_acquisition_source('tiktok', 'alguien')`));
  const [p] = await rows(db, `select acquisition_source, acquisition_creator from public.profiles where id = $1`, [USER]);
  assert.deepEqual(p, { acquisition_source: 'tiktok', acquisition_creator: 'alguien' });
  await assert.rejects(asUser(db, USER, () => db.query(`select public.set_acquisition_source('hackeo')`)), /fuente no válida/);
  await assert.rejects(asRole(db, 'anon', '', () => db.query(`select public.set_acquisition_source('otro')`)), /permission denied/);
  // Fuente no social → se descarta el nombre del creador.
  await asUser(db, STRANGER, () => db.query(`select public.set_acquisition_source('amigo', 'Juan')`));
  const [s] = await rows(db, `select acquisition_creator from public.profiles where id = $1`, [STRANGER]);
  assert.equal(s.acquisition_creator, null);
  const sum = (await asAdmin(db, () => db.query(`select public.admin_survey_summary() s`))).rows[0].s;
  assert.equal(Number(sum.answered), 2);
});

test('ninguna función nueva es ejecutable por anon', async () => {
  const { db } = await world();
  const r = await rows(db, `
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'creator%' or p.proname like 'admin\\_%' or p.proname = 'set_acquisition_source')
       and has_function_privilege('anon', p.oid, 'execute')`);
  assert.deepEqual(r, []);
});
