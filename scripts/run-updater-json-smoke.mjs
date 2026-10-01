#!/usr/bin/env node
// Smoke de scripts/updater-json.mjs: las 8 claves del updater salen de las 4
// firmas, y si falta una el script corta en vez de subir un latest.json rengo.
// Uso: node scripts/run-updater-json-smoke.mjs
import { armarLatest } from './updater-json.mjs';

let fails = 0;
const check = (nombre, ok, extra) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} — ${nombre}`);
  if (!ok) {
    fails += 1;
    if (extra !== undefined) console.log('      ', extra);
  }
};

const sigs = {
  'tWriter_aarch64.app.tar.gz.sig': 'SIG-ARM\n',
  'tWriter_x64.app.tar.gz.sig': 'SIG-X64',
  'tWriter_0.24.0_amd64.deb.sig': 'SIG-DEB',
  'tWriter_0.24.0_x64-setup.exe.sig': 'SIG-EXE',
};
const l = armarLatest(sigs, '0.24.0', '2026-10-01T00:00:00.000Z');
const claves = Object.keys(l.platforms).sort();
check('las 8 claves de v0.23.0', claves.join() === [
  'darwin-aarch64', 'darwin-aarch64-app', 'darwin-x86_64', 'darwin-x86_64-app',
  'linux-x86_64', 'linux-x86_64-deb', 'windows-x86_64', 'windows-x86_64-nsis',
].join(), claves);
check('Intel no agarra la firma de ARM', l.platforms['darwin-x86_64'].signature === 'SIG-X64');
check('la firma va sin el salto de línea', l.platforms['darwin-aarch64'].signature === 'SIG-ARM');
check('url al archivo sin .sig', l.platforms['linux-x86_64'].url.endsWith('/tWriter_0.24.0_amd64.deb'));
check('versión y fecha', l.version === '0.24.0' && l.pub_date === '2026-10-01T00:00:00.000Z');

const sinLinux = { ...sigs };
delete sinLinux['tWriter_0.24.0_amd64.deb.sig'];
let tiro = false;
try { armarLatest(sinLinux, '0.24.0', 'x'); } catch (e) { tiro = /_amd64\.deb/.test(e.message); }
check('si falta una firma, corta y dice cuál', tiro);

if (fails) { console.error(`\n${fails} fallo(s)`); process.exit(1); }
console.log('\nupdater-json smoke OK');
