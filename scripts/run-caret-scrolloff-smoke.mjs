#!/usr/bin/env node
// Smoke runner de caret-scrolloff. No es parte del build de Angular.
// Compila el TS necesario a un dir temporal (CommonJS) y corre las aserciones.
// Uso: node scripts/run-caret-scrolloff-smoke.mjs
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'caret-scrolloff-smoke-'));

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
    'src/app/editor/caret-scrolloff.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

// Insets esperados: top/bottom iguales entre threshold y margin (el vertical
// es compartido). En X, threshold sigue en 0 (el punto de disparo no se
// mueve) y margin sigue en 5 (el default histórico de scrollMargin de PM, la
// posición de reposo tampoco se mueve — ver PM_DEFAULT_SCROLL_MARGIN_X).
const thresholdInsets = (v) => ({ top: v, right: 0, bottom: v, left: 0 });
const marginInsets = (v) => ({ top: v, right: 5, bottom: v, left: 5 });
const props = (v) => ({ scrollThreshold: thresholdInsets(v), scrollMargin: marginInsets(v) });

let exitCode = 0;
try {
  const mod = await import(pathToFileURL(join(outDir, 'caret-scrolloff.js')).href);
  const { lineHeightPxFrom, caretScrolloff } = mod;

  // El fallback es 17 * 1.5 = 25.5px (FONT_DEFAULT del settings-service).
  const lineHeightCases = [
    ['px resuelto del editor de capítulos (17 * 1.5)', () => lineHeightPxFrom('25.5px', 17), 25.5],
    ['px resuelto del editor de notas (17 * 1.55)', () => lineHeightPxFrom('26.35px', 17), 26.35],
    ['normal → fallback 1.5', () => lineHeightPxFrom('normal', 17), 25.5],
    ['string vacío → fallback', () => lineHeightPxFrom('', 17), 25.5],
    ['sin unidad px (unitless) → fallback', () => lineHeightPxFrom('1.5', 17), 25.5],
    // fallback con fontSize 20 sería 30 — distingue de un trim roto que dejara pasar el fallback.
    ['con espacios alrededor', () => lineHeightPxFrom('  42px  ', 20), 42],
    // fallback con fontSize NaN sería 25.5 — distingue de que el px resuelto realmente gane.
    ['px válido gana aunque el fontSize sea basura', () => lineHeightPxFrom('30px', Number.NaN), 30],
    ['fontSize inválido con normal → fallback de fuente 17', () => lineHeightPxFrom('normal', 0), 25.5],
    ['0px → el guard > 0 lo rechaza, cae a fallback', () => lineHeightPxFrom('0px', 17), 25.5],
  ];

  const scrolloffCases = [
    ['2 líneas a 17px de fuente', () => caretScrolloff(25.5), props(51)],
    ['2 líneas a 12px (mínimo)', () => caretScrolloff(18), props(36)],
    ['2 líneas a 28px (máximo)', () => caretScrolloff(42), props(84)],
    ['redondea el line-height de notas (26.35 * 2)', () => caretScrolloff(26.35), props(53)],
    ['lines custom', () => caretScrolloff(25.5, 3), props(77)],
    ['line-height NaN → fallback 25.5 * 2', () => caretScrolloff(Number.NaN), props(51)],
    ['line-height negativo → fallback', () => caretScrolloff(-10), props(51)],
    ['line-height 0 → fallback (mismos insets que NaN)', () => caretScrolloff(0), props(51)],
    ['lines 0 → default 2', () => caretScrolloff(25.5, 0), props(51)],
    ['lines negativo → default 2', () => caretScrolloff(25.5, -1), props(51)],
  ];

  let passed = 0;
  for (const [name, run, expected] of lineHeightCases) {
    const got = run();
    assert.deepStrictEqual(got, expected, `\n  case: ${name}\n  got:  ${JSON.stringify(got)}\n  exp:  ${JSON.stringify(expected)}`);
    passed++;
  }
  console.log(`lineHeightPxFrom: ${passed}/${lineHeightCases.length} ok`);

  passed = 0;
  for (const [name, run, expected] of scrolloffCases) {
    const got = run();
    assert.deepStrictEqual(got, expected, `\n  case: ${name}\n  got:  ${JSON.stringify(got)}\n  exp:  ${JSON.stringify(expected)}`);
    // El inset vertical es simétrico y compartido entre threshold y margin.
    assert.strictEqual(got.scrollThreshold.top, got.scrollThreshold.bottom, `threshold.top != threshold.bottom en: ${name}`);
    assert.strictEqual(got.scrollMargin.top, got.scrollMargin.bottom, `margin.top != margin.bottom en: ${name}`);
    assert.strictEqual(got.scrollThreshold.top, got.scrollMargin.top, `el inset vertical difiere entre threshold y margin en: ${name}`);
    // En X, threshold queda en 0 (punto de disparo sin cambios) y margin en 5
    // (default histórico de PM, posición de reposo sin cambios).
    assert.strictEqual(got.scrollThreshold.left, 0, `threshold.left != 0 en: ${name}`);
    assert.strictEqual(got.scrollThreshold.right, 0, `threshold.right != 0 en: ${name}`);
    assert.strictEqual(got.scrollMargin.left, 5, `margin.left != 5 en: ${name}`);
    assert.strictEqual(got.scrollMargin.right, 5, `margin.right != 5 en: ${name}`);
    // Objetos distintos (no alias) — guarda contra "simplificar" a un solo objeto compartido.
    assert.notStrictEqual(got.scrollThreshold, got.scrollMargin, `threshold y margin son el mismo objeto en: ${name}`);
    passed++;
  }
  console.log(`caretScrolloff: ${passed}/${scrolloffCases.length} ok`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

process.exit(exitCode);
