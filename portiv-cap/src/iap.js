// Portiv — Wrapper de RevenueCat (compras in-app) para Capacitor iOS.
// esbuild lo empaqueta → www/portiv-iap.js, que index.html carga con <script>.
// Expone window.PortivIAP: API pequeña y agnóstica de UI que la "pantalla Pro"
// (paywall propio en JS vanilla) puede llamar directamente.

import { Capacitor } from '@capacitor/core';
import { Purchases, LOG_LEVEL, PURCHASES_ERROR_CODE } from '@revenuecat/purchases-capacitor';
import { RevenueCatUI, PAYWALL_RESULT } from '@revenuecat/purchases-capacitor-ui';
import { SignInWithApple } from '@capacitor-community/apple-sign-in';

// ══════════════════════════════════════════════════════════════════════════════
//  CLAVE DE API DE REVENUECAT — test hoy, producción el día del lanzamiento
//  ─────────────────────────────────────────────────────────────────────────────
//  Son claves PÚBLICAS de SDK: viajan dentro del binario por diseño y no son un
//  secreto (el secreto es la clave v2 del backend, que no vive aquí).
//
//  Para pasar a producción hay DOS caminos — elige uno, no hacen falta los dos:
//
//   a) Editar este archivo: pegar la clave `appl_…` en RC_KEYS.prod y cambiar
//      RC_ENV_DEFAULT a 'prod'. Luego `npm run sync`.
//   b) Sin tocar el código:  export PORTIV_RC_KEY_PROD='appl_…' && npm run sync:prod
//      (scripts/build-iap-prod.js la inyecta en tiempo de build con --define).
//
//  En ambos casos el build de PRODUCCIÓN se niega a completarse si la clave está
//  vacía, no empieza por `appl_`, o si el bundle resultante todavía contiene una
//  clave `test_`. Es decir: subir la de sandbox por olvido no es posible.
// ══════════════════════════════════════════════════════════════════════════════
// Tomado el camino (a): la clave de producción vive AQUÍ, no en una variable de entorno.
//
// El motivo es que el camino (b) dejaba una trampa silenciosa. La clave sólo existía
// dentro del artefacto ya compilado, así que `npm run sync` y `npm run open:ios` —que
// llaman a `build:iap`, sin el --define— reconstruían www/portiv-iap.js con la clave de
// SANDBOX. La app arranca igual, el paywall se abre igual, y nadie puede comprar: el
// fallo no se ve hasta que un usuario real lo intenta. Con la clave en el código, los
// dos caminos de build producen un bundle de producción y la trampa desaparece.
//
// No es un secreto: `appl_…` es la clave PÚBLICA del SDK de iOS, pensada para viajar
// dentro del binario, y ya está en el repo dentro de www/portiv-iap.js. La que sí es
// secreta es la clave v2 del backend, que no vive en este archivo.
const RC_KEYS = {
  test: 'test_QuOSkuEiywERIEaFurpQhZlKIoQ',
  prod: 'appl_zfKbgdFDEuQbqaRzGzRQQKayUSr',
};
const RC_ENV_DEFAULT = 'prod';

// esbuild sustituye estos dos identificadores en el build de producción (--define).
// En el build normal no existen, de ahí el guard con typeof.
const RC_ENV  = (typeof __PV_RC_ENV__ !== 'undefined') ? __PV_RC_ENV__ : RC_ENV_DEFAULT;
const _RC_INJ = (typeof __PV_RC_KEY__ !== 'undefined') ? __PV_RC_KEY__ : '';
const REVENUECAT_IOS_API_KEY = _RC_INJ || RC_KEYS[RC_ENV] || RC_KEYS.test;
const RC_IS_TEST_KEY = /^test_/.test(REVENUECAT_IOS_API_KEY) || RC_ENV !== 'prod';

// Identifier del entitlement en RevenueCat (minúscula). NO es el display name
// ("Portiv Pro"): usar el display name aquí devuelve siempre undefined en
// info.entitlements.active[...] y deja bloqueado al usuario que sí pagó.
const ENTITLEMENT_ID = 'pro';
const OFFERING_ID    = 'default';

const state = {
  configured: false,
  isPro: false,
  offering: null,
  packages: { monthly: null, annual: null },
  listeners: new Set(),
};

const isNative = () => !!(Capacitor.isNativePlatform && Capacitor.isNativePlatform());

function _emit() {
  document.documentElement.classList.toggle('portiv-pro', state.isPro);
  window.PORTIV_PRO = state.isPro;
  window.dispatchEvent(new CustomEvent('portiv-pro-change', { detail: { isPro: state.isPro } }));
  state.listeners.forEach(cb => { try { cb(state.isPro); } catch (e) {} });
}

