#!/usr/bin/env node
// Smoke runner del cierre de drag. No es parte del build de Angular.
// Compila el TS a un dir temporal y corre las aserciones.
//
// Lo que se prueba acá es justo lo que un test con DOM real NO puede probar:
// que el cierre no dependa del nodo origen. Con timers y EventTarget falsos se
// puede simular "el navegador nunca despachó dragend porque Angular borró el
// nodo", que en un browser de verdad no se puede forzar a mano.
//
// Uso: node scripts/run-drag-cleanup-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'drag-cleanup-smoke-'));

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
    'src/app/core/drag-cleanup.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'drag-cleanup.js')).href);
const { armarCierreDeDrag, DRAG_WATCHDOG_MS } = mod;

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

/** EventTarget falso: guarda los listeners y deja dispararlos a mano. */
function targetFalso() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    disparar(type) {
      for (const cb of [...(listeners.get(type) ?? [])]) cb();
    },
    cantidad(type) {
      return listeners.get(type)?.size ?? 0;
    },
    total() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

/** Timers falsos: el tiempo avanza sólo cuando lo dice el test. */
function timersFalsos() {
  let ahora = 0;
  let siguienteId = 1;
  const pendientes = new Map();
  return {
    api: {
      set(cb, ms) {
        const id = siguienteId++;
        pendientes.set(id, { cb, cuando: ahora + ms });
        return id;
      },
      clear(id) {
        pendientes.delete(id);
      },
    },
    avanzar(ms) {
      ahora += ms;
      for (const [id, t] of [...pendientes]) {
        if (t.cuando <= ahora) {
          pendientes.delete(id);
          t.cb();
        }
      }
    },
    vivos() {
      return pendientes.size;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

// El caso del bug de CodeRabbit: Angular desconectó el nodo origen, así que el
// navegador nunca entrega `dragend` a `window`. El watchdog tiene que cerrar
// igual — es la única razón por la que existe.
{
  const t = targetFalso();
  const timers = timersFalsos();
  let cerrado = 0;
  armarCierreDeDrag(t, () => (cerrado += 1), timers.api, 1000);

  t.disparar('dragover');
  timers.avanzar(500);
  check('drag vivo: no cierra antes del watchdog', cerrado === 0);

  // El nodo se murió: no llegan más dragover y `dragend` nunca se despacha.
  timers.avanzar(1000);
  check('nodo desconectado: el watchdog cierra igual', cerrado === 1);
  check('cerrar corre una sola vez', cerrado === 1);
  check('cerrar desarma los listeners', t.total() === 0);
  check('cerrar no deja timers colgados', timers.vivos() === 0);
}

// Un drag largo no se corta: cada `dragover` rearma el watchdog.
{
  const t = targetFalso();
  const timers = timersFalsos();
  let cerrado = 0;
  armarCierreDeDrag(t, () => (cerrado += 1), timers.api, 1000);

  // El spec despacha dragover cada ~350ms; simular 10 vueltas.
  for (let i = 0; i < 10; i += 1) {
    timers.avanzar(350);
    t.disparar('dragover');
  }
  check('drag de 3,5s con dragover regular: sigue abierto', cerrado === 0);

  timers.avanzar(1000);
  check('al dejar de llegar dragover, cierra', cerrado === 1);
}

// El camino rápido: el nodo sigue conectado y `dragend` llega a `window`.
{
  const t = targetFalso();
  const timers = timersFalsos();
  let cerrado = 0;
  armarCierreDeDrag(t, () => (cerrado += 1), timers.api, 1000);

  t.disparar('dragover');
  t.disparar('dragend');
  check('dragend cierra al instante, sin esperar el watchdog', cerrado === 1);
  check('dragend desarma los listeners', t.total() === 0);
  check('dragend no deja timers colgados', timers.vivos() === 0);

  timers.avanzar(5000);
  check('el watchdog no vuelve a cerrar después de dragend', cerrado === 1);
}

// `drop` NO se escucha: en captura sobre window correría antes del handler del
// shell, que lee draggingNode() para saber qué abrir.
{
  const t = targetFalso();
  const timers = timersFalsos();
  let cerrado = 0;
  armarCierreDeDrag(t, () => (cerrado += 1), timers.api, 1000);
  check('no registra listener de drop', t.cantidad('drop') === 0);
  t.disparar('drop');
  check('drop no cierra el drag', cerrado === 0);
}

// Desarmar explícito (lo que hace endDrag): apaga todo y NO llama a cerrar,
// para que el caller pueda invocarlo desde su propio cierre sin recursión.
{
  const t = targetFalso();
  const timers = timersFalsos();
  let cerrado = 0;
  const desarmar = armarCierreDeDrag(t, () => (cerrado += 1), timers.api, 1000);

  desarmar();
  check('desarmar no llama a cerrar', cerrado === 0);
  check('desarmar saca los listeners', t.total() === 0);
  check('desarmar limpia el timer', timers.vivos() === 0);

  desarmar();
  check('desarmar es idempotente', cerrado === 0);

  timers.avanzar(5000);
  t.disparar('dragend');
  check('desarmado: ni watchdog ni dragend cierran', cerrado === 0);
}

// Drag que nunca entra a la ventana: cero dragover, cero dragend. El watchdog
// arranca armado justamente para esto.
{
  const t = targetFalso();
  const timers = timersFalsos();
  let cerrado = 0;
  armarCierreDeDrag(t, () => (cerrado += 1), timers.api, 1000);
  timers.avanzar(1000);
  check('sin un solo dragover, el watchdog igual cierra', cerrado === 1);
}

// El default está en el rango sano: más de dos vueltas del loop de 350ms del
// spec, y menos de dos segundos (el cartel no puede quedar visible un rato).
{
  check('DRAG_WATCHDOG_MS deja margen sobre el loop de 350ms', DRAG_WATCHDOG_MS >= 350 * 3);
  check('DRAG_WATCHDOG_MS no deja el cartel colgado', DRAG_WATCHDOG_MS <= 2000);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`drag-cleanup: ${passed} aserciones OK, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
