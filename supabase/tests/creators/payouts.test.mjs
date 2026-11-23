// Cierre del mes: regla M+2, mínimo de $20, acumulado, marcar pagado, reembolsos después de pagar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addCreator, ev, send, rows, uuid, addDays, asAdmin } from './harness.mjs';

const ANNUAL = 'com.portivapp.portafolio.anual';
const T0 = new Date('2026-12-01T15:00:00Z');

// N usuarios del creador que pasan a pagar el anual ($49.99 → $8.4983 de comisión cada uno).
async function annualUsers(db, code, from, n, at = T0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = uuid(from + i);
    await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code, at, product: ANNUAL }));
    const paid = ev({ type: 'RENEWAL', user: u, price: 49.99, at: addDays(at, 21), product: ANNUAL });
    await send(db, paid);
    out.push({ u, paid });
  }
  return out;
}
const close = (db, month, now) =>
  asAdmin(db, () => db.query(`select public.creators_month_close($1::date, 20, $2::timestamptz) r`, [month, now])).then((r) => r.rows[0].r);

test('no se puede cerrar diciembre antes del 15 de febrero', async () => {
  const db = await freshDb();
  await addCreator(db, { name: 'G', offer_code: 'GASTON' });
  await assert.rejects(close(db, '2026-12-01', '2027-02-14T17:00:00Z'), /se puede cerrar desde el 2027-02-15/);
});

test('cierre: paga a quien llega a $20 y acumula a quien no; repetir no duplica', async () => {
  const db = await freshDb();
  const big = await addCreator(db, { name: 'Grande', offer_code: 'GRANDE', payout_method: 'paypal', payout_details: { email: 'g@pay.test' } });
  const small = await addCreator(db, { name: 'Chico', offer_code: 'CHICO', payout_method: 'wise' });
  await annualUsers(db, 'GRANDE', 100, 3);                     // 3 × 8.4983 = 25.49
  await annualUsers(db, 'CHICO', 200, 1);                      // 8.50 → no llega

  const r = await close(db, '2026-12-01', '2027-02-15T17:00:00Z');
  assert.equal(r.payouts.length, 1);
  const p = r.payouts[0];
  assert.equal(p.creator_id, big.id);
  assert.equal(Number(p.amount_usd), 25.49);
  assert.equal(p.method, 'paypal');
  assert.deepEqual(p.payout_details, { email: 'g@pay.test' });
  assert.equal(r.carried_over.length, 1);
  assert.equal(r.carried_over[0].creator_id, small.id);

  const again = await close(db, '2026-12-01', '2027-02-16T17:00:00Z');
  assert.equal(again.payouts.length, 1);
  assert.equal((await rows(db, `select count(*)::int n from public.payouts`))[0].n, 1);
});

test('lo acumulado se suma al mes siguiente y entonces sí se paga', async () => {
  const db = await freshDb();
  await addCreator(db, { name: 'Chico', offer_code: 'CHICO' });
  await annualUsers(db, 'CHICO', 300, 1, T0);                              // dic: 8.50
  await annualUsers(db, 'CHICO', 310, 2, new Date('2027-01-05T15:00:00Z')); // ene: 17.00
  const dic = await close(db, '2026-12-01', '2027-02-15T17:00:00Z');
  assert.equal(dic.payouts.length, 0);
  // Las comisiones de enero aún no son pagables en feb: no entran en el cierre de diciembre.
  const ene = await close(db, '2027-01-01', '2027-03-15T17:00:00Z');
  assert.equal(ene.payouts.length, 1);
  assert.equal(Number(ene.payouts[0].amount_usd), 25.49);
});

test('marcar pagado: exige referencia y pasa las comisiones a paid', async () => {
  const db = await freshDb();
  const g = await addCreator(db, { name: 'G', offer_code: 'GASTON' });
  await annualUsers(db, 'GASTON', 400, 3);
  const r = await close(db, '2026-12-01', '2027-02-15T17:00:00Z');
  const id = r.payouts[0].payout_id;
  await assert.rejects(asAdmin(db, () => db.query(`select public.admin_mark_payout_paid($1, '  ')`, [id])), /falta la referencia/);
  await asAdmin(db, () => db.query(`select public.admin_mark_payout_paid($1, 'WISE-123')`, [id]));
  const st = await rows(db, `select status, count(*)::int n from public.commissions where creator_id = $1 group by 1`, [g.id]);
  assert.deepEqual(st, [{ status: 'paid', n: 3 }]);
  await assert.rejects(asAdmin(db, () => db.query(`select public.admin_mark_payout_paid($1, 'otra')`, [id])), /ya marcado/);
});

