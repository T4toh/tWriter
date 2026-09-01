#!/usr/bin/env node
// Smoke runner de las formas derivadas del diccionario per-saga.
// No es parte del build de Angular. Compila el TS a un dir temporal y corre
// las aserciones. Uso: node scripts/run-derived-forms-smoke.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'derived-forms-smoke-'));

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
    '--outDir', outDir,
    'src/app/dictionary/derived-forms.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'derived-forms.js')).href);
const { makeDictLookup, stripInflection, generateForms } = mod;

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

// Diccionario de prueba: entradas reales de Meridian más las formas que el
// generador escribiría para `bardear` y `teletransportar` (Task 2).
const DICT_ES = [
  'arcanismo', 'mirmidón', 'telequinético', 'telequinética', 'encantación',
  'Aedan', 'lúmen', 'dracónido', 'piedrita',
  'bardear', 'bardeando', 'bardeado', 'bardeada', 'bardeo', 'bardeás',
  'bardea', 'bardean', 'bardeé', 'bardeaste', 'bardeó', 'bardearon',
  'bardeaba', 'bardeaban', 'bardeá',
  'teletransportar', 'teletransportando', 'teletransportado',
  'teletransportada', 'teletransporto', 'teletransportás', 'teletransporta',
  'teletransportan', 'teletransporté', 'teletransportaste', 'teletransportó',
  'teletransportaron', 'teletransportaba', 'teletransportaban',
  'teletransportá',
];
const DICT_EN = ['chobbo', 'faunt', 'xenoarchaeologist', 'koziara', 'naruu', 'holoblade'];
const ES = makeDictLookup(DICT_ES);
const EN = makeDictLookup(DICT_EN);

console.log('stripInflection — pela');
for (const [word, idioma, esperado] of [
  ['bardearlo', 'es', 'bardear'],
  ['bardeármelo', 'es', 'bardear'],
  ['teletransportándose', 'es', 'teletransportando'],
  ['bardeámelo', 'es', 'bardeá'],
  ['arcanismos', 'es', 'arcanismo'],
  ['mirmidones', 'es', 'mirmidón'],
  ['bardeados', 'es', 'bardeado'],
  ['telequinéticas', 'es', 'telequinética'],
  ['lúmenes', 'es', 'lúmen'],
  ['chobbos', 'en', 'chobbo'],
  ['faunts', 'en', 'faunt'],
  ['naruus', 'en', 'naruu'],
  ['Koziaras', 'en', 'koziara'],
  ['xenoarchaeologists', 'en', 'xenoarchaeologist'],
]) {
  const got = stripInflection(word, idioma, idioma === 'es' ? ES : EN);
  check(`${word} [${idioma}] → ${esperado}`, got === esperado, got);
}

console.log('stripInflection — NO pela');
for (const [word, idioma, motivo] of [
  ['perla', 'es', 'el resto «per» no llega a 4 caracteres'],
  ['casas', 'es', '«casa» no está en el diccionario'],
  ['mirmidon', 'es', 'sin flexión no se consulta el índice sin tildes'],
  ['encantanción', 'es', 'typo, ningún patrón aplica'],
  ['Aedan', 'es', 'nombre propio sin flexión'],
  ['manos', 'es', 'el resto «ma» no llega a 4 caracteres'],
  ['hermanos', 'es', '«herma» no está en el diccionario'],
  ['sombras', 'es', 'palabra común'],
  ['blades', 'en', '«blade» no está en el diccionario'],
]) {
  const got = stripInflection(word, idioma, idioma === 'es' ? ES : EN);
  check(`${word} [${idioma}] → null (${motivo})`, got === null, got);
}

console.log('generateForms — verbos');
{
  const bardear = generateForms('bardear', 'verbo', 'es');
  check(
    'bardear da las 15 formas del núcleo, en orden',
    bardear.join(' ') ===
      'bardear bardeando bardeado bardeada bardeo bardeás bardea bardean ' +
      'bardeé bardeaste bardeó bardearon bardeaba bardeaban bardeá',
    bardear.join(' '),
  );
  check('el generador no escribe plurales de participio',
    !bardear.includes('bardeados') && !bardear.includes('bardeadas'), bardear.join(' '));

  const comer = generateForms('comer', 'verbo', 'es');
  check('comer da 15 (tabla -er)', comer.length === 15, comer.join(' '));
  check('comer conjuga con voseo', comer.includes('comés') && comer.includes('comé'), comer.join(' '));
  check('comer no tuteo', !comer.includes('comes'), comer.join(' '));

  const vivir = generateForms('vivir', 'verbo', 'es');
  check('vivir da 14: pretérito 1ª e imperativo voseo colisionan en «viví»',
    vivir.length === 14 && vivir.filter((f) => f === 'viví').length === 1, vivir.join(' '));

  const trancar = generateForms('trancar', 'verbo', 'es');
  check('-car ajusta el pretérito 1ª sg a «tranqué»',
    trancar.includes('tranqué') && !trancar.includes('trancé'), trancar.join(' '));
  check('-gar ajusta a «pagué»', generateForms('pagar', 'verbo', 'es').includes('pagué'));
  check('-zar ajusta a «cacé»', generateForms('cazar', 'verbo', 'es').includes('cacé'));

  const leer = generateForms('leer', 'verbo', 'es');
  check('raíz en vocal: i átona pasa a y',
    leer.includes('leyendo') && leer.includes('leyó') && leer.includes('leyeron'), leer.join(' '));
  check('raíz en vocal: i tónica lleva tilde, NO pasa a y',
    leer.includes('leído') && leer.includes('leída') && leer.includes('leíste') &&
    !leer.includes('leido') && !leer.includes('leyste'), leer.join(' '));

  check('un lema que no es infinitivo da lista vacía',
    generateForms('teletransporta', 'verbo', 'es').length === 0);
  check('un lema demasiado corto da lista vacía',
    generateForms('ar', 'verbo', 'es').length === 0);
}

console.log('generateForms — adjetivos e inglés');
{
  check('adjetivo en -o da masculino y femenino, sin plurales',
    generateForms('telequinético', 'adjetivo', 'es').join(' ') === 'telequinético telequinética',
    generateForms('telequinético', 'adjetivo', 'es').join(' '));
  check('adjetivo invariable en género no genera nada',
    generateForms('arcanista', 'adjetivo', 'es').length === 0);
  check('en inglés no se genera nada, ni verbos ni género',
    generateForms('bardear', 'verbo', 'en').length === 0 &&
    generateForms('chobbo', 'adjetivo', 'en').length === 0);
}

console.log('');
console.log(`${passed} ok, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
