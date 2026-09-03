#!/usr/bin/env node
// Smoke runner de planoConMapa. No es parte del build de Angular.
// Compila los TS necesarios a un dir temporal y corre las aserciones.
// Uso: node scripts/run-plano-con-mapa-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'plano-con-mapa-smoke-'));

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
    'src/app/dialogos/plano-con-mapa.ts',
    'src/app/dialogos/validator.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { planoConMapa } = await import(pathToFileURL(join(outDir, 'dialogos/plano-con-mapa.js')).href);
const { htmlToPlain } = await import(pathToFileURL(join(outDir, 'dialogos/validator.js')).href);

// 1) El plano tiene que ser idéntico al de htmlToPlain. Es LA condición del
//    diseño: si se desalinean, los fixes se aplican en el lugar equivocado.
const htmls = [
  '<p>Hola mundo.</p>',
  '<p>Con <em>cursiva</em> adentro.</p>',
  '<p></p><p>Después de un bloque vacío.</p>',
  '<p>  Con espacios al borde.  </p>',
  '<p>Entidad &amp; y espacio&nbsp;duro.</p>',
  '<p>Uno<br/>Dos</p>',
  '<p>Uno.</p><p>Dos.</p><p>Tres.</p>',
  '<h1 class="chapter-title">Título</h1><p>Cuerpo.</p>',
  // htmlToPlain saca tags primero y recién después corre las 9 pasadas de
  // ENTITY_MAP en orden de inserción sobre el string ya sin tags: eso da
  // doble decodificación (una entidad literal escrita como `&amp;lt;`
  // termina en `<`, no en `&lt;`) y hace que un `&` partido por un tag
  // inline se una y decodifique. Los dos son comportamiento real de
  // producción — se replican, no se corrigen acá.
  '<p>&amp;lt;</p>',
  '<p>&amp;mdash;</p>',
  '<p>&<em>amp;</em>fin</p>',
];
let fallos = 0;
for (const html of htmls) {
  const { plain, mapa } = planoConMapa(html);
  if (plain !== htmlToPlain(html)) {
    fallos += 1;
    console.error(`FALLA plano != htmlToPlain para ${html}\n  got: ${JSON.stringify(plain)}\n  exp: ${JSON.stringify(htmlToPlain(html))}`);
  }
  if (mapa.length !== plain.length) {
    fallos += 1;
    console.error(`FALLA mapa.length ${mapa.length} != plain.length ${plain.length} para ${html}`);
  }
}

// 2) El mapa tiene que apuntar al carácter correcto del HTML.
const casos = [
  ['<p>Hola mundo.</p>', 0, 'H', 'primer carácter'],
  ['<p>Con <em>cursiva</em> adentro.</p>', 4, 'c', 'carácter adentro de la cursiva'],
  ['<p>  Con espacios.  </p>', 0, 'C', 'el trim no descoloca el mapa'],
  ['<p>Entidad &amp; fin.</p>', 8, '&', 'la entidad decodificada apunta a su inicio en el HTML'],
  ['<p></p><p>Segundo.</p>', 0, 'S', 'el bloque vacío descartado no descoloca'],
  ['<p>&amp;lt;</p>', 0, '&', 'el carácter doble-decodificado apunta al & inicial en el HTML'],
];
for (const [html, idxPlano, esperado, desc] of casos) {
  const { mapa } = planoConMapa(html);
  const got = html[mapa[idxPlano]];
  if (got !== esperado) {
    fallos += 1;
    console.error(`FALLA ${desc}: html[${mapa[idxPlano]}] = ${JSON.stringify(got)} != ${JSON.stringify(esperado)}`);
  }
}
console.log(fallos === 0 ? `${htmls.length + casos.length} chequeos OK` : `${fallos} fallas`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fallos === 0 ? 0 : 1);
