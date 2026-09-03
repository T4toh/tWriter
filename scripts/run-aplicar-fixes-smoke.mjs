#!/usr/bin/env node
// Smoke runner de aplicarFixesHtml. No es parte del build de Angular.
// Compila los TS necesarios a un dir temporal y corre las aserciones.
// Uso: node scripts/run-aplicar-fixes-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'aplicar-fixes-smoke-'));

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
    'src/app/dialogos/aplicar-fixes.ts',
    'src/app/dialogos/plano-con-mapa.ts',
    'src/app/dialogos/validator.ts',
    'src/app/core/types.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { aplicarFixesHtml } = await import(pathToFileURL(join(outDir, 'dialogos/aplicar-fixes.js')).href);

const casos = [
  {
    desc: 'fix adentro de una cursiva: se aplica y la cursiva sobrevive',
    html: '<p>Dijo <em>hola</em> y se fue.</p>',
    fixes: [{ offset: 5, length: 4, replacement: 'chau' }],
    esperado: { html: '<p>Dijo <em>chau</em> y se fue.</p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'fix que cruza el borde de un tag: se saltea, el HTML no cambia',
    html: '<p>Dijo <em>hola</em> y se fue.</p>',
    fixes: [{ offset: 3, length: 5, replacement: 'XXXXX' }],
    esperado: { html: '<p>Dijo <em>hola</em> y se fue.</p>', aplicados: 0, salteados: 1 },
  },
  {
    desc: 'fix en un párrafo posterior a uno vacío: offset correcto',
    html: '<p></p><p>Hola mundo.</p>',
    fixes: [{ offset: 5, length: 5, replacement: 'tierra' }],
    esperado: { html: '<p></p><p>Hola tierra.</p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'fix después de una entidad: offset correcto pese al cambio de largo',
    html: '<p>A &amp; B final.</p>',
    fixes: [{ offset: 6, length: 5, replacement: 'FINAL' }],
    esperado: { html: '<p>A &amp; B FINAL.</p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'fix en bloque con espacios al borde: el trim no descoloca',
    html: '<p>   Hola mundo.   </p>',
    fixes: [{ offset: 0, length: 4, replacement: 'Chau' }],
    esperado: { html: '<p>   Chau mundo.   </p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'varios fixes en el mismo párrafo: todos, sin corrimiento',
    html: '<p>uno dos tres</p>',
    fixes: [
      { offset: 0, length: 3, replacement: 'UNO' },
      { offset: 8, length: 4, replacement: 'TRES' },
    ],
    esperado: { html: '<p>UNO dos TRES</p>', aplicados: 2, salteados: 0 },
  },
  {
    desc: 'sin fixes: devuelve el html igual',
    html: '<p>Nada.</p>',
    fixes: [],
    esperado: { html: '<p>Nada.</p>', aplicados: 0, salteados: 0 },
  },
  // Los siguientes no vienen del brief: cubren el borde derecho del rango,
  // que es donde el borrador original tenía un bug (ver reporte de la
  // tarea). `largoEnHtml` del borrador adivinaba el largo de la entidad
  // buscando el primer `;`, que con el doble-decode de `&amp;lt;` (dos
  // pasadas → un solo `<` de plano) encuentra el `;` de adentro y deja
  // colgado un `lt;` en el HTML de salida.
  {
    desc: 'fix que termina en una entidad doble-decodificada: no deja colgado nada',
    html: '<p>fin &amp;lt; ya</p>',
    fixes: [{ offset: 4, length: 1, replacement: 'X' }],
    esperado: { html: '<p>fin X ya</p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'fix que termina en una entidad simple pegada al cierre del bloque',
    html: '<p>A &amp;</p>',
    fixes: [{ offset: 0, length: 3, replacement: 'Z' }],
    esperado: { html: '<p>Z</p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'fix de largo 0: inserción pura, no consume nada del HTML',
    html: '<p>Hola mundo.</p>',
    fixes: [{ offset: 4, length: 0, replacement: '!' }],
    esperado: { html: '<p>Hola! mundo.</p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'fix de largo 0 fuera de rango: se saltea sin romper',
    html: '<p>Hola.</p>',
    fixes: [{ offset: 99, length: 0, replacement: '!' }],
    esperado: { html: '<p>Hola.</p>', aplicados: 0, salteados: 1 },
  },
  {
    desc: 'inserción al final del texto (offset === plain.length): cae adentro del </p>, no después',
    html: '<p>Hola mundo</p>',
    fixes: [{ offset: 10, length: 0, replacement: '!' }],
    esperado: { html: '<p>Hola mundo!</p>', aplicados: 1, salteados: 0 },
  },
];
let fallos = 0;
for (const c of casos) {
  const r = aplicarFixesHtml(c.html, c.fixes);
  const ok = r.html === c.esperado.html
    && r.aplicados === c.esperado.aplicados
    && r.salteados === c.esperado.salteados;
  if (!ok) { fallos += 1; console.error(`FALLA ${c.desc}: ${JSON.stringify(r)} != ${JSON.stringify(c.esperado)}`); }
}
console.log(fallos === 0 ? `${casos.length} casos OK` : `${fallos} fallas`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fallos === 0 ? 0 : 1);
