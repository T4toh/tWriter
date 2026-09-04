#!/usr/bin/env node
// Smoke runner de las fuentes de la app (`src/app/core/app-fonts.ts`).
// No es parte del build de Angular: compila el TS a un dir temporal y corre
// las aserciones. Uso: node scripts/run-app-fonts-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'app-fonts-smoke-'));

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
    'src/app/core/app-fonts.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { APP_FONT_VAR, resolveAppFontStack } = await import(
  pathToFileURL(join(outDir, 'app-fonts.js')).href
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

console.log('resolveAppFontStack');
// El default NO se copia acá: devolver null es lo que le dice al llamador que
// borre la custom property y deje ganar el valor de styles.scss.
check('null → null (gana el default de la app)', resolveAppFontStack('ui', null) === null);
check('string vacío → null', resolveAppFontStack('ui', '') === null);
check('solo espacios → null', resolveAppFontStack('mono', '   ') === null);

{
  const stack = resolveAppFontStack('ui', 'Inter');
  check('familia simple va citada y primera', stack.startsWith("'Inter', "), stack);
  check('fallback del slot ui es sans', stack.includes('sans-serif'), stack);
}
{
  const stack = resolveAppFontStack('ui', 'EB Garamond');
  check('familia con espacios queda citada', stack.startsWith("'EB Garamond', "), stack);
}
{
  const stack = resolveAppFontStack('mono', 'JetBrains Mono');
  check('fallback del slot mono es monospace', stack.includes('ui-monospace'), stack);
}
{
  // Una familia con apóstrofo cerraría la comilla y rompería la declaración
  // entera si no se escapa.
  const stack = resolveAppFontStack('ui', "Bob's Font");
  check('apóstrofo escapado', stack === "'Bob\\'s Font', system-ui, -apple-system, 'Segoe UI', sans-serif", stack);
}
{
  const stack = resolveAppFontStack('ui', '  Inter  ');
  check('recorta espacios de los bordes', stack.startsWith("'Inter', "), stack);
}

console.log('APP_FONT_VAR');
check('ui → --font-ui', APP_FONT_VAR.ui === '--font-ui');
check('mono → --font-mono', APP_FONT_VAR.mono === '--font-mono');

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
