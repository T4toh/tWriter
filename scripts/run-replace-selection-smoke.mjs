#!/usr/bin/env node
// Smoke runner de la selección del reemplazo. No es parte del build de Angular.
// Compila el TS a un dir temporal y corre las aserciones.
//
// Prueba la mitad pura: contadores, tri-estado, y el armado de los FileEdit que
// se van a escribir. Un off-by-one acá escribe en archivos que el autor
// destildó, y no hay forma de verlo mirando la UI.
//
// Uso: node scripts/run-replace-selection-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'replace-selection-smoke-'));

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
    'src/app/core/replace-selection.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'replace-selection.js')).href);
const { contar, estadoGrupo, toggleOcurrencia, toggleGrupo, editsDesdeSeleccion } = mod;

let passed = 0;
let failed = 0;
function check(nombre, cond) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  ✗ ${nombre}`);
  }
}

/** Grupo de prueba: `n` ocurrencias en `path`, offsets 10, 20, 30… */
function grupo(path, n, skipped = 0) {
  return {
    path,
    title: path,
    occurrences: Array.from({ length: n }, (_, i) => ({
      id: `${path}#${(i + 1) * 10}`,
      snippet: `…ocurrencia ${i}…`,
      htmlStart: (i + 1) * 10,
      htmlEnd: (i + 1) * 10 + 8,
    })),
    skipped: Array.from({ length: skipped }, () => ({
      snippet: '…cruza…',
      reason: 'cruzaTag',
    })),
  };
}

const groups = [grupo('/a/1.html', 5), grupo('/a/2.html', 3)];

{
  const c = contar(groups, new Set());
  check('sin nada destildado, todo seleccionado', c.total === 8 && c.selected === 8);
  check('cuenta capítulos', c.chapters === 2 && c.chaptersSelected === 2);
}

{
  const des = new Set(['/a/1.html#20']);
  const c = contar(groups, des);
  check('una destildada baja el selected', c.selected === 7 && c.total === 8);
  check('el capítulo sigue contando', c.chaptersSelected === 2);
}

{
  const des = new Set(groups[1].occurrences.map((o) => o.id));
  const c = contar(groups, des);
  check('capítulo entero destildado no cuenta', c.chaptersSelected === 1);
  check('selected baja al del otro capítulo', c.selected === 5);
}

{
  check('grupo intacto = all', estadoGrupo(groups[0], new Set()) === 'all');
  check(
    'grupo con una destildada = some',
    estadoGrupo(groups[0], new Set(['/a/1.html#20'])) === 'some',
  );
  check(
    'grupo con todas menos una destildada = some',
    estadoGrupo(groups[0], new Set(groups[0].occurrences.slice(0, 4).map((o) => o.id))) === 'some',
  );
  check(
    'grupo entero destildado = none',
    estadoGrupo(groups[0], new Set(groups[0].occurrences.map((o) => o.id))) === 'none',
  );
}

{
  const a = toggleOcurrencia('/a/1.html#10', new Set());
  check('toggle apaga', a.has('/a/1.html#10'));
  const b = toggleOcurrencia('/a/1.html#10', a);
  check('toggle de nuevo prende', !b.has('/a/1.html#10'));
  check('toggle no muta el Set original', a.has('/a/1.html#10'));
}

{
  const apagado = toggleGrupo(groups[0], new Set());
  check('toggleGrupo desde all apaga todas', estadoGrupo(groups[0], apagado) === 'none');
  check('toggleGrupo no toca el otro grupo', estadoGrupo(groups[1], apagado) === 'all');
  const prendido = toggleGrupo(groups[0], apagado);
  check('toggleGrupo desde none prende todas', estadoGrupo(groups[0], prendido) === 'all');
  const parcial = new Set(['/a/1.html#20']);
  check(
    'toggleGrupo desde some prende todas',
    estadoGrupo(groups[0], toggleGrupo(groups[0], parcial)) === 'all',
  );
}

{
  const edits = editsDesdeSeleccion(groups, new Set(['/a/1.html#20']));
  check('un edit por archivo con selección', edits.length === 2);
  const a = edits.find((e) => e.path === '/a/1.html');
  check('el archivo con 5 menos 1 lleva 4 ranges', a.ranges.length === 4);
  check(
    'la ocurrencia destildada no está en los ranges',
    !a.ranges.some(([start]) => start === 20),
  );
  check('los ranges son [htmlStart, htmlEnd]', a.ranges[0][0] === 10 && a.ranges[0][1] === 18);
}

{
  const todasFuera = new Set(groups[0].occurrences.map((o) => o.id));
  const edits = editsDesdeSeleccion(groups, todasFuera);
  check('el archivo sin selección no genera edit', edits.length === 1);
  check('y el que queda es el otro', edits[0].path === '/a/2.html');
}

{
  // Un grupo que SOLO tiene skipped no aporta nada que escribir.
  const soloSkipped = [grupo('/a/3.html', 0, 2)];
  const c = contar(soloSkipped, new Set());
  check('grupo solo con skipped tiene total 0', c.total === 0);
  check('y no genera edits', editsDesdeSeleccion(soloSkipped, new Set()).length === 0);
  check('y su tri-estado es none', estadoGrupo(soloSkipped[0], new Set()) === 'none');
}

rmSync(outDir, { recursive: true, force: true });

console.log(`replace-selection: ${passed} aserciones OK, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
