#!/usr/bin/env node
// Smoke runner del locator de búsqueda. No es parte del build de Angular.
// Compila el TS a un dir temporal y corre las aserciones.
//
// Prueba `pickBestBlock`, la mitad pura de `highlightBestMatch`: dado el texto
// de cada bloque del capítulo, cuál gana. El walk del DOM y la selección quedan
// afuera (necesitan document/Range) y se verifican a mano en la app.
//
// El bug que motivó esto: el salto elegía el PRIMER bloque con CUALQUIER
// término, así que buscando `Creo que se llamaba` caía en el primer `que` del
// capítulo — casi siempre arriba de todo — y nunca en la frase.
//
// Uso: node scripts/run-search-locate-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'search-locate-smoke-'));

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
    'src/app/core/search-highlight.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'search-highlight.js')).href);
const { pickBestBlock, tokenize, findAllMatchesInPlain, esInicioDePalabra, esMatchDeTermino } = mod;

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

/** Como lo llama `highlightBestMatch`: tokeniza la query y pasa el raw. */
function pick(bloques, query, fold = false) {
  return pickBestBlock(bloques, tokenize(query), query, fold);
}

// ─────────────────────────────────────────────────────────────────────────────

// El repro exacto del bug. `que` y `se` aparecen en todo el capítulo; la frase
// entera está en el bloque 3. Antes ganaba el 0 por tener un `que`.
{
  const bloques = [
    'Salió de la casa antes de que amaneciera.',
    'Se acomodó el abrigo y bajó la escalera.',
    'El portero dormía.',
    'Creo que se llamaba Ambrosio, pero nunca estuve seguro.',
    'Después no lo volvió a ver.',
  ];
  check('frase completa gana sobre el primer bloque con un token', pick(bloques, 'Creo que se llamaba') === 3);
}

// Cobertura sin forma rica: todo minúscula y sin puntuación ⇒ no hay literal
// que priorizar, gana el bloque con más términos distintos.
{
  const bloques = [
    'ambos partieron temprano',
    'los nobles esperaban en el patio',
    'ambos nobles brindaron por la victoria',
  ];
  check('gana el bloque con más términos distintos', pick(bloques, 'ambos nobles') === 2);
}

// El segundo repro del TODO: las dos palabras están en el capítulo pero a
// párrafos de distancia. El bloque que las tiene juntas gana igual.
{
  const bloques = [
    'Ambos se miraron sin decir nada.',
    'El resto del capítulo no dice nada del tema.',
    'Los nobles de la corte lo sabían.',
    'Ambos nobles firmaron el acuerdo esa noche.',
  ];
  check('términos desperdigados: gana donde caen juntos', pick(bloques, 'Ambos nobles') === 3);
}

// Forma rica: el literal completo gana de una, aunque otro bloque tenga más
// tokens sueltos. Es el match más específico posible.
{
  const bloques = [
    'duendes por todos lados, duendes y más duendes',
    'y entonces alguien gritó: ¡Duendes! con toda el alma',
  ];
  check('literal con forma rica gana sobre repetición de tokens', pick(bloques, '¡Duendes!') === 1);
}

// Empate de cobertura ⇒ el más temprano. El lector espera el primero.
{
  const bloques = ['tenía una espada', 'no tenía nada', 'tenía una espada'];
  check('empate de cobertura: gana el más temprano', pick(bloques, 'tenía espada') === 0);
}

// Sin ningún match ⇒ -1, y `highlightBestMatch` cae al host entero.
{
  check('ningún bloque matchea ⇒ -1', pick(['hola', 'chau'], 'zeppelin') === -1);
  check('query vacía ⇒ -1', pick(['hola'], '') === -1);
  check('lista de bloques vacía ⇒ -1', pick([], 'hola') === -1);
}

// Acentos: con fold (modo fuzzy) `mansion` encuentra `mansión`; sin fold, no
// — el modo exacto es accent-sensitive a propósito, para proofreading.
{
  const bloques = ['nada que ver acá', 'la mansión encantada del pueblo'];
  check('fold=true: mansion encuentra mansión', pick(bloques, 'mansion', true) === 1);
  check('fold=false: mansion NO encuentra mansión', pick(bloques, 'mansion', false) === -1);
}

// Un solo término: primer bloque que lo tenga, igual que antes. La mejora no
// cambia el caso simple, que ya funcionaba.
{
  const bloques = ['sin nada', 'acá está la espada', 'la espada otra vez'];
  check('un término: primer bloque que lo contiene', pick(bloques, 'espada') === 1);
}

// Términos repetidos dentro del bloque no inflan la cobertura: lo que importa
// es cuántos términos DISTINTOS aparecen, o `duendes duendes duendes` ganaría
// sobre el párrafo que tiene la frase de verdad.
{
  const bloques = ['duendes duendes duendes duendes', 'los duendes de la mansion'];
  check('cuenta términos distintos, no repeticiones', pick(bloques, 'duendes mansion') === 1);
}


