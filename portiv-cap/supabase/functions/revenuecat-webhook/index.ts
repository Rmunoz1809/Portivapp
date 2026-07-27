// Supabase Edge Function: revenuecat-webhook
// Recibe eventos de RevenueCat y actualiza profiles.subscription_status del usuario.
// ⚠️ NO desplegada. Para desplegar (cuando estés listo):
//     supabase functions deploy revenuecat-webhook --no-verify-jwt
//     supabase secrets set REVENUECAT_WEBHOOK_SECRET=<tu-secreto>
//   (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta la plataforma).
//
// En RevenueCat → Project → Integrations → Webhooks:
//   URL: https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/revenuecat-webhook
//   Authorization header: el mismo valor que REVENUECAT_WEBHOOK_SECRET.
//
// Requisito de datos: el app_user_id de RevenueCat debe ser el user.id de Supabase
// (lo garantiza Purchases.logIn(session.user.id) en el cliente). La tabla `profiles`
// debe tener PK `id` = auth.users.id y una columna `subscription_status text`.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('REVENUECAT_WEBHOOK_SECRET') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// Estado de subscription_status según el tipo de evento de RevenueCat.
const STATUS_BY_TYPE: Record<string, string> = {
  INITIAL_PURCHASE: 'active',
  RENEWAL:          'active',
  UNCANCELLATION:   'active',
  CANCELLATION:     'cancelled', // auto-renovación off; sigue activo hasta expirar
  EXPIRATION:       'expired',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // Autenticación del webhook (header Authorization configurado en RevenueCat).
  if (WEBHOOK_SECRET) {
    const auth = req.headers.get('Authorization') ?? '';
    if (auth !== WEBHOOK_SECRET && auth !== `Bearer ${WEBHOOK_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response('Bad Request', { status: 400 }); }

  const event: any   = body?.event ?? {};
  const type: string = event.type ?? '';
  const appUserId: string = event.app_user_id ?? '';
  const status = STATUS_BY_TYPE[type];

  // Eventos no manejados → 200 para evitar reintentos de RevenueCat.
  if (!status) return json({ ok: true, ignored: type });

  // Ignora IDs anónimos / no-UUID (no corresponden a un usuario de Supabase).
  if (!UUID_RE.test(appUserId)) return json({ ok: true, skipped: 'non-uuid app_user_id', type });

  const { error } = await admin
    .from('profiles')
    .update({ subscription_status: status })
    .eq('id', appUserId);

  if (error) {
    console.error('update profiles failed:', error.message);
    return json({ ok: false, error: error.message }, 500);
  }

  return json({ ok: true, type, status, user: appUserId });
});