function _setPro(v) {
  state.isPro = !!v;
  _emit();
}

function _entActive(info) {
  return !!(info && info.entitlements && info.entitlements.active && info.entitlements.active[ENTITLEMENT_ID]);
}

async function configure() {
  if (state.configured) return;
  if (!isNative()) {
    // En navegador (preview web) no hay StoreKit: no-op para no romper la web.
    console.warn('[PortivIAP] Plataforma web: RevenueCat deshabilitado (solo iOS/Android nativo).');
    state.configured = true;
    return;
  }
  // Aviso ruidoso en cada arranque mientras la clave sea de sandbox: con `test_` las
  // compras NO son reales y el entitlement no llega al backend de producción.
  if (RC_IS_TEST_KEY) {
    console.warn('[PortivIAP] ⚠ Clave de RevenueCat de PRUEBA (env=' + RC_ENV + '). Las compras NO son reales. '
      + 'Antes del App Store: ver el bloque "CLAVE DE API DE REVENUECAT" en src/iap.js.');
  }
  try { await Purchases.setLogLevel({ level: RC_IS_TEST_KEY ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN }); } catch (e) {}
  await Purchases.configure({ apiKey: REVENUECAT_IOS_API_KEY });
  state.configured = true;
  // Actualizaciones en vivo (renovaciones, cambios desde App Store, restore, etc.)
  try {
    await Purchases.addCustomerInfoUpdateListener((info) => { _setPro(_entActive(info)); });
  } catch (e) {}
  await refresh();
}

// Identidad ya vinculada (o vinculándose) con RevenueCat. index.html llama a login()
// desde el gate de sesión, que puede reentrar (reintento del gate, TOKEN_REFRESHED,
// re-render): sin este guard cada pasada dispararía un logIn de red inútil.
let _idUid = null;
let _idPromise = null;

// Vincula la compra al usuario de Supabase (app_user_id = user.id, el mismo que ve el webhook).
// Idempotente por uid: repetirla con el mismo usuario no vuelve a llamar al SDK.
async function login(appUserId) {
  const uid = appUserId ? String(appUserId) : '';
  if (!uid) return state.isPro;
  try { if (!state.configured) await configure(); } catch (e) { return state.isPro; }
  if (!isNative()) return state.isPro;
  if (_idUid === uid) {                       // mismo usuario: ya vinculado o en vuelo
    if (_idPromise) { try { await _idPromise; } catch (e) {} }
    return state.isPro;
  }
  _idUid = uid;
  _idPromise = Purchases.logIn({ appUserID: uid })
    .then(({ customerInfo }) => { _setPro(_entActive(customerInfo)); })
    // Fallo (red, SDK sin configurar): se suelta el uid para que la SIGUIENTE transición
    // de sesión reintente. Nunca se propaga: el login de la app no puede depender de esto.
    .catch((e) => { console.warn('[PortivIAP] logIn falló', e); _idUid = null; })
    .finally(() => { _idPromise = null; });
  await _idPromise;
  return state.isPro;
}

async function logout() {
  _idUid = null; _idPromise = null;
  try { delete window.__pvPendingIapUid; } catch (e) {}
  if (!isNative()) { _setPro(false); return; }
  // Purchases.logOut() lanza si el usuario actual ya es anónimo — no es un error real.
  try { await Purchases.logOut(); } catch (e) {}
  _setPro(false);
}

async function refresh() {
  if (!isNative()) return state.isPro;
  try {
    const { customerInfo } = await Purchases.getCustomerInfo();
    _setPro(_entActive(customerInfo));
  } catch (e) { console.warn('[PortivIAP] getCustomerInfo falló', e); }
  return state.isPro;
}

// Carga el offering "default" y localiza los packages $rc_monthly / $rc_annual.
async function loadOfferings() {
  if (!isNative()) return state.packages;
  try {
    const offs = await Purchases.getOfferings();
    const off = (offs.all && offs.all[OFFERING_ID]) || offs.current || null;
    state.offering = off;
    state.packages = { monthly: null, annual: null };
    if (off && Array.isArray(off.availablePackages)) {
      for (const p of off.availablePackages) {
        if (p.identifier === '$rc_monthly' || p.packageType === 'MONTHLY') state.packages.monthly = p;
        if (p.identifier === '$rc_annual'  || p.packageType === 'ANNUAL')  state.packages.annual  = p;
      }
    }
    _paintPrices();
  } catch (e) { console.warn('[PortivIAP] getOfferings falló', e); }
  return state.packages;
}

