/* Portiv · Creadores — código compartido por el dashboard (index.html) y el admin (admin.html).
   Cliente de Supabase con su PROPIA clave de sesión ('pv-creadores-auth'): la web principal de
   Portiv vive en el mismo origen y no debe ver (ni pisar) esta sesión. */
(function () {
  'use strict';

  var SB_URL = 'https://zblhifszlhdgkhnymwjh.supabase.co';
  // Clave anónima pública (la misma PV_SB_ANON de la web principal). No es un secreto: RLS + RPCs.
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpibGhpZnN6bGhkZ2tobnltd2poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNjIzMTgsImV4cCI6MjA5NzczODMxOH0.Oc5gM9b5Bkxm9ef8Nfifz3KOmaDcMThLisfeCQwbiPo';
  var STORAGE_KEY = 'pv-creadores-auth';
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var MIN_PAYOUT = 20; // mínimo de pago mensual (p_min por defecto de creators_month_close)
  var SUPPORT_MAIL = 'rm@portivapp.com';
  var METODOS = { wise: 'Wise', paypal: 'PayPal', usdt: 'USDT', ach: 'ACH' };

  // Un enlace vencido vuelve con #error=...&error_code=otp_expired. Se lee ANTES de crear el
  // cliente, porque supabase-js limpia el hash al iniciar.
  var linkError = (function () {
    try {
      var raw = (location.hash || '').replace(/^#/, '') + '&' + (location.search || '').replace(/^\?/, '');
      var p = new URLSearchParams(raw);
      var code = p.get('error_code') || p.get('error');
      if (!code) return null;
      if (/otp_expired|expired/i.test(code + ' ' + (p.get('error_description') || ''))) {
        return 'El enlace expiró o ya se usó. Pide uno nuevo.';
      }
      return 'No pudimos iniciar sesión con ese enlace. Pide uno nuevo.';
    } catch (e) { return null; }
  })();

  var sb = null;
  try {
    sb = window.supabase.createClient(SB_URL, SB_ANON, {
      auth: {
        storageKey: STORAGE_KEY,
        flowType: 'implicit',
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true
      }
    });
  } catch (e) {
    console.warn('[creadores] no se pudo crear el cliente de Supabase', e);
  }

  // ── Formato ──────────────────────────────────────────────────────
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var nf2 = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var nfInt = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
  var nfPct = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(v) {
    var n = num(v);
    var s = 'US$' + nf2.format(Math.abs(n));
    return n < 0 ? '−' + s : s;
  }
  function int(v) { return nfInt.format(num(v)); }
  function pct(rate) { return nfPct.format(num(rate) * 100) + '%'; }
  function pctNum(rate) { return nfPct.format(num(rate) * 100); }
  function fmtMonth(ym) { // 'YYYY-MM' o 'YYYY-MM-DD' → 'dic 2026'
    var m = /^(\d{4})-(\d{2})/.exec(String(ym || ''));
    if (!m) return String(ym || '');
    return MESES[Number(m[2]) - 1] + ' ' + m[1];
  }
  function fmtDate(v) { // fecha sola o timestamp → '15 dic 2026'
    if (!v) return '';
    var s = String(v);
    var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? null : new Date(s);
    if (!d) { var p = s.split('-'); return Number(p[2]) + ' ' + MESES[Number(p[1]) - 1] + ' ' + p[0]; }
    if (isNaN(d)) return s;
    return d.getDate() + ' ' + MESES[d.getMonth()] + ' ' + d.getFullYear();
  }
  function fmtDateTime(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d)) return String(v);
    var hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return fmtDate(v) + ', ' + hh + ':' + mm;
  }
  function metodo(m) { return m ? (METODOS[m] || m) : '—'; }

  // ── Avisos y portapapeles ────────────────────────────────────────
  var toastEl = null, toastT = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove('on'); }, 1800);
  }
  function copy(text, okMsg) {
    var done = function () { toast(okMsg || 'Copiado'); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('No se pudo copiar'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  }

  // ── Errores ──────────────────────────────────────────────────────
  function errText(e) {
    if (!e) return 'Error desconocido.';
    if (typeof e === 'string') return e;
    return e.message || e.error_description || e.error || e.msg || 'Error desconocido.';
  }
  function isAuthError(e) {
    if (!e) return false;
    var s = String(e.code || '') + ' ' + String(e.message || '');
    return e.status === 401 || /PGRST30[13]|JWT|sin sesión/i.test(s);
  }
  function loginErrorText(e) {
    var code = String((e && (e.code || e.error_code)) || '');
    var msg = String((e && e.message) || '');
    var status = e && e.status;
    if (status === 429 || /rate.?limit|over_email_send|over_request/i.test(code + ' ' + msg) ||
        /security purposes|only request this after/i.test(msg)) {
      var s = /after (\d+) seconds?/i.exec(msg);
      if (s) return 'Por seguridad, espera ' + s[1] + ' segundos antes de pedir otro enlace.';
      return 'Ya enviamos varios correos hace poco. Espera unos minutos y vuelve a intentarlo; revisa también tu carpeta de spam.';
    }
    if (/otp_disabled|signup_disabled|user_not_found/i.test(code) ||
        /signups? not allowed|user not found|not allowed for otp/i.test(msg)) {
      return 'Ese correo no está registrado como creador de Portiv.';
    }
    if (/invalid.*email|email_address_invalid|validation_failed/i.test(code + ' ' + msg)) {
      return 'Revisa el correo: no parece válido.';
    }
    return 'No pudimos enviar el enlace. Intenta de nuevo en unos minutos.';
  }

  async function rpc(name, args) {
    if (!sb) throw new Error('No se pudo conectar con el servidor.');
    var res = args === undefined ? await sb.rpc(name) : await sb.rpc(name, args);
    if (res.error) {
      if (isAuthError(res.error)) { signOut(); }
      throw res.error;
    }
    return res.data;
  }

  // ── Sesión ───────────────────────────────────────────────────────
  var auth = null; // opciones de startAuth
  var currentUid = null;

  function cleanUrl() {
    if (/access_token|error|type=magiclink/.test(location.hash + location.search)) {
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
    }
  }

  function renderLogin(msg, isErr) {
    var root = auth.root;
    auth.setHeader && auth.setHeader(null);
    root.className = '';
    root.innerHTML =
      '<div class="login fade"><div class="card">' +
        '<img class="login-logo" src="../icon.png" alt="Portiv" width="48" height="48">' +
        '<h1>' + esc(auth.title) + '</h1>' +
        '<p class="lead">' + esc(auth.lead) + '</p>' +
        '<form id="loginForm" novalidate>' +
          '<div class="field"><label for="loginEmail">Correo</label>' +
          '<input id="loginEmail" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="tu@correo.com" required></div>' +
          '<button class="btn" type="submit" id="loginBtn">Enviar enlace</button>' +
        '</form>' +
        '<div class="msg" id="loginMsg"' + (msg ? '' : ' hidden') + '>' +
          (msg ? '<div class="note' + (isErr ? ' err' : '') + '">' + esc(msg) + '</div>' : '') +
        '</div>' +
      '</div></div>';
    var form = root.querySelector('#loginForm');
    var input = root.querySelector('#loginEmail');
    var btn = root.querySelector('#loginBtn');
    var box = root.querySelector('#loginMsg');
    try { var last = localStorage.getItem('pv-creadores-last-email'); if (last) input.value = last; } catch (e) {}
    var show = function (html) { box.hidden = !html; box.innerHTML = html || ''; };
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var email = input.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        show('<div class="note err">Escribe un correo válido.</div>');
        input.focus();
        return;
      }
      btn.disabled = true; btn.textContent = 'Enviando…';
      show('');
      try {
        if (!sb) throw new Error('sin cliente');
        var r = await sb.auth.signInWithOtp({
          email: email,
          options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname }
        });
        if (r && r.error) throw r.error;
        try { localStorage.setItem('pv-creadores-last-email', email); } catch (e) {}
        form.hidden = true;
        show('<div class="note ok"><b>Te enviamos un enlace a tu correo.</b><br>Ábrelo en este mismo dispositivo para entrar. Puede tardar un minuto; revisa spam si no lo ves.</div>' +
             '<p class="small" style="margin-top:12px"><button type="button" class="btn-link" id="loginOtro">Usar otro correo</button></p>');
        box.querySelector('#loginOtro').addEventListener('click', function () {
          form.hidden = false; show(''); btn.disabled = false; btn.textContent = 'Enviar enlace'; input.focus();
        });
      } catch (e) {
        show('<div class="note err">' + esc(loginErrorText(e)) + '</div>');
        btn.disabled = false; btn.textContent = 'Enviar enlace';
      }
    });
  }

  function signedIn(session) {
    if (!session || !session.user) return;
    if (currentUid === session.user.id) return;
    currentUid = session.user.id;
    cleanUrl();
    auth.setHeader && auth.setHeader(session.user.email || '');
    auth.onSignedIn(session);
  }

  async function signOut() {
    currentUid = null;
    // scope 'local': cerrar aquí NO debe cerrar la sesión del dueño en la app principal ni en otros equipos.
    try { if (sb) await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    if (auth) renderLogin();
  }

  async function startAuth(opts) {
    auth = opts;
    if (!sb) {
      opts.root.innerHTML = '<div class="login"><div class="note err">No se pudo cargar la conexión con Portiv. Recarga la página.</div></div>';
      return;
    }
    sb.auth.onAuthStateChange(function (ev, session) {
      // No llamar a supabase dentro del callback (puede bloquearse): se difiere.
      setTimeout(function () {
        if (ev === 'SIGNED_OUT') { if (currentUid) { currentUid = null; renderLogin(); } }
        else if (ev === 'SIGNED_IN' && session) { signedIn(session); }
      }, 0);
    });
    var session = null;
    try {
      var r = await sb.auth.getSession();
      session = r && r.data ? r.data.session : null;
    } catch (e) { session = null; }
    if (session) signedIn(session);
    else { cleanUrl(); renderLogin(linkError, true); }
  }

  window.PVC = {
    sb: sb, rpc: rpc, startAuth: startAuth, signOut: signOut,
    esc: esc, money: money, int: int, num: num, pct: pct, pctNum: pctNum,
    fmtMonth: fmtMonth, fmtDate: fmtDate, fmtDateTime: fmtDateTime, metodo: metodo,
    toast: toast, copy: copy, errText: errText, isAuthError: isAuthError,
    MIN_PAYOUT: MIN_PAYOUT, SUPPORT_MAIL: SUPPORT_MAIL, METODOS: METODOS
  };
})();
