#!/usr/bin/env node
// Smoke runner de las funciones puras de scripts/armar-lt-lock.mjs.
// Uso: node scripts/run-lt-lock-smoke.mjs
import { elegirVersion, lineaDeChangelog, rutaJava, sumarAlChangelog } from './armar-lt-lock.mjs';

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) { passed += 1; console.log('  ok   —', name); }
  else { failed += 1; console.error('  FAIL —', name); if (info !== undefined) console.error('         ', info); }
}

const hoy = new Date('2026-10-28');
const v = (version, f) => ({ version, fecha: new Date(f) });

let r = elegirVersion([v('21.0.13+9', '2026-10-22'), v('21.0.12.1+1', '2026-08-19')], hoy);
check('saltea la de menos de 7 días', r === '21.0.12.1+1', r);
r = elegirVersion([v('6.8', '2026-05-05'), v('6.7', '2025-10-10')], hoy);
check('toma la más nueva elegible', r === '6.8', r);
r = elegirVersion([v('6.7', '2025-10-10'), v('6.8', '2026-05-05')], hoy);
check('no depende del orden de entrada', r === '6.8', r);
r = elegirVersion([v('6.9', '2026-10-27')], hoy);
check('ninguna elegible → null', r === null, r);
r = elegirVersion([v('6.8', '2026-10-21')], hoy);
check('7 días justos entra', r === '6.8', r);

r = rutaJava('jdk-21.0.12.1+1', 'aarch64-apple-darwin');
check('java en Mac arm64', r === 'jdk-21.0.12.1+1-jre/Contents/Home/bin/java', r);
r = rutaJava('jdk-21.0.12.1+1', 'x86_64-apple-darwin');
check('java en Mac Intel', r === 'jdk-21.0.12.1+1-jre/Contents/Home/bin/java', r);
r = rutaJava('jdk-21.0.12.1+1', 'x86_64-unknown-linux-gnu');
check('java en Linux', r === 'jdk-21.0.12.1+1-jre/bin/java', r);
r = rutaJava('jdk-21.0.12.1+1', 'x86_64-pc-windows-msvc');
check('java en Windows', r === 'jdk-21.0.12.1+1-jre/bin/java.exe', r);

const lockA = { lt: '6.8', jre: '21.0.12.1+1' };
r = lineaDeChangelog(lockA, { lt: '6.9', jre: '21.0.12.1+1' });
check('LT nuevo → Changed', r?.tipo === 'Changed' && r.linea.includes('6.9'), r);
r = lineaDeChangelog(lockA, { lt: '6.8', jre: '21.0.13+9' });
check('solo Java → Security', r?.tipo === 'Security' && r.linea.includes('21.0.13+9'), r);
r = lineaDeChangelog(lockA, { lt: '6.9', jre: '21.0.13+9' });
check('los dos → Changed con las dos versiones', r?.tipo === 'Changed' && r.linea.includes('6.9') && r.linea.includes('21.0.13+9'), r);
check('nada cambió → null', lineaDeChangelog(lockA, { ...lockA }) === null);

const base = ['# Changelog', '', '## [Unreleased]', '', '### Changed', '', '- Algo.', '', '## [0.1.0] - 2026-01-01', '', '### Added', '', '- Viejo.', ''].join('\n');
r = sumarAlChangelog(base, 'Changed', 'LanguageTool updated to 6.9.');
check('tipo existente: la línea va debajo del encabezado', r.includes('### Changed\n\n- LanguageTool updated to 6.9.\n- Algo.'), r);
r = sumarAlChangelog(base, 'Security', 'Java runtime updated.');
check('tipo nuevo: se crea dentro de [Unreleased]', r.indexOf('### Security') > r.indexOf('## [Unreleased]') && r.indexOf('### Security') < r.indexOf('## [0.1.0]'), r);
check('tipo nuevo: con su línea', r.includes('### Security\n\n- Java runtime updated.\n'), r);
check('Security va después de Changed', r.indexOf('### Security') > r.indexOf('- Algo.'), r);
r = sumarAlChangelog(base, 'Added', 'Nuevo.');
check('Added va antes de Changed', r.indexOf('### Added') < r.indexOf('### Changed') && r.indexOf('### Added') > r.indexOf('## [Unreleased]'), r);
const vacio = ['# Changelog', '', '## [Unreleased]', '', '## [0.1.0] - 2026-01-01', ''].join('\n');
r = sumarAlChangelog(vacio, 'Security', 'X.');
check('[Unreleased] vacío', r.includes('## [Unreleased]\n\n### Security\n\n- X.\n\n## [0.1.0]'), r);

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
