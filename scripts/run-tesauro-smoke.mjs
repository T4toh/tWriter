#!/usr/bin/env node
// Smoke runner de palabraEn (tesauro bajo demanda). No es parte del build de
// Angular. Compila el TS necesario a un dir temporal y corre las aserciones.
// Uso: node scripts/run-tesauro-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'tesauro-smoke-'));

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
    'src/app/editor/palabra-en.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'palabra-en.js')).href);
const { palabraEn } = mod;

const casos = [
  ['la nave oscura', 5, [3, 7], 'cursor adentro de la palabra'],
  ['la nave oscura', 3, [3, 7], 'cursor pegado al inicio'],
  ['la nave oscura', 7, [3, 7], 'cursor pegado al final'],
  ['la  nave oscura', 3, null, 'cursor entre dos espacios'],
  ['el navío ancló', 4, [3, 8], 'palabra acentuada'],
  ['la niña rió', 4, [3, 7], 'eñe'],
  ['—Perdón —dijo', 3, [1, 7], 'raya de diálogo no es parte de la palabra'],
  ['fin', 3, [0, 3], 'final del texto'],
  ['', 0, null, 'texto vacío'],
  ['la nave oscura', 2, [0, 2], 'cursor pegado al final de la primera palabra: agarra esa, no la siguiente'],
];
let fallos = 0;
for (const [texto, offset, esperado, desc] of casos) {
  const r = palabraEn(texto, offset);
  const got = r ? [r.inicio, r.fin] : null;
  const ok = JSON.stringify(got) === JSON.stringify(esperado);
  if (!ok) { fallos += 1; console.error(`FALLA ${desc}: ${JSON.stringify(got)} != ${JSON.stringify(esperado)}`); }
}
console.log(fallos === 0 ? `${casos.length} casos OK` : `${fallos} fallas`);

rmSync(outDir, { recursive: true, force: true });
process.exit(fallos === 0 ? 0 : 1);
