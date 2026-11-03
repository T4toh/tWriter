#!/usr/bin/env node
// Smoke runner del editor de guion: la parte pura (líneas, resaltado del
// formato de escenas y tramos que van a LanguageTool). No es parte del build
// de Angular. Compila los TS a un dir temporal y corre las aserciones.
// Uso: node scripts/run-guion-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'guion-smoke-'));

const r = spawnSync(
  join(repo, 'node_modules', '.bin', 'tsc'),
  [
    '--target', 'es2022',
    '--ignoreConfig',
    '--module', 'commonjs',
    '--strict',
    '--skipLibCheck',
    '--outDir', outDir,
    'src/app/guion/lineas.ts',
    'src/app/guion/resaltar.ts',
    'src/app/guion/texto-para-corregir.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const { partirLineas, unirLineas, partirPegado, cuantoDesindentar } = await import(pathToFileURL(join(outDir, 'lineas.js')).href);
const { resaltar } = await import(pathToFileURL(join(outDir, 'resaltar.js')).href);
const { textoParaCorregir } = await import(pathToFileURL(join(outDir, 'texto-para-corregir.js')).href);

let passed = 0;
let failed = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed += 1;
    console.log('  ok   —', name);
  } else {
    failed += 1;
    console.error('  FAIL —', name);
    console.error('          got ', g);
    console.error('          want', w);
  }
}

// Las primeras líneas de game/historia/prologo/01-llegada.md (rpg-copado),
// copiadas acá para no depender de ese repo.
const FIXTURE = `<!--
Escena de ejemplo del formato (borrador, todavía no lo lee el juego).

Cómo se escribe:
- "# Título": nombre de la escena. No se ve en pantalla.
- "[fondo: x]", "[entra: X]", "[sale: X]": la imagen de fondo y quién está en pantalla.
-->

# Prólogo: la llegada

## Prólogo · En el barco

[fondo: barco]
[entra: HERMANO]

> El sol pega sobre el agua. A lo lejos se ven la playa y las palmeras, y la brisa del mar trae olor a sal.

HERMANO (sonriendo): Al fin.

MARINERO: ¡Tierra a la vista!

## Prólogo · El muelle

[fondo: muelle]

[entra: VIAJERO]

HERMANO (serio): ¿Qué está pasando? ¿Por qué se van?

VIAJERO (cansado): Se suponía que esto iba a ser un nuevo comienzo para nuestra familia, pero…

No se puede vivir en un lugar como este.

<!-- Ejemplo de opciones y tirada, para ver cómo se escriben. -->

- Preguntarle qué pasó.
  VIAJERO: ¿No te enteraste? Atacaron otra vez.
- [Perspicacia CD 12] Mirarlo bien: ¿está asustado de verdad o exagera?
  - éxito:
    > Le tiemblan las manos y no deja de mirar hacia el monte. No exagera.
    [recordar: le_creiste_al_viajero]
  - falla:
    > No te das cuenta si es miedo o cansancio.
- No decir nada.

[si: le_creiste_al_viajero]
  HERMANO (triste): Cuide a los suyos.
[si no]
  HERMANO: Que tenga buen viaje.

[sale: VIAJERO]
`;

const clases = (linea, enComentario = false) => resaltar(linea, enComentario).spans.map((s) => s.clase);
const texto = (linea, clase) => {
  const s = resaltar(linea, false).spans.find((x) => x.clase === clase);
  return s ? linea.slice(s.desde, s.hasta) : null;
};

console.log('lineas');
eq('\\r\\n se normaliza', partirLineas('a\r\nb\r\n'), ['a', 'b']);
eq('sin \\n final', partirLineas('a\nb'), ['a', 'b']);
eq('saca UN solo \\n final', partirLineas('a\n\n\n'), ['a', '', '']);
eq('unir pone el \\n final (write_note no agrega nada)', unirLineas(['a', '', 'b']), 'a\n\nb\n');
eq('tabs se conservan', unirLineas(partirLineas('\t- éxito:\n  > x')), '\t- éxito:\n  > x\n');
eq('round-trip de la fixture', unirLineas(partirLineas(FIXTURE)), FIXTURE);
// Review: un archivo que termina en líneas en blanco no pierde una por guardado.
for (const x of ['a\n', 'a\n\n', 'a\n\n\n', '\n', '\n\n']) {
  eq(`round-trip exacto de ${JSON.stringify(x)}`, unirLineas(partirLineas(x)), x);
}
eq('sin \\n final gana uno (único cambio aceptado)', unirLineas(partirLineas('a')), 'a\n');
// Pegado: el \n final del portapapeles es una línea más (pegar líneas enteras
// al principio de otra no las pega a esa).
eq('pegado con \\n final', partirPegado('A\nB\n'), ['A', 'B', '']);
eq('pegado sin \\n final', partirPegado('A\r\nB'), ['A', 'B']);
// Shift+Tab: hasta dos espacios o un tab.
eq('desindentar 2 espacios', cuantoDesindentar('  x'), 2);
eq('desindentar 1 espacio', cuantoDesindentar(' x'), 1);
eq('desindentar tab', cuantoDesindentar('\tx'), 1);
eq('desindentar nada', cuantoDesindentar('x'), 0);

