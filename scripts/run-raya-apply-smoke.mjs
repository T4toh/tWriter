#!/usr/bin/env node
// Smoke runner de `convertFragmentHtml` (editor/raya-convert.ts). No es parte
// del build de Angular. Compila los TS necesarios a un dir temporal y corre las
// aserciones. Uso: node scripts/run-raya-apply-smoke.mjs
//
// Solo cubre la mitad SIN DOM. `serializeRange` (editor/raya-apply.ts) importa
// @tiptap/core y no se puede cargar en node: se valida con `pnpm build` + el
// checklist manual, igual que `highlightFirstMatch`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'raya-apply-smoke-'));

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
    'src/app/editor/raya-convert.ts',
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

const mod = await import(pathToFileURL(join(outDir, 'editor/raya-convert.js')).href);
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
  check('el markup no se pierde en un inciso simple', out === '—Hola —dijo <em>Ana</em>.', out);
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
    out === '<p>—Hola —dijo Ana.</p><p>—Chau —respondió.</p>',
    out,
  );
}
{
  // El markup de apertura corría la comilla de la posición 0 y el ancla de D1
  // no disparaba; hoy el converter trabaja sobre el texto sin tags y los
  // vuelve a poner.
  const out = convertFragmentHtml('<em>"Vení"</em>, dijo ella.');
  check('diálogo que arranca con <em> → convierte y la cursiva queda', out === '—<em>Vení</em> —dijo ella.', out);
}
{
  const out = convertFragmentHtml('<em>“Vení”</em>, dijo ella.');
  check('idem con comillas tipográficas', out === '—<em>Vení</em> —dijo ella.', out);
}
{
  const out = convertFragmentHtml('<strong>"Vení"</strong>, dijo ella.');
  check('diálogo que arranca con <strong>', out === '—<strong>Vení</strong> —dijo ella.', out);
}
{
  // El que motivó el guard de normalización: sin él, `convert()` devolvía el
  // mismo párrafo con “” degradadas a "" y sin raya, y la transacción lo
  // escribía. Un párrafo donde ninguna regla muerde tiene que dar null.
  const out = convertFragmentHtml('La palabra “fin” dice mucho.');
  check('sin diálogo → null (no degrada “” a "")', out === null, out);
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
