#!/usr/bin/env node
// Smoke runner de los términos compuestos del diccionario per-saga.
// No es parte del build de Angular: compila el TS a un dir temporal y corre
// las aserciones.
// Uso: node scripts/run-compound-terms-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'compound-smoke-'));

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
    'src/app/dictionary/compound-terms.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'compound-terms.js')).href);
const { isCompound, splitDictionary, findCompoundRanges, isInsideCompound } = mod;

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

console.log('isCompound / splitDictionary');
{
  check('una palabra no es compuesta', isCompound('Kallai') === false);
  check('dos palabras sí', isCompound('Kun Lian') === true);
  check('los bordes no cuentan', isCompound('  Kallai  ') === false);
  // LT parte en el apóstrofe: `Sarta’an cayó al mar.` marca `an` sola. Para el
  // diccionario cuenta como compuesta aunque el autor la lea como una palabra.
  check('el apóstrofe tipográfico parte', isCompound('Sarta’an') === true);
  check('el apóstrofe recto también', isCompound("Sarta'an") === true);
  const { simples, compuestas } = splitDictionary(['Kallai', 'Kun Lian', 'Sarta’an']);
  check('parte bien', simples.length === 1 && compuestas.length === 2, { simples, compuestas });
}

console.log('match de frase');
{
  const plain = 'El reino de Kun Lian cayó en invierno.';
  const rs = findCompoundRanges(plain, ['Kun Lian']);
  check('encuentra la frase', rs.length === 1, rs);
  check('el rango es exacto', plain.slice(rs[0].start, rs[0].end) === 'Kun Lian', rs[0]);
}
{
  const plain = 'Kun Lian y Kun Lian otra vez.';
  check('todas las apariciones', findCompoundRanges(plain, ['Kun Lian']).length === 2);
}
{
  const plain = 'Sirvieron  Tres\tTorres en copa larga.';
  const rs = findCompoundRanges(plain, ['Tres Torres']);
  check('tolera doble espacio y tab entre palabras', rs.length === 1, rs);
}
{
  const plain = 'Contó hasta Tres\n\nTorres altas se veían.';
  check('NO cruza el \\n\\n entre bloques', findCompoundRanges(plain, ['Tres Torres']).length === 0);
}

console.log('case-sensitive — la razón de ser del feature');
{
  const plain = 'Bebió Tres Torres mirando las tres torres de piedra.';
  const rs = findCompoundRanges(plain, ['Tres Torres']);
  check('matchea el vino', rs.length === 1, rs);
  check('no matchea la frase común en minúscula', rs[0].start === plain.indexOf('Tres Torres'), rs[0]);
}

console.log('bordes de palabra (sin \\b, que es ASCII-only)');
{
  check(
    'no matchea adentro de otra palabra',
    findCompoundRanges('unKun Liano', ['Kun Lian']).length === 0,
  );
  check(
    'la puntuación pegada sí cierra el término',
    findCompoundRanges('Cayó Kun Lian, al fin.', ['Kun Lian']).length === 1,
  );
  check(
    'el acento cuenta como letra en el borde',
    findCompoundRanges('áKun Lian', ['Kun Lian']).length === 0,
  );
  check(
    'un término con acento matchea igual',
    findCompoundRanges('Vino de Sá Antón hoy.', ['Sá Antón']).length === 1,
  );
}

console.log('apóstrofe — el caso «Sarta’an», que LT parte en `Sarta` + `an`');
{
  const plain = 'Sarta’an cayó al mar.';
  const rs = findCompoundRanges(plain, ['Sarta’an']);
  check('matchea el término entero', rs.length === 1, rs);
  check('el rango cubre las dos mitades', rs[0].start === 0 && rs[0].end === 8, rs[0]);
  // Lo que LT marca de verdad, medido contra el container: offset 6, largo 2.
  check('la marca de LT sobre `an` queda contenida', isInsideCompound(rs, 6, 8));
}
{
  // El autor lo guarda con la tipográfica y el texto puede traer la recta, o al
  // revés según de dónde vino pegado: las variantes son intercambiables.
  check(
    'guardado con ’ matchea texto con \'',
    findCompoundRanges("Sarta'an cayó.", ['Sarta’an']).length === 1,
  );
  check(
    'guardado con \' matchea texto con ’',
    findCompoundRanges('Sarta’an cayó.', ["Sarta'an"]).length === 1,
  );
}
{
  const plain = 'Escapó de Sa’artan hace años.';
  const rs = findCompoundRanges(plain, ['Sa’artan']);
  check('los DOS matches de LT quedan contenidos', rs.length === 1 && isInsideCompound(rs, 10, 12) && isInsideCompound(rs, 13, 18), rs);
}

console.log('cada hueco lleva SU separador, no uno genérico');
{
  check(
    'un término con apóstrofe NO matchea con espacio',
    findCompoundRanges('Sarta an cayó.', ['Sarta’an']).length === 0,
  );
  check(
    'un término con espacio NO matchea con apóstrofe',
    findCompoundRanges('Tres’Torres en copa.', ['Tres Torres']).length === 0,
  );
  const mixto = findCompoundRanges("Vino Amalut d'Sa’artan hoy.", ["Amalut d'Sa’artan"]);
  check('un término con los dos separadores matchea', mixto.length === 1, mixto);
}

console.log('el largo le gana al corto');
{
  const plain = 'Amalut de las Arenas entró.';
  const rs = findCompoundRanges(plain, ['de las Arenas', 'Amalut de las Arenas']);
  check('gana la entrada larga', rs.length === 1 && rs[0].term === 'Amalut de las Arenas', rs);
}

console.log('contención — el caso AGREEMENT_DET_NOUN de «las Arenas»');
{
  const plain = 'Amalut de las Arenas entró.';
  const rs = findCompoundRanges(plain, ['Amalut de las Arenas']);
  const lasArenas = plain.indexOf('las Arenas');
  check(
    'un match de LT contenido se descarta',
    isInsideCompound(rs, lasArenas, lasArenas + 'las Arenas'.length),
  );
  check(
    'el término entero también',
    isInsideCompound(rs, rs[0].start, rs[0].end),
  );
  const entro = plain.indexOf('entró');
  check(
    'un match de afuera NO se descarta',
    isInsideCompound(rs, entro, entro + 5) === false,
  );
  check(
    'un match que se solapa a medias NO se descarta (contención, no intersección)',
    isInsideCompound(rs, rs[0].end - 3, rs[0].end + 6) === false,
  );
}

console.log('degenerados');
{
  check('sin términos, sin rangos', findCompoundRanges('Kun Lian', []).length === 0);
  check('las simples se ignoran acá', findCompoundRanges('Kallai', ['Kallai']).length === 0);
  check('texto vacío', findCompoundRanges('', ['Kun Lian']).length === 0);
  check(
    'metacaracteres de regex no rompen',
    findCompoundRanges('Vino a.b c+d hoy.', ['a.b c+d']).length === 1,
  );
  check(
    'y no matchean como regex',
    findCompoundRanges('Vino axb cyd hoy.', ['a.b c+d']).length === 0,
  );
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
