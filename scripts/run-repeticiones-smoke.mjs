#!/usr/bin/env node
// Smoke runner del detector de repeticiones. No es parte del build de Angular.
// Compila los TS necesarios a un dir temporal y corre las aserciones.
// Uso: node scripts/run-repeticiones-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'rep-smoke-'));

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
    'src/app/repeticiones/detector.ts',
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

const mod = await import(pathToFileURL(join(outDir, 'repeticiones/detector.js')).href);
const { detectRepeticiones, DEFAULTS, normalizar } = mod;

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) {
    passed += 1;
    console.log('  ok   —', name);
  } else {
    failed += 1;
    console.error('  FAIL —', name);
    if (info !== undefined) console.error('         ', JSON.stringify(info));
  }
}

const det = (plain, lang, over = {}) =>
  detectRepeticiones(plain, lang, { ...DEFAULTS, ignorar: [], ...over });

console.log('positivos — los tres casos del problema');
{
  const h = det('Era una nave oscura, oscura como el vacío.', 'es');
  check('dos pegadas → un hit (excepción por ventanaCorta)', h.length === 1, h);
  check('la marca va en la SEGUNDA aparición', h[0]?.offset === 21, h[0]);
  check('distancia = 1', h[0]?.distancia === 1, h[0]);
}
{
  const h = det('El capitán oscuro miró el pasillo oscuro del casco oscuro.', 'es');
  check('tres apariciones → dos hits', h.length === 2, h.map((x) => x.offset));
  check('el segundo hit cuenta 3 apariciones', h[1]?.apariciones === 3, h[1]);
}
{
  const h = det('Caminó lentamente y habló lentamente y respiró lentamente.', 'es');
  check('tres adverbios → dos hits', h.length === 2, h.map((x) => x.palabra));
}
{
  const h = det('The dark captain saw the dark corridor of the dark hull.', 'en');
  check('inglés: tres apariciones → dos hits', h.length === 2, h);
}

console.log('negativos — los que hacen inservible al feature si fallan');
{
  const plain = 'Kallai cruzó el patio. Kallai miró el cielo. Kallai no dijo nada. Kallai esperó. Kallai entró.';
  check(
    'nombre propio del diccionario repetido → cero hits',
    det(plain, 'es', { ignorar: ['Kallai'] }).length === 0,
    det(plain, 'es', { ignorar: ['Kallai'] }),
  );
}
{
  // El caso que falla si el detector confía en que `ignorar` llega normalizado:
  // `sagaCtx.dictionary()` devuelve minúsculas CON diacríticos.
  const plain = 'Kallái cruzó el patio. Kallái miró el cielo. Kallái esperó.';
  check(
    'diccionario con diacríticos sin normalizar → cero hits',
    det(plain, 'es', { ignorar: ['kallái'] }).length === 0,
    det(plain, 'es', { ignorar: ['kallái'] }),
  );
}
{
  // Nombre AUSENTE del diccionario: lo tapa la capa 5 (capitalizado mid-oración).
  const plain = 'El viejo llamó a Bastien, después buscó a Bastien y por fin halló a Bastien.';
  check('nombre propio ausente del diccionario → cero hits', det(plain, 'es').length === 0, det(plain, 'es'));
}
{
  const plain = '—Vení —dijo ella. —No —dijo él. —Ahora —dijo ella otra vez.';
  check('diálogo con `dijo` repetido → cero hits', det(plain, 'es').length === 0, det(plain, 'es'));
}
{
  const plain = '"Come," she whispered. "No," he whispered. "Now," she whispered again.';
  check('inglés con `whispered` repetido → cero hits', det(plain, 'en').length === 0, det(plain, 'en'));
}
{
  const plain = 'Cuando entonces cuando entonces cuando entonces vino.';
  check('stopwords largas repetidas → cero hits', det(plain, 'es').length === 0, det(plain, 'es'));
}
{
  const plain = 'Vio el mago y vio el rey y vio el bufón.';
  check('palabra corta bajo largoMinimo → cero hits', det(plain, 'es').length === 0, det(plain, 'es'));
}
{
  // Relleno sin repeticiones propias: si el relleno se repite, el test mide
  // otra cosa.
  // Ojo: `token${i}` NO sirve — la tokenización es /\p{L}+/, así que los
  // dígitos se caen y las 50 palabras del relleno quedan todas en `token`.
  const relleno = Array.from({ length: 50 }, (_, i) => `relleno${'x'.repeat(i + 1)}`).join(' ');
  const plain = `oscuridad ${relleno} oscuridad`;
  check('más allá de la ventana → cero hits', det(plain, 'es').length === 0, det(plain, 'es'));
}
{
  // Test del umbral: dos apariciones dentro de `ventana` pero más allá de
  // `ventanaCorta`, con minApariciones 3.
  const plain = 'La montaña se alzaba al norte del valle mientras el viento bajaba por la montaña.';
  check('dos apariciones separadas con minApariciones 3 → cero hits', det(plain, 'es').length === 0, det(plain, 'es'));
  check(
    'las mismas con minApariciones 2 → un hit',
    det(plain, 'es', { minApariciones: 2 }).length === 1,
    det(plain, 'es', { minApariciones: 2 }),
  );
}
{
  const plain = 'Nosotros entrenamos cuerpo a cuerpo, pero es bastante distinto.';
  check('construcción con nexo (`cuerpo a cuerpo`) → cero hits', det(plain, 'es').length === 0, det(plain, 'es'));
}
{
  const plain = 'They fought side by side until the end.';
  check('inglés: `side by side` → cero hits', det(plain, 'en').length === 0, det(plain, 'en'));
}
{
  // Test del reset por párrafo.
  const plain = 'Cerró la escotilla de la nave.\n\nLa nave crujió y la nave se apagó.';
  const h = det(plain, 'es');
  check('la ventana no cruza el \\n\\n', h.length === 1, h);
  check('el hit que queda es del segundo párrafo', h[0]?.offset > 31, h[0]);
}

console.log('offsets');
{
  const plain = 'Uno dos tres.\n\nEra una nave oscura, oscura como el vacío.';
  const h = det(plain, 'es');
  check('offset global correcto tras un párrafo', plain.slice(h[0].offset, h[0].offset + h[0].length) === 'oscura', h[0]);
  check('offsetPrevio apunta a la aparición anterior', plain.slice(h[0].offsetPrevio, h[0].offsetPrevio + 6) === 'oscura', h[0]);
}

console.log('normalizar');
check('saca diacríticos', normalizar('Oscurá') === 'oscura');
check('minúsculas', normalizar('NAVE') === 'nave');

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
