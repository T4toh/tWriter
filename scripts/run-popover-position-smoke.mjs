#!/usr/bin/env node
// Smoke runner de popover-position. No es parte del build de Angular.
// Compila el TS necesario a un dir temporal (CommonJS) y corre las aserciones.
// Uso: node scripts/run-popover-position-smoke.mjs
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'popover-position-smoke-'));

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
    'src/app/editor/popover-position.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

let exitCode = 0;
try {
  const mod = await import(pathToFileURL(join(outDir, 'popover-position.js')).href);
  const { placePopover } = mod;

  const VIEWPORT = { width: 1000, height: 800 };
  const SMALL = { width: 1000, height: 300 };
  const NARROW = { width: 200, height: 800 };
  const SIZE = { width: 320, height: 200 };

  const cases = [
    ['abre abajo', () => placePopover({ left: 100, top: 100, bottom: 120 }, SIZE, VIEWPORT), { x: 100, y: 126, placement: 'below', maxHeight: 200 }],
    ['flipea arriba', () => placePopover({ left: 100, top: 650, bottom: 700 }, SIZE, VIEWPORT), { x: 100, y: 444, placement: 'above', maxHeight: 200 }],
    ['no entra en ningún lado → below con altura limitada', () => placePopover({ left: 100, top: 140, bottom: 160 }, SIZE, SMALL), { x: 100, y: 166, placement: 'below', maxHeight: 126 }],
    ['entra completo arriba (viewport chico)', () => placePopover({ left: 100, top: 250, bottom: 280 }, SIZE, SMALL), { x: 100, y: 44, placement: 'above', maxHeight: 200 }],
    ['clamp derecho', () => placePopover({ left: 950, top: 100, bottom: 120 }, SIZE, VIEWPORT), { x: 672, y: 126, placement: 'below', maxHeight: 200 }],
    ['clamp izquierdo', () => placePopover({ left: -50, top: 100, bottom: 120 }, SIZE, VIEWPORT), { x: 8, y: 126, placement: 'below', maxHeight: 200 }],
    ['viewport angosto', () => placePopover({ left: 40, top: 100, bottom: 120 }, SIZE, NARROW), { x: 8, y: 126, placement: 'below', maxHeight: 200 }],
    ['gap y margin custom', () => placePopover({ left: 100, top: 100, bottom: 120 }, SIZE, VIEWPORT, 20, 40), { x: 100, y: 140, placement: 'below', maxHeight: 200 }],
    ['no entra en ningún lado → gana arriba con altura limitada', () => placePopover({ left: 100, top: 200, bottom: 210 }, SIZE, SMALL), { x: 100, y: 8, placement: 'above', maxHeight: 186 }],
  ];

  let passed = 0;
  for (const [name, run, expected] of cases) {
    const got = run();
    assert.deepStrictEqual(got, expected, `\n  case: ${name}\n  got:  ${JSON.stringify(got)}\n  exp:  ${JSON.stringify(expected)}`);
    passed++;
  }
  console.log(`placePopover: ${passed}/${cases.length} ok`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

process.exit(exitCode);
