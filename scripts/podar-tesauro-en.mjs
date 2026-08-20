#!/usr/bin/env node
// Poda el tesauro inglés de WordNet (el que shipea LibreOffice) para bundlearlo
// en tWriter. Tira los sinónimos etiquetados `(generic term)`, `(related term)`,
// `(similar term)` y `(antonym)`: son hiperónimos y relaciones de WordNet, ruido
// para un novelista (`move` como sinónimo de `ship`). Medido: 18,5 MB → ~6,3 MB.
//
// Recalcula el N de cada entrada y descarta las que quedan sin ninguna acepción,
// porque el parser de `tesauro.rs` confía en que el N coincida con las líneas
// que siguen.
//
// Uso: node scripts/podar-tesauro-en.mjs <th_en_US_v2.dat> <salida.dat>
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('uso: node scripts/podar-tesauro-en.mjs <th_en_US_v2.dat> <salida.dat>');
  process.exit(2);
}

const RUIDO = /\((generic|related|similar) term\)|\(antonym\)/;
const lineas = readFileSync(src, 'utf8').split('\n');
const out = ['UTF-8'];
let entradas = 0;
let i = 1; // la primera línea del .dat es el encoding

while (i < lineas.length) {
  const cabecera = lineas[i];
  i += 1;
  const corte = cabecera.lastIndexOf('|');
  if (corte < 0) continue;
  const n = Number(cabecera.slice(corte + 1));
  if (!Number.isInteger(n) || n < 0) continue;
  const palabra = cabecera.slice(0, corte);
  const acepciones = [];
  for (let k = 0; k < n && i < lineas.length; k += 1, i += 1) {
    const campos = lineas[i].split('|');
    const sinonimos = campos
      .slice(1)
      .filter((s) => s.trim() !== '' && !RUIDO.test(s));
    if (sinonimos.length > 0) acepciones.push([campos[0], ...sinonimos].join('|'));
  }
  if (acepciones.length === 0) continue;
  out.push(`${palabra}|${acepciones.length}`, ...acepciones);
  entradas += 1;
}

const texto = out.join('\n') + '\n';
writeFileSync(dst, texto);
console.log(`${entradas} entradas · ${(Buffer.byteLength(texto) / 1e6).toFixed(1)} MB`);
