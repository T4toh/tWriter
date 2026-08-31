#!/usr/bin/env node
// Smoke runner de las plantillas de notas. No es parte del build de Angular.
// Compila el TS a un dir temporal y corre las aserciones.
// Uso: node scripts/run-note-templates-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'note-templates-smoke-'));

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
    'src/app/shared/note-templates.ts',
    'src/app/shared/note-blocks.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}


const mod = await import(pathToFileURL(join(outDir, 'note-templates.js')).href);
const { NOTE_TEMPLATES, combinarPlantillas, bloquesDePlantilla } = mod;

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

console.log('NOTE_TEMPLATES');
check('son 6', NOTE_TEMPLATES.length === 6, NOTE_TEMPLATES.length);
check(
  'los ids son los del spec',
  NOTE_TEMPLATES.map((t) => t.id).join(',') === 'vacia,personaje,conjuro,mundo,lista-agrupada,catalogo',
  NOTE_TEMPLATES.map((t) => t.id).join(','),
);
check('todas son de fábrica', NOTE_TEMPLATES.every((t) => t.origen === 'fabrica'));

{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'personaje'));
  const h2 = bs.filter((b) => b.tipo === 'h2').map((b) => b.texto);
  check(
    'personaje trae las 5 secciones del corpus',
    h2.join(',') === 'Raza,Características,Objetos,Magia,Detalles',
    h2.join(','),
  );
  check('las 5 son listas', bs.filter((b) => b.tipo === 'lista').length === 5, JSON.stringify(bs.map((b) => b.tipo)));
  check('personaje NO trae h1', !bs.some((b) => b.tipo === 'h1'), JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'conjuro'));
  const h2 = bs.filter((b) => b.tipo === 'h2').map((b) => b.texto);
  check('conjuro trae las 3 del corpus', h2.join(',') === 'Descripción,Atajos e Encantaciones,Conjuro', h2.join(','));
  check('Descripción es párrafo', bs[1].tipo === 'parrafo', JSON.stringify(bs.map((b) => b.tipo)));
  check('Atajos es lista', bs[3].tipo === 'lista', JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'vacia'));
  check('vacia arranca con h1', bs[0].tipo === 'h1', JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'catalogo'));
  check('catalogo trae h1 + h2', bs.some((b) => b.tipo === 'h1') && bs.some((b) => b.tipo === 'h2'), JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'mundo'));
  const h2 = bs.filter((b) => b.tipo === 'h2').map((b) => b.texto);
  check('mundo trae General/Lugares/Personajes', h2.join(',') === 'General,Lugares,Personajes', h2.join(','));
  check('mundo es prosa, sin listas', !bs.some((b) => b.tipo === 'lista'), JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'lista-agrupada'));
  const h2 = bs.filter((b) => b.tipo === 'h2').map((b) => b.texto);
  check('lista-agrupada copia los títulos de Personajes.md', h2.join(',') === 'Principales,Secundarios (Orden de Aparición)', h2.join(','));
}

console.log('combinarPlantillas');
{
  const out = combinarPlantillas(NOTE_TEMPLATES, [{ nombre: 'Conjuro', markdown: '## Otra cosa\n' }]);
  const conjuro = out.find((t) => t.label === 'Conjuro');
  check('el archivo del autor le gana a la de fábrica', conjuro.origen === 'archivo', JSON.stringify(conjuro));
  check('no duplica la entrada', out.filter((t) => t.label === 'Conjuro').length === 1, JSON.stringify(out.map((t) => t.label)));
  check('sigue habiendo 6', out.length === 6, out.length);
}
{
  const out = combinarPlantillas(NOTE_TEMPLATES, [{ nombre: 'conjuro', markdown: '## x\n' }]);
  check('la colisión es case-insensitive', out.length === 6 && out.find((t) => t.label === 'conjuro').origen === 'archivo', JSON.stringify(out.map((t) => `${t.label}:${t.origen}`)));
}
{
  const out = combinarPlantillas(NOTE_TEMPLATES, [
    { nombre: 'Nave', markdown: '## Tripulación\n-\n' },
    { nombre: 'Arma', markdown: '## Daño\n' },
  ]);
  check('las plantillas nuevas se suman al final', out.length === 8, out.length);
  check('y van ordenadas alfabéticamente', out.slice(6).map((t) => t.label).join(',') === 'Arma,Nave', out.slice(6).map((t) => t.label).join(','));
  check('las de fábrica mantienen su orden', out.slice(0, 6).map((t) => t.id).join(',') === 'vacia,personaje,conjuro,mundo,lista-agrupada,catalogo', out.slice(0, 6).map((t) => t.id).join(','));
}
{
  const out = combinarPlantillas(NOTE_TEMPLATES, [{ nombre: 'Rota', markdown: '   \n' }]);
  check('una plantilla que no parsea a nada se descarta', !out.some((t) => t.label === 'Rota'), JSON.stringify(out.map((t) => t.label)));
}
{
  const out = combinarPlantillas(NOTE_TEMPLATES, [{ nombre: 'Mundo', markdown: '## Otra\n' }]);
  check(
    'Mundo.md pisa la plantilla "mundo" por id, aunque el label sea "Mundo (estado del libro)"',
    out.length === 6 && out.filter((t) => t.label === 'Mundo').length === 1 && out.find((t) => t.label === 'Mundo').origen === 'archivo',
    JSON.stringify(out.map((t) => `${t.id}:${t.label}:${t.origen}`)),
  );
}

console.log('');
console.log(`${passed} ok, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
