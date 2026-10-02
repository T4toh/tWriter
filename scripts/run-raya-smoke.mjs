#!/usr/bin/env node
// Smoke runner del validador de raya. No es parte del build de Angular.
// Compila los TS necesarios a un dir temporal y corre las aserciones.
// Uso: node scripts/run-raya-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'raya-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022',
    '--ignoreConfig',
    '--module', 'commonjs',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--allowSyntheticDefaultImports',
    '--outDir', outDir,
    'src/app/dialogos/validator.ts',
    'src/app/dialogos/rules-dedicated.ts',
    'src/app/dialogos/converter.ts',
    'src/app/dialogos/tags.ts',
    'src/app/dialogos/detect.ts',
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
const { validateRaya, htmlToPlain } = mod;

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

console.log('validateRaya');
{
  const plain = '—Bastien va a completar tu morral más tarde. Te espero afuera, hermoso.';
  const v = validateRaya(plain, 'es');
  check('diálogo simple sin inciso → sin violaciones', v.length === 0, v);
}
{
  // Solo dispara si el verbo está después de sentence boundary (.?!…) —
  // verbos mid-content no son dicendi-tags (ej. `—Así le dicen al oro.`).
  const v = validateRaya('—¿Nervioso? Preguntó su hermana.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('verbo dicendi post-? sin raya → dash-orphan', orphan !== undefined, v);
}
{
  const v = validateRaya('—Así le dicen al oro, Adi. Después te explico.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('verbo regular mid-content NO dispara dash-orphan', orphan === undefined, v);
}
{
  const v = validateRaya('—Torre Blanca. Se nota, mago. Repite tu historia, viajera.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('imperativo con «tu» detrás NO dispara dash-orphan', orphan === undefined, v);
}
{
  const v = validateRaya('—Ya está. Repite el viejo.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('presente con sujeto detrás sí dispara dash-orphan', orphan !== undefined, v);
}
{
  // Un verbo de habla adentro de una cita «…» es del texto citado, no un
  // inciso del narrador al que le falte la raya (DPD comillas 2a).
  const v = validateRaya('—Me escribió: «No vengas. Dijo mamá que no.» Y eso fue todo.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('dicendi adentro de «…» NO dispara dash-orphan', orphan === undefined, v);
}
{
  const v = validateRaya('—Leí “Sin raya. Dijo él.” anoche.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('dicendi adentro de “…” NO dispara dash-orphan', orphan === undefined, v);
}
{
  // La cita cerrada no tapa lo que viene después.
  const v = validateRaya('—Me dijo «vení». Preguntó su hermana.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('dicendi después de una cita cerrada sí dispara dash-orphan', orphan !== undefined, v);
}
// Guardas de los anti-falsos-positivos de dash-orphan: lo que SÍ es un inciso
// sin raya tiene que seguir saliendo.
for (const [txt, nombre] of [
  ['—¿Nervioso? preguntó su hermana.', 'minúscula después de ? sigue disparando'],
  ['—Bueno… Dijo Juan.', 'mayúscula después de … sigue disparando'],
  ['—Ya está. Dicen los niños.', '«dicen» con sujeto sigue disparando'],
  ['—Ya está. Dicen Ana y Luis.', '«dicen» con nombre propio sigue disparando'],
  ['—Basta. Preguntó mi hermana.', '«mi» puede arrancar el sujeto'],
]) {
  const v = validateRaya(txt, 'es');
  check(nombre, v.some((x) => x.ruleId === 'dash-orphan'), v);
}
{
  const v = validateRaya('"Hola" dijo Juan.', 'es');
  const p = v.find((x) => x.ruleId === 'pending-conversion');
  check('comillas con verbo dicendi → pending-conversion', p !== undefined, v);
  check('autoFix contiene raya', p?.autoFix?.replacement.includes('—Hola') === true, p?.autoFix);
}
{
  const v = validateRaya('-Hola, dijo.', 'es');
  const s = v.find((x) => x.ruleId === 'dash-short');
  check('guion corto → dash-short', s !== undefined, v);
  check('autoFix = em-dash', s?.autoFix?.replacement === '—', s?.autoFix);
}
{
  // Necesita ≥3 verbos dicendi distintos por la salvaguarda anti-falso-positivo
  // (monólogo con 2 incisos sigue siendo aceptable según DPD).
  const v = validateRaya('—A —dijo. —B —preguntó. —C —respondió. —D —murmuró.', 'es');
  const c = v.find((x) => x.ruleId === 'paragraph-collapsed');
  check('4 turns con verbos distintos → paragraph-collapsed', c !== undefined, v.map((x) => x.ruleId));
}
{
  const v = validateRaya('—¡Duendes! —gritó. —Todo apestaba —agregó. —Resulta que los duendes ayudaban.', 'es');
  const c = v.find((x) => x.ruleId === 'paragraph-collapsed');
  check('monólogo con 2 incisos NO dispara collapsed', c === undefined, v.map((x) => x.ruleId));
}
{
  const v = validateRaya('"Hello," said John.', 'en');
  check('inglés → exit early', v.length === 0, v);
}
{
  const v = validateRaya('—Me dijo «hola» al pasar.', 'es');
  check('cita interna «hola» válida → sin pending-conversion', !v.some((x) => x.ruleId === 'pending-conversion'), v);
}
{
  const v = validateRaya('— Texto del diálogo.', 'es');
  const s = v.find((x) => x.ruleId === 'space-after-open');
  check('espacio sobrante post-raya → space-after-open', s !== undefined, v);
  check('autoFix borra el espacio', s?.autoFix?.replacement === '', s?.autoFix);
}
{
  const v = validateRaya('—Hola —Dijo Juan.', 'es');
  const c = v.find((x) => x.ruleId === 'verb-capitalized');
  check('verbo capitalizado → verb-capitalized', c !== undefined, v);
  check('autoFix minúscula', c?.autoFix?.replacement === 'd', c?.autoFix);
}
{
  const v = validateRaya('—Hola. —dijo Juan.', 'es');
  const p = v.find((x) => x.ruleId === 'period-before-verb');
  check('punto antes de raya de verbo → period-before-verb', p !== undefined, v);
}
{
  const v = validateRaya('—Primero.\n\n—Bien. Dijo el viejo.', 'es');
  const orphan = v.find((x) => x.ruleId === 'dash-orphan');
  check('multi-párrafo → offsets globales correctos', orphan !== undefined && orphan.offset > 10, orphan);
}

console.log('htmlToPlain');
check('separa <p> con \\n\\n', htmlToPlain('<p>Uno</p><p>Dos</p>') === 'Uno\n\nDos');
check('<br> como separador', htmlToPlain('<p>Uno<br>Dos</p>') === 'Uno\n\nDos');
check('desnuda inline markup', htmlToPlain('<p>Hola <em>mundo</em> <strong>cruel</strong></p>') === 'Hola mundo cruel');
check('decodifica entidades', htmlToPlain('<p>foo &amp; bar &mdash; baz</p>') === 'foo & bar — baz');

{
  const { detectLang } = await import(pathToFileURL(join(outDir, 'dialogos/detect.js')).href);
  check('detectLang: diálogo corto en inglés → en', detectLang('<p>"No," Tom said. "No way."</p>') === 'en');
  check('detectLang: diálogo corto en español → es', detectLang('<p>—No —dijo Tom—. No hay forma.</p>') === 'es');
}

rmSync(outDir, { recursive: true, force: true });
{
  // Retomar el parlamento tras el comentario con `. —` (DPD 2.3d pide `—.`):
  // en bloque, porque un párrafo es un hablante (DPD 3.1). De a uno solo si
  // el párrafo parece colapsado (eso lo cubre run-raya-corpus-smoke.mjs).
  const plain = '—Hola. —Amelia se acercó al escritorio. —Vestite.';
  const v = validateRaya(plain, 'es').find((x) => x.ruleId === 'closing-dash');
  const f = v?.autoFix;
  const fixed = f ? plain.slice(0, f.offset) + f.replacement + plain.slice(f.offset + f.length) : '';
  check('`. —` al retomar → closing-dash con arreglo en bloque', f !== undefined && !f.manual, v);
  check('el arreglo deja `escritorio—. Vestite.`', fixed === '—Hola. —Amelia se acercó al escritorio—. Vestite.', fixed);
}

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
