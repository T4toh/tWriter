#!/usr/bin/env node
// Smoke runner de note-blocks (markdown <-> bloques). No es parte del build de Angular.
// Compila el TS a un dir temporal y corre las aserciones.
// Uso: node scripts/run-note-blocks-smoke.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'note-blocks-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--outDir', outDir,
    'src/app/shared/note-blocks.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'note-blocks.js')).href);
const { markdownABloques, bloquesAMarkdown, bloqueVacio } = mod;

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) {
    passed += 1;
    console.log('  ok   —', name);
  } else {
    failed += 1;
    console.error('  FAIL —', name);
    if (info !== undefined) console.error('         ', info);
  }
}
const tipos = (bs) => bs.map((b) => b.tipo).join(',');

console.log('markdownABloques — headings');
{
  const bs = markdownABloques('# Aedan\n\n## Raza\n- Humano\n');
  check('h1 + h2 + lista', tipos(bs) === 'h1,h2,lista', tipos(bs));
  check('el h1 guarda el título', bs[0].texto === 'Aedan', bs[0].texto);
  check('la lista guarda el item', bs[2].items.length === 1 && bs[2].items[0] === 'Humano', JSON.stringify(bs[2]));
}
{
  const bs = markdownABloques('### Muy anidado\n');
  check('###+ colapsa a h2', tipos(bs) === 'h2,parrafo', tipos(bs));
}

console.log('markdownABloques — párrafo implícito');
{
  const bs = markdownABloques('## Descripción\n\n## Objetos\n-\n');
  check('heading sin nada abajo genera parrafo vacío', tipos(bs) === 'h2,parrafo,h2,lista', tipos(bs));
  check('el parrafo implícito viene vacío', bs[1].texto === '', JSON.stringify(bs[1]));
  check('el heading con bullet NO genera parrafo', bs[3].items.length === 1 && bs[3].items[0] === '', JSON.stringify(bs[3]));
}

console.log('markdownABloques — prosa y bullets');
{
  const bs = markdownABloques('Islota en el mar del norte. \\\nLugar natal de los humanos.\n');
  check('líneas seguidas quedan en UN parrafo', tipos(bs) === 'parrafo', tipos(bs));
  check('el salto duro sobrevive', bs[0].texto.includes('\\\n'), JSON.stringify(bs[0].texto));
}
{
  const bs = markdownABloques('- uno\n* dos\n+ tres\n');
  check('-, * y + entran a la misma lista', tipos(bs) === 'lista' && bs[0].items.length === 3, JSON.stringify(bs));
}
{
  const bs = markdownABloques('- Humano\n\nProsa aparte\n');
  check('línea vacía corta la lista', tipos(bs) === 'lista,parrafo', tipos(bs));
}
{
  const bs = markdownABloques('---\n');
  check('--- no es bullet', tipos(bs) === 'parrafo', tipos(bs));
}
{
  const bs = markdownABloques('');
  check('markdown vacío → sin bloques', bs.length === 0, JSON.stringify(bs));
}

console.log('bloquesAMarkdown — modo nota');
{
  const bs = [
    { tipo: 'h2', texto: 'Raza', items: [] },
    { tipo: 'lista', texto: '', items: ['Humano', '  ', ''] },
    { tipo: 'h2', texto: 'Objetos', items: [] },
    { tipo: 'lista', texto: '', items: ['', ''] },
    { tipo: 'parrafo', texto: '', items: [] },
  ];
  const md = bloquesAMarkdown(bs);
  check('descarta items vacíos', md.includes('- Humano') && !md.includes('- \n'), JSON.stringify(md));
  check('descarta la lista entera si quedó vacía', !md.includes('Objetos'), JSON.stringify(md));
  check('descarta el parrafo vacío', md.trim().split('\n').length === 2, JSON.stringify(md));
  check('termina en newline', md.endsWith('\n'), JSON.stringify(md));
}
{
  check('sin bloques con contenido → string vacío', bloquesAMarkdown([{ tipo: 'parrafo', texto: '', items: [] }]) === '');
}

console.log('bloquesAMarkdown — modo plantilla');
{
  const bs = markdownABloques('## Descripción\n\n## Atajos\n- ¡Fuego!\n');
  const tpl = bloquesAMarkdown(bs, { plantilla: true });
  check('la plantilla no lleva contenido', !tpl.includes('¡Fuego!'), JSON.stringify(tpl));
  check('la plantilla conserva un bullet vacío', tpl.includes('\n-'), JSON.stringify(tpl));
  const back = markdownABloques(tpl);
  check('round-trip: mismos tipos', tipos(back) === tipos(bs), `${tipos(back)} vs ${tipos(bs)}`);
  check('round-trip: mismos títulos', back[0].texto === 'Descripción' && back[2].texto === 'Atajos', JSON.stringify(back));
  const back2 = markdownABloques(bloquesAMarkdown(back, { plantilla: true }));
  check('round-trip estable en la segunda vuelta', tipos(back2) === tipos(back), `${tipos(back2)} vs ${tipos(back)}`);
}

console.log('round-trip — párrafos adyacentes');
{
  const md1 = '## Descripción\n\nUno.\n\nDos.\n';
  const bs1 = markdownABloques(md1);
  check('parsea dos párrafos', tipos(bs1) === 'h2,parrafo,parrafo', tipos(bs1));
  const md2 = bloquesAMarkdown(bs1);
  const bs2 = markdownABloques(md2);
  check('round-trip preserva dos párrafos', tipos(bs2) === tipos(bs1), `${tipos(bs2)} vs ${tipos(bs1)}`);
  check('round-trip preserva el contenido', bs2[1].texto === 'Uno.' && bs2[2].texto === 'Dos.', JSON.stringify(bs2.slice(1)));
}

console.log('round-trip — listas adyacentes');
{
  const md1 = '- a\n\n- b\n';
  const bs1 = markdownABloques(md1);
  check('parsea dos listas', tipos(bs1) === 'lista,lista', tipos(bs1));
  const md2 = bloquesAMarkdown(bs1);
  const bs2 = markdownABloques(md2);
  check('round-trip preserva dos listas', tipos(bs2) === tipos(bs1), `${tipos(bs2)} vs ${tipos(bs1)}`);
  check('round-trip preserva items', bs2[0].items[0] === 'a' && bs2[1].items[0] === 'b', JSON.stringify(bs2));
}

console.log('bloqueVacio');
{
  const l = bloqueVacio('lista');
  check('lista arranca con un item vacío', l.items.length === 1 && l.items[0] === '', JSON.stringify(l));
  check('h2 arranca sin items', bloqueVacio('h2').items.length === 0);
}

console.log('');
console.log(`${passed} ok, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
