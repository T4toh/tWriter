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
    // `word-validator.ts` tampoco tiene imports, así que compila igual de suelto.
    // Entra acá porque `existsCaseInsensitive` es lo que deduplica las formas
    // generadas antes de escribirlas, y su criterio de identidad tiene que
    // sobrevivir a los pares mínimos con tilde que emite el generador.
    'src/app/dictionary/word-validator.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'derived-forms.js')).href);
const { makeDictLookup, stripInflection, generateForms, inferLemma } = mod;
const validator = await import(pathToFileURL(join(outDir, 'word-validator.js')).href);
const { existsCaseInsensitive, compareWords } = validator;

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

console.log('inferLemma');
{
  const primero = (w, i) => {
    const c = inferLemma(w, i)[0];
    return c ? `${c.lema}/${c.categoria}` : 'null';
  };
  for (const [word, esperado] of [
    ['teletransportó', 'teletransportar/verbo'],
    ['bardean', 'bardear/verbo'],
    ['casteando', 'castear/verbo'],
    ['teletransportaste', 'teletransportar/verbo'],
    ['teletransportaba', 'teletransportar/verbo'],
    ['bardeado', 'bardear/verbo'],
    ['comiendo', 'comer/verbo'],
  ]) {
    check(`${word} → ${esperado}`, primero(word, 'es') === esperado, primero(word, 'es'));
  }

  check('-iendo ofrece -er y -ir como dos candidatos',
    inferLemma('comiendo', 'es').map((c) => c.lema).join(',') === 'comer,comir',
    JSON.stringify(inferLemma('comiendo', 'es')));

  check('las formas en -a dan adjetivo primero y el verbo reconstruido segundo',
    inferLemma('castea', 'es').map((c) => `${c.lema}/${c.categoria}`).join(',') ===
      'castea/adjetivo,castear/verbo',
    JSON.stringify(inferLemma('castea', 'es')));
  check('teletransporta reconstruye teletransportar',
    inferLemma('teletransporta', 'es').some((c) => c.lema === 'teletransportar' && c.categoria === 'verbo'),
    JSON.stringify(inferLemma('teletransporta', 'es')));
  check('las formas en -o reconstruyen el infinitivo en -ar',
    inferLemma('teletransporto', 'es').some((c) => c.lema === 'teletransportar'),
    JSON.stringify(inferLemma('teletransporto', 'es')));
  check('telequinético propone adjetivo primero',
    inferLemma('telequinético', 'es')[0].categoria === 'adjetivo',
    JSON.stringify(inferLemma('telequinético', 'es')));

  check('la stop-list corta los sustantivos en -ción',
    inferLemma('teletransportación', 'es').length === 0,
    JSON.stringify(inferLemma('teletransportación', 'es')));
  check('la stop-list corta -miento y -dad',
    inferLemma('arcanismiento', 'es').length === 0 && inferLemma('oscuridad', 'es').length === 0);
  check('en inglés no infiere nada', inferLemma('chobbos', 'en').length === 0);
  check('un nombre propio corto no se confunde con un verbo',
    inferLemma('Aedan', 'es').length === 0, JSON.stringify(inferLemma('Aedan', 'es')));
  check('una palabra sin sufijo reconocible no da candidatos',
    inferLemma('Arcaneum', 'es').length === 0, JSON.stringify(inferLemma('Arcaneum', 'es')));
  // Limitación conocida y aceptada: un nombre largo terminado en -en/-an sí
  // propone verbo. No hay señal para distinguirlo sin un etiquetador
  // morfológico, y para eso está el botón Cancelar del preview.
  check('LIMITACIÓN: Bastien propone bastier, y se cancela a mano',
    inferLemma('Bastien', 'es')[0].lema === 'bastier',
    JSON.stringify(inferLemma('Bastien', 'es')));

  // Los sufijos de 1ª plural salieron de REGLAS: el núcleo de 15 formas no los
  // emite, así que inferirlos prometía una cobertura que no llegaba nunca.
  check('casteamos no infiere lema: el generador no emite la 1ª plural',
    inferLemma('casteamos', 'es').length === 0,
    JSON.stringify(inferLemma('casteamos', 'es')));
  check('casteábamos tampoco',
    inferLemma('casteábamos', 'es').length === 0,
    JSON.stringify(inferLemma('casteábamos', 'es')));
}

console.log('inferLemma × generateForms — todo sufijo inferido se genera');
{
  // La propiedad que faltaba: si `+ formas…` acepta una palabra, alguna de las
  // listas que ofrece tiene que contenerla, o el autor agrega 15 formas y la
  // palabra que apretó sigue subrayada.
  for (const word of [
    'bardean', 'bardeaba', 'bardeaban', 'bardeaste', 'bardearon', 'bardeando',
    'bardeado', 'bardeada', 'bardeó', 'bardeé', 'bardeá', 'bardeás',
    'castea', 'casteando', 'teletransporta', 'teletransporto', 'teletransportó',
    'comiendo', 'comían', 'comía', 'comieron', 'comiste', 'comió',
    'aprendés', 'sobrevivís', 'sobreviví', 'vivido', 'vivida', 'telequinético',
  ]) {
    const candidatos = inferLemma(word, 'es');
    const cubre = candidatos.some((c) =>
      generateForms(c.lema, c.categoria, 'es').includes(word.toLowerCase()));
    check(`${word} queda cubierta por alguno de sus candidatos`, cubre,
      JSON.stringify(candidatos));
  }
}

console.log('existsCaseInsensitive — identidad acento-sensible');
{
  // El dedupe real de `addManyWords`/`addManyToDictionary`: acumular las formas
  // saltando las que ya están. Con el collator de sensitivity base, `bardeo` y
  // `bardeó` eran «la misma», y cada verbo en -ar perdía el pretérito 3ª sg y el
  // imperativo voseo — y al reabrir el panel salían como «ya está».
  const formas = generateForms('teletransportar', 'verbo', 'es');
  const acumulada = [];
  for (const f of formas) {
    if (existsCaseInsensitive(acumulada, f)) continue;
    acumulada.push(f);
  }
  check('las 15 formas generadas sobreviven al dedupe',
    acumulada.length === 15, `${acumulada.length}: ${acumulada.join(' ')}`);
  check('el par mínimo -o/-ó sobrevive',
    acumulada.includes('teletransporto') && acumulada.includes('teletransportó'),
    acumulada.join(' '));
  check('el par mínimo -a/-á sobrevive',
    acumulada.includes('teletransporta') && acumulada.includes('teletransportá'),
    acumulada.join(' '));
  check('bardeó no cuenta como ya presente cuando está bardeo',
    existsCaseInsensitive(['bardeo', 'bardea'], 'bardeó') === false);
  check('las mayúsculas sí se ignoran',
    existsCaseInsensitive(['Bardeó'], 'bardeó') === true);
  check('el orden alfabético sigue ignorando las tildes',
    compareWords('bardeo', 'bardeó') === 0 && compareWords('Bardeo', 'bardeó') === 0);
}

console.log('');
console.log(`${passed} ok, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
