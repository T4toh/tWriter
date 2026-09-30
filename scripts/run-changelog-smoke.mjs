#!/usr/bin/env node
// Smoke runner de scripts/changelog.mjs: Keep a Changelog + SemVer.
// Uso: node scripts/run-changelog-smoke.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cerrar, extraer, nivelMinimo, siguiente, tiposSinPublicar, ultimaVersion } from './changelog.mjs';

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) { passed += 1; console.log('  ok   —', name); }
  else { failed += 1; console.error('  FAIL —', name); if (info !== undefined) console.error('         ', info); }
}
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const R = 'https://github.com/T4toh/tWriter';
const md = (unreleased) => [
  '# Changelog', '', 'Intro.', '',
  '## [Unreleased]', '', ...unreleased, '',
  '## [0.2.0] - 2026-01-02', '', '### Added', '', '- Cambio viejo.', '',
  '## [0.1.0] - 2026-01-01', '', '### Fixed', '', '- Primero.', '',
  `[unreleased]: ${R}/compare/v0.2.0...HEAD`,
  `[0.2.0]: ${R}/compare/v0.1.0...v0.2.0`,
  `[0.1.0]: ${R}/releases/tag/v0.1.0`, '',
].join('\n');
const conFix = md(['### Fixed', '', '- Arreglo.']);
const conAdd = md(['### Added', '', '- Nuevo.', '', '### Fixed', '', '- Arreglo.']);

check('ultimaVersion', ultimaVersion(conFix)?.join('.') === '0.2.0');
check('tiposSinPublicar', tiposSinPublicar(conAdd).join() === 'Added,Fixed');
check('tipo desconocido falla', /no es un tipo/.test(throws(() => tiposSinPublicar(md(['### Agregado', '- x']))) ?? ''));
check('ítem sin tipo falla', /fuera de un/.test(throws(() => tiposSinPublicar(md(['- suelto']))) ?? ''));
check('nivelMinimo: solo Fixed → patch', nivelMinimo(['Fixed'], 0) === 'patch');
check('nivelMinimo: Added → minor', nivelMinimo(['Added', 'Fixed'], 0) === 'minor');
check('nivelMinimo: Removed en 0.x → minor', nivelMinimo(['Removed'], 0) === 'minor');
check('nivelMinimo: Removed desde 1.0 → major', nivelMinimo(['Removed'], 1) === 'major');
check('siguiente', siguiente([0, 2, 0], 'patch') === '0.2.1' && siguiente([0, 2, 3], 'minor') === '0.3.0' && siguiente([0, 2, 3], 'major') === '1.0.0');

const cerrado = cerrar(conFix, '0.2.1', '2026-02-03');
check('cerrar abre un [Unreleased] vacío arriba', cerrado.includes('## [Unreleased]\n\n## [0.2.1] - 2026-02-03\n\n### Fixed\n\n- Arreglo.'), cerrado);
check('cerrar actualiza los links', cerrado.includes(`[unreleased]: ${R}/compare/v0.2.1...HEAD\n[0.2.1]: ${R}/compare/v0.2.0...v0.2.1\n[0.2.0]:`), cerrado.slice(-300));
check('cerrar vacío falla', /vacía/.test(throws(() => cerrar(cerrado, '0.2.2', 'x')) ?? ''));
check('patch con Added falla (pide minor)', /pide minor \(0\.3\.0\)/.test(throws(() => cerrar(conAdd, '0.2.1', 'x')) ?? ''));
check('minor con solo Fixed se deja (más grande está bien)', cerrar(conFix, '0.3.0', 'x').includes('## [0.3.0] - x'));
check('salto que no es SemVer falla', /no sigue a/.test(throws(() => cerrar(conFix, '0.4.0', 'x')) ?? ''));

check('extraer con o sin «v»', extraer(conFix, 'v0.2.0') === '### Added\n\n- Cambio viejo.' && extraer(conFix, '0.2.0') === extraer(conFix, 'v0.2.0'), extraer(conFix, 'v0.2.0'));
check('extraer la última no se lleva los links', extraer(conFix, 'v0.1.0') === '### Fixed\n\n- Primero.', extraer(conFix, 'v0.1.0'));
check('extraer una versión que no está da vacío', extraer(conFix, 'v9.9.9') === '');

// El CHANGELOG.md real respeta el formato.
const real = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
check('CHANGELOG.md: [Unreleased] con tipos válidos', Array.isArray(tiposSinPublicar(real)));
check('CHANGELOG.md: v0.22.0 se extrae', extraer(real, 'v0.22.0').startsWith('### Added'));
check('CHANGELOG.md: tiene links de comparación', /^\[unreleased\]: .+\.\.\.HEAD$/m.test(real));
const tiposUsados = [...real.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
check('CHANGELOG.md: solo tipos de Keep a Changelog', tiposUsados.every((t) => ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'].includes(t)), [...new Set(tiposUsados)]);

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
