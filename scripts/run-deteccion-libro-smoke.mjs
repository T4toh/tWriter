#!/usr/bin/env node
// Smoke runner de detectarEnCapitulo (src/app/revision/deteccion.ts). No es
// parte del build de Angular. Compila los TS necesarios a un dir temporal y
// corre las aserciones.
// Uso: node scripts/run-deteccion-libro-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'deteccion-libro-smoke-'));

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
    'src/app/revision/deteccion.ts',
    'src/app/dialogos/converter.ts',
    'src/app/dialogos/detect.ts',
    'src/app/dialogos/validator.ts',
    'src/app/dialogos/rules-dedicated.ts',
    'src/app/dialogos/tags.ts',
    'src/app/quotes/educate.ts',
    'src/app/repeticiones/detector.ts',
    'src/app/core/types.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { detectarEnCapitulo } = await import(
  pathToFileURL(join(outDir, 'revision/deteccion.js')).href
);
const { EXCEPCIONES_DEFAULT } = await import(
  pathToFileURL(join(outDir, 'repeticiones/detector.js')).href
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

const opts = { excepciones: EXCEPCIONES_DEFAULT, diccionario: [] };

console.log('detectarEnCapitulo');
{
  // Caso del Critical real: diálogo EN con comillas rectas — el converter NO
  // tiene que tocarlo (rayas: 0), educateQuotes sí (comillas > 0).
  const html = '<p>"I don\'t know," she said. "Really."</p>';
  const res = detectarEnCapitulo(html, 'en', opts);
  check('EN con diálogo: rayas gateadas a 0', res.rayas === 0, res);
  check('EN con diálogo: comillas > 0', res.comillas > 0, res);
}
{
  // ES sin convertir: el converter tiene trabajo.
  const html = '<p>"No sé," dijo ella. "De verdad."</p>';
  const res = detectarEnCapitulo(html, 'es', opts);
  check('ES sin convertir: rayas > 0', res.rayas > 0, res);
}
{
  // Sin idioma seteado (null) + contenido en español: `detectLang` decide
  // 'es', así que rayas sigue elegible (no se pierde por no tener el campo).
  const html = '<p>"No sé," dijo ella. "De verdad."</p>';
  const res = detectarEnCapitulo(html, null, opts);
  check('sin idioma seteado + contenido ES: rayas > 0', res.rayas > 0, res);
}
{
  // La otra cara de la moneda del caso anterior: sin idioma seteado (null)
  // pero con contenido en inglés, `detectLang` decide 'en' — rayas tiene que
  // gatearse igual que si `idioma` viniera explícito en 'en'. Este es el caso
  // que destapó la inconsistencia del fix round 1 (rayas gateaba con el campo
  // CRUDO, comillas con el EFECTIVO — acá los dos entran con `idioma` nulo y
  // antes salían clasificados distinto).
  const html = '<p>"I don\'t know," she said. "Really."</p>';
  const res = detectarEnCapitulo(html, null, opts);
  check('sin idioma seteado + contenido EN: rayas gateadas a 0', res.rayas === 0, res);
  check('sin idioma seteado + contenido EN: comillas > 0', res.comillas > 0, res);
}
{
  // ES ya convertido y limpio: nada que hacer.
  const html = '<p>—No sé —dijo ella—. De verdad.</p>';
  const res = detectarEnCapitulo(html, 'es', opts);
  check(
    'ES limpio: los cuatro detectores en 0',
    res.rayas === 0 && res.comillas === 0 && res.arreglosRae === 0 && res.repeticiones === 0,
    res,
  );
}

rmSync(outDir, { recursive: true, force: true });

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
