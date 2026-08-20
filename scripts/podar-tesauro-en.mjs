#!/usr/bin/env node
// Poda el tesauro inglés de WordNet (el que shipea LibreOffice) para bundlearlo
// en tWriter. A los sinónimos etiquetados `(generic term)` se les pela la
// etiqueta y se conserva la palabra (`vessel (generic term)` → `vessel`), pero
// se los manda al final de la acepción: para cambiar una palabra repetida en
// una novela un hiperónimo es un reemplazo aceptable y el autor lo ve antes de
// aceptarlo, pero lo bueno (los sinónimos reales) tiene que salir primero
// porque `MAX_SINONIMOS` de `tesauro.rs` corta la acepción en 12. Los etiquetados `(related term)`,
// `(similar term)` y `(antonym)` sí se descartan enteros: no son sinónimos.
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

const DESCARTAR = /\((related|similar) term\)|\(antonym\)/;
const GENERICO = /\s*\(generic term\)\s*/;
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
    const normales = [];
    const genericos = [];
    for (const s of campos.slice(1)) {
      if (s.trim() === '' || DESCARTAR.test(s)) continue;
      if (GENERICO.test(s)) genericos.push(s.replace(GENERICO, '').trim());
      else normales.push(s);
    }
    const sinonimos = [...normales, ...genericos];
    if (sinonimos.length > 0) acepciones.push([campos[0], ...sinonimos].join('|'));
  }
  if (acepciones.length === 0) continue;
  out.push(`${palabra}|${acepciones.length}`, ...acepciones);
  entradas += 1;
}

const texto = out.join('\n') + '\n';
writeFileSync(dst, texto);
console.log(`${entradas} entradas · ${(Buffer.byteLength(texto) / 1e6).toFixed(1)} MB`);
