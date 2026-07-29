#!/usr/bin/env node
// Smoke runner del diccionario de la saga. No es parte del build de Angular.
// Compila los TS necesarios a un dir temporal (CommonJS) y corre las aserciones.
// Uso: node scripts/run-suggest-smoke.mjs
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'suggest-smoke-'));

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
    'src/app/dictionary/suggest.ts',
    'src/app/core/search-highlight.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'dictionary/suggest.js')).href);
const { suggestFromDictionary } = mod;

const DICT = ['Kallai', 'Kállia', 'Bastien', 'Meridian', 'duende', 'Adi'];

const cases = [
  ['Kallay', DICT, undefined, ['Kallai']],
  ['kallia', DICT, undefined, ['Kállia']],
  ['bastien', DICT, undefined, ['Bastien']],
  ['Kalliaa', DICT, 2, ['Kállia', 'Kallai']],
  ['Xdo', DICT, undefined, []],
  ['Meridiam', DICT, undefined, ['Meridian']],
  ['Meridiaan', DICT, undefined, ['Meridian']],
  ['zzzzqqqq', DICT, undefined, []],
  ['Bastien', DICT, undefined, []],
  ['Kalla', DICT, 1, ['Kallai']],
  ['Kallai', [], undefined, []],
  ['', DICT, undefined, []],
];

let passed = 0;
for (const [word, dict, max, expected] of cases) {
  const got = max === undefined ? suggestFromDictionary(word, dict) : suggestFromDictionary(word, dict, max);
  assert.deepStrictEqual(got, expected, `\n  word: ${word}\n  got:  ${JSON.stringify(got)}\n  exp:  ${JSON.stringify(expected)}`);
  passed++;
}

rmSync(outDir, { recursive: true, force: true });
console.log(`suggestFromDictionary: ${passed}/${cases.length} ok`);