// Info simple para pintar la pantalla Pro sin tocar el SDK.
function getPackagesInfo() {
  const fmt = (p) => (p && p.product) ? {
    id: p.identifier,
    type: p.packageType,
    priceString: p.product.priceString,
    price: p.product.price,
    currency: p.product.currencyCode,
    title: p.product.title,
  } : null;
  return { monthly: fmt(state.packages.monthly), annual: fmt(state.packages.annual) };
}

async function purchase(which) {
  if (!state.configured) await configure();
  if (!isNative()) { alert('Las compras solo están disponibles en la app de iOS.'); return { success: false, reason: 'web' }; }
  if (!state.packages.monthly && !state.packages.annual) await loadOfferings();
  const pkg = which === 'annual'  ? state.packages.annual
            : which === 'monthly' ? state.packages.monthly
            : (state.packages[which] || null);
  if (!pkg) return { success: false, reason: 'no-package' };
  try {
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
    _setPro(_entActive(customerInfo));
    return { success: state.isPro, customerInfo };
  } catch (e) {
    if (e && (e.userCancelled || e.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR)) {
      return { success: false, reason: 'cancelled' };
    }
    console.warn('[PortivIAP] compra falló', e);
    return { success: false, reason: 'error', error: e };
  }
}

async function restore() {
  if (!state.configured) await configure();
  if (!isNative()) { alert('Restaurar compras solo está disponible en la app de iOS.'); return false; }
  try {
    const { customerInfo } = await Purchases.restorePurchases();
    _setPro(_entActive(customerInfo));
  } catch (e) { console.warn('[PortivIAP] restore falló', e); }
  return state.isPro;
}

// Presenta el PAYWALL PREHECHO de RevenueCat (diseñado en el dashboard, offering "default").
// Reemplaza la pantalla de suscripción custom. Devuelve un resultado normalizado:
//   { result, purchased, restored, cancelled, error, notPresented, isPro }
//   · purchased/restored → activar Pro y continuar.
//   · cancelled → el usuario cerró la hoja.
//   · error/notPresented → no se pudo mostrar (p.ej. paywall no configurado aún en el dashboard).
async function presentPaywall() {
  if (!state.configured) await configure();
  if (!isNative()) {
    return { result: 'NOT_PRESENTED', purchased: false, restored: false, cancelled: false, error: false, notPresented: true, isPro: state.isPro };
  }
  // Asegura que el offering "default" (con sus packages) esté cargado antes de presentar.
  if (!state.offering) { try { await loadOfferings(); } catch (e) {} }
  try {
    const opts = { displayCloseButton: true };
    if (state.offering) opts.offering = state.offering;
    const { result } = await RevenueCatUI.presentPaywall(opts);
    await refresh(); // relee entitlements → sincroniza state.isPro tras compra/restore
    return {
      result,
      purchased:    result === PAYWALL_RESULT.PURCHASED,
      restored:     result === PAYWALL_RESULT.RESTORED,
      cancelled:    result === PAYWALL_RESULT.CANCELLED,
      error:        result === PAYWALL_RESULT.ERROR,
      notPresented: result === PAYWALL_RESULT.NOT_PRESENTED,
      isPro:        state.isPro,
    };
  } catch (e) {
    console.warn('[PortivIAP] presentPaywall falló', e);
    return { result: 'ERROR', purchased: false, restored: false, cancelled: false, error: true, notPresented: false, isPro: state.isPro };
  }
}

// ── Auto-cableado OPCIONAL de la UI por atributos data-* (no invasivo) ──
//   <button data-iap-buy="monthly">…</button>
//   <button data-iap-buy="annual">…</button>
//   <button data-iap-restore>Restaurar compras</button>
//   <span data-iap-price="monthly"></span>   ← se rellena con el precio localizado
//   <span data-iap-price="annual"></span>
function _paintPrices() {
  const info = getPackagesInfo();
  document.querySelectorAll('[data-iap-price]').forEach(el => {
    const k = el.getAttribute('data-iap-price');
    if (info[k] && info[k].priceString) el.textContent = info[k].priceString;
  });
}

function autowire() {
  document.querySelectorAll('[data-iap-buy]').forEach(el => {
    if (el._iapWired) return; el._iapWired = true;
    el.addEventListener('click', async (ev) => {
      ev.preventDefault();
      el.setAttribute('disabled', '');
      const r = await purchase(el.getAttribute('data-iap-buy'));
      el.removeAttribute('disabled');
      if (r.success) location.reload();
    });
  });
  document.querySelectorAll('[data-iap-restore]').forEach(el => {
    if (el._iapWired) return; el._iapWired = true;
    el.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const ok = await restore();
      alert(ok ? 'Compras restauradas: Portiv Pro activo.' : 'No se encontraron compras activas.');
    });
  });
}

