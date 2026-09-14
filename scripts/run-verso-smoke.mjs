#!/usr/bin/env node
// Smoke runner de toggleVerso (bloque de verso siempre único, sin anidar ni
// duplicar hermanos). Compila la mitad pura a node_modules/.cache —no a un
// tmpdir— porque importa `@tiptap/pm/transform` en runtime y node lo tiene que
// resolver subiendo hasta node_modules. Uso: node scripts/run-verso-smoke.mjs
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = join(repo, 'node_modules', '.cache', 'verso-smoke');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const r = spawnSync(
  join(repo, 'node_modules', '.bin', 'tsc'),
  [
    '--target', 'es2022', '--module', 'commonjs', '--moduleResolution', 'node',
    '--strict', '--skipLibCheck', '--esModuleInterop', '--outDir', outDir,
    'src/app/editor/verso.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(r.status ?? 1);
}
const { toggleVerso } = await import(pathToFileURL(join(outDir, 'verso.js')).href);

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    blockquote: { content: 'block+', group: 'block' },
    text: { group: 'inline' },
  },
});
const { paragraph: p, blockquote: bq } = schema.nodes;
const t = (s) => schema.text(s);

function html(node) {
  if (node.isText) return node.text;
  const kids = node.content.content.map(html).join('');
  if (node.type === p) return `<p>${kids}</p>`;
  if (node.type === bq) return `<blockquote>${kids}</blockquote>`;
  return kids;
}
const docHtml = (doc) => doc.content.content.map(html).join('');

let passed = 0, failed = 0;
function check(name, got, want) {
  if (got === want) { passed++; console.log('  ok   —', name); }
  else { failed++; console.error('  FAIL —', name, '\n         got:', got, '\n        want:', want); }
}

// `from`/`to` son posiciones de ProseMirror: doc abre en 0, cada <p> suma 1 al
// abrir y 1 al cerrar, cada carácter 1, cada <blockquote> 1 y 1.
function run(doc, from, to = from) {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
  const tr = toggleVerso(state.tr, bq);
  return tr ? docHtml(state.apply(tr).doc) : null;
}
const P = (s) => p.create(null, [t(s)]);
const BQ = (...ps) => bq.create(null, ps);
const D = (...ns) => schema.node('doc', null, ns);

console.log('toggleVerso');
check('párrafo suelto → se envuelve',
  run(D(P('aa'), P('bb')), 2), '<blockquote><p>aa</p></blockquote><p>bb</p>');
check('cursor adentro de un bloque → se desenvuelve',
  run(D(BQ(P('aa'))), 3), '<p>aa</p>');
check('párrafo del medio de un bloque → sale y parte el bloque',
  run(D(BQ(P('aa'), P('bb'), P('cc'))), 7),
  '<blockquote><p>aa</p></blockquote><p>bb</p><blockquote><p>cc</p></blockquote>');
check('selección que arranca en un bloque y sigue afuera → un solo bloque',
  run(D(BQ(P('aa')), P('bb')), 3, 8), '<blockquote><p>aa</p><p>bb</p></blockquote>');
check('párrafo pegado debajo de un bloque → se funde con el de arriba',
  run(D(BQ(P('aa')), P('bb')), 8), '<blockquote><p>aa</p><p>bb</p></blockquote>');
check('párrafo pegado encima de un bloque → se funde con el de abajo',
  run(D(P('aa'), BQ(P('bb'))), 2), '<blockquote><p>aa</p><p>bb</p></blockquote>');
check('párrafo entre dos bloques → los tres se funden',
  run(D(BQ(P('aa')), P('bb'), BQ(P('cc'))), 8),
  '<blockquote><p>aa</p><p>bb</p><p>cc</p></blockquote>');
check('selección que cubre dos bloques y la prosa del medio → uno solo',
  run(D(BQ(P('aa')), P('bb'), BQ(P('cc'))), 3, 13),
  '<blockquote><p>aa</p><p>bb</p><p>cc</p></blockquote>');
check('párrafo suelto lejos de un bloque → no lo toca',
  run(D(BQ(P('aa')), P('bb'), P('cc')), 12),
  '<blockquote><p>aa</p></blockquote><p>bb</p><blockquote><p>cc</p></blockquote>');

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
