#!/usr/bin/env node
// Smoke runner de textoDeFase (texto del toast mientras se genera el EPUB).
// No es parte del build de Angular. Compila el TS a un dir temporal y corre
// las aserciones. Uso: node scripts/run-export-progreso-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'export-progreso-smoke-'));

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
    'src/app/core/export-progreso.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { textoDeFase } = await import(pathToFileURL(join(outDir, 'export-progreso.js')).href);

const casos = [
  [{ fase: 'Leyendo capítulos', hecho: 0, total: 0 }, 'Leyendo capítulos…',
    'fase sin conteo: solo el texto'],
  [{ fase: 'Escribiendo capítulos', hecho: 0, total: 12 }, 'Escribiendo capítulos (1 de 12)',
    'primer capítulo: 1 de 12, no 0 de 12'],
  [{ fase: 'Escribiendo capítulos', hecho: 11, total: 12 }, 'Escribiendo capítulos (12 de 12)',
    'último capítulo: llega justo a total'],
  [{ fase: 'Escribiendo capítulos', hecho: 0, total: 1 }, 'Escribiendo capítulos (1 de 1)',
    'libro de un solo capítulo'],
  [{ fase: 'Armando índice y empaquetando', hecho: 0, total: 0 }, 'Armando índice y empaquetando…',
    'fase final sin conteo'],
];
let fallos = 0;
for (const [payload, esperado, desc] of casos) {
  const got = textoDeFase(payload);
  if (got !== esperado) { fallos += 1; console.error(`FALLA ${desc}: "${got}" != "${esperado}"`); }
}
console.log(fallos === 0 ? `${casos.length} casos OK` : `${fallos} fallas`);

rmSync(outDir, { recursive: true, force: true });
process.exit(fallos === 0 ? 0 : 1);
