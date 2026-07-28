// Genera dist/index.html minificado a partir de index.html. El FUENTE queda intacto, con
// todos sus comentarios: son la documentación del proyecto (el 24 % del JS son comentarios,
// ~334 KB, y ahí está la explicación de por qué cada decisión es como es).
//
//   npm i -D esbuild html-minifier-terser
//   npm run build
//
// Qué hace, en orden:
//   1. Extrae cada bloque <script> INLINE (los que tienen src se dejan intactos) y lo pasa
//      por esbuild.transform.
//   2. Extrae cada bloque <style> y lo minifica como CSS.
//   3. Minifica el HTML que queda alrededor.
//   4. Escribe dist/index.html y reporta tamaños crudo y gzip.
//
// DECISIÓN IMPORTANTE — minifyIdentifiers: false
// -----------------------------------------------
// Portiv es un monolito con 17 bloques <script> separados que comparten globales por el
// objeto window implícito, y con manejadores inline en el HTML (onclick="_authSignin()",
// onmouseenter="_prefetchOutlookEvent(...)", …). Renombrar identificadores de nivel superior
// rompería esas referencias cruzadas de formas que no aparecen hasta que un usuario pulsa el
// botón concreto. Se renuncia a ese porcentaje de compresión a cambio de una minificación
// que no puede romper nada: el grueso del ahorro son los comentarios y los espacios, y esos
// sí se van. Si algún día el monolito se parte en módulos, se puede reactivar.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';
import { minify as minifyHtml } from 'html-minifier-terser';

const gzip = promisify(zlib.gzip);
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC  = path.join(ROOT, 'index.html');
const OUT  = path.join(ROOT, 'dist', 'index.html');

const kb = n => (n / 1024).toFixed(1) + ' KB';

// Reemplaza cada coincidencia de `re` usando un reemplazador ASÍNCRONO.
async function replaceAsync(str, re, fn) {
  const jobs = [];
  str.replace(re, (...args) => { jobs.push(fn(...args)); return ''; });
  const done = await Promise.all(jobs);
  let i = 0;
  return str.replace(re, () => done[i++]);
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE_RE  = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;

async function build() {
  const src = await fs.readFile(SRC, 'utf8');
  const srcBytes = Buffer.byteLength(src);

  let jsIn = 0, jsOut = 0, jsBlocks = 0;
  let withJs = await replaceAsync(src, SCRIPT_RE, async (full, attrs, code) => {
    // Los <script src="…"> no tienen cuerpo que minificar; se dejan tal cual.
    if (/\bsrc\s*=/i.test(attrs)) return full;
    // Cualquier type que no sea JS (application/json, text/template…) se deja intacto.
    if (/\btype\s*=\s*["'](?!text\/javascript|application\/javascript|module)/i.test(attrs)) return full;
    if (!code.trim()) return full;
    jsBlocks++;
    jsIn += Buffer.byteLength(code);
    const r = await esbuild.transform(code, {
      loader: 'js',
      target: 'es2020',
      minifyWhitespace: true,
      minifySyntax: true,
      minifyIdentifiers: false,   // ← ver la nota de arriba
      legalComments: 'none',
    });
    jsOut += Buffer.byteLength(r.code);
    return `<script${attrs}>${r.code}</script>`;
  });

  let cssIn = 0, cssOut = 0, cssBlocks = 0;
  withJs = await replaceAsync(withJs, STYLE_RE, async (full, attrs, code) => {
    if (!code.trim()) return full;
    cssBlocks++;
    cssIn += Buffer.byteLength(code);
    const r = await esbuild.transform(code, { loader: 'css', minify: true, legalComments: 'none' });
    cssOut += Buffer.byteLength(r.code);
    return `<style${attrs}>${r.code}</style>`;
  });

  // El JS y el CSS ya están minificados arriba → aquí NO se vuelven a tocar (minifyJS/minifyCSS
  // en false). `conservativeCollapse` colapsa los espacios a UNO en vez de eliminarlos: en un
  // documento con texto suelto entre etiquetas inline, quitarlos del todo puede pegar palabras.
  const out = await minifyHtml(withJs, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    minifyJS: false,
    minifyCSS: false,
    caseSensitive: true,
    keepClosingSlash: true,
    removeAttributeQuotes: false,
    removeRedundantAttributes: false,
  });

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, out, 'utf8');

  // El HTML referencia fonts/fonts.css y los woff2 del preload → dist/ tiene que ser
  // servible por sí solo, o al abrirlo se cae a las fuentes del sistema y no se puede
  // verificar de verdad antes de desplegar.
  try {
    await fs.cp(path.join(ROOT, 'fonts'), path.join(ROOT, 'dist', 'fonts'), { recursive: true });
  } catch (e) { console.warn('  ! no se pudo copiar fonts/:', e.message); }

  const outBytes = Buffer.byteLength(out);
  const [gzSrc, gzOut] = await Promise.all([gzip(src), gzip(out)]);

  console.log(`  JS   : ${jsBlocks} bloques · ${kb(jsIn)} → ${kb(jsOut)}`);
  console.log(`  CSS  : ${cssBlocks} bloques · ${kb(cssIn)} → ${kb(cssOut)}`);
  console.log(`  HTML : ${kb(srcBytes)} → ${kb(outBytes)}  (−${(100 - outBytes / srcBytes * 100).toFixed(1)} %)`);
  console.log(`  gzip : ${kb(gzSrc.length)} → ${kb(gzOut.length)}  (−${(100 - gzOut.length / gzSrc.length * 100).toFixed(1)} %)`);
  console.log(`  → ${path.relative(ROOT, OUT)}`);
}

build().catch(e => { console.error(e); process.exit(1); });
