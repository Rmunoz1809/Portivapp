#!/usr/bin/env node
/* Genera el CLIENT SECRET (JWT ES256) para "Sign in with Apple" web / Supabase.
 * Reutilizable: el secret de Apple caduca máx 6 meses -> vuelve a correr esto.
 * NO toca nada de pagos. Solo firma un JWT con tu llave .p8 de Sign in with Apple.
 *
 * Uso:  node apple-oauth-secret.js <SERVICES_ID>
 *   ej: node apple-oauth-secret.js com.portivapp.signin
 */
const crypto = require('crypto');
const fs = require('fs');

const TEAM_ID     = 'K97579JSV7';                         // Apple Developer Team ID
const KEY_ID      = 'TCSNW57DCG';                          // Key ID de la llave Sign in with Apple
const P8_PATH     = '/Users/rafael/Downloads/AuthKey_TCSNW57DCG.p8';
const SERVICES_ID = process.argv[2] || 'com.portivapp.signin'; // == sub del JWT == Client ID en Supabase (web)

const b64u = (b) => Buffer.from(b).toString('base64url');
const now  = Math.floor(Date.now() / 1000);
const header  = { alg: 'ES256', kid: KEY_ID };
const payload = {
  iss: TEAM_ID,
  iat: now,
  exp: now + 15552000,            // 180 días (máximo permitido por Apple)
  aud: 'https://appleid.apple.com',
  sub: SERVICES_ID,
};
const data = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(payload));
const key  = crypto.createPrivateKey(fs.readFileSync(P8_PATH));
const sig  = crypto.sign('SHA256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
const jwt  = data + '.' + sig.toString('base64url');

const exp = new Date((now + 15552000) * 1000).toISOString().slice(0, 10);
process.stderr.write(`Services ID (Client ID en Supabase): ${SERVICES_ID}\ncaduca: ${exp}\n\nCLIENT SECRET (pega esto en Supabase > Apple > Secret Key):\n`);
process.stdout.write(jwt + '\n');
