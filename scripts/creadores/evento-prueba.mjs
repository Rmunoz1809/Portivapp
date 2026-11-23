#!/usr/bin/env node
// Manda eventos SIMULADOS de RevenueCat al webhook de creadores (creators-webhook).
//
//   node scripts/creadores/evento-prueba.mjs flujo   --code GASTON
//   node scripts/creadores/evento-prueba.mjs trial   --code GASTON --user <uuid>
//   node scripts/creadores/evento-prueba.mjs cobro   --user <uuid> [--anual] [--precio 4.99]
//   node scripts/creadores/evento-prueba.mjs reembolso --user <uuid> --tx <transaction_id>
//
// Escenarios: trial (INITIAL_PURCHASE de prueba con el código) · semana (RENEWAL $0 de la semana
// del código) · cobro (RENEWAL pagado) · reembolso (CANCELLATION CUSTOMER_SUPPORT, precio negativo)
// · flujo (trial → semana → cobro → reembolso del cobro, todo con el mismo usuario).
//
// Por defecto los eventos van con environment SANDBOX: se guardan marcados y NUNCA entran en un
// pago. Solo atribuyen/generan comisión si la función tiene CREATORS_ACCEPT_SANDBOX=true.
// --produccion los manda como PRODUCTION (cuentan de verdad: úsalo solo con un creador de prueba).
//
// Secreto: CREATORS_WEBHOOK_SECRET en el entorno, o el archivo ~/.config/portiv/creators-webhook-secret.
// URL: CREATORS_WEBHOOK_URL o la de producción.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const scenario = args[0];
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);

const URL_ = process.env.CREATORS_WEBHOOK_URL || 'https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/creators-webhook';
let SECRET = process.env.CREATORS_WEBHOOK_SECRET;
if (!SECRET) {
  try { SECRET = readFileSync(homedir() + '/.config/portiv/creators-webhook-secret', 'utf8').trim(); } catch {}
}
if (!SECRET) { console.error('Falta el secreto (CREATORS_WEBHOOK_SECRET o ~/.config/portiv/creators-webhook-secret)'); process.exit(1); }
if (!['trial', 'semana', 'cobro', 'reembolso', 'flujo'].includes(scenario)) {
  console.error('Escenario: trial | semana | cobro | reembolso | flujo'); process.exit(1);
}

const user = opt('user', randomUUID());
const code = (opt('code', '') || '').toUpperCase() || null;
const annual = flag('anual');
const product = annual ? 'com.portivapp.portafolio.anual' : 'com.portivapp.portafolio.mensual';
const price = Number(opt('precio', annual ? '49.99' : '4.99'));
const env = flag('produccion') ? 'PRODUCTION' : 'SANDBOX';
const otx = opt('otx', 'prueba-otx-' + user.slice(0, 8));

function event(type, o = {}) {
  const at = o.at || Date.now();
  return {
    api_version: '1.0',
    event: {
      id: 'prueba-' + randomUUID(),
      type,
      app_user_id: user, original_app_user_id: user, aliases: [user],
      environment: env, store: 'APP_STORE', product_id: product,
      period_type: o.period || 'NORMAL',
      price: o.price ?? 0, price_in_purchased_currency: o.price ?? 0, currency: 'USD',
      tax_percentage: 0, commission_percentage: 0.15, takehome_percentage: 0.85,
      offer_code: o.code ?? null,
      transaction_id: o.tx || 'prueba-tx-' + randomUUID().slice(0, 8),
      original_transaction_id: otx,
      purchased_at_ms: at, event_timestamp_ms: at + 1000, expiration_at_ms: at + 30 * 86400000,
      is_trial_conversion: o.trialConversion ?? null,
      cancel_reason: o.cancelReason ?? null,
      entitlement_ids: ['Portiv Pro'],
    },
  };
}

async function post(label, body) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: SECRET },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`${label.padEnd(10)} ${body.event.type.padEnd(17)} ${String(body.event.price).padStart(7)}  tx=${body.event.transaction_id}  → ${r.status} ${text}`);
  if (!r.ok) process.exitCode = 1;
  return body.event;
}

const DAY = 86400000;
const t0 = Date.now() - 22 * DAY;
console.log(`usuario ${user} · ${env} · ${product}${code ? ' · código ' + code : ''}\n`);

if (scenario === 'trial') await post('trial', event('INITIAL_PURCHASE', { period: 'TRIAL', code }));
if (scenario === 'semana') await post('semana', event('RENEWAL', { period: 'TRIAL', code, trialConversion: true }));
if (scenario === 'cobro') await post('cobro', event('RENEWAL', { price, trialConversion: true }));
if (scenario === 'reembolso') {
  const tx = opt('tx');
  if (!tx) { console.error('reembolso necesita --tx <transaction_id del cobro>'); process.exit(1); }
  await post('reembolso', event('CANCELLATION', { price: -price, tx, cancelReason: 'CUSTOMER_SUPPORT' }));
}
if (scenario === 'flujo') {
  if (!code) { console.error('flujo necesita --code'); process.exit(1); }
  await post('trial', event('INITIAL_PURCHASE', { period: 'TRIAL', code, at: t0 }));
  await post('semana', event('RENEWAL', { period: 'TRIAL', code, trialConversion: true, at: t0 + 14 * DAY }));
  const paid = await post('cobro', event('RENEWAL', { price, at: t0 + 21 * DAY }));
  const dup = { api_version: '1.0', event: paid };
  await post('duplicado', dup);
  await post('reembolso', event('CANCELLATION', { price: -price, tx: paid.transaction_id, cancelReason: 'CUSTOMER_SUPPORT', at: Date.now() }));
}
