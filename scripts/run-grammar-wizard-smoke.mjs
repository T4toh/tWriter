#!/usr/bin/env node
// Smoke runner del recorrido de gramática uno por uno («Revisar»). No es parte
// del build de Angular. Compila el TS a un dir temporal y corre las aserciones.
// Uso: node scripts/run-grammar-wizard-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'grammar-wizard-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022',
    '--ignoreConfig',
    '--module', 'commonjs',
    '--strict',
    '--skipLibCheck',
    '--outDir', outDir,
    'src/app/editor/grammar-wizard.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { nextReviewMatch, reviewPosition } = await import(
  pathToFileURL(join(outDir, 'grammar-wizard.js')).href
);

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

const m = (id, from, to = from + 3) => ({ id, from, to });
// Desordenados a propósito: el orden lo pone la función, no el que llama.
const lista = [m('c', 40), m('a', 5), m('b', 20), m('d', 20, 21)];
const nada = new Set();

console.log('nextReviewMatch');
check('arranca por el primero del doc', nextReviewMatch(lista, 0, nada)?.id === 'a');
check('desde incluido: el match que empieza ahí cuenta', nextReviewMatch(lista, 5, nada)?.id === 'a');
check('a igual from, el más corto primero', nextReviewMatch(lista, 6, nada)?.id === 'd');
check('saltea los salteados', nextReviewMatch(lista, 6, new Set(['d']))?.id === 'b');
check('después del último vuelve al principio', nextReviewMatch(lista, 41, nada)?.id === 'a');
check('al volver al principio también saltea', nextReviewMatch(lista, 41, new Set(['a']))?.id === 'd');
check('todos salteados → null', nextReviewMatch(lista, 0, new Set(['a', 'b', 'c', 'd'])) === null);
check('lista vacía → null', nextReviewMatch([], 0, nada) === null);
check('no reordena la lista que recibe', lista[0].id === 'c');

console.log('reviewPosition');
{
  const p = reviewPosition(lista, 'b');
  check('posición en orden de lectura', p?.n === 3 && p?.total === 4, p);
  check('id que no está → null', reviewPosition(lista, 'zz') === null);
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
