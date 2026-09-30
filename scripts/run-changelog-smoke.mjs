#!/usr/bin/env node
// Smoke runner de scripts/changelog.mjs (cerrar y extraer secciones).
// Uso: node scripts/run-changelog-smoke.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cerrar, extraer } from './changelog.mjs';

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) { passed += 1; console.log('  ok   —', name); }
  else { failed += 1; console.error('  FAIL —', name); if (info !== undefined) console.error('         ', info); }
}
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const md = [
  '# Changelog', '', 'Intro.', '',
  '## Sin publicar', '', '- Cosa nueva.', '',
  '## v0.2.0 — 2026-01-02', '', '### Grupo', '- Cambio viejo.', '',
  '## Historial anterior', '', '### v0.1.0 — 2026-01-01', '- Primero.', '',
].join('\n');

const cerrado = cerrar(md, '0.3.0', '2026-02-03');
check('cerrar abre una «Sin publicar» vacía arriba', cerrado.includes('## Sin publicar\n\n## v0.3.0 — 2026-02-03\n\n- Cosa nueva.'), cerrado);
check('cerrar no toca el resto', cerrado.endsWith(md.slice(md.indexOf('## v0.2.0'))));
check('cerrar con «Sin publicar» vacía falla', /vacía/.test(throws(() => cerrar(cerrado, '0.4.0', '2026-03-04')) ?? ''));
check('cerrar una versión repetida falla', /ya tiene/.test(throws(() => cerrar(md.replace('## v0.2.0', '## v0.3.0'), '0.3.0', 'x')) ?? ''));
check('cerrar sin «Sin publicar» falla', /no hay/.test(throws(() => cerrar('# Changelog\n', '0.3.0', 'x')) ?? ''));

check('extraer con o sin «v»', extraer(md, 'v0.2.0') === '### Grupo\n- Cambio viejo.' && extraer(md, '0.2.0') === extraer(md, 'v0.2.0'), extraer(md, 'v0.2.0'));
check('extraer corta en la próxima sección de nivel 2, no en los ###', !extraer(md, 'v0.2.0').includes('Historial'));
check('extraer una versión que no está da vacío', extraer(md, 'v9.9.9') === '');
check('extraer no confunde v0.2.0 con v0.2.01', extraer(md.replace('## v0.2.0 ', '## v0.2.01 '), 'v0.2.0') === '');

// El CHANGELOG.md real: tiene «Sin publicar» y la última versión se extrae.
const real = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
check('CHANGELOG.md tiene «## Sin publicar»', real.includes('\n## Sin publicar\n'));
check('CHANGELOG.md: v0.22.0 se extrae', extraer(real, 'v0.22.0').startsWith('### Diálogos con raya'));

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
