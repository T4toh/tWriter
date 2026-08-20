#!/usr/bin/env node
// Genera `src/assets/licencias.json`, que es lo que muestra el modal "Acerca de".
//
// Corre en el `prebuild`, así la lista no se pudre cuando cambian las
// dependencias: si agregás o saqués una, el diff del JSON commiteado te avisa.
//
// Cuatro fuentes, ninguna herramienta nueva:
//   1. `LICENSE` y `package.json` del repo — la app y su versión.
//   2. `src-tauri/resources/tesauro/` — los dos textos que SÍ estamos obligados
//      a reproducir (la LGPL 2.1 del tesauro español y la licencia de WordNet).
//   3. Las dependencias directas de `package.json`, con el `license` y el texto
//      que trae cada paquete en `node_modules`.
//   4. Las dependencias directas de `src-tauri/Cargo.toml`, con el `license` que
//      `cargo metadata` ya expone y el texto del crate en el registry local.
//
// Solo lista dependencias DIRECTAS, y el modal lo dice: prometer el árbol
// transitivo entero sin haberlo verificado sería peor que no listarlo.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => readFileSync(p, 'utf8');
const leerSiEstá = (p) => (existsSync(p) ? leer(p) : null);

/** El texto de licencia que trae un paquete, si lo trae. */
function textoDeLicencia(dir) {
  if (!existsSync(dir)) return null;
  const candidato = readdirSync(dir).find((f) => /^(LICEN[SC]E|COPYING)/i.test(f));
  if (!candidato) return null;
  const texto = leerSiEstá(join(dir, candidato));
  // Un `LICENSE` que es un symlink roto o un directorio no sirve de nada.
  return texto && texto.trim().length > 0 ? texto.trim() : null;
}

// ── 1. La app ────────────────────────────────────────────────────────────────
const pkg = JSON.parse(leer(join(repo, 'package.json')));
const app = {
  nombre: 'tWriter',
  version: pkg.version,
  licencia: 'MIT',
  texto: leer(join(repo, 'LICENSE')).trim(),
  repo: 'https://github.com/T4toh/tWriter',
};

// ── 2. Los datos de terceros que shipeamos ───────────────────────────────────
const tesauro = join(repo, 'src-tauri', 'resources', 'tesauro');
const datos = [
  {
    nombre: 'OpenThesaurus-es (th_es_v2.dat)',
    descripcion:
      'Tesauro de sinónimos en español, de Marcelo Garrone, tal como lo distribuye ' +
      'LibreOffice. Se incluye sin ninguna modificación, byte por byte, que es lo que ' +
      'pide su licencia.',
    licencia: 'LGPL-2.1',
    texto: leer(join(tesauro, 'COPYING-LGPL-2.1.txt')).trim(),
  },
  {
    nombre: 'WordNet 2.1 (th_en_us.dat)',
    descripcion:
      'Tesauro de sinónimos en inglés, derivado de WordNet 2.1 (Princeton University) ' +
      'vía LibreOffice. Modificado: se le quitaron las relaciones que no son sinonimia ' +
      '(«related term», «similar term», «antonym») y se le pelaron las etiquetas a los ' +
      'hiperónimos. El detalle está en scripts/podar-tesauro-en.mjs.',
    licencia: 'WordNet',
    texto: leer(join(tesauro, 'WordNet_license.txt')).trim(),
  },
];

// ── 3. npm ───────────────────────────────────────────────────────────────────
const paquetes = [];
for (const [nombre, rango] of Object.entries(pkg.dependencies ?? {})) {
  const dir = join(repo, 'node_modules', nombre);
  const propio = leerSiEstá(join(dir, 'package.json'));
  const meta = propio ? JSON.parse(propio) : {};
  paquetes.push({
    nombre,
    version: meta.version ?? rango,
    origen: 'npm',
    licencia: typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'desconocida'),
    texto: textoDeLicencia(dir),
  });
}

// ── 4. crates ────────────────────────────────────────────────────────────────
const cargoToml = leer(join(repo, 'src-tauri', 'Cargo.toml'));
// El bloque `[dependencies]` hasta la próxima sección. Alcanza un parseo de
// líneas: no queremos un parser de TOML por esto.
const bloque = cargoToml.split(/^\[dependencies\]$/m)[1]?.split(/^\[/m)[0] ?? '';
const directas = new Set(
  bloque
    .split('\n')
    .map((l) => l.match(/^([A-Za-z0-9_-]+)\s*=/)?.[1])
    .filter(Boolean),
);
const metadata = JSON.parse(
  execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--manifest-path', join(repo, 'src-tauri', 'Cargo.toml')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ),
);
for (const crate of metadata.packages) {
  if (!directas.has(crate.name)) continue;
  paquetes.push({
    nombre: crate.name,
    version: crate.version,
    origen: 'cargo',
    licencia: crate.license ?? 'desconocida',
    // `manifest_path` apunta al Cargo.toml del crate en el registry local.
    texto: textoDeLicencia(dirname(crate.manifest_path)),
  });
}

// ── Textos deduplicados ──────────────────────────────────────────────────────
// El texto de Apache-2.0 son 11 KB y lo traen diecisiete crates idénticas: sin
// deduplicar, el JSON se va a 197 KB de licencia repetida. Cada paquete guarda
// el índice de su texto en `textos`.
const textos = [];
const índiceDe = new Map();
for (const p of paquetes) {
  if (!p.texto) {
    p.texto = null;
    continue;
  }
  if (!índiceDe.has(p.texto)) {
    índiceDe.set(p.texto, textos.length);
    textos.push(p.texto);
  }
  p.texto = índiceDe.get(p.texto);
}

// ── Agrupado por licencia ────────────────────────────────────────────────────
const porLicencia = new Map();
for (const p of paquetes.sort((a, b) => a.nombre.localeCompare(b.nombre))) {
  if (!porLicencia.has(p.licencia)) porLicencia.set(p.licencia, []);
  porLicencia.get(p.licencia).push(p);
}
const grupos = [...porLicencia.entries()]
  .map(([licencia, lista]) => ({ licencia, paquetes: lista }))
  .sort((a, b) => b.paquetes.length - a.paquetes.length);

const salida = { app, datos, grupos, textos };

// ── Invariantes ──────────────────────────────────────────────────────────────
// Estos asserts SON el test del script: si alguna vez el JSON sale sin los dos
// textos que estamos obligados a reproducir, el build tiene que fallar y no
// shipear una pantalla de licencias incompleta.
const fallar = (msg) => {
  console.error(`generar-licencias: ${msg}`);
  process.exit(1);
};
if (!app.version) fallar('package.json sin version');
if (!app.texto.includes('MIT License')) fallar('LICENSE no parece la MIT');
for (const d of datos) {
  if (!d.texto || d.texto.length < 500) fallar(`el texto de ${d.nombre} salió vacío o cortado`);
}
if (paquetes.length === 0) fallar('no se listó ninguna dependencia');
if (!paquetes.some((p) => p.origen === 'cargo')) fallar('no se listó ninguna crate');

writeFileSync(join(repo, 'src', 'assets', 'licencias.json'), JSON.stringify(salida, null, 2) + '\n');
const conTexto = paquetes.filter((p) => p.texto !== null).length;
console.log(
  `licencias.json: ${paquetes.length} dependencias directas ` +
    `(${conTexto} con texto, ${textos.length} textos únicos), ` +
    `${grupos.length} licencias distintas, ${datos.length} datos de terceros.`,
);