console.log('resaltar');
eq('nombre + gesto + texto', clases('HERMANO (sonriendo): Al fin.'), ['nombre', 'gesto', 'texto']);
eq('nombre recortado', texto('HERMANO (sonriendo): Al fin.', 'nombre'), 'HERMANO');
eq('gesto con paréntesis', texto('HERMANO (sonriendo): Al fin.', 'gesto'), '(sonriendo)');
eq('texto sin el espacio', texto('HERMANO (sonriendo): Al fin.', 'texto'), 'Al fin.');
eq('nombre sin gesto', clases('MARINERO: ¡Tierra a la vista!'), ['nombre', 'texto']);
eq('nombre con dígito', clases('COMPANERA1: hola'), ['nombre', 'texto']);
eq('nombre con Ñ', clases('NIÑA: hola'), ['nombre', 'texto']);
eq('solo el primer :', texto('VIAJERO: Dijo: que sí', 'texto'), 'Dijo: que sí');
eq('minúscula no es nombre', clases('Hola: chau'), ['texto']);
eq('narración', clases('> El sol pega sobre el agua.'), ['narracion', 'texto']);
eq('narración texto', texto('> El sol pega sobre el agua.', 'texto'), 'El sol pega sobre el agua.');
eq('lugar', clases('## Prólogo · En el barco'), ['lugar']);
eq('título', clases('# Prólogo: la llegada'), ['titulo']);
eq('fondo', clases('[fondo: barco]'), ['instruccion']);
eq('entra con nombre', clases('[entra: VIAJERO]'), ['instruccion', 'nombre']);
eq('sale nombre recortado', texto('[sale: VIAJERO]', 'nombre'), 'VIAJERO');
eq('si no', clases('[si no]'), ['instruccion']);
eq('instrucción con sangría', clases('  [recordar: le_creiste_al_viajero]'), ['instruccion']);
eq('instrucción con sangría arranca después de ella', resaltar('  [si no]', false).spans[0].desde, 2);
eq('opción', clases('- Preguntarle qué pasó.'), ['opcion', 'texto']);
eq('opción con tirada', clases('- [Perspicacia CD 12] Mirarlo bien: ¿está asustado?'), ['opcion', 'tirada', 'texto']);
eq('tirada recortada', texto('- [Perspicacia CD 12] Mirarlo bien.', 'tirada'), '[Perspicacia CD 12]');
eq('texto de la opción con tirada', texto('- [Perspicacia CD 12] Mirarlo bien.', 'texto'), 'Mirarlo bien.');
eq('éxito', clases('  - éxito:'), ['resultado']);
eq('falla', clases('  - falla:'), ['resultado']);
eq('exito sin tilde', clases('- exito:'), ['resultado']);
eq('continuación', clases('No se puede vivir en un lugar como este.'), ['texto']);
eq('vacía', clases(''), []);
eq('solo sangría', clases('   '), []);

console.log('comentarios');
eq('comentario de una línea cierra', resaltar('<!-- Ejemplo -->', false).enComentario, false);
eq('comentario de una línea', clases('<!-- Ejemplo -->'), ['comentario']);
const abierto = resaltar('<!--', false);
eq('abre comentario', abierto.enComentario, true);
eq('instrucción adentro del comentario', clases('[si: algo]', true), ['comentario']);
eq('nombre adentro del comentario', clases('HERMANO: x', true), ['comentario']);
const cierre = resaltar('fin -->', true);
eq('cierra comentario', cierre.enComentario, false);
eq('línea de cierre es comentario', cierre.spans.map((s) => s.clase), ['comentario']);
eq('comentario pegado a texto', clases('HERMANO: hola <!-- ojo -->'), ['nombre', 'texto', 'comentario']);
{
  let en = false;
  for (const l of partirLineas(FIXTURE)) en = resaltar(l, en).enComentario;
  eq('la fixture deja el comentario cerrado', en, false);
}

console.log('textoParaCorregir');
{
  const r = textoParaCorregir([
    'HERMANO (serio): ¿Qué pasa?',
    '[fondo: x]',
    '> Narra.',
    '<!--',
    'HERMANO: adentro',
    '-->',
    '- [Perspicacia CD 12] Mirarlo bien.',
  ]);
  eq('solo la prosa, separada por \\n\\n', r.plain, '¿Qué pasa?\n\nNarra.\n\nMirarlo bien.');
  eq('una línea por tramo', r.tramos.map((t) => t.linea), [0, 2, 6]);
  eq('offsets del primer tramo', r.tramos[0], { linea: 0, desde: 17, hasta: 27, plainStart: 0, plainEnd: 10 });
  eq('el último tramo recorta bien', r.plain.slice(r.tramos[2].plainStart, r.tramos[2].plainEnd), 'Mirarlo bien.');
}
eq('sin prosa, plain vacío', textoParaCorregir(['', '[si no]']).plain, '');
eq('entre tramos siempre \\n\\n, nunca espacio', textoParaCorregir(['A: uno', 'dos']).plain, 'uno\n\ndos');
eq('la sangría no entra', textoParaCorregir(['  VIAJERO: hola']).tramos[0].desde, 11);

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
