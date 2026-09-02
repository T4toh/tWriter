import { ENTITY_MAP, P_BLOCK_RE } from './validator';

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
 *
 * OJO con las entidades: `htmlToPlain` (vía `stripInline`) primero saca TODOS
 * los tags del bloque y recién después corre una pasada global por cada
 * entrada de `ENTITY_MAP`, en su orden de inserción (`nbsp, amp, lt, gt,
 * quot, #39, hellip, mdash, ndash`). Eso es intencional replicar, no un bug a
 * corregir acá: produce doble decodificación (`&amp;lt;` → pasada `amp` da
 * `&lt;` → pasada `lt` la vuelve a decodificar a `<`) y hace que un `&`
 * partido por un tag inline (`&<em>amp;</em>fin`) sí se una y decodifique,
 * porque para cuando corren las pasadas de entidades los tags ya no están.
 * Por eso acá se hace en dos fases por parte (bloque, o tramo entre `<br>`):
 * primero se sacan los tags dejando el `&` como carácter común, después se
 * corren las mismas pasadas secuenciales de `ENTITY_MAP` sobre el buffer ya
 * sin tags.
 */
export function planoConMapa(html: string): { plain: string; mapa: Int32Array } {
  const chars: string[] = [];
  const idx: number[] = [];
  // Buffer de la parte en curso (un bloque, o un tramo entre dos `<br>`), ya
  // sin tags pero todavía con entidades sin decodificar.
  let parteChars: string[] = [];
  let parteIdx: number[] = [];

  // Una pasada de `text.split(entidad).join(char)`, pero sobre el par de
  // arrays paralelos en vez de sobre un string. El índice que sobrevive de
  // cada match es el del primer carácter de la secuencia reemplazada — así,
  // en un doble decode, el carácter final sigue apuntando al `&` original.
  const decodificarUnaVez = (
    entidad: string,
    reemplazo: string,
  ): void => {
    const outChars: string[] = [];
    const outIdx: number[] = [];
    let i = 0;
    while (i < parteChars.length) {
      let matchea = i + entidad.length <= parteChars.length;
      for (let k = 0; matchea && k < entidad.length; k += 1) {
        if (parteChars[i + k] !== entidad[k]) matchea = false;
      }
      if (matchea) {
        outChars.push(reemplazo);
        outIdx.push(parteIdx[i]);
        i += entidad.length;
      } else {
        outChars.push(parteChars[i]);
        outIdx.push(parteIdx[i]);
        i += 1;
      }
    }
    parteChars = outChars;
    parteIdx = outIdx;
  };

  const cerrarParte = (): void => {
    for (const entidad of Object.keys(ENTITY_MAP)) {
      decodificarUnaVez(entidad, ENTITY_MAP[entidad]);
    }
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
      // Las entidades NO se decodifican acá: recién en `cerrarParte`, sobre
      // el buffer ya sin tags — ver comentario de cabecera.
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
