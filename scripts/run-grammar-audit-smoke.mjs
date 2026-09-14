#!/usr/bin/env node
// Smoke runner del filtro de la auditoría de gramática: qué matches de LT se
// descartan por el diccionario de la saga antes de listarlos. Es el mismo
// criterio que aplica el editor al capítulo abierto, así que si divergen, el
// panel muestra cosas que el editor no marca (o al revés).
// Uso: node scripts/run-grammar-audit-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'grammar-audit-smoke-'));

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
    '--allowSyntheticDefaultImports',
    '--outDir', outDir,
    'src/app/core/grammar-audit-filter.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'core', 'grammar-audit-filter.js')).href);
const { filtrarMatchesAuditoria } = mod;

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) {
    passed += 1;
    console.log('  ok   —', name);
  } else {
    failed += 1;
    console.error('  FAIL —', name);
    if (info !== undefined) console.error('         ', JSON.stringify(info));
  }
}

function match(plain, word, category, ruleId = 'X') {
  const offset = plain.indexOf(word);
  return { offset, length: word.length, message: '', shortMessage: '', ruleId, category, replacements: [] };
}

console.log('filtrarMatchesAuditoria');
{
  const plain = 'Kallai miró a las Arenas y dijo hola.';
  const dic = ['Kallai', 'Amalut de las Arenas'];

  const typoDic = match(plain, 'Kallai', 'TYPOS');
  check('TYPOS de una palabra del diccionario se descarta',
    filtrarMatchesAuditoria(plain, [typoDic], dic, 'es').length === 0);

  const typoReal = match(plain, 'hola', 'TYPOS');
  check('TYPOS fuera del diccionario queda',
    filtrarMatchesAuditoria(plain, [typoReal], dic, 'es').length === 1);

  const gram = match(plain, 'Kallai', 'GRAMMAR');
  check('no-TYPOS sobre palabra del diccionario queda (el dict solo silencia typos)',
    filtrarMatchesAuditoria(plain, [gram], dic, 'es').length === 1);

  check('mayúsculas no importan para el dict',
    filtrarMatchesAuditoria('kallai vino.', [match('kallai vino.', 'kallai', 'TYPOS')], dic, 'es').length === 0);
}
{
  const plain = 'Amalut de las Arenas llegó.';
  const dic = ['Amalut de las Arenas'];
  const dentro = match(plain, 'las Arenas', 'GRAMMAR', 'AGREEMENT_DET_NOUN');
  check('cualquier categoría adentro de una compuesta se descarta',
    filtrarMatchesAuditoria(plain, [dentro], dic, 'es').length === 0);
  const fuera = match(plain, 'llegó', 'GRAMMAR');
  check('fuera de la compuesta queda',
    filtrarMatchesAuditoria(plain, [fuera], dic, 'es').length === 1);
}
{
  // Flexión: `kallais` (plural) con `Kallai` en el dict, solo si hay idioma.
  const plain = 'Los kallais cantaron.';
  const dic = ['Kallai'];
  const m = match(plain, 'kallais', 'TYPOS');
  check('plural de una palabra del dict se descarta con idioma',
    filtrarMatchesAuditoria(plain, [m], dic, 'es').length === 0);
  check('sin idioma no se pela flexión',
    filtrarMatchesAuditoria(plain, [m], dic, null).length === 1);
}
{
  check('sin diccionario deja todo',
    filtrarMatchesAuditoria('a b', [match('a b', 'a', 'TYPOS')], [], 'es').length === 1);
  check('preserva el orden y los objetos', (() => {
    const plain = 'uno dos';
    const a = match(plain, 'uno', 'GRAMMAR');
    const b = match(plain, 'dos', 'TYPOS');
    const out = filtrarMatchesAuditoria(plain, [a, b], [], 'es');
    return out[0] === a && out[1] === b;
  })());
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
