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

const { aplicarEnCapitulo } = await import(
  pathToFileURL(join(outDir, 'revision/deteccion.js')).href
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
  const res = aplicarEnCapitulo(html, 'en', todo);
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
  const res = aplicarEnCapitulo(html, null, todo);
  check('EN sin idioma seteado: sin rayas españolas', !res.html.includes('—'), res.html);
}
{
  // ES sin convertir, todo tildado: rayas tiene que convertir el diálogo.
  const html = '<p>"No sé," dijo ella. "De verdad."</p>';
  const res = aplicarEnCapitulo(html, 'es', todo);
  check('ES + todo tildado: convierte a raya', res.html.includes('—'), res.html);
}
{
  // ES ya convertido y limpio: nada que tocar, el html sale igual.
  const html = '<p>—No sé —dijo ella—. De verdad.</p>';
  const res = aplicarEnCapitulo(html, 'es', todo);
  check('ES limpio: html sin cambios', res.html === html, res.html);
  check('ES limpio: sin salteados', res.salteados === 0, res);
}
{
  // Nada tildado: el html no se toca pase lo que pase.
  const html = '<p>"No sé," dijo ella.</p>';
  const res = aplicarEnCapitulo(html, 'es', { rayas: false, comillas: false, arreglosRae: false });
  check('nada tildado: html sin cambios', res.html === html, res.html);
}
{
  // Fix de `pending-conversion` que cruza un tag (cursiva adentro de la
  // comilla): aplicarFixesHtml lo saltea en vez de comerse el `</em>`, y
  // aplicarEnCapitulo tiene que devolver ese salteo, no tragárselo.
  const html = '<p>"No <em>sé,</em>" dijo ella.</p>';
  const res = aplicarEnCapitulo(html, 'es', { rayas: false, comillas: false, arreglosRae: true });
  check('fix que cruza tag: se contabiliza como salteado', res.salteados > 0, res);
  check('fix que cruza tag: el html no se toca', res.html === html, res.html);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
