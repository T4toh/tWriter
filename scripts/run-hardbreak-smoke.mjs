#!/usr/bin/env node
// Smoke runner de splitHardBreaks (hardBreak → corte de párrafo).
// Compila la mitad pura a un tmpdir y la corre contra un schema mínimo de
// ProseMirror. Uso: node scripts/run-hardbreak-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Schema, DOMSerializer } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'hardbreak-smoke-'));

const r = spawnSync(
  join(repo, 'node_modules', '.bin', 'tsc'),
  [
    '--target', 'es2022', '--ignoreConfig', '--module', 'commonjs',
    '--strict', '--skipLibCheck', '--esModuleInterop', '--outDir', outDir,
    'src/app/editor/split-hard-breaks.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(r.status ?? 1);
}
const { splitHardBreaks } = await import(pathToFileURL(join(outDir, 'split-hard-breaks.js')).href);

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*', group: 'block', attrs: { align: { default: null } },
      toDOM: (n) => ['p', n.attrs.align ? { style: `text-align: ${n.attrs.align}` } : {}, 0],
    },
    blockquote: { content: 'block+', group: 'block', toDOM: () => ['blockquote', 0] },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline', selectable: false, toDOM: () => ['br'] },
  },
  marks: { em: { toDOM: () => ['em', 0] } },
});
const { paragraph: p, blockquote: bq, hardBreak: br, text } = schema.nodes;
const t = (s, marks) => schema.text(s, marks);
const em = schema.marks.em.create();

// Serializar a string sin DOM: recorrido a mano sobre toDOM.
function html(node) {
  if (node.isText) {
    let s = node.text;
    for (const m of node.marks) s = `<em>${s}</em>`;
    return s;
  }
  if (node.type === br) return '<br>';
  const kids = node.content.content.map(html).join('');
  if (node.type === p) return `<p${node.attrs.align ? ` style="text-align: ${node.attrs.align}"` : ''}>${kids}</p>`;
  if (node.type === bq) return `<blockquote>${kids}</blockquote>`;
  return kids;
}
const docHtml = (doc) => doc.content.content.map(html).join('');

let passed = 0, failed = 0;
function check(name, got, want) {
  if (got === want) { passed++; console.log('  ok   —', name); }
  else { failed++; console.error('  FAIL —', name, '\n         got:', got, '\n        want:', want); }
}

function run(doc, cursor) {
  let state = EditorState.create({ doc, selection: cursor != null ? TextSelection.create(doc, cursor) : undefined });
  const tr = splitHardBreaks(state.doc, state.tr);
  if (tr === null) return { state, tr };
  return { state: state.apply(tr), tr };
}

console.log('splitHardBreaks');
{
  const doc = schema.node('doc', null, [p.create(null, [t('—Foo'), br.create(), t('—Bar'), br.create(), t('—Baz')])]);
  check('diálogos pegados con br → tres párrafos', docHtml(run(doc).state.doc), '<p>—Foo</p><p>—Bar</p><p>—Baz</p>');
}
{
  const doc = schema.node('doc', null, [p.create(null, [t('uno', [em]), br.create(), t('dos', [em]), t(' tres')])]);
  check('itálica que cruza el br sigue en los dos lados', docHtml(run(doc).state.doc), '<p><em>uno</em></p><p><em>dos</em> tres</p>');
}
{
  const doc = schema.node('doc', null, [p.create({ align: 'center' }, [t('a'), br.create(), t('b')])]);
  check('atributos del bloque se copian al nuevo', docHtml(run(doc).state.doc), '<p style="text-align: center">a</p><p style="text-align: center">b</p>');
}
{
  const doc = schema.node('doc', null, [bq.create(null, [p.create(null, [t('verso uno'), br.create(), t('verso dos')])])]);
  check('dentro de blockquote: un <p> por verso', docHtml(run(doc).state.doc), '<blockquote><p>verso uno</p><p>verso dos</p></blockquote>');
}
{
  const doc = schema.node('doc', null, [p.create(null, [t('Foo'), br.create()])]);
  check('br al final → párrafo vacío (renglón en blanco, como Enter)', docHtml(run(doc).state.doc), '<p>Foo</p><p></p>');
}
{
  const doc = schema.node('doc', null, [p.create(null, [t('sin br')])]);
  check('sin hardBreak devuelve null', run(doc).tr, null);
}
{
  // Cursor justo después del br (donde queda tras Enter-que-se-volvió-br):
  // tiene que caer al principio del párrafo nuevo, no al final del viejo.
  const doc = schema.node('doc', null, [p.create(null, [t('Hola'), br.create(), t('mundo')])]);
  const { state } = run(doc, 6);
  const $c = state.selection.$from;
  check('cursor cae al inicio del párrafo nuevo', `${$c.index(0)}:${$c.parentOffset}`, '1:0');
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
