#!/usr/bin/env node
// Smoke runner de textoDeFase (texto del toast mientras se genera el EPUB).
// No es parte del build de Angular. Compila el TS a un dir temporal y corre
// las aserciones. Uso: node scripts/run-export-progreso-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'export-progreso-smoke-'));

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
    'src/app/core/export-progreso.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { textoDeFase, resumenDeAviso } = await import(pathToFileURL(join(outDir, 'export-progreso.js')).href);

const casos = [
  [{ libro: '/x/Libro', fase: 'Leyendo capítulos', hecho: 0, total: 0 }, 'Leyendo capítulos…',
    'fase sin conteo: solo el texto'],
  [{ libro: '/x/Libro', fase: 'Escribiendo capítulos', hecho: 0, total: 12 }, 'Escribiendo capítulos (1 de 12)',
    'primer capítulo: 1 de 12, no 0 de 12'],
  [{ libro: '/x/Libro', fase: 'Escribiendo capítulos', hecho: 11, total: 12 }, 'Escribiendo capítulos (12 de 12)',
    'último capítulo: llega justo a total'],
  [{ libro: '/x/Libro', fase: 'Escribiendo capítulos', hecho: 0, total: 1 }, 'Escribiendo capítulos (1 de 1)',
    'libro de un solo capítulo'],
  [{ libro: '/x/Libro', fase: 'Armando índice y empaquetando', hecho: 0, total: 0 }, 'Armando índice y empaquetando…',
    'fase final sin conteo'],
];
let fallos = 0;
for (const [payload, esperado, desc] of casos) {
  const got = textoDeFase(payload);
  if (got !== esperado) { fallos += 1; console.error(`FALLA ${desc}: "${got}" != "${esperado}"`); }
}

// resumenDeAviso: lo que entra al toast; el resto se lee en el detalle.
const avisoLargo =
  'Itálicas o negritas mal anidadas (cruzan párrafos) en Magia Blanca (1): el EPUB salió bien, pero conviene reabrir y guardar esa parte en el editor.';
const casosAviso = [
  ['Falta la tapa del libro.', 'Falta la tapa del libro.',
    'aviso corto: se devuelve igual, sin detalle'],
  ['  Falta la tapa.  ', 'Falta la tapa.',
    'se recorta el espacio de los bordes'],
  [avisoLargo,
    'Itálicas o negritas mal anidadas (cruzan párrafos) en Magia Blanca (1): el EPUB salió bien, pero conviene…',
    'aviso largo: corta en el último espacio, sin partir palabras'],
  ['x'.repeat(140), `${'x'.repeat(110)}…`,
    'sin espacios: corta duro en el máximo'],
];
for (const [aviso, esperado, desc] of casosAviso) {
  const got = resumenDeAviso(aviso);
  if (got !== esperado) { fallos += 1; console.error(`FALLA ${desc}: "${got}" != "${esperado}"`); }
}
const total = casos.length + casosAviso.length;
console.log(fallos === 0 ? `${total} casos OK` : `${fallos} fallas`);

rmSync(outDir, { recursive: true, force: true });
process.exit(fallos === 0 ? 0 : 1);
