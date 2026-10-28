#!/usr/bin/env node
// Smoke runner de `sagaDelContexto`: en qué saga está parado el autor según el
// capítulo abierto o lo que navega. Uso: node scripts/run-saga-del-contexto-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'saga-contexto-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022',
    '--ignoreConfig',
    '--module', 'commonjs',
    '--strict',
    '--skipLibCheck',
    '--outDir', outDir,
    'src/app/tree/saga-del-contexto.ts',
    'src/app/core/types.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { sagaDelContexto } = await import(pathToFileURL(join(outDir, 'tree/saga-del-contexto.js')).href);

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) { passed += 1; console.log('  ok   —', name); }
  else { failed += 1; console.error('  FAIL —', name); if (info !== undefined) console.error('         ', info); }
}

const n = (path, kind, children = []) => ({ name: path.split('/').pop(), path, kind, children });
const R = '/novelas';
const tree = n(R, 'root', [
  n(`${R}/1 - Meridiano`, 'saga', [
    n(`${R}/1 - Meridiano/1 - Noche`, 'book', [n(`${R}/1 - Meridiano/1 - Noche/1.html`, 'chapter')]),
  ]),
  n(`${R}/2 - Meridiano Sur`, 'saga'),
  n(`${R}/Notas`, 'folder'),
]);

check('la saga misma', sagaDelContexto(tree, `${R}/1 - Meridiano`)?.path === `${R}/1 - Meridiano`);
check('un capítulo adentro', sagaDelContexto(tree, `${R}/1 - Meridiano/1 - Noche/1.html`)?.path === `${R}/1 - Meridiano`);
check('no confunde un prefijo de nombre', sagaDelContexto(tree, `${R}/2 - Meridiano Sur`)?.path === `${R}/2 - Meridiano Sur`);
check('una carpeta libre no es saga', sagaDelContexto(tree, `${R}/Notas`) === null);
check('sin contexto', sagaDelContexto(tree, null) === null);
check('sin árbol', sagaDelContexto(null, `${R}/1 - Meridiano`) === null);
check('separador de Windows', sagaDelContexto(
  n('C:\\novelas', 'root', [n('C:\\novelas\\1 - Meridiano', 'saga')]), 'C:\\novelas\\1 - Meridiano\\1 - Noche\\1.html')?.path === 'C:\\novelas\\1 - Meridiano');

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
