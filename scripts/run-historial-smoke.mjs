#!/usr/bin/env node
// Smoke runner de pushHistorial (historial de notificaciones de la campana).
// Uso: node scripts/run-historial-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'historial-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  ['--target', 'es2022', '--ignoreConfig', '--module', 'commonjs', '--strict',
   '--skipLibCheck', '--outDir', outDir, 'src/app/notificaciones/historial.ts'],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(r.status ?? 1);
}

const { pushHistorial, MAX_HISTORIAL } = await import(
  pathToFileURL(join(outDir, 'historial.js')).href
);

let fails = 0;
function check(nombre, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { console.log(`ok   ${nombre}`); return; }
  fails++;
  console.log(`FAIL ${nombre}\n     got:  ${g}\n     want: ${w}`);
}

const ids = (lista) => lista.map((e) => e.id);
const e = (id) => ({ id });

check('la primera entrada queda sola', ids(pushHistorial([], e(1))), [1]);

// El orden ES la feature: la campana muestra lo último que pasó arriba de todo.
check(
  'la más nueva va primero',
  ids(pushHistorial([e(2), e(1)], e(3))),
  [3, 2, 1],
);

// El recorte tiene que comerse las viejas, nunca la que acaba de entrar.
check(
  'al llegar al tope se cae la más vieja',
  ids(pushHistorial([e(3), e(2), e(1)], e(4), 3)),
  [4, 3, 2],
);
check(
  'una lista ya pasada de tope se recorta igual',
  ids(pushHistorial([e(9), e(8), e(7), e(6)], e(10), 2)),
  [10, 9],
);

check('tope 1 deja solo la nueva', ids(pushHistorial([e(1)], e(2), 1)), [2]);
check('tope 0 no guarda nada', ids(pushHistorial([e(1)], e(2), 0)), []);
check('tope negativo tampoco', ids(pushHistorial([e(1)], e(2), -5)), []);

// No muta la lista que recibe: el signal de Angular compara por identidad.
const original = [e(1)];
pushHistorial(original, e(2));
check('no muta la lista original', ids(original), [1]);

check('el tope por default es el exportado', MAX_HISTORIAL, 200);
check(
  'sin tope explícito usa el default',
  pushHistorial(Array.from({ length: MAX_HISTORIAL }, (_, i) => e(i)), e(999)).length,
  MAX_HISTORIAL,
);

rmSync(outDir, { recursive: true, force: true });
if (fails) { console.error(`\n${fails} fallo(s)`); process.exit(1); }
console.log('\nhistorial smoke OK');
