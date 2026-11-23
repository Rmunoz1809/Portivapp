// Lógica de comisiones: public.creators_process_event() con eventos con la forma real de RevenueCat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addCreator, ev, send, rows, uuid, addDays, addMonths, asAdmin, setupAdmin } from './harness.mjs';

const MONTHLY = 'com.portivapp.portafolio.mensual';
const ANNUAL = 'com.portivapp.portafolio.anual';
const T0 = new Date('2026-12-01T15:00:00Z');       // canje + inicio de la prueba

async function base() {
  const db = await freshDb();
  const gaston = await addCreator(db, { name: 'Gastón', offer_code: 'GASTON', email: 'gaston@test.dev', payout_method: 'wise' });
  const old = await addCreator(db, { name: 'Viejo', offer_code: 'VIEJO', active: false });
  return { db, gaston, old };
}
const comms = (db, user) => rows(db, `select * from public.commissions where app_user_id = $1 order by charged_at, id`, [user]);
const attr = async (db, user) => (await rows(db, `select * from public.attributions where app_user_id = $1`, [user]))[0];

// Flujo típico: canje del código (14 días de prueba) → semana del código ($0) → primer cobro.
async function redeemAndConvert(db, user, { product = MONTHLY, price = 4.99 } = {}) {
  const r1 = await send(db, ev({ type: 'INITIAL_PURCHASE', user, period: 'TRIAL', price: 0, code: 'GASTON', at: T0, product }));
  const r2 = await send(db, ev({ type: 'RENEWAL', user, period: 'TRIAL', price: 0, code: 'GASTON', at: addDays(T0, 14), product, trialConversion: true }));
  const paid = ev({ type: 'RENEWAL', user, period: 'NORMAL', price, at: addDays(T0, 21), product, trialConversion: false });
  const r3 = await send(db, paid);
  return { r1, r2, r3, paid };
}

test('migra PORTIV7 del esquema anterior con 0 %', async () => {
  const db = await freshDb();
  const [c] = await rows(db, `select * from public.creators where offer_code = 'PORTIV7'`);
  assert.equal(c.name, 'Portiv (propio)');
  assert.equal(Number(c.commission_rate), 0);
  assert.equal(c.commission_months, 12);
  assert.equal(c.asc_offer_id, '1ca65d7d-d205-4453-be1c-13388ef6b78e');
});

test('la prueba de 14 días no paga comisión, pero atribuye', async () => {
  const { db, gaston } = await base();
  const u = uuid(1);
  const r = await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'gaston', at: T0 }));
  assert.equal(r.result, 'attributed');
  const a = await attr(db, u);
  assert.equal(a.creator_id, gaston.id);
  assert.equal(a.source, 'offer_code');
  assert.equal(a.first_paid_at, null);
  assert.equal(Number(a.commission_rate), 0.2);
  assert.equal((await comms(db, u)).length, 0);
});

test('la semana extra del código ($0) no paga comisión', async () => {
  const { db } = await base();
  const u = uuid(2);
  const { r2 } = await redeemAndConvert(db, u);
  assert.equal(r2.result, 'no_op');
  const c = await comms(db, u);
  assert.equal(c.length, 1, 'solo el cobro real');
  assert.equal(Number(c[0].gross_usd), 4.99);
});

test('primera compra: 20 % del neto (precio × 0.85), mes M y pago el 15 de M+2', async () => {
  const { db, gaston } = await base();
  const u = uuid(3);
  const { r3, paid } = await redeemAndConvert(db, u);
  assert.equal(r3.result, 'commission');
  const [c] = await comms(db, u);
  assert.equal(c.creator_id, gaston.id);
  assert.equal(c.kind, 'charge');
  assert.equal(c.transaction_id, paid.transaction_id);
  assert.equal(Number(c.net_usd), 4.2415);         // 4.99 × 0.85
  assert.equal(Number(c.amount_usd), 0.8483);      // × 0.20
  assert.equal(c.earned_month.toISOString().slice(0, 10), '2026-12-01');
  assert.equal(c.payable_on.toISOString().slice(0, 10), '2027-02-15');
  assert.equal(c.status, 'pending');
  const a = await attr(db, u);
  assert.equal(a.first_paid_at.toISOString(), addDays(T0, 21).toISOString());
});

