#!/usr/bin/env node
// Smoke runner de las funciones puras de scripts/armar-lt-lock.mjs.
// Uso: node scripts/run-lt-lock-smoke.mjs
import { elegirVersion, rutaJava } from './armar-lt-lock.mjs';

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

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
