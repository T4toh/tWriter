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
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'note-templates.js')).href);
const { renderNoteTemplate, NOTE_TEMPLATES } = mod;

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

console.log('renderNoteTemplate');
check('vacia → null (el backend escribe el # solo)', renderNoteTemplate('vacia', 'Aedan') === null);
check('id desconocido → null', renderNoteTemplate('no-existe', 'Aedan') === null);

{
  const md = renderNoteTemplate('personaje', 'Aedan');
  check('personaje arranca con el título', md.startsWith('# Aedan\n\n'), md);
  check('personaje trae las 4 secciones', ['Raza', 'Características', 'Objetos', 'Magia'].every((s) => md.includes(`## ${s}\n`)), md);
  check('cada sección deja un bullet abierto', md.split('- \n').length === 5, md);
  check('cierra con newline', md.endsWith('\n'), JSON.stringify(md.slice(-8)));
}

{
  const md = renderNoteTemplate('mundo', 'Mundo');
  check('mundo trae General/Lugares/Personajes', ['General', 'Lugares', 'Personajes'].every((s) => md.includes(`## ${s}\n`)), md);
  check('mundo no trae secciones de personaje', !md.includes('## Raza'), md);
}

console.log('NOTE_TEMPLATES');
check('3 plantillas', NOTE_TEMPLATES.length === 3, NOTE_TEMPLATES.map((t) => t.id));
check('vacia es la primera (default del select)', NOTE_TEMPLATES[0].id === 'vacia');
check('todas tienen label no vacío', NOTE_TEMPLATES.every((t) => !!t.label));

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
