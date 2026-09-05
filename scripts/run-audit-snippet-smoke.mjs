#!/usr/bin/env node
// Smoke runner del snippet y el ancla de las auditorías (RAE y repeticiones).
// No es parte del build de Angular: compila el TS a un dir temporal y corre
// las aserciones.
// Uso: node scripts/run-audit-snippet-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'audit-snippet-smoke-'));

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
    'src/app/core/audit-snippet.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'audit-snippet.js')).href);
const { auditSnippet, auditAnchor, auditTitleFromPath, AUDIT_MARGIN } = mod;

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

console.log('auditSnippet');
{
  const plain = 'Era una nave oscura, oscura como el vacío.';
  const off = plain.indexOf('oscura', 15);
  const s = auditSnippet(plain, off, 6);
  check('marca la ocurrencia entre ‹›', s.includes('‹oscura›'), s);
  check('sin elipsis si entra entero', !s.startsWith('…') && !s.endsWith('…'), s);
}
{
  // Texto más largo que el margen a los dos lados: tiene que recortar y avisar.
  const relleno = 'x'.repeat(200);
  const plain = `${relleno} nave ${relleno}`;
  const off = plain.indexOf('nave');
  const s = auditSnippet(plain, off, 4);
  check('elipsis a la izquierda', s.startsWith('…'), s.slice(0, 12));
  check('elipsis a la derecha', s.endsWith('…'), s.slice(-12));
  // La ventana de AUDIT_MARGIN se cuenta en chars, y el espacio que separa la
  // ocurrencia del relleno es uno de ellos: quedan MARGIN-1 `x` de cada lado.
  const flanco = 'x'.repeat(AUDIT_MARGIN - 1);
  check(
    'el contexto es de AUDIT_MARGIN chars a cada lado',
    s === `…${flanco} ‹nave› ${flanco}…`,
    s,
  );
}
{
  // El snippet SÍ puede cruzar el borde de bloque: es para leer, no para
  // matchear. Cortarlo dejaría snippets mutilados al inicio de cada párrafo.
  const plain = 'Fin del primero.\n\nNave al principio del segundo.';
  const off = plain.indexOf('Nave');
  check('cruza el \\n\\n', auditSnippet(plain, off, 4).includes('primero'), auditSnippet(plain, off, 4));
}
{
  const plain = 'Sola.';
  check('longitud 0 no rompe', auditSnippet(plain, 0, 0) === '‹›Sola.', auditSnippet(plain, 0, 0));
}

console.log('auditAnchor');
{
  const plain = 'Fin del primero.\n\nNave al principio del segundo.';
  const off = plain.indexOf('Nave');
  const a = auditAnchor(plain, off, 4);
  check('NO cruza el \\n\\n hacia atrás', !a.includes('primero'), a);
  check('el ancla es texto literal del plano', plain.includes(a), a);
}
{
  const plain = 'Primero.\n\nAcá está la nave del medio.\n\nTercero.';
  const off = plain.indexOf('nave');
  const a = auditAnchor(plain, off, 4);
  check('NO cruza el \\n\\n hacia adelante', !a.includes('Tercero'), a);
  check('se queda en su bloque entero', a === 'Acá está la nave del medio.', a);
}
{
  const relleno = 'y'.repeat(200);
  const plain = `${relleno} nave ${relleno}`;
  const off = plain.indexOf('nave');
  const a = auditAnchor(plain, off, 4);
  const flancoY = 'y'.repeat(AUDIT_MARGIN - 1);
  check(
    'recorta a AUDIT_MARGIN cuando el bloque es más largo',
    a === `${flancoY} nave ${flancoY}`,
    a,
  );
}
{
  // El highlighter compara literales: el ancla nunca puede traer los `‹›` del
  // snippet ni whitespace de borde, o no matchearía nada.
  const plain = 'Acá está la nave.';
  const a = auditAnchor(plain, plain.indexOf('nave'), 4);
  check('sin marcas ‹›', !a.includes('‹') && !a.includes('›'), a);
  check('sin whitespace en los bordes', a === a.trim(), a);
}

console.log('auditTitleFromPath');
{
  check('pela el .html', auditTitleFromPath('/a/b/03 - Nombre.html') === '03 - Nombre');
  check('funciona con separador de Windows', auditTitleFromPath('a\\b\\05.html') === '05');
  check('sin extensión lo deja igual', auditTitleFromPath('/a/b/07') === '07');
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
