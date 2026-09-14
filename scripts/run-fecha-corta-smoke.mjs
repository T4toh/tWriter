#!/usr/bin/env node
// Smoke runner de formatFechaCorta (fecha corta de la landing).
// Uso: node scripts/run-fecha-corta-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'fecha-corta-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  ['--target', 'es2022', '--ignoreConfig', '--module', 'commonjs', '--strict',
   '--skipLibCheck', '--outDir', outDir, 'src/app/shared/fecha-corta.ts'],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(r.status ?? 1);
}

const { formatFechaCorta, isDateFormat } = await import(
  pathToFileURL(join(outDir, 'fecha-corta.js')).href
);

let fails = 0;
function check(nombre, got, want) {
  if (got === want) { console.log(`ok   ${nombre}`); return; }
  fails++;
  console.log(`FAIL ${nombre}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
}

// Hora local a propósito: es lo que ve el autor en la grilla.
const ms = new Date(2026, 8, 4, 15, 30).getTime(); // 4 de septiembre de 2026
check('dmy rellena día y mes', formatFechaCorta(ms, 'dmy'), '04/09/2026');
check('ymd mismo separador, orden invertido', formatFechaCorta(ms, 'ymd'), '2026/09/04');
check('dmy año completo en 2004', formatFechaCorta(new Date(2004, 0, 1).getTime(), 'dmy'), '01/01/2004');
check('ymd fin de año', formatFechaCorta(new Date(2026, 11, 31).getTime(), 'ymd'), '2026/12/31');
check('isDateFormat acepta dmy', isDateFormat('dmy'), true);
check('isDateFormat rechaza basura', isDateFormat('mdy'), false);
check('isDateFormat rechaza undefined', isDateFormat(undefined), false);

rmSync(outDir, { recursive: true, force: true });
if (fails) { console.error(`\n${fails} fallo(s)`); process.exit(1); }
console.log('\nfecha-corta smoke OK');
