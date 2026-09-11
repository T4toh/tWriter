#!/usr/bin/env node
// Smoke runner de `capitulosPorDefecto` (export/muestra.ts): cuántos capítulos
// entran en la muestra por defecto. Mismo patrón que run-rae-smoke.mjs.
// Uso: node scripts/run-muestra-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'muestra-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--strict',
    '--skipLibCheck',
    '--outDir', outDir,
    'src/app/export/muestra.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { capitulosPorDefecto } = await import(pathToFileURL(join(outDir, 'muestra.js')).href);

let failed = 0;
function check(name, got, want) {
  if (got === want) {
    console.log('  ok   —', name);
  } else {
    failed += 1;
    console.error('  FAIL —', name, `got=${got} want=${want}`);
  }
}

console.log('capitulosPorDefecto');
check('sin capítulos → 1', capitulosPorDefecto([]), 1);
check('todo en cero → 1', capitulosPorDefecto([0, 0, 0]), 1);
check('10 iguales → 1 (el primero ya es el 10 %)', capitulosPorDefecto(Array(10).fill(1000)), 1);
check('20 iguales → 2', capitulosPorDefecto(Array(20).fill(1000)), 2);
check('primero corto, segundo largo → 2', capitulosPorDefecto([100, 5000, 5000, 5000]), 2);
check('un solo capítulo → 1', capitulosPorDefecto([4000]), 1);
check('nunca pasa el total', capitulosPorDefecto([1, 1, 1]), 1);

rmSync(outDir, { recursive: true, force: true });
if (failed > 0) process.exit(1);
