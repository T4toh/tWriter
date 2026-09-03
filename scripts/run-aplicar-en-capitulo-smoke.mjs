#!/usr/bin/env node
// Smoke runner de aplicarEnCapitulo (src/app/revision/deteccion.ts). No es
// parte del build de Angular. Compila los TS necesarios a un dir temporal y
// corre las aserciones.
// Uso: node scripts/run-aplicar-en-capitulo-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'aplicar-en-capitulo-smoke-'));

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
    'src/app/revision/deteccion.ts',
    'src/app/dialogos/converter.ts',
    'src/app/dialogos/detect.ts',
    'src/app/dialogos/validator.ts',
    'src/app/dialogos/rules-dedicated.ts',
    'src/app/dialogos/tags.ts',
    'src/app/dialogos/aplicar-fixes.ts',
    'src/app/dialogos/plano-con-mapa.ts',
    'src/app/editor/rae-convert.ts',
    'src/app/quotes/educate.ts',
    'src/app/repeticiones/detector.ts',
    'src/app/core/types.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { aplicarEnCapitulo, detectarEnCapitulo } = await import(
  pathToFileURL(join(outDir, 'revision/deteccion.js')).href
);
const { EXCEPCIONES_DEFAULT } = await import(
  pathToFileURL(join(outDir, 'repeticiones/detector.js')).href
);

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

const todo = { rayas: true, comillas: true, arreglosRae: true };

console.log('aplicarEnCapitulo');
{
  // El caso Critical del brief: capítulo EN con diálogo entre comillas y
  // TODO tildado. No puede terminar con rayas españolas ni comillas rectas.
  const html = "<p>“I don't know,” she said. “Really.”</p>";
  const res = aplicarEnCapitulo(html, null, 'en', todo);
  check('EN + todo tildado: sin rayas españolas', !res.html.includes('—'), res.html);
  check(
    'EN + todo tildado: comillas tipográficas, no aplanadas a rectas',
    res.html.includes('“') && !res.html.includes('"'),
    res.html,
  );
}
{
  // Mismo caso pero sin idioma seteado — detectLang tiene que clasificarlo EN
  // iguial que hace `comillas`, y el gate de rayas tiene que coincidir.
  const html = "<p>“I don't know,” she said. “Really.”</p>";
  const res = aplicarEnCapitulo(html, null, null, todo);
  check('EN sin idioma seteado: sin rayas españolas', !res.html.includes('—'), res.html);
}
{
  // ES sin convertir, todo tildado: rayas tiene que convertir el diálogo.
  const html = '<p>"No sé," dijo ella. "De verdad."</p>';
  const res = aplicarEnCapitulo(html, null, 'es', todo);
  check('ES + todo tildado: convierte a raya', res.html.includes('—'), res.html);
}
{
  // ES ya convertido y limpio: nada que tocar, el html sale igual.
  const html = '<p>—No sé —dijo ella—. De verdad.</p>';
  const res = aplicarEnCapitulo(html, null, 'es', todo);
  check('ES limpio: html sin cambios', res.html === html, res.html);
  check('ES limpio: sin salteados', res.salteados === 0, res);
}
{
  // Nada tildado: el html no se toca pase lo que pase.
  const html = '<p>"No sé," dijo ella.</p>';
  const res = aplicarEnCapitulo(html, null, 'es', { rayas: false, comillas: false, arreglosRae: false });
  check('nada tildado: html sin cambios', res.html === html, res.html);
}
{
  // Fix round 1: `pending-conversion` (autoFix = salida de convert()) es
  // EXACTAMENTE la misma transformación que ya hace `rayas` — si arreglosRae
  // la contara, las dos casillas dejarían de ser independientes (tildar solo
  // arreglosRae convertía el diálogo igual, sin que el autor lo pidiera).
  const html = '<p>"No sé," dijo ella. "De verdad."</p>';
  {
    const res = aplicarEnCapitulo(html, null, 'es', { rayas: false, comillas: false, arreglosRae: true });
    check('solo arreglosRae: NO convierte a raya', res.html === html, res.html);
  }
  {
    const res = aplicarEnCapitulo(html, null, 'es', { rayas: true, comillas: false, arreglosRae: false });
    check('solo rayas: sí convierte a raya', res.html.includes('—'), res.html);
  }
  {
    const det = detectarEnCapitulo(html, null, 'es', { excepciones: EXCEPCIONES_DEFAULT, diccionario: [] });
    check('detectarEnCapitulo: arreglosRae no cuenta la conversión pendiente', det.arreglosRae === 0, det);
  }
}