test('reembolso DESPUÉS de pagar: ajuste negativo que se descuenta del siguiente pago', async () => {
  const db = await freshDb();
  const g = await addCreator(db, { name: 'G', offer_code: 'GASTON' });
  const users = await annualUsers(db, 'GASTON', 500, 3);
  const r = await close(db, '2026-12-01', '2027-02-15T17:00:00Z');
  await asAdmin(db, () => db.query(`select public.admin_mark_payout_paid($1, 'PP-1')`, [r.payouts[0].payout_id]));

  const { u, paid } = users[0];
  const ref = await send(db, ev({ type: 'CANCELLATION', user: u, price: -49.99, cancelReason: 'CUSTOMER_SUPPORT', tx: paid.transaction_id, at: new Date('2027-02-20T15:00:00Z') }));
  assert.equal(ref.result, 'adjusted');
  const [adj] = await rows(db, `select * from public.commissions where kind = 'adjustment'`);
  assert.equal(Number(adj.amount_usd), -8.4983);
  assert.equal(adj.status, 'payable');

  // Febrero: 3 anuales nuevos (3 × 8.4983) − 8.4983 = 16.9966 → $17.00, no llega a 20, se acumula.
  await annualUsers(db, 'GASTON', 510, 3, new Date('2027-02-01T15:00:00Z'));
  const feb = await close(db, '2027-02-01', '2027-04-15T17:00:00Z');
  assert.equal(feb.payouts.length, 0);
  assert.equal(Number(feb.carried_over[0].amount_usd), 17);
});

test('reembolso de una comisión que está en un pago aún no hecho: el pago se recalcula', async () => {
  const db = await freshDb();
  await addCreator(db, { name: 'G', offer_code: 'GASTON' });
  const users = await annualUsers(db, 'GASTON', 600, 4);         // 33.99
  const r = await close(db, '2026-12-01', '2027-02-15T17:00:00Z');
  assert.equal(Number(r.payouts[0].amount_usd), 33.99);
  const { u, paid } = users[0];
  await send(db, ev({ type: 'CANCELLATION', user: u, price: -49.99, cancelReason: 'CUSTOMER_SUPPORT', tx: paid.transaction_id, at: new Date('2027-02-16T15:00:00Z') }));
  const [p] = await rows(db, `select * from public.payouts`);
  assert.equal(Number(p.amount_usd), 25.49);
});

test('deshacer un pago pendiente libera sus comisiones; uno pagado no se puede deshacer', async () => {
  const db = await freshDb();
  await addCreator(db, { name: 'G', offer_code: 'GASTON' });
  await annualUsers(db, 'GASTON', 700, 3);
  const r = await close(db, '2026-12-01', '2027-02-15T17:00:00Z');
  const id = r.payouts[0].payout_id;
  await asAdmin(db, () => db.query(`select public.admin_cancel_payout($1)`, [id]));
  assert.equal((await rows(db, `select count(*)::int n from public.commissions where payout_id is not null`))[0].n, 0);
  const r2 = await close(db, '2026-12-01', '2027-02-15T17:00:00Z');
  await asAdmin(db, () => db.query(`select public.admin_mark_payout_paid($1, 'X')`, [r2.payouts[0].payout_id]));
  await assert.rejects(asAdmin(db, () => db.query(`select public.admin_cancel_payout($1)`, [r2.payouts[0].payout_id])), /solo se puede deshacer/);
});

test('las comisiones de sandbox nunca entran en un cierre', async () => {
  const db = await freshDb();
  await addCreator(db, { name: 'G', offer_code: 'GASTON' });
  for (let i = 0; i < 3; i++) {
    const u = uuid(800 + i);
    await send(db, ev({ type: 'INITIAL_PURCHASE', user: u, period: 'TRIAL', price: 0, code: 'GASTON', env: 'SANDBOX', at: T0, product: ANNUAL }), { sandbox: true });
    await send(db, ev({ type: 'RENEWAL', user: u, price: 49.99, env: 'SANDBOX', at: addDays(T0, 21), product: ANNUAL }), { sandbox: true });
  }
  const r = await close(db, '2026-12-01', '2027-02-15T17:00:00Z');
  assert.equal(r.payouts.length, 0);
  assert.equal(r.carried_over.length, 0);
});
