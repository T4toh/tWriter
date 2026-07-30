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
  // Documenta la rama <p> del converter. El caller no puede producir este
  // input: los rangos del validador viven siempre adentro de un textblock
  // (`extractPlainText` emite \n\n por bloque y por hard break), así que
  // `doc.slice` nunca devuelve nodos de bloque.
  const out = convertFragmentHtml('<p>"Hola", dijo Ana.</p><p>"Chau", respondió.</p>');
  check(
    'fragmento con <p> → convierte cada párrafo sin colapsarlos',
    out === '<p>—Hola, dijo Ana.</p><p>—Chau, respondió.</p>',
    out,
  );
}
{
  // El markup de apertura corre la comilla de la posición 0 y el ancla ^(\s*)"
  // de D1 no dispara. Nada que convertir → null, y el caller avisa.
  const out = convertFragmentHtml('<em>"Vení"</em>, dijo ella.');
  check('diálogo que arranca con <em> → null (D1 no puede anclar)', out === null, out);
}
{
  // El que motivó el finding: sin el guard de normalización, `convert()`
  // devolvía el mismo párrafo con “” degradadas a "" y sin raya, y la
  // transacción lo escribía.
  const out = convertFragmentHtml('<em>“Vení”</em>, dijo ella.');
  check(
    'idem con comillas tipográficas → null (no degrada “” a "")',
    out === null,
    out,
  );
}
{
  const out = convertFragmentHtml('<strong>"Vení"</strong>, dijo ella.');
  check('diálogo que arranca con <strong> → null', out === null, out);
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
