#!/usr/bin/env node
// Smoke runner de `convertFragmentHtml` (editor/rae-convert.ts). No es parte
// del build de Angular. Compila los TS necesarios a un dir temporal y corre las
// aserciones. Uso: node scripts/run-rae-apply-smoke.mjs
//
// Solo cubre la mitad SIN DOM. `serializeRange` (editor/rae-apply.ts) importa
// @tiptap/core y no se puede cargar en node: se valida con `pnpm build` + el
// checklist manual, igual que `highlightFirstMatch`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'rae-apply-smoke-'));

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
    'src/app/editor/rae-convert.ts',
    'src/app/dialogos/converter.ts',
    'src/app/dialogos/tags.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'editor/rae-convert.js')).href);
const { convertFragmentHtml } = mod;

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

console.log('convertFragmentHtml');
{
  // El caso del bug: hasta ahora esto se aplicaba como texto plano y el <em>
  // desaparecía del párrafo.
  const out = convertFragmentHtml('"Vení", dijo <em>ella</em>, "ya mismo".');
  check(
    'diálogo con <em> → raya y la itálica sigue envolviendo las mismas palabras',
    out === '—Vení —dijo <em>ella</em>—, ya mismo.',
    out,
  );
}
{
  const out = convertFragmentHtml('"Hola", dijo <em>Ana</em>.');
  check('el markup no se pierde en un inciso simple', out === '—Hola, dijo <em>Ana</em>.', out);
}
{
  const out = convertFragmentHtml('El <strong>capitán</strong> miró el mar.');
  check('fragmento sin nada que convertir → null', out === null, out);
}
{
  // Rango que cruza bloques: el slice serializa con <p> adentro y el converter
  // entra por su rama <p>, que procesa cada párrafo por separado.
  const out = convertFragmentHtml('<p>"Hola", dijo Ana.</p><p>"Chau", respondió.</p>');
  check(
    'fragmento con <p> → convierte cada párrafo sin colapsarlos',
    out === '<p>—Hola, dijo Ana.</p><p>—Chau, respondió.</p>',
    out,
  );
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
