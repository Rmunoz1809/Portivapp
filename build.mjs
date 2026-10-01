// Genera dist/index.html minificado a partir de index.html. El FUENTE queda intacto, con
// todos sus comentarios: son la documentación del proyecto (el 24 % del JS son comentarios,
// ~334 KB, y ahí está la explicación de por qué cada decisión es como es).
//
//   npm i -D esbuild html-minifier-terser
//   npm run build
//
// Qué hace, en orden:
//   1. Recorre el HTML con un tokenizador mínimo (rawBlocks) que localiza los <script> y
//      <style> REALES, y pasa el cuerpo de cada <script> INLINE (los que tienen src se dejan
//      intactos) por esbuild.transform.
//   2. Minifica como CSS el cuerpo de cada <style>.
//   3. Minifica el HTML que queda alrededor.
//   4. Escribe dist/index.html y reporta tamaños crudo y gzip.
//
// POR QUÉ UN TOKENIZADOR Y NO UNA REGEX (bug de sep-2026: «Beneficio por acci\f3n (EPS)»)
// --------------------------------------------------------------------------------------
// Antes los bloques se buscaban con /<style\b[^>]*>([\s\S]*?)<\/style>/ sobre el documento
// entero. Un comentario HTML que MENCIONA una etiqueta —«(estilos en <style id="pvAnalisisCss">)»
// en la pestaña Análisis— abría un «bloque» falso que llegaba hasta el </style> siguiente:
// todo el marcado de la pestaña se minificaba como si fuera CSS, y esbuild (charset ascii por
// defecto) escribía cada letra acentuada como escape CSS: «acción» → «acci\f3n». El navegador
// no interpreta escapes CSS en texto HTML, así que se veían tal cual. Lo mismo pasaría con un
// "<style" o "<script" dentro de un atributo o de una cadena JS. El tokenizador salta
// comentarios, lee los atributos respetando comillas y toma el contenido de <script>/<style>
// hasta su cierre, como hace el navegador. Además esbuild va con charset 'utf8': los acentos
// salen tal cual (el documento declara <meta charset="UTF-8">) y no como \xF3 ni \f3.
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
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { minify as minifyHtml } from 'html-minifier-terser';

const gzip = promisify(zlib.gzip);
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC  = path.join(ROOT, 'index.html');
const OUT  = path.join(ROOT, 'dist', 'index.html');

const kb = n => (n / 1024).toFixed(1) + ' KB';

// Tokenizador HTML mínimo: devuelve los elementos de texto crudo (<script>, <style>,
// <textarea>, <title>) que el NAVEGADOR vería como tales, con la posición de su cuerpo.
//   · <!-- … -->              comentario: se salta entero; lo que mencione dentro no es marcado
//   · <!…>, <?…>, </…>        doctype / cierre: hasta el primer >
//   · <nombre atributos>      apertura: los atributos se leen respetando comillas, así que un
//                             ">" o un "<style" dentro de un valor no cuentan
//   · tras <script>/<style>/<textarea>/<title>, el cuerpo llega hasta el primer </nombre
//     (sin distinguir mayúsculas) seguido de espacio, / o >, como en el navegador.
// textarea y title se recorren sólo para no buscar etiquetas dentro; no se minifican.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const isWs = c => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

export function rawBlocks(html) {
  const n = html.length, out = [];
  const NAME_RE = /[a-zA-Z][^\s/>]*/y;
  let i = 0;
  while (i < n) {
    i = html.indexOf('<', i);
    if (i < 0) break;
    if (html.startsWith('<!--', i)) {
      const e = html.indexOf('-->', i + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const c = html[i + 1];
    if (c === '!' || c === '?' || c === '/') {
      const e = html.indexOf('>', i + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    NAME_RE.lastIndex = i + 1;
    const m = NAME_RE.exec(html);
    if (!m) { i++; continue; }              // un "<" suelto en el texto
    const name = m[0].toLowerCase();
    // Atributos (estados «attribute name / value» del tokenizador HTML).
    let j = i + 1 + m[0].length;
    while (j < n && html[j] !== '>') {
      if (isWs(html[j]) || html[j] === '/') { j++; continue; }
      while (j < n && !isWs(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++;
      while (j < n && isWs(html[j])) j++;
      if (html[j] !== '=') continue;
      j++;
      while (j < n && isWs(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const e = html.indexOf(q, j + 1);
        j = e < 0 ? n : e + 1;
      } else {
        while (j < n && !isWs(html[j]) && html[j] !== '>') j++;
      }
    }
    const openEnd = Math.min(j + 1, n);
    if (!RAW_TEXT.has(name)) { i = openEnd; continue; }
    const END_RE = new RegExp('</' + name + '(?=[\\s/>])', 'ig');
    END_RE.lastIndex = openEnd;
    const em = END_RE.exec(html);
    const bodyEnd = em ? em.index : n;
    const ce = em ? html.indexOf('>', bodyEnd) : -1;
    out.push({
      name,
      attrs: html.slice(i + 1 + m[0].length, j),
      bodyStart: openEnd,
      bodyEnd,
    });
    i = ce < 0 ? n : ce + 1;
  }
  return out;
}

// Sustituye el cuerpo de cada bloque por lo que devuelva `fn` (asíncrona; null = intacto).
async function replaceBlocks(html, blocks, fn) {
  const done = await Promise.all(blocks.map(b => fn(b, html.slice(b.bodyStart, b.bodyEnd))));
  let out = '', last = 0;
  blocks.forEach((b, k) => {
    if (done[k] == null) return;
    out += html.slice(last, b.bodyStart) + done[k];
    last = b.bodyEnd;
  });
  return out + html.slice(last);
}

async function build() {
  const src = await fs.readFile(SRC, 'utf8');
  const srcBytes = Buffer.byteLength(src);

  let jsIn = 0, jsOut = 0, jsBlocks = 0;
  let cssIn = 0, cssOut = 0, cssBlocks = 0;
  const withJs = await replaceBlocks(src, rawBlocks(src), async ({ name, attrs }, code) => {
    if (!code.trim()) return null;
    if (name === 'script') {
      // Los <script src="…"> no tienen cuerpo que minificar; se dejan tal cual.
      if (/\bsrc\s*=/i.test(attrs)) return null;
      // Cualquier type que no sea JS (application/json, text/template…) se deja intacto.
      if (/\btype\s*=\s*["'](?!text\/javascript|application\/javascript|module)/i.test(attrs)) return null;
      jsBlocks++;
      jsIn += Buffer.byteLength(code);
      const r = await esbuild.transform(code, {
        loader: 'js',
        target: 'es2020',
        charset: 'utf8',            // acentos tal cual, no \xF3 (ver la nota de arriba)
        minifyWhitespace: true,
        minifySyntax: true,
        minifyIdentifiers: false,   // ← ver la nota de arriba
        legalComments: 'none',
      });
      jsOut += Buffer.byteLength(r.code);
      return r.code;
    }
    if (name === 'style') {
      cssBlocks++;
      cssIn += Buffer.byteLength(code);
      const r = await esbuild.transform(code, { loader: 'css', minify: true, charset: 'utf8', legalComments: 'none' });
      cssOut += Buffer.byteLength(r.code);
      return r.code;
    }
    return null;                    // <textarea>, <title>: intactos
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

// Sólo construye al ejecutarse directamente (`npm run build`); importado, expone rawBlocks.
// Se comparan rutas reales: con un enlace simbólico de por medio (/tmp → /private/tmp en
// macOS) una comparación literal daría falso y el build no haría nada sin avisar.
let isMain = false;
try { isMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (isMain) build().catch(e => { console.error(e); process.exit(1); });
