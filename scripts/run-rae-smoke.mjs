#!/usr/bin/env node
// Smoke runner del validador RAE. No es parte del build de Angular.
// Compila los TS necesarios a un dir temporal y corre las aserciones.
// Uso: node scripts/run-rae-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'rae-smoke-'));

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
    'src/app/dialogos/validator.ts',
    'src/app/dialogos/rules-dedicated.ts',
    'src/app/dialogos/converter.ts',
    'src/app/dialogos/tags.ts',
    'src/app/core/types.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'dialogos/validator.js')).href);
const { validateRae, htmlToPlain } = mod;

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

console.log('validateRae');
{
  const plain = '—Bastien va a completar tu morral más tarde. Te espero afuera, hermoso.';
  const v = validateRae(plain, 'es');
  check('diálogo simple sin inciso → sin violaciones', v.length === 0, v);
}
{
  // Solo dispara si el verbo está después de sentence boundary (.?!…) —
  // verbos mid-content no son dicendi-tags (ej. `—Así le dicen al oro.`).
  const v = validateRae('—¿Nervioso? Preguntó su hermana.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('verbo dicendi post-? sin raya → dash-orphan', orphan !== undefined, v);
}
{
  const v = validateRae('—Así le dicen al oro, Adi. Después te explico.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('verbo regular mid-content NO dispara dash-orphan', orphan === undefined, v);
}
{
  const v = validateRae('"Hola" dijo Juan.', 'es');
  const p = v.find((x) => x.ruleId === 'pending-conversion');
  check('comillas con verbo dicendi → pending-conversion', p !== undefined, v);
  check('autoFix contiene raya', p?.autoFix?.replacement.includes('—Hola') === true, p?.autoFix);
}
{
  const v = validateRae('-Hola, dijo.', 'es');
  const s = v.find((x) => x.ruleId === 'dash-short');
  check('guion corto → dash-short', s !== undefined, v);
  check('autoFix = em-dash', s?.autoFix?.replacement === '—', s?.autoFix);
}
{
  // Necesita ≥3 verbos dicendi distintos por la salvaguarda anti-falso-positivo
  // (monólogo con 2 incisos sigue siendo aceptable según DPD).
  const v = validateRae('—A —dijo. —B —preguntó. —C —respondió. —D —murmuró.', 'es');
  const c = v.find((x) => x.ruleId === 'paragraph-collapsed');
  check('4 turns con verbos distintos → paragraph-collapsed', c !== undefined, v.map((x) => x.ruleId));
}
{
  const v = validateRae('—¡Duendes! —gritó. —Todo apestaba —agregó. —Resulta que los duendes ayudaban.', 'es');
  const c = v.find((x) => x.ruleId === 'paragraph-collapsed');
  check('monólogo con 2 incisos NO dispara collapsed', c === undefined, v.map((x) => x.ruleId));
}
{
  const v = validateRae('"Hello," said John.', 'en');
  check('inglés → exit early', v.length === 0, v);
}
{
  const v = validateRae('—Me dijo «hola» al pasar.', 'es');
  check('cita interna «hola» válida → sin pending-conversion', !v.some((x) => x.ruleId === 'pending-conversion'), v);
}
{
  const v = validateRae('— Texto del diálogo.', 'es');
  const s = v.find((x) => x.ruleId === 'space-after-open');
  check('espacio sobrante post-raya → space-after-open', s !== undefined, v);
  check('autoFix borra el espacio', s?.autoFix?.replacement === '', s?.autoFix);
}
{
  const v = validateRae('—Hola —Dijo Juan.', 'es');
  const c = v.find((x) => x.ruleId === 'verb-capitalized');
  check('verbo capitalizado → verb-capitalized', c !== undefined, v);
  check('autoFix minúscula', c?.autoFix?.replacement === 'd', c?.autoFix);
}
{
  const v = validateRae('—Hola. —dijo Juan.', 'es');
  const p = v.find((x) => x.ruleId === 'period-before-verb');
  check('punto antes de raya de verbo → period-before-verb', p !== undefined, v);
}
{
  const v = validateRae('—Primero.\n\n—Bien. Dijo el viejo.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('multi-párrafo → offsets globales correctos', orphan !== undefined && orphan.offset > 10, orphan);
}

console.log('htmlToPlain');
check('separa <p> con \\n\\n', htmlToPlain('<p>Uno</p><p>Dos</p>') === 'Uno\n\nDos');
check('<br> como separador', htmlToPlain('<p>Uno<br>Dos</p>') === 'Uno\n\nDos');
check('desnuda inline markup', htmlToPlain('<p>Hola <em>mundo</em> <strong>cruel</strong></p>') === 'Hola mundo cruel');
check('decodifica entidades', htmlToPlain('<p>foo &amp; bar &mdash; baz</p>') === 'foo & bar — baz');

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