test('renovaciones: 12 cobros mensuales cuentan, el 13.º (aunque Apple lo cobre 1 día antes) no', async () => {
  const { db } = await base();
  const u = uuid(4);
  const { paid } = await redeemAndConvert(db, u);
  const first = new Date(paid.purchased_at_ms);
  const results = [];
  for (let m = 1; m <= 13; m++) {
    const at = m === 12 ? addDays(addMonths(first, 12), -1) : addMonths(first, m);
    results.push((await send(db, ev({ type: 'RENEWAL', user: u, price: 4.99, at }))).result);
  }
  assert.deepEqual(results.slice(0, 11), Array(11).fill('commission'));
  assert.equal(results[11], 'outside_window');
  assert.equal(results[12], 'outside_window');
  assert.equal((await comms(db, u)).length, 12);
});

test('plan anual: 1 cobro con comisión; la renovación del año siguiente ya no', async () => {
  const { db } = await base();
  const u = uuid(5);
  const { r3 } = await redeemAndConvert(db, u, { product: ANNUAL, price: 49.99 });
  assert.equal(r3.result, 'commission');
  const [c] = await comms(db, u);
  assert.equal(Number(c.amount_usd), 8.4983);      // 49.99 × 0.85 × 0.20
  const r = await send(db, ev({ type: 'RENEWAL', user: u, product: ANNUAL, price: 49.99, at: addDays(addMonths(addDays(T0, 21), 12), -1) }));
  assert.equal(r.result, 'outside_window');
});

test('reembolso antes de pagar al creador: la comisión queda reversed', async () => {
  const { db } = await base();
  const u = uuid(6);
  const { paid } = await redeemAndConvert(db, u);
  const r = await send(db, ev({ type: 'CANCELLATION', user: u, price: -4.99, cancelReason: 'CUSTOMER_SUPPORT', tx: paid.transaction_id, at: addDays(T0, 25) }));
  assert.equal(r.result, 'reversed');
  const [c] = await comms(db, u);
  assert.equal(c.status, 'reversed');
  // Un segundo aviso del mismo reembolso no hace nada.
  const r2 = await send(db, ev({ type: 'CANCELLATION', user: u, price: -4.99, cancelReason: 'CUSTOMER_SUPPORT', tx: paid.transaction_id, at: addDays(T0, 26) }));
  assert.equal(r2.result, 'already_reversed');
});

test('reembolso sin transaction_id coincidente: se usa original_transaction_id + monto', async () => {
  const { db } = await base();
  const u = uuid(7);
  await redeemAndConvert(db, u);
  const r = await send(db, ev({ type: 'CANCELLATION', user: u, price: -4.99, cancelReason: 'CUSTOMER_SUPPORT', tx: 'otro-id', at: addDays(T0, 25) }));
  assert.equal(r.result, 'reversed');
});

test('cancelar la renovación (UNSUBSCRIBE, price 0) no toca la comisión', async () => {
  const { db } = await base();
  const u = uuid(8);
  await redeemAndConvert(db, u);
  const r = await send(db, ev({ type: 'CANCELLATION', user: u, price: 0, cancelReason: 'UNSUBSCRIBE', at: addDays(T0, 25) }));
  assert.equal(r.result, 'no_op');
  assert.equal((await comms(db, u))[0].status, 'pending');
});

test('evento duplicado: el reintento de RevenueCat no duplica nada', async () => {
  const { db } = await base();
  const u = uuid(9);
  const { paid } = await redeemAndConvert(db, u);
  const again = await send(db, paid);
  assert.equal(again.duplicate, true);
  assert.equal((await comms(db, u)).length, 1);
  // Mismo cobro con otro id de evento (mismo transaction_id): tampoco se duplica.
  const other = await send(db, { ...paid, id: 'otro-evento' });
  assert.equal(other.result, 'commission_duplicate_tx');
  assert.equal((await comms(db, u)).length, 1);
});