function onChange(cb) {
  if (typeof cb === 'function') { state.listeners.add(cb); cb(state.isPro); }
  return () => state.listeners.delete(cb);
}

// ══════════════════════════════════════════════════════════════════════════════
//  SIGN IN WITH APPLE — NATIVO (dentro de la app, sin navegador externo)
//  · En iOS nativo usa ASAuthorizationController (hoja del sistema + Face ID) vía el
//    plugin @capacitor-community/apple-sign-in → devuelve identityToken (JWT).
//  · index.html toma ese token y lo canjea con Supabase: signInWithIdToken({apple}).
//  · Nonce: se envía el SHA-256(rawNonce) a Apple; el rawNonce va a Supabase, que
//    re-hashea y compara → previene replay. (Patrón oficial Supabase.)
//  · En web NO existe StoreKit/ASAuthorization → PortivAppleAuth.isNative()=false y
//    index.html cae al flujo OAuth de navegador (signInWithOAuth) como antes.
// ══════════════════════════════════════════════════════════════════════════════
const BUNDLE_ID = 'com.portivapp.portafolio';
const SUPABASE_URL_FALLBACK = 'https://zblhifszlhdgkhnymwjh.supabase.co';

function _hex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function _randomNonce() {
  const a = new Uint8Array(32);
  (self.crypto || window.crypto).getRandomValues(a);
  return _hex(a);
}
async function _sha256hex(str) {
  const buf = await (self.crypto || window.crypto).subtle.digest('SHA-256', new TextEncoder().encode(str));
  return _hex(buf);
}

// Devuelve { identityToken, rawNonce, response } o lanza. reason:'cancelled' si el usuario cierra la hoja.
async function appleSignIn() {
  if (!isNative()) { const e = new Error('web'); e.reason = 'web'; throw e; }
  const rawNonce = _randomNonce();
  const hashedNonce = await _sha256hex(rawNonce);
  let res;
  try {
    res = await SignInWithApple.authorize({
      clientId: BUNDLE_ID,                                                   // ignorado en iOS nativo, requerido por el tipo
      redirectURI: `${SUPABASE_URL_FALLBACK}/auth/v1/callback`,              // idem (solo web/android)
      scopes: 'email name',
      nonce: hashedNonce,
    });
  } catch (e) {
    // ASAuthorizationError.canceled = 1001 · el plugin también emite 'ERR_REQUEST_CANCELED'.
    const code = e && (e.code != null ? String(e.code) : '');
    const msg = (e && e.message) || '';
    if (code === '1001' || code === 'ERR_REQUEST_CANCELED' || /cancel/i.test(msg)) {
      const c = new Error('cancelled'); c.reason = 'cancelled'; throw c;
    }
    throw e;
  }
  const identityToken = res && res.response && res.response.identityToken;
  if (!identityToken) { const e = new Error('Apple no devolvió identityToken'); e.reason = 'no-token'; throw e; }
  return { identityToken, rawNonce, response: res.response };
}

window.PortivAppleAuth = { signIn: appleSignIn, isNative };

window.PortivIAP = {
  configure, login, logout, refresh,
  loadOfferings, getPackagesInfo,
  purchase,
  purchaseMonthly: () => purchase('monthly'),
  purchaseAnnual:  () => purchase('annual'),
  restore, presentPaywall, autowire, onChange,
  isPro: () => state.isPro,
  appUserId: () => _idUid,        // para verificar en consola que NO es $RCAnonymousID
  // Diagnóstico rápido en la consola de Safari conectada al dispositivo:
  //   PortivIAP.env()  →  { env:'test', testKey:true, keyPrefix:'test_QuOS…' }
  env: () => ({ env: RC_ENV, testKey: RC_IS_TEST_KEY, keyPrefix: REVENUECAT_IOS_API_KEY.slice(0, 9) + '…' }),
  ENTITLEMENT_ID, OFFERING_ID,
};

// Arranque: configura, carga ofertas y cablea la UI por data-*.
// El login con el usuario de Supabase lo dispara el bloque en index.html.
(async () => {
  try { await configure(); await loadOfferings(); }
  catch (e) { console.warn('[PortivIAP] init', e); }
  // Este bundle se inyecta con `defer`, así que en un arranque en frío con sesión
  // persistida el gate de auth ya corrió y dejó el uid aquí. Sin recogerlo, ese
  // usuario se quedaría anónimo hasta el siguiente login manual.
  try { const pend = window.__pvPendingIapUid; if (pend) login(pend); } catch (e) {}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autowire);
  else autowire();
})();
