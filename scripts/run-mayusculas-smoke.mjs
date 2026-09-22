#!/usr/bin/env node
// Smoke runner del detector de mayúsculas rancias. No es parte del build.
// Compila la mitad pura a un dir temporal y corre las aserciones.
// Uso: node scripts/run-mayusculas-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'mayusculas-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022',
    '--ignoreConfig',
    '--module', 'commonjs',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--allowSyntheticDefaultImports',
    '--outDir', outDir,
    'src/app/dictionary/mayusculas-rancias.ts',
    'src/app/core/types.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'dictionary/mayusculas-rancias.js')).href);
const { detectMayusculasRancias } = mod;

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) {
    passed += 1;
    console.log('  ok   —', name);
  } else {
    failed += 1;
    console.error('  FAIL —', name);
    if (info !== undefined) console.error('         ', JSON.stringify(info));
  }
}

const DICT = ['Aedan', 'Yiriel', 'McKay', 'ARS', 'kallai'];
const run = (plain, dict = DICT) => detectMayusculasRancias(plain, dict);
const ids = (vs) => vs.map((v) => v.ruleId);
const sug = (vs) => vs.map((v) => v.message);

console.log('mezcla');
{
  const v = run('Ella LLOra en silencio.');
  check('LLOra → mezclada', ids(v).join() === 'mayuscula-mezclada', v);
  check('sugerencia Llora (capitalizada, primera va en mayúscula)', sug(v)[0].includes('«Llora»'), v);
  check('offset/length sobre la palabra', v[0].offset === 5 && v[0].length === 5, v[0]);
}
{
  const v = run('Y AEdan miró a YIRIel.');
  check('AEdan y YIRIel → dos mezcladas', ids(v).join() === 'mayuscula-mezclada,mayuscula-mezclada', v);
  check('sugerencia toma la grafía del diccionario', sug(v)[0].includes('«Aedan»') && sug(v)[1].includes('«Yiriel»'), v);
}
{
  const v = run('¿QUieres algo? YIri sonrió.');
  check('QUieres y YIri → mezcladas, capitalizadas', sug(v).join() === '«QUieres» → «Quieres»,«YIri» → «Yiri»', v);
}
{
  const v = run('El viejo McKay saludó a Roberto LaMoza en el HoloDrive de ExoSystems.');
  check('CamelCase (McKay, LaMoza, HoloDrive, ExoSystems) no se marca', v.length === 0, v);
}
{
  const v = run('A dozen AVs, their IDs, the CPUs and PhDs.');
  check('plural de sigla (AVs, IDs, CPUs, PhDs) no se marca', v.length === 0, v);
}
{
  const v = run('esto eS raro');
  check('mayúscula interna sola (eS) no es rancia de arranque', v.length === 0, v);
}

console.log('diccionario');
{
  const v = run('Y aedan se fue. El magus y el hombrelobo.', ['Aedan', 'Magus', 'Hombrelobo']);
  check('minúscula en texto con entrada Capitalizada NO se marca (762 falsos en el corpus)', v.length === 0, v);
}
{
  const v = run('Kallai vino. Los kallai se fueron.');
  check('entrada minúscula + palabra capitalizada no se marca', v.length === 0, v);
}
{
  const v = run('—¡AEDAN! —gritó.');
  check('ALL-CAPS de una palabra del diccionario es grito, no se marca', v.length === 0, v);
}
{
  const v = run('AEDAN', []);
  check('ALL-CAPS de una palabra fuera del diccionario tampoco', v.length === 0, v);
}

console.log('cortas');
{
  const v = run('Sí, ME lo dijo ayer.');
  check('ME entre minúsculas → corta', ids(v).join() === 'mayuscula-corta', v);
  check('sugerencia me (no arranca oración)', sug(v)[0].includes('«me»'), v);
}
{
  const v = run('Ayer. YA no quiero.');
  check('YA tras punto → sugiere Ya', sug(v)[0]?.includes('«Ya»'), v);
}
{
  const v = run('—EL perro ladra.');
  check('EL tras raya de diálogo → sugiere El', sug(v)[0]?.includes('«El»'), v);
}
{
  const v = run('Le dije: ¡YA! Get on the ship. NOW! —¡¿Y QUÉ?!');
  check('¡YA!, NOW!, QUÉ?! pegadas a !/? son grito', v.length === 0, v);
}
{
  const v = run('Is a G-VI drone.');
  check('VI colgando de un guion (G-VI) no se marca', v.length === 0, v);
}
{
  const v = run('From the US, the IT crowd.');
  check('US e IT fuera de la lista', v.length === 0, v);
}
{
  const v = run('—¡NO ME TOQUES! —gritó.');
  check('NO y ME dentro de un grito entero no se marcan', v.length === 0, v);
}
{
  const v = run('Pagó en ARS y en RC.');
  check('ARS y RC: siglas, fuera de la lista, no se marcan', v.length === 0, v);
}
{
  const v = run('I saw THE dog and A cat.');
  check('THE (lista en) sí, A (una letra) nunca', ids(v).join() === 'mayuscula-corta' && v[0].offset === 6, v);
}
{
  const v = run('A veces vengo. Él y yo.');
  check('A y Él capitalizadas normales no se marcan', v.length === 0, v);
}

console.log('forma de la violación');
{
  const v = run('Ella LLOra.');
  check('category mayusculas, severity warning, autoFix con la sugerencia sobre la palabra',
    v[0].category === 'mayusculas' && v[0].severity === 'warning'
      && v[0].autoFix.offset === 5 && v[0].autoFix.length === 5 && v[0].autoFix.replacement === 'Llora', v[0]);
}
{
  const v = run('ME fui. LLOra YIri.');
  check('salida ordenada por offset', v.map((x) => x.offset).join() === '0,8,14', v);
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
