// Portiv — Wrapper de RevenueCat (compras in-app) para Capacitor iOS.
// esbuild lo empaqueta → www/portiv-iap.js, que index.html carga con <script>.
// Expone window.PortivIAP: API pequeña y agnóstica de UI que la "pantalla Pro"
// (paywall propio en JS vanilla) puede llamar directamente.

import { Capacitor } from '@capacitor/core';
import { Purchases, LOG_LEVEL, PURCHASES_ERROR_CODE } from '@revenuecat/purchases-capacitor';
import { RevenueCatUI, PAYWALL_RESULT } from '@revenuecat/purchases-capacitor-ui';
import { SignInWithApple } from '@capacitor-community/apple-sign-in';

// ⚠️ CAMBIAR por la API key de iOS de PRODUCCIÓN antes de lanzar al App Store.
const REVENUECAT_IOS_API_KEY = 'test_QuOSkuEiywERIEaFurpQhZlKIoQ';
const ENTITLEMENT_ID = 'Portiv Pro';
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
  try { await Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG }); } catch (e) {}
  await Purchases.configure({ apiKey: REVENUECAT_IOS_API_KEY });
  state.configured = true;
  // Actualizaciones en vivo (renovaciones, cambios desde App Store, restore, etc.)
  try {
    await Purchases.addCustomerInfoUpdateListener((info) => { _setPro(_entActive(info)); });
  } catch (e) {}
  await refresh();
}

// Vincula la compra al usuario de Supabase (app_user_id = user.id, el mismo que ve el webhook).
async function login(appUserId) {
  if (!state.configured) await configure();
  if (!isNative() || !appUserId) return state.isPro;
  try {
    const { customerInfo } = await Purchases.logIn({ appUserID: String(appUserId) });
    _setPro(_entActive(customerInfo));
  } catch (e) { console.warn('[PortivIAP] logIn falló', e); }
  return state.isPro;
}

async function logout() {
  if (!isNative()) { _setPro(false); return; }
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
  ENTITLEMENT_ID, OFFERING_ID,
};

// Arranque: configura, carga ofertas y cablea la UI por data-*.
// El login con el usuario de Supabase lo dispara el bloque en index.html.
(async () => {
  try { await configure(); await loadOfferings(); }
  catch (e) { console.warn('[PortivIAP] init', e); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autowire);
  else autowire();
})();