test('creador inactivo: su código no atribuye ni genera comisión', async () => {
  const { db } = await base();
  const u = uuid(10);
  const r = await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'VIEJO', at: T0 }));
  assert.equal(r.result, 'creator_inactive');
  await send(db, ev({ type: 'RENEWAL', user: u, price: 4.99, at: addDays(T0, 21) }));
  assert.equal(await attr(db, u), undefined);
  assert.equal((await comms(db, u)).length, 0);
});

test('creador desactivado DESPUÉS de atribuir: los usuarios que ya trajo siguen contando', async () => {
  const { db, gaston } = await base();
  const u = uuid(11);
  await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'GASTON', at: T0 }));
  await asAdmin(db, () => db.query(`select public.admin_upsert_creator($1::jsonb)`, [JSON.stringify({ id: gaston.id, active: false })]));
  const r = await send(db, ev({ type: 'RENEWAL', user: u, price: 4.99, at: addDays(T0, 21) }));
  assert.equal(r.result, 'commission');
});

test('usuario sin código: sus cobros no generan nada', async () => {
  const { db } = await base();
  const u = uuid(12);
  await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, at: T0 }));
  const r = await send(db, ev({ type: 'RENEWAL', user: u, price: 4.99, at: addDays(T0, 14) }));
  assert.equal(r.result, 'no_op');
  assert.equal(await attr(db, u), undefined);
  assert.equal((await rows(db, `select count(*)::int n from public.commissions`))[0].n, 0);
});

test('código desconocido: no atribuye', async () => {
  const { db } = await base();
  const r = await send(db, ev({ type: 'INITIAL_PURCHASE', user: uuid(13), period: 'TRIAL', price: 0, code: 'NOEXISTE', at: T0 }));
  assert.equal(r.result, 'code_unknown');
});

test('quien ya pagaba antes (historial de rc-webhook) no se atribuye al canjear', async () => {
  const { db } = await base();
  const u = uuid(14);
  await db.query(`insert into public.subscription_events (event_id, user_id, type, store, event_ms, payload)
                  values ('viejo-1', $1, 'RENEWAL', 'APP_STORE', $2, $3::jsonb)`,
    [u, T0.getTime() - 40 * 86400000, JSON.stringify({ app_user_id: u, price: 4.99, environment: 'PRODUCTION', purchased_at_ms: T0.getTime() - 40 * 86400000 })]);
  const r = await send(db, ev({ type: 'RENEWAL', user: u, price: 0, period: 'TRIAL', code: 'GASTON', at: T0 }));
  assert.equal(r.result, 'already_customer');
  await send(db, ev({ type: 'RENEWAL', user: u, price: 4.99, at: addDays(T0, 7) }));
  assert.equal((await comms(db, u)).length, 0);
});

test('quien ya pagaba (visto por el propio webhook de creadores) tampoco se atribuye', async () => {
  const { db } = await base();
  const u = uuid(15);
  await send(db, ev({ type: 'RENEWAL', user: u, price: 4.99, at: addDays(T0, -30) }));
  const r = await send(db, ev({ type: 'RENEWAL', user: u, price: 0, period: 'TRIAL', code: 'GASTON', at: T0 }));
  assert.equal(r.result, 'already_customer');
});

test('el primer código gana: un segundo código no cambia la atribución', async () => {
  const { db, gaston } = await base();
  await addCreator(db, { name: 'Otra', offer_code: 'OTRA' });
  const u = uuid(16);
  await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'GASTON', at: T0 }));
  const r = await send(db, ev({ type: 'RENEWAL', user: u, period: 'TRIAL', price: 0, code: 'OTRA', at: addDays(T0, 14) }));
  assert.equal(r.result, 'no_op');
  assert.equal((await attr(db, u)).creator_id, gaston.id);
});

test('impuestos: neto = precio × (1 − tax) × takehome', async () => {
  const { db } = await base();
  const u = uuid(17);
  await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'GASTON', at: T0 }));
  await send(db, ev({ type: 'RENEWAL', user: u, price: 10, tax: 0.16, at: addDays(T0, 21) }));
  const [c] = await comms(db, u);
  assert.equal(Number(c.net_usd), 7.14);           // 10 × 0.84 × 0.85
  assert.equal(Number(c.amount_usd), 1.428);
});