{
  // Fix crítico: comillas angulares sin diálogo de verdad, rayas tildado.
  // `convert()` crudo aplanaría «»→"" sin convertir nada — con el guard, el
  // html sale intacto.
  const html = '<p>El cartel decía «Prohibido pasar».</p>';
  const res = aplicarEnCapitulo(html, null, 'es', todo);
  check('ES con «» sin diálogo: html sin cambios', res.html === html, res.html);
}
{
  // Mismo caso con comillas tipográficas rectas “ ”.
  const html = '<p>El cartel decía “Prohibido pasar”.</p>';
  const res = aplicarEnCapitulo(html, null, 'es', todo);
  check('ES con “” sin diálogo: html sin cambios', res.html === html, res.html);
}
{
  // El guard no puede matar el caso bueno: diálogo de verdad sin convertir
  // sigue convirtiéndose.
  const html = '<p>"No sé," dijo ella. "De verdad."</p>';
  const res = aplicarEnCapitulo(html, null, 'es', todo);
  check('ES con diálogo de verdad: sí convierte a raya', res.html.includes('—'), res.html);
}

console.log('aplicarEnCapitulo: idioma del libro manda sobre el del capítulo');
// Solo `comillas` tildado en estos tres casos (no `todo`): aísla el bug real
// del brief — el converter de rayas (D1) convierte CUALQUIER párrafo que
// arranca con comilla sin mirar el idioma (comportamiento previo, documentado
// en deteccion.ts), así que sumar `rayas` acá mezclaría ese quirk conocido con
// lo que este cambio prueba: que educateQuotes (comillas) no toque un
// capítulo que el libro declaró español.
const soloComillas = { rayas: false, comillas: true, arreglosRae: false };
{
  // Libro declara 'es', capítulo trae 'en' en su meta — el libro manda:
  // comillas queda gateada a 0, el html no se toca.
  const html = "<p>“I don't know,” she said. “Really.”</p>";
  const res = aplicarEnCapitulo(html, 'es', 'en', soloComillas);
  check('libro es + capítulo en: comillas no se aplica, html sin cambios', res.html === html, res.html);
}
{
  // El bug que este cambio arregla: libro 'es', capítulo sin idioma en su
  // meta (import .docx) con una cita en inglés. Antes `detectLang` lo
  // clasificaba 'en' y `educateQuotes` le tocaba la tipografía sobre un
  // capítulo que en realidad es español.
  const html = "<p>“I don't know,” she said. “Really.”</p>";
  const res = aplicarEnCapitulo(html, 'es', null, soloComillas);
  check('libro es + capítulo sin idioma + cita EN: comillas no se aplica, html sin cambios', res.html === html, res.html);
}
{
  // Libro sin idioma declarado: el `.meta.json` del capítulo decide, como
  // siempre — inglés, comillas educadas.
  const html = "<p>\"I don't know,\" she said. \"Really.\"</p>";
  const res = aplicarEnCapitulo(html, null, 'en', todo);
  check('libro sin idioma + capítulo en: sin rayas españolas', !res.html.includes('—'), res.html);
  check('libro sin idioma + capítulo en: comillas educadas', res.html.includes('“'), res.html);
}
{
  // Libro sin idioma Y capítulo sin idioma: el fallback a `detectLang` sigue
  // funcionando como último recurso.
  const html = "<p>\"I don't know,\" she said. \"Really.\"</p>";
  const res = aplicarEnCapitulo(html, null, null, todo);
  check('libro sin idioma + capítulo sin idioma + contenido EN: sin rayas españolas', !res.html.includes('—'), res.html);
  check('libro sin idioma + capítulo sin idioma + contenido EN: comillas educadas', res.html.includes('“'), res.html);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
