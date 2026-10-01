#!/usr/bin/env node
// Arma el `latest.json` del updater con las firmas `.sig` del release.
//
// Lo usa el job `updater-json` de release.yml cuando terminaron todos los
// builds. Antes lo escribía cada `tauri-action` por su cuenta (bajar, sumar su
// plataforma, volver a subir) y dos builds terminando juntos se pisaban: en
// v0.24.0 el de macOS x86_64 falló con 404 al subirlo y quedaron afuera Linux
// y macOS Intel, o sea que esas instalaciones no se iban a enterar del update.
//
// Uso: node scripts/updater-json.mjs <dir-con-los-sig> <version> > latest.json
// Lo prueba scripts/run-updater-json-smoke.mjs.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mismo endpoint que `plugins.updater.endpoints` de tauri.conf.json.
const BASE = 'https://github.com/T4toh/tWriter/releases/latest/download';

// Archivo firmado (por cómo termina su nombre) → las claves que tauri-action
// escribía para él. Son las de v0.23.0, la última que salió entera.
export const PLATAFORMAS = [
  ['_aarch64.app.tar.gz', ['darwin-aarch64', 'darwin-aarch64-app']],
  ['_x64.app.tar.gz', ['darwin-x86_64', 'darwin-x86_64-app']],
  ['_amd64.deb', ['linux-x86_64', 'linux-x86_64-deb']],
  ['_x64-setup.exe', ['windows-x86_64', 'windows-x86_64-nsis']],
];

/** `sigs`: nombre del `.sig` → contenido. Tira si falta alguna plataforma:
 *  un `latest.json` incompleto deja instalaciones sin update, en silencio. */
export function armarLatest(sigs, version, pubDate) {
  const platforms = {};
  const faltan = [];
  for (const [sufijo, claves] of PLATAFORMAS) {
    const sig = Object.keys(sigs).find((n) => n.endsWith(`${sufijo}.sig`));
    if (!sig) {
      faltan.push(sufijo);
      continue;
    }
    const archivo = sig.slice(0, -'.sig'.length);
    for (const k of claves) {
      platforms[k] = { signature: sigs[sig].trim(), url: `${BASE}/${archivo}` };
    }
  }
  if (faltan.length) throw new Error(`faltan firmas para: ${faltan.join(', ')}`);
  return { version, notes: '', pub_date: pubDate, platforms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) {
    console.error('uso: node scripts/updater-json.mjs <dir-con-los-sig> <version>');
    process.exit(2);
  }
  const sigs = {};
  for (const n of readdirSync(dir)) {
    if (n.endsWith('.sig')) sigs[n] = readFileSync(join(dir, n), 'utf8');
  }
  const latest = armarLatest(sigs, version.replace(/^v/, ''), new Date().toISOString());
  process.stdout.write(JSON.stringify(latest, null, 2) + '\n');
}
