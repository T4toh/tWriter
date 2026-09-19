#!/usr/bin/env node
// Smoke runner del estado de la novela y su historial de revisiones.
// Uso: node scripts/run-estados-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'estados-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  ['--target', 'es2022', '--ignoreConfig', '--module', 'commonjs', '--strict',
   '--skipLibCheck', '--outDir', outDir, 'src/app/core/estado-libro.ts'],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(r.status ?? 1);
}

const {
  estadoLibro,
  esEstadoLibro,
  admiteCapitulosNuevos,
  selloRevision,
  esSelloRevision,
  ultimaRevisionMs,
  necesitaRevisar,
} = await import(pathToFileURL(join(outDir, 'estado-libro.js')).href);

let fails = 0;
function check(nombre, got, want) {
  if (got === want) { console.log(`ok   ${nombre}`); return; }
  fails++;
  console.log(`FAIL ${nombre}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
}

check('estado válido pasa derecho', estadoLibro('publicada'), 'publicada');
check('sin estado arranca en curso', estadoLibro(undefined), 'en_curso');
check('estado basura cae al default', estadoLibro('finalizada'), 'en_curso');
check('esEstadoLibro rechaza el bool viejo', esEstadoLibro(true), false);

check('en curso admite capítulos', admiteCapitulosNuevos('en_curso'), true);
check('terminada ya no', admiteCapitulosNuevos('terminada'), false);
check('publicada tampoco', admiteCapitulosNuevos('publicada'), false);

// Hora local a propósito: es la que el autor ve en el nombre del EPUB.
check('sello rellena mes, día, hora y minuto',
  selloRevision(new Date(2026, 8, 4, 9, 5)), '2026-09-04T09:05');
check('sello a medianoche', selloRevision(new Date(2026, 11, 31, 0, 0)), '2026-12-31T00:00');

// El campo de texto del modal de configuración deja tipear cualquier cosa:
// el picker nativo no se puede usar en WebKitGTK.
check('sello tipeado bien', esSelloRevision('2026-09-19T21:33'), true);
check('sello sin hora no alcanza', esSelloRevision('2026-09-19'), false);
check('solo el año no es un sello', esSelloRevision('2026'), false);
check('la fecha en formato argentino no', esSelloRevision('19/09/2026'), false);
check('con segundos tampoco', esSelloRevision('2026-09-19T21:33:10'), false);
check('la T va en mayúscula', esSelloRevision('2026-09-19t21:33'), false);
check('vacío no', esSelloRevision(''), false);
check('mes 13 no', esSelloRevision('2026-13-01T00:00'), false);
// El caso que el `Date` solo deja pasar: no es inválido, rueda al 3 de marzo.
check('31 de febrero no, aunque Date lo acepte', esSelloRevision('2026-02-31T00:00'), false);
check('29 de febrero bisiesto sí', esSelloRevision('2024-02-29T00:00'), true);
check('lo que escupe selloRevision siempre valida',
  esSelloRevision(selloRevision(new Date(2026, 0, 1, 0, 0))), true);

const tarde = new Date(2026, 8, 18, 14, 30).getTime();
check('última revisión sin lista', ultimaRevisionMs(undefined), null);
check('última revisión ignora el orden de la lista',
  ultimaRevisionMs(['2026-09-18T14:30', '2026-08-01T10:00']), tarde);
check('última revisión saltea sellos rotos',
  ultimaRevisionMs(['no es fecha', '2026-09-18T14:30']), tarde);
check('todos los sellos rotos es como no tener ninguno',
  ultimaRevisionMs(['no es fecha']), null);

const despues = tarde + 60_000;
const antes = tarde - 60_000;
check('un libro en curso nunca necesita revisión',
  necesitaRevisar('en_curso', [], despues), false);
check('terminada sin revisiones necesita',
  necesitaRevisar('terminada', [], antes), true);
check('publicada sin revisiones necesita',
  necesitaRevisar('publicada', undefined, antes), true);
check('editado después de la última revisión necesita',
  necesitaRevisar('publicada', ['2026-09-18T14:30'], despues), true);
check('revisado después de la última edición no necesita',
  necesitaRevisar('publicada', ['2026-09-18T14:30'], antes), false);
check('sin fecha de edición alcanza con haber revisado',
  necesitaRevisar('terminada', ['2026-09-18T14:30'], undefined), false);

rmSync(outDir, { recursive: true, force: true });
if (fails) { console.error(`\n${fails} fallo(s)`); process.exit(1); }
console.log('\nestados smoke OK');
