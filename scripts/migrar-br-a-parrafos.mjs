#!/usr/bin/env node
// Migración one-shot del repo de novelas: cada `<br>` dentro de un `<p>` pasa a
// ser corte de párrafo. Los `<br>` los generaba el editor (ver
// `src/app/editor/split-hard-breaks.ts`) y el importer Pandoc pre-2026-05-12;
// hoy ya no entran nuevos. Se corre una vez por repo, con tWriter cerrado.
// Uso: node scripts/migrar-br-a-parrafos.mjs <root-novelas> [--apply]
//      node scripts/migrar-br-a-parrafos.mjs --test
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [root, flag] = process.argv.slice(2);
const apply = flag === '--apply';
const INLINE = /^<(\/?)(em|i|strong|b|u)>$/;

function splitBr(html) {
  // Solo se toca adentro de <p>; fuera de <p> (no debería haber) se deja.
  return html.replace(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/g, (m, attrs = '', inner) => {
    if (!/<br\s*\/?>/i.test(inner)) return m;
    const open = attrs ? `<p${attrs}>` : '<p>';
    const stack = []; // inline abiertos al momento del <br>
    let out = open;
    for (const tok of inner.split(/(<[^>]+>)/)) {
      if (!tok) continue;
      if (/^<br\s*\/?>$/i.test(tok)) {
        out += stack.slice().reverse().map((t) => `</${t}>`).join('') + `</p>${open}` + stack.map((t) => `<${t}>`).join('');
        continue;
      }
      const im = tok.match(INLINE);
      if (im) im[1] ? stack.pop() : stack.push(im[2]);
      out += tok;
    }
    out += '</p>';
    // <br></p> o <p><br> dejan un <p></p> vacío: afuera.
    return out.replace(new RegExp(`${open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(<(?:em|i|strong|b|u)>)*(</(?:em|i|strong|b|u)>)*</p>`, 'g'), '');
  });
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (e.endsWith('.html')) acc.push(p);
  }
  return acc;
}

if (root === '--test') {
  const cases = [
    ['<p>—Foo<br>—Bar<br>—Baz</p>', '<p>—Foo</p><p>—Bar</p><p>—Baz</p>'],
    ['<p>Foo<br></p>', '<p>Foo</p>'],
    ['<p><em>uno<br>dos</em> tres</p>', '<p><em>uno</em></p><p><em>dos</em> tres</p>'],
    ['<p style="text-align: center">a<br>b</p>', '<p style="text-align: center">a</p><p style="text-align: center">b</p>'],
    ['<p>sin br</p><hr class="scene-break"/>', '<p>sin br</p><hr class="scene-break"/>'],
  ];
  let bad = 0;
  for (const [i, e] of cases) { const o = splitBr(i); if (o !== e) { bad++; console.log('FAIL', o); } }
  console.log(bad ? `${bad} FAIL` : `${cases.length} ok`);
  process.exit(bad ? 1 : 0);
}

let files = 0, brs = 0;
for (const f of walk(root)) {
  const src = readFileSync(f, 'utf8');
  const n = (src.match(/<br\s*\/?>/gi) || []).length;
  if (!n) continue;
  const out = splitBr(src);
  const left = (out.match(/<br\s*\/?>/gi) || []).length;
  if (left) console.error(`QUEDAN ${left} <br> fuera de <p>: ${f}`);
  files++; brs += n;
  if (apply) writeFileSync(f, out);
}
console.log(`${apply ? 'APLICADO' : 'DRY-RUN'}: ${files} archivos, ${brs} <br>`);