// ─── Límite de palabra ─────────────────────────────────────────────────────
// El repro: buscando `y Ami ya está`, la `y` matcheaba adentro de `ayudó` y en
// la `Y` de `Yiri`. Regla: borde izquierdo siempre, y palabra completa para
// términos de ≤3 chars, donde el prefijo no sirve para nada.

{
  check('inicio de string es inicio de palabra', esInicioDePalabra('ayudó', 0) === true);
  check('letra antes ⇒ no es inicio', esInicioDePalabra('ayudó', 1) === false);
  check('espacio antes ⇒ es inicio', esInicioDePalabra('a yudó', 2) === true);
  check('puntuación antes ⇒ es inicio', esInicioDePalabra('—ya', 1) === true);
  check('número antes ⇒ no es inicio', esInicioDePalabra('3ya', 1) === false);
}

{
  // Término corto ⇒ palabra completa. La `y` de `yiri` arranca palabra pero no
  // la termina, así que no vale.
  check('y en "yiri" no vale (corto, no es palabra)', esMatchDeTermino('yiri lo vio', 0, 'y') === false);
  check('y sola vale', esMatchDeTermino('lo y ami', 3, 'y') === true);
  check('y en "ayudó" no vale (medio de palabra)', esMatchDeTermino('ayudó', 1, 'y') === false);
  // Término largo ⇒ prefijo permitido.
  check('golpear en "golpearon" vale', esMatchDeTermino('lo golpearon', 3, 'golpear') === true);
  check('esta en "estaban" vale (4 chars, prefijo)', esMatchDeTermino('estaban listos', 0, 'esta') === true);
  // Pero nunca en el medio, por largo que sea.
  check('golpear en "regolpearon" no vale', esMatchDeTermino('regolpearon', 2, 'golpear') === false);
}

/** Substrings resaltados por findAllMatchesInPlain, para leerlos de un vistazo. */
function marcados(plain, query, fold = false) {
  return findAllMatchesInPlain(plain, tokenize(query), query, fold).map((m) =>
    plain.slice(m.start, m.end),
  );
}

{
  // El repro del autor, tal cual: `y Ami ya está` tiene forma rica (la `A`
  // mayúscula), así que gana el literal completo y marca la frase entera. Un
  // solo mark, no cuatro.
  const plain = 'Yiri lo ayudó a terminar y Ami ya está lista';
  const out = marcados(plain, 'y Ami ya está');
  check('query con forma rica ⇒ un mark con la frase entera', JSON.stringify(out) === JSON.stringify(['y Ami ya está']));
}

{
  // El camino que SÍ tenía la basura: los snippets del panel pasan
  // `matchedTerms` como términos y `rawQuery` vacío, o sea sin forma rica que
  // priorizar. Antes marcaba la `Y` de `Yiri` y la `y` de `ayudó`.
  const plain = 'Yiri lo ayudó a terminar y Ami ya está lista';
  const out = findAllMatchesInPlain(plain, ['Y', 'Ami', 'ya', 'está'], '').map((m) =>
    plain.slice(m.start, m.end),
  );
  check(
    'camino matchedTerms: solo palabras completas para los cortos',
    JSON.stringify(out) === JSON.stringify(['y', 'Ami', 'ya', 'está']),
  );
  check('no marca la Y de Yiri', !out.includes('Y'));
}

{
  // Lo que NO hay que romper: el proofreading busca prefijos.
  check('golpear encuentra golpearon', marcados('lo golpearon fuerte', 'golpear')[0] === 'golpear');
  check('caballera encuentra caballeras', marcados('las caballeras', 'caballera')[0] === 'caballera');
}

{
  // Dos ocurrencias, una mala y una buena: la mala no debe tapar a la buena.
  const out = marcados('ayudó y luego se fue', 'y');
  check('descarta la del medio y encuentra la buena', out.length === 1);
}

{
  // El literal de forma rica NO pasa por la guarda: sigue siendo búsqueda de
  // literal exacto, que es lo que hace específico a `¡Duendes!`.
  const out = marcados('gritó ¡Duendes! fuerte', '¡Duendes!');
  check('el literal con forma rica se sigue resaltando', out[0] === '¡Duendes!');
}

{
  // pickBestBlock cuenta cobertura con la misma guarda: un bloque que solo
  // tiene los términos adentro de otras palabras no debería ganar.
  const bloques = ['Yiri lo ayudó a caminar', 'y Ami ya está lista'];
  check('la cobertura no cuenta matches del medio de palabra', pick(bloques, 'y ya') === 1);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`search-locate: ${passed} aserciones OK, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
