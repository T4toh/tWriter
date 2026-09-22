#!/usr/bin/env node
// Smoke runner de la matemática del visor de imágenes (zoom.ts).
// Uso: node scripts/run-zoom-smoke.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'zoom-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  ['--target', 'es2022', '--ignoreConfig', '--module', 'commonjs', '--strict',
   '--skipLibCheck', '--outDir', outDir, 'src/app/image-viewer/zoom.ts'],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(r.status ?? 1);
}

const { fitScale, centrar, clampPan, zoomAt, wheelFactor, MAX_SCALE, MIN_SCALE } = await import(
  pathToFileURL(join(outDir, 'zoom.js')).href
);

let fails = 0;
function check(nombre, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { console.log(`ok   ${nombre}`); return; }
  fails++;
  console.log(`FAIL ${nombre}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
}
const r3 = (v) => ({ scale: +v.scale.toFixed(3), tx: +v.tx.toFixed(3), ty: +v.ty.toFixed(3) });

const caja = { imgW: 2000, imgH: 1000, boxW: 800, boxH: 600 };
check('fit: limita por el eje más apretado', fitScale(caja), 0.4);
check('fit: no agranda una imagen chica', fitScale({ imgW: 100, imgH: 50, boxW: 800, boxH: 600 }), 1);
check('fit: imagen sin tamaño no divide por cero', fitScale({ imgW: 0, imgH: 0, boxW: 800, boxH: 600 }), 1);

check('centrar: encajada queda centrada en ambos ejes', r3(centrar(0.4, caja)), { scale: 0.4, tx: 0, ty: 100 });
check('centrar: 1:1 arranca desde el borde superior izquierdo', r3(centrar(1, caja)), { scale: 1, tx: 0, ty: 0 });

check('clampPan: no deja fondo a la derecha', r3(clampPan({ scale: 1, tx: -5000, ty: -900 }, caja)), { scale: 1, tx: -1200, ty: -400 });
check('clampPan: no deja fondo a la izquierda', r3(clampPan({ scale: 1, tx: 50, ty: 0 }, caja)), { scale: 1, tx: 0, ty: 0 });
check('clampPan: eje que entra se recentra aunque venga corrido', r3(clampPan({ scale: 0.4, tx: -30, ty: -30 }, caja)), { scale: 0.4, tx: 0, ty: 100 });

// Zoom ×2 desde el fit con el cursor en el centro de la caja: el punto de la
// imagen bajo el cursor no se mueve, así que la imagen sigue centrada.
check('zoomAt: al centro mantiene el centro', r3(zoomAt(centrar(0.4, caja), caja, 2, 400, 300)), { scale: 0.8, tx: -400, ty: -100 });
// Con el cursor en la esquina superior izquierda, ese punto (0,0) queda fijo.
check('zoomAt: en la esquina fija la esquina', r3(zoomAt(centrar(1, caja), caja, 2, 0, 0)), { scale: 2, tx: 0, ty: 0 });
check('zoomAt: tope superior', zoomAt({ scale: 6, tx: 0, ty: 0 }, caja, 10, 0, 0).scale, MAX_SCALE);
check('zoomAt: tope inferior', zoomAt({ scale: 0.2, tx: 0, ty: 0 }, caja, 0.01, 0, 0).scale, MIN_SCALE);

check('wheelFactor: rueda hacia adelante acerca', wheelFactor(-100) > 1, true);
check('wheelFactor: rueda hacia atrás aleja', wheelFactor(100) < 1, true);
check('wheelFactor: ida y vuelta se cancelan', +(wheelFactor(100) * wheelFactor(-100)).toFixed(6), 1);
check('wheelFactor: delta gigante se recorta', wheelFactor(-10000), wheelFactor(-100));

if (fails) { console.log(`\n${fails} FAIL`); process.exit(1); }
console.log('\ntodo ok');
