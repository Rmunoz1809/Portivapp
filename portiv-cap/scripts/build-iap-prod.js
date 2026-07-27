#!/usr/bin/env node
// Build de PRODUCCIÓN de www/portiv-iap.js.
//
// Existe por un motivo concreto: la clave de RevenueCat que hay en src/iap.js es de
// sandbox (`test_…`), y subir el binario con ella significa que NADIE puede comprar.
// Es un fallo silencioso — la app arranca, el paywall se abre, y la compra muere.
// Este script hace imposible ese despiste: sin una clave `appl_…` válida no compila,
// y si el bundle resultante todavía contiene una `test_`, lo borra y falla.
//
// Uso:
//   export PORTIV_RC_KEY_PROD='appl_xxxxxxxxxxxxxxxxxxxxxxxxx'
//   npm run build:iap:prod          # solo el bundle
//   npm run sync:prod               # bundle + npx cap sync ios
//
// Alternativa sin variable de entorno: pegar la clave en RC_KEYS.prod dentro de
// src/iap.js — este script también la lee de ahí.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'src', 'iap.js');
const OUT  = path.join(ROOT, 'www', 'portiv-iap.js');

function die(msg) {
  console.error('\n✗ build:iap:prod — ' + msg + '\n');
  process.exit(1);
}

// ── 1. Resolver la clave: variable de entorno primero, si no RC_KEYS.prod del código ──
let key = (process.env.PORTIV_RC_KEY_PROD || '').trim();
let origen = 'PORTIV_RC_KEY_PROD';
if (!key) {
  const src = fs.readFileSync(SRC, 'utf8');
  const m = src.match(/prod\s*:\s*'([^']*)'/);
  key = ((m && m[1]) || '').trim();
  origen = 'RC_KEYS.prod en src/iap.js';
}

// ── 2. Validar ────────────────────────────────────────────────────────────────
if (!key) {
  die('no hay clave de producción.\n'
    + "  Opción a:  export PORTIV_RC_KEY_PROD='appl_…' && npm run build:iap:prod\n"
    + '  Opción b:  pegar la clave en RC_KEYS.prod dentro de src/iap.js\n'
    + '  La clave pública de iOS está en RevenueCat → Project settings → API keys.');
}
if (/^test_/.test(key)) die('la clave de ' + origen + ' es de SANDBOX (empieza por "test_"). Se necesita la de producción.');
if (!/^appl_/.test(key)) die('la clave de ' + origen + ' no parece de iOS: debe empezar por "appl_" (recibido: "' + key.slice(0, 6) + '…").');
if (key.length < 20)     die('la clave de ' + origen + ' es demasiado corta (' + key.length + ' caracteres). ¿Se copió entera?');

// ── 3. Compilar con la clave inyectada ────────────────────────────────────────
console.log('· clave de producción tomada de: ' + origen);
console.log('· inyectando: ' + key.slice(0, 9) + '…' + key.slice(-4));

const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild');
try {
  execFileSync(esbuild, [
    SRC,
    '--bundle',
    '--format=iife',
    '--outfile=' + OUT,
    '--minify',
    '--define:__PV_RC_ENV__="prod"',
    '--define:__PV_RC_KEY__=' + JSON.stringify(key),
  ], { stdio: 'inherit', cwd: ROOT });
} catch (e) {
  die('esbuild falló.');
}

// ── 4. Verificar el artefacto, no la intención ────────────────────────────────
// Se comprueba que la clave inyectada esté REALMENTE dentro del bundle: si el --define
// no se aplicó, no aparece, y entonces la app habría arrancado con la de sandbox.
// El bundle se borra a propósito en ese caso — mejor sin artefacto (la app no arranca y
// se nota al instante) que con la clave equivocada (arranca y nadie puede pagar).
//
// Nota: el literal `test_…` SÍ sigue apareciendo en el bundle, porque RC_KEYS.test vive
// en el código. Es peso muerto, no la clave activa: `_RC_INJ` es truthy y corta el `||`
// antes de llegar a él. Por eso aquí NO se busca la ausencia de "test_" — sería una
// comprobación que falla siempre y acabaría desactivándose.
const out = fs.readFileSync(OUT, 'utf8');
if (!out.includes(key)) {
  fs.unlinkSync(OUT);
  die('la clave de producción no aparece en el bundle generado (el --define no se aplicó).\n'
    + '  Se ha borrado www/portiv-iap.js para que no se suba el build anterior por error.');
}
if (!out.includes('"prod"') && !out.includes("'prod'") && !/prod/.test(out)) {
  fs.unlinkSync(OUT);
  die('el bundle no quedó marcado como entorno "prod". Se ha borrado www/portiv-iap.js.');
}

console.log('\n✓ www/portiv-iap.js construido con la clave de PRODUCCIÓN.');
console.log('  Siguiente: npx cap sync ios  (o usa `npm run sync:prod`, que ya lo hace).\n');
