import { BR_RE, ENTITY_MAP, P_BLOCK_RE } from './validator';

const BR_SOLO_RE = /^<br\s*\/?>$/i;

/**
 * Igual que `htmlToPlain` de `validator.ts`, pero además devuelve el índice en
 * el HTML de cada carácter del plano.
 *
 * Existe porque las violaciones de `validateRae` traen offsets sobre el plano y
 * el archivo en disco es HTML: sin el mapa, aplicar un fix obliga a reconstruir
 * el HTML desde texto plano, que es como se pierden `<em>` y `<strong>`.
 *
 * `plain` DEBE salir idéntico al de `htmlToPlain`. Si las dos se desalinean los
 * fixes se aplican en el lugar equivocado y en silencio, así que el smoke
 * runner compara las dos salidas sobre HTML reales.
 */
export function planoConMapa(html: string): { plain: string; mapa: Int32Array } {
  const chars: string[] = [];
  const idx: number[] = [];
  // Buffer de la parte en curso (un bloque, o un tramo entre dos `<br>`).
  let parteChars: string[] = [];
  let parteIdx: number[] = [];

  const cerrarParte = (): void => {
    // El `.trim()` de `pushIfText`, recortando los dos arrays a la vez.
    let a = 0;
    let b = parteChars.length;
    while (a < b && /\s/.test(parteChars[a])) a += 1;
    while (b > a && /\s/.test(parteChars[b - 1])) b -= 1;
    if (b <= a) {
      parteChars = [];
      parteIdx = [];
      return; // parte vacía: se descarta, igual que `pushIfText`
    }
    if (chars.length > 0) {
      // El separador `\n\n` no existe en el HTML: se lo ancla al final del
      // bloque anterior. Ningún fix cae sobre un separador, pero el mapa
      // necesita una entrada por carácter para que los índices no se corran.
      const ancla = idx[idx.length - 1] + 1;
      chars.push('\n', '\n');
      idx.push(ancla, ancla);
    }
    for (let k = a; k < b; k += 1) {
      chars.push(parteChars[k]);
      idx.push(parteIdx[k]);
    }
    parteChars = [];
    parteIdx = [];
  };

  const comerChunk = (chunk: string, base: number): void => {
    let i = 0;
    while (i < chunk.length) {
      const c = chunk[i];
      if (c === '<') {
        const fin = chunk.indexOf('>', i);
        if (fin === -1) {
          // `<` suelto: es texto.
          parteChars.push(c);
          parteIdx.push(base + i);
          i += 1;
          continue;
        }
        const tag = chunk.slice(i, fin + 1);
        if (BR_SOLO_RE.test(tag)) cerrarParte();
        i = fin + 1;
        continue;
      }
      if (c === '&') {
        const entidad = Object.keys(ENTITY_MAP).find((e) => chunk.startsWith(e, i));
        if (entidad) {
          parteChars.push(ENTITY_MAP[entidad]);
          parteIdx.push(base + i);
          i += entidad.length;
          continue;
        }
      }
      parteChars.push(c);
      parteIdx.push(base + i);
      i += 1;
    }
    cerrarParte();
  };

  // Mismo recorrido de bloques que `htmlToPlain`.
  const matches = Array.from(html.matchAll(P_BLOCK_RE));
  if (matches.length === 0) {
    comerChunk(html, 0);
  } else {
    let last = 0;
    for (const m of matches) {
      const start = m.index ?? 0;
      comerChunk(html.slice(last, start), last);
      // `m[1]` es el interior del `<p>`; su base es start + largo de la tag de
      // apertura.
      const apertura = m[0].length - m[1].length - '</p>'.length;
      comerChunk(m[1], start + apertura);
      last = start + m[0].length;
    }
    comerChunk(html.slice(last), last);
  }

  return { plain: chars.join(''), mapa: Int32Array.from(idx) };
}