test('sin takehome_percentage: usa 1 − commission_percentage; sin ninguno: 0.85', async () => {
  const { db } = await base();
  const u1 = uuid(18), u2 = uuid(19);
  for (const u of [u1, u2]) await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'GASTON', at: T0 }));
  await send(db, ev({ type: 'RENEWAL', user: u1, price: 10, takehome: null, commission: 0.30, at: addDays(T0, 21) }));
  await send(db, ev({ type: 'RENEWAL', user: u2, price: 10, takehome: null, commission: null, at: addDays(T0, 21) }));
  assert.equal(Number((await comms(db, u1))[0].takehome_rate), 0.7);
  assert.equal(Number((await comms(db, u2))[0].takehome_rate), 0.85);
});

test('sandbox: se guarda pero no cuenta; con aceptación explícita se procesa marcado', async () => {
  const { db } = await base();
  const u = uuid(20);
  const r = await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'GASTON', env: 'SANDBOX', at: T0 }));
  assert.equal(r.result, 'stored_sandbox');
  assert.equal(await attr(db, u), undefined);
  const [e] = await rows(db, `select * from public.creator_events where app_user_id = $1`, [u]);
  assert.equal(e.is_sandbox, true);

  const r2 = await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'GASTON', env: 'SANDBOX', at: T0 }), { sandbox: true });
  assert.equal(r2.result, 'attributed');
  await send(db, ev({ type: 'RENEWAL', user: u, price: 4.99, env: 'SANDBOX', at: addDays(T0, 21) }), { sandbox: true });
  const [c] = await comms(db, u);
  assert.equal(c.is_sandbox, true);
  assert.equal((await attr(db, u)).is_sandbox, true);
});

test('compra anónima: la atribución pasa al uid cuando llega con alias', async () => {
  const { db } = await base();
  const anon = '$RCAnonymousID:abc123', u = uuid(21);
  await send(db, ev({ type: 'INITIAL_PURCHASE', user: anon, period: 'TRIAL', price: 0, code: 'GASTON', at: T0 }));
  assert.ok(await attr(db, anon));
  const r = await send(db, ev({ type: 'RENEWAL', user: u, aliases: [anon, u], originalUser: anon, price: 4.99, at: addDays(T0, 21) }));
  assert.equal(r.result, 'commission');
  assert.equal(await attr(db, anon), undefined);
  assert.equal((await comms(db, u)).length, 1);
});

test('encuesta: no genera comisión, y el Offer Code la reemplaza', async () => {
  const { db, gaston } = await base();
  const u = uuid(22);
  await db.query(`insert into auth.users (id) values ($1)`, [u]);
  const { asUser } = await import('./harness.mjs');
  await asUser(db, u, () => db.query(`select public.set_acquisition_source('instagram', '@Gaston')`));
  const s = await attr(db, u);
  assert.equal(s.source, 'survey');
  await send(db, ev({ type: 'RENEWAL', user: u, price: 4.99, at: addDays(T0, -2) }));
  assert.equal((await comms(db, u)).length, 0, 'la encuesta sola nunca paga');

  const u2 = uuid(23);
  await db.query(`insert into auth.users (id) values ($1)`, [u2]);
  await asUser(db, u2, () => db.query(`select public.set_acquisition_source('youtube', 'gaston')`));
  const r = await send(db, ev({ type: 'INITIAL_PURCHASE', user: u2, period: 'TRIAL', price: 0, code: 'GASTON', at: T0 }));
  assert.equal(r.result, 'attributed');
  const a = await attr(db, u2);
  assert.equal(a.source, 'offer_code');
  assert.equal(a.creator_id, gaston.id);
  assert.equal(a.survey_source, 'youtube', 'conserva la respuesta de la encuesta');
});

