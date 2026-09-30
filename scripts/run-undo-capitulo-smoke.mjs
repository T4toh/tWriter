#!/usr/bin/env node
// Smoke runner de withFreshHistory: Ctrl+Z en un capítulo recién abierto no
// puede traer el texto del anterior. Usa ProseMirror puro (@tiptap/pm), sin
// DOM: el estado y el historial se cargan en node sin problema.
// Compila a node_modules/.cache (y no a /tmp) para que `@tiptap/pm` resuelva.
// Uso: node scripts/run-undo-capitulo-smoke.mjs
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cache = join(repo, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outDir = mkdtempSync(join(cache, 'undo-smoke-'));
const r = spawnSync(
  join(repo, 'node_modules', '.bin', 'tsc'),
  ['--target', 'es2022', '--ignoreConfig', '--module', 'commonjs',
    '--strict', '--skipLibCheck', '--outDir', outDir, 'src/app/editor/fresh-history.ts'],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(r.status ?? 1);
}
const req = createRequire(join(outDir, 'x.js'));
const { withFreshHistory } = req(join(outDir, 'fresh-history.js'));
const { Schema } = req('@tiptap/pm/model');
const { EditorState } = req('@tiptap/pm/state');
const { history, undo, undoDepth } = req('@tiptap/pm/history');
rmSync(outDir, { recursive: true, force: true });

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
});
const doc = (t) => schema.node('doc', null, [schema.node('paragraph', null, [schema.text(t)])]);
const undone = (s) => {
  let out = s;
  undo(s, (tr) => { out = s.apply(tr); });
  return out.doc.textContent;
};
// Lo que hace el editor al abrir otro capítulo: setContent sobre el mismo estado.
const openChapter = (s, t) => s.apply(s.tr.replaceWith(0, s.doc.content.size, doc(t).content));

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) { passed += 1; console.log('  ok   —', name); }
  else { failed += 1; console.error('  FAIL —', name); if (info !== undefined) console.error('         ', info); }
}

let s = EditorState.create({ doc: doc('capítulo uno'), plugins: [history()] });
s = s.apply(s.tr.insertText(' editado', s.doc.content.size - 1));

const sinArreglo = openChapter(s, 'capítulo dos');
check('sin el arreglo, Ctrl+Z sale del capítulo abierto (el bug)', undone(sinArreglo) !== 'capítulo dos', undone(sinArreglo));

const abierto = withFreshHistory(openChapter(s, 'capítulo dos'));
check('historial vacío al abrir', undoDepth(abierto) === 0, undoDepth(abierto));
check('Ctrl+Z no trae el capítulo anterior', undone(abierto) === 'capítulo dos', undone(abierto));
check('conserva documento y plugins', abierto.doc.textContent === 'capítulo dos' && abierto.plugins.length === 1);

const editado = abierto.apply(abierto.tr.insertText(' bis', abierto.doc.content.size - 1));
check('una edición en el capítulo nuevo se deshace hasta ahí', undone(editado) === 'capítulo dos', undone(editado));

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
