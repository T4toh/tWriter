#!/usr/bin/env node
// Smoke runner del orden por estructura de los resultados de búsqueda. No es
// parte del build de Angular. Compila el TS a un dir temporal y corre las
// aserciones.
//
// El panel de búsqueda ordena los grupos por posición en el árbol en vez de por
// score BM25: buscando una frase literal el ranking no aporta nada, y lo que se
// quiere es recorrer los hits en el orden en que se lee el libro.
//
// Uso: node scripts/run-orden-estructura-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'orden-estructura-smoke-'));

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
    'src/app/core/orden-estructura.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'orden-estructura.js')).href);
const { ordenDeEstructura, compararPorEstructura, POSICION_DESCONOCIDA } = mod;

let passed = 0;
let failed = 0;

function check(nombre, cond) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${nombre}`);
  }
}

/** Nodo del árbol con lo mínimo que mira el orden: path, kind, children. */
function nodo(path, kind, children = []) {
  return { name: path.split('/').pop() ?? path, path, kind, children };
}

/** Árbol de prueba con la forma real: saga → libro → sección → capítulo, más
 *  una nota, que en el árbol del repo vive al lado de los capítulos. */
const arbol = nodo('/r', 'folder', [
  nodo('/r/1 - Meridian', 'saga', [
    nodo('/r/1 - Meridian/1 - Caballera', 'book', [
      nodo('/r/1 - Meridian/1 - Caballera/1 - Trabajo', 'section', [
        nodo('/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html', 'chapter'),
        nodo('/r/1 - Meridian/1 - Caballera/1 - Trabajo/3.html', 'chapter'),
      ]),
      nodo('/r/1 - Meridian/1 - Caballera/4 - Desvío', 'section', [
        nodo('/r/1 - Meridian/1 - Caballera/4 - Desvío/3.html', 'chapter'),
      ]),
    ]),
    nodo('/r/1 - Meridian/2 - Trabajo', 'book', [
      nodo('/r/1 - Meridian/2 - Trabajo/3 - Paseo', 'section', [
        nodo('/r/1 - Meridian/2 - Trabajo/3 - Paseo/4.html', 'chapter'),
      ]),
    ]),
    nodo('/r/1 - Meridian/Notas', 'notes', [
      nodo('/r/1 - Meridian/Notas/religiones.md', 'note'),
    ]),
  ]),
  nodo('/r/2 - BA 2077', 'saga', [
    nodo('/r/2 - BA 2077/1 - Luces', 'book', [
      nodo('/r/2 - BA 2077/1 - Luces/5.html', 'chapter'),
    ]),
  ]),
]);

/** Ordena paths como lo hace el panel: sort estable sobre la lista que llegó
 *  del backend (ordenada por score). */
function ordenar(paths, orden) {
  return [...paths].sort((a, b) => compararPorEstructura(orden, a, b));
}

// ─────────────────────────────────────────────────────────────────────────────

const orden = ordenDeEstructura(arbol);

// El repro del autor: el backend los devolvió por score al revés del orden de
// lectura, y la lista tiene que salir Trabajo 1, Trabajo 3, Desvío 3.
{
  const porScore = [
    '/r/1 - Meridian/1 - Caballera/4 - Desvío/3.html',
    '/r/1 - Meridian/1 - Caballera/1 - Trabajo/3.html',
    '/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html',
  ];
  const esperado = [
    '/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html',
    '/r/1 - Meridian/1 - Caballera/1 - Trabajo/3.html',
    '/r/1 - Meridian/1 - Caballera/4 - Desvío/3.html',
  ];
  check(
    'orden de lectura dentro de un libro',
    JSON.stringify(ordenar(porScore, orden)) === JSON.stringify(esperado),
  );
}

// Cruzando sagas y libros: Meridian antes que BA 2077, y adentro los libros en
// orden. Es el caso de scope "Todo el repo".
{
  const porScore = [
    '/r/2 - BA 2077/1 - Luces/5.html',
    '/r/1 - Meridian/2 - Trabajo/3 - Paseo/4.html',
    '/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html',
  ];
  const esperado = [
    '/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html',
    '/r/1 - Meridian/2 - Trabajo/3 - Paseo/4.html',
    '/r/2 - BA 2077/1 - Luces/5.html',
  ];
  check(
    'orden cruzando sagas y libros',
    JSON.stringify(ordenar(porScore, orden)) === JSON.stringify(esperado),
  );
}

// Las notas siguen su posición en el árbol: la nota de Meridian va después de
// los capítulos de Meridian y antes de la saga siguiente.
{
  const porScore = [
    '/r/2 - BA 2077/1 - Luces/5.html',
    '/r/1 - Meridian/Notas/religiones.md',
    '/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html',
  ];
  const esperado = [
    '/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html',
    '/r/1 - Meridian/Notas/religiones.md',
    '/r/2 - BA 2077/1 - Luces/5.html',
  ];
  check(
    'las notas caen en su posición del árbol',
    JSON.stringify(ordenar(porScore, orden)) === JSON.stringify(esperado),
  );
}

// Un path que no está en el árbol (borrado en disco, índice sin refrescar) va
// al final en vez de arriba de todo o de romper el sort.
{
  const porScore = [
    '/r/fantasma/9.html',
    '/r/1 - Meridian/1 - Caballera/4 - Desvío/3.html',
    '/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html',
  ];
  const salida = ordenar(porScore, orden);
  check('el path desconocido va al final', salida[salida.length - 1] === '/r/fantasma/9.html');
  check(
    'los conocidos igual quedan en orden de lectura',
    salida[0] === '/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html',
  );
}

// Dos desconocidos: empatan en 0, así que el sort estable preserva el orden por
// score que traían. Si el comparador usara Infinity, esto daría NaN y el orden
// quedaría indefinido.
{
  const porScore = ['/r/fantasma/b.html', '/r/fantasma/a.html'];
  const salida = ordenar(porScore, orden);
  check(
    'dos desconocidos preservan el orden por score',
    salida[0] === '/r/fantasma/b.html' && salida[1] === '/r/fantasma/a.html',
  );
  check(
    'el comparador de dos desconocidos da 0, no NaN',
    compararPorEstructura(orden, '/r/x', '/r/y') === 0,
  );
  check('POSICION_DESCONOCIDA es finita', Number.isFinite(POSICION_DESCONOCIDA));
}

// Árbol vacío (proyecto sin cargar): el mapa queda vacío y el orden no explota
// — todos empatan y la lista sale como vino.
{
  const vacio = ordenDeEstructura(null);
  check('árbol null ⇒ mapa vacío', vacio.size === 0);
  const porScore = ['/r/b.html', '/r/a.html'];
  const salida = ordenar(porScore, vacio);
  check(
    'sin árbol, la lista sale como vino',
    salida[0] === '/r/b.html' && salida[1] === '/r/a.html',
  );
}

// La raíz entra al mapa antes que sus hijos, y el recorrido es en profundidad:
// el capítulo del primer libro va antes que la sección del segundo.
{
  check('la raíz es la posición 0', orden.get('/r') === 0);
  check(
    'recorrido en profundidad, no por nivel',
    orden.get('/r/1 - Meridian/1 - Caballera/1 - Trabajo/1.html') <
      orden.get('/r/1 - Meridian/2 - Trabajo'),
  );
}

rmSync(outDir, { recursive: true, force: true });

console.log(`orden-estructura: ${passed} aserciones OK, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