test('reembolso revertido por Apple (REFUND_REVERSED) restituye la comisión', async () => {
  const { db } = await base();
  const u = uuid(24);
  const { paid } = await redeemAndConvert(db, u);
  await send(db, ev({ type: 'CANCELLATION', user: u, price: -4.99, cancelReason: 'CUSTOMER_SUPPORT', tx: paid.transaction_id, at: addDays(T0, 25) }));
  const r = await send(db, ev({ type: 'REFUND_REVERSED', user: u, price: 4.99, tx: paid.transaction_id, at: addDays(T0, 30) }));
  assert.equal(r.result, 'restored');
  assert.equal((await comms(db, u))[0].status, 'pending');
});

test('TRANSFER y TEST se guardan y se ignoran', async () => {
  const { db } = await base();
  assert.equal((await send(db, ev({ type: 'TRANSFER', user: uuid(25) }))).result, 'ignored');
  assert.equal((await send(db, ev({ type: 'TEST', user: uuid(26) }))).result, 'ignored');
});

test('evento sin id o sin tipo: error, no guarda nada', async () => {
  const { db } = await base();
  const r = await send(db, { ...ev({ user: uuid(27) }), id: '' });
  assert.equal(r.ok, false);
});

test('condiciones fijadas al atribuir: cambiar el % después no afecta a usuarios ya atribuidos', async () => {
  const { db, gaston } = await base();
  const u = uuid(28);
  await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'GASTON', at: T0 }));
  await asAdmin(db, () => db.query(`select public.admin_upsert_creator($1::jsonb)`, [JSON.stringify({ id: gaston.id, commission_rate: 0.3, commission_months: 6 })]));
  await send(db, ev({ type: 'RENEWAL', user: u, price: 4.99, at: addDays(T0, 21) }));
  assert.equal(Number((await comms(db, u))[0].commission_rate), 0.2);
  const u2 = uuid(29);
  await send(db, ev({ type: 'INITIAL_PURCHASE', user: u2, period: 'TRIAL', price: 0, code: 'GASTON', at: T0 }));
  await send(db, ev({ type: 'RENEWAL', user: u2, price: 4.99, at: addDays(T0, 21) }));
  assert.equal(Number((await comms(db, u2))[0].commission_rate), 0.3);
});

test('pending → payable el 15 de M+2 (hora de Panamá)', async () => {
  const { db } = await base();
  const u = uuid(30);
  await redeemAndConvert(db, u);                       // cobro el 22 dic 2026 → pagable el 15 feb 2027
  const n0 = (await rows(db, `select public.creators_refresh_statuses('2027-02-15T04:59:00Z') n`))[0].n;   // 14 feb 23:59 Panamá
  assert.equal(n0, 0);
  const n1 = (await rows(db, `select public.creators_refresh_statuses('2027-02-15T05:00:00Z') n`))[0].n;   // 15 feb 00:00 Panamá
  assert.equal(n1, 1);
  assert.equal((await comms(db, u))[0].status, 'payable');
});

test('las tablas viejas en español se borraron', async () => {
  const db = await freshDb();
  const [r] = await rows(db, `select to_regclass('public.creadores') a, to_regclass('public.creador_ventas') b`);
  assert.equal(r.a, null);
  assert.equal(r.b, null);
});

test('backfill: recupera desde subscription_events lo que rc-webhook no pudo pasar, sin duplicar', async () => {
  const { db } = await base();
  const u = uuid(31);
  const e1 = ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'GASTON', at: T0 });
  const e2 = ev({ type: 'RENEWAL', user: u, price: 4.99, at: addDays(T0, 21) });
  for (const e of [e2, e1]) {   // insertados desordenados: el backfill ordena por event_ms
    await db.query(`insert into public.subscription_events (event_id, user_id, type, store, event_ms, payload)
                    values ($1, $2, $3, 'APP_STORE', $4, $5::jsonb)`, [e.id, u, e.type, e.event_timestamp_ms, JSON.stringify(e)]);
  }
  await send(db, e1);                                   // el primero sí llegó en vivo
  const n = (await rows(db, `select public.creators_backfill() n`))[0].n;
  assert.equal(n, 1);
  assert.equal((await comms(db, u)).length, 1);
  assert.equal((await rows(db, `select public.creators_backfill() n`))[0].n, 0);
});
