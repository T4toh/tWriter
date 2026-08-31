#!/usr/bin/env node
// Smoke runner de `notasDelLibro`. No es parte del build de Angular.
// El fixture replica la estructura real de `~/novelas`: sagas numeradas y una
// carpeta `Notas/` paralela cuyo nombre NO lleva el prefijo ni el "2.0".
// Uso: node scripts/run-notas-del-libro-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'notas-libro-smoke-'));

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
    'src/app/tree/notas-del-libro.ts',
    'src/app/core/types.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'tree/notas-del-libro.js')).href);
const { notasDelLibro, calzaSaga, sinPrefijoNumerico, carpetasDeNotas, relativoAlRoot } = mod;

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

// ── Fixture ──
const R = '/novelas';
const n = (kind, path, name, children = []) => ({ kind, path, name, children });
const nota = (dir, file) => n('note', `${dir}/${file}`, file);

// La raíz del árbol real viene con kind 'saga' (get_tree la arma así), no
// 'folder'. El fixture lo replica porque justamente ahí estaba el bug: buscar
// la saga con `find` agarraba la raíz y todo devolvía null.
const tree = n('saga', R, 'novelas', [
  n('saga', `${R}/1 - Meridian 2.0`, '1 - Meridian 2.0', [
    n('book', `${R}/1 - Meridian 2.0/3 - Secreto`, '3 - Secreto', [
      n('chapter', `${R}/1 - Meridian 2.0/3 - Secreto/1 - Hombre Alado/1.html`, '1', []),
      n('notes', `${R}/1 - Meridian 2.0/3 - Secreto/notas`, 'notas', [
        nota(`${R}/1 - Meridian 2.0/3 - Secreto/notas`, 'Arreglos.md'),
      ]),
    ]),
    n('book', `${R}/1 - Meridian 2.0/5 - Camino a Casa`, '5 - Camino a Casa', [
      n('chapter', `${R}/1 - Meridian 2.0/5 - Camino a Casa/1.html`, '1', []),
    ]),
  ]),
  n('saga', `${R}/3 - Milky Way`, '3 - Milky Way', [
    n('book', `${R}/3 - Milky Way/1 - Uno`, '1 - Uno', [
      n('chapter', `${R}/3 - Milky Way/1 - Uno/1.html`, '1', []),
    ]),
  ]),
  n('saga', `${R}/9 - Sin Notas`, '9 - Sin Notas', [
    n('book', `${R}/9 - Sin Notas/1 - Libro`, '1 - Libro', [
      n('chapter', `${R}/9 - Sin Notas/1 - Libro/1.html`, '1', []),
    ]),
  ]),
  n('folder', `${R}/Notas`, 'Notas', [
    n('folder', `${R}/Notas/Meridian`, 'Meridian', [
      n('folder', `${R}/Notas/Meridian/3 - Secreto`, '3 - Secreto', [
        nota(`${R}/Notas/Meridian/3 - Secreto`, 'Aedan.md'),
        nota(`${R}/Notas/Meridian/3 - Secreto`, 'Mundo.md'),
      ]),
      n('folder', `${R}/Notas/Meridian/4 - La Princesa`, '4 - La Princesa', [
        nota(`${R}/Notas/Meridian/4 - La Princesa`, 'Aedan.md'),
      ]),
      nota(`${R}/Notas/Meridian`, 'Personajes.md'),
      n('folder', `${R}/Notas/Meridian/Lugares`, 'Lugares', [
        nota(`${R}/Notas/Meridian/Lugares`, 'Cantaria.md'),
      ]),
    ]),
    n('folder', `${R}/Notas/Milky Way`, 'Milky Way', [
      nota(`${R}/Notas/Milky Way`, 'Species.md'),
    ]),
  ]),
]);

const CAP_SECRETO = `${R}/1 - Meridian 2.0/3 - Secreto/1 - Hombre Alado/1.html`;

console.log('sinPrefijoNumerico / calzaSaga');
check('saca el prefijo numérico', sinPrefijoNumerico('1 - Meridian 2.0') === 'Meridian 2.0');
check('sin prefijo lo deja igual', sinPrefijoNumerico('Notas') === 'Notas');
check('Meridian calza con 1 - Meridian 2.0', calzaSaga('Meridian', '1 - Meridian 2.0'));
check('Milky Way calza exacto', calzaSaga('Milky Way', '3 - Milky Way'));
check('case-insensitive', calzaSaga('meridian', '1 - MERIDIAN 2.0'));
check('otra saga NO calza', !calzaSaga('Buenos Aires 2077', '1 - Meridian 2.0'));
check('vacío no calza', !calzaSaga('', '1 - Meridian 2.0'));

console.log('notasDelLibro');
check('sin path activo → null', notasDelLibro(tree, null) === null);
check('sin árbol → null', notasDelLibro(null, CAP_SECRETO) === null);
check('path desconocido → null', notasDelLibro(tree, '/otro/lado.html') === null);
check(
  'saga sin carpeta de notas → null',
  notasDelLibro(tree, `${R}/9 - Sin Notas/1 - Libro/1.html`) === null,
);

{
  const res = notasDelLibro(tree, CAP_SECRETO);
  check('resuelve la saga sin prefijo', res?.sagaNombre === 'Meridian 2.0', res?.sagaNombre);
  check('resuelve el libro', res?.libroNombre === '3 - Secreto', res?.libroNombre);
  const etiquetas = res.libro.map((x) => x.etiqueta);
  check('fichas del libro abierto', etiquetas.includes('Aedan') && etiquetas.includes('Mundo'), etiquetas);
  check('suma el notas/ del árbol de novelas', etiquetas.includes('Arreglos'), etiquetas);
  check(
    'NO trae el Aedan de otro libro',
    res.libro.filter((x) => x.nombre === 'Aedan').length === 1,
    res.libro.map((x) => x.path),
  );
  check(
    'el Aedan que trae es el del libro abierto',
    res.libro.find((x) => x.nombre === 'Aedan')?.path === `${R}/Notas/Meridian/3 - Secreto/Aedan.md`,
    res.libro.find((x) => x.nombre === 'Aedan')?.path,
  );
  const saga = res.saga.map((x) => x.etiqueta);
  check('notas de saga sueltas', saga.includes('Personajes'), saga);
  check(
    'las carpetas temáticas NO se aplanan en la saga (eran 95 filas)',
    !saga.some((e) => e.startsWith('Lugares')),
    saga,
  );
  check(
    'las carpetas de libro NO se cuelan en las de saga',
    !saga.some((e) => e.startsWith('3 - Secreto') || e.startsWith('4 - La Princesa')),
    saga,
  );
  check('la saga son solo sus .md sueltas', saga.join() === 'Personajes', saga);
  check('carpeta de saga resuelta', res.carpetaSagaPath === `${R}/Notas/Meridian`, res.carpetaSagaPath);
  check('carpeta del libro resuelta', res.carpetaLibroPath === `${R}/Notas/Meridian/3 - Secreto`, res.carpetaLibroPath);
  check('libro ordenado alfabéticamente', etiquetas.join() === [...etiquetas].sort((a, b) => a.localeCompare(b, 'es')).join(), etiquetas);
}

{
  // Saga con notas pero sin carpeta por libro: solo notas de saga.
  const res = notasDelLibro(tree, `${R}/3 - Milky Way/1 - Uno/1.html`);
  check('sin carpeta del libro → libro vacío', res?.libro.length === 0, res?.libro);
  check('sin carpeta del libro → saga con sus notas', res?.saga.map((x) => x.etiqueta).includes('Species'), res?.saga);
}

{
  // Libro sin carpeta de notas propia dentro de Notas/, pero la saga sí tiene.
  const res = notasDelLibro(tree, `${R}/1 - Meridian 2.0/5 - Camino a Casa/1.html`);
  check('libro nuevo sin notas → lista vacía, saga intacta', res?.libro.length === 0 && res.saga.length > 0, res);
  check(
    'libro nuevo → carpeta destino aunque no exista en disco',
    res?.carpetaLibroPath === `${R}/Notas/Meridian/5 - Camino a Casa`,
    res?.carpetaLibroPath,
  );
}

{
  // Regresión: con la raíz siendo kind 'saga', la saga real tiene que ganar.
  const res = notasDelLibro(tree, CAP_SECRETO);
  check('la raíz kind=saga NO le gana a la saga real', res?.sagaNombre === 'Meridian 2.0', res?.sagaNombre);
  const capSuelto = `${R}/suelto.html`;
  const treeConCapSuelto = { ...tree, children: [...tree.children, n('chapter', capSuelto, 'suelto')] };
  check('capítulo colgado de la raíz → null (no hay saga)', notasDelLibro(treeConCapSuelto, capSuelto) === null);
}

{
  // Arrancando desde una nota abierta en vez de un capítulo.
  const res = notasDelLibro(tree, `${R}/1 - Meridian 2.0/3 - Secreto/notas/Arreglos.md`);
  check('desde una nota del árbol de novelas también resuelve', res?.libroNombre === '3 - Secreto', res?.libroNombre);
}

{
  // Selector de destino del form de creación: todas las carpetas que pueden
  // alojar una nota, etiquetadas con su path relativo al root.
  const carpetas = carpetasDeNotas(tree, R);
  check('encuentra carpetas de notas', carpetas.length > 0, carpetas.length);
  check(
    'ninguna etiqueta arranca con el root',
    carpetas.every((c) => !c.etiqueta.startsWith(R)),
    JSON.stringify(carpetas.slice(0, 3)),
  );
  check(
    'vienen ordenadas por etiqueta',
    carpetas.map((c) => c.etiqueta).join('|') ===
      [...carpetas.map((c) => c.etiqueta)].sort((a, b) => a.localeCompare(b, 'es')).join('|'),
    JSON.stringify(carpetas.map((c) => c.etiqueta)),
  );
  check(
    'solo carpetas: ni capítulos ni notas sueltas',
    carpetas.every((c) => !c.path.endsWith('.md') && !c.path.endsWith('.html')),
    JSON.stringify(carpetas.map((c) => c.path)),
  );
  check('árbol nulo → lista vacía', carpetasDeNotas(null, R).length === 0);
}

{
  check('relativoAlRoot pela el root', relativoAlRoot(`${R}/Notas/Meridian`, R) === 'Notas/Meridian');
  check('el root mismo es "."', relativoAlRoot(R, R) === '.');
  check(
    'un path fuera del root queda entero',
    relativoAlRoot('/otro/lado/Notas', R) === '/otro/lado/Notas',
  );
  // Regresión: `startsWith` pelado hacía que una carpeta hermana con prefijo
  // común (`/novelas-viejo`) devolviera `-viejo/Notas/x`.
  check(
    'una hermana con prefijo comun NO se considera dentro del root',
    relativoAlRoot(`${R}-viejo/Notas/x`, R) === `${R}-viejo/Notas/x`,
    relativoAlRoot(`${R}-viejo/Notas/x`, R),
  );
  check(
    'el root con barra final tambien pela bien',
    relativoAlRoot(`${R}/Notas/x`, `${R}/`) === 'Notas/x',
    relativoAlRoot(`${R}/Notas/x`, `${R}/`),
  );
  check('root vacio deja el path entero', relativoAlRoot(`${R}/Notas`, '') === `${R}/Notas`);
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
