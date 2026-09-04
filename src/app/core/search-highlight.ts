/** Mapa de vocales acentuadas → base (preserva ñ/Ñ deliberadamente). Espejo de
 *  `fold_accent_char` en `src-tauri/src/search.rs`. */
const ACCENT_MAP: Record<string, string> = {
  á: 'a', à: 'a', ä: 'a', â: 'a', ã: 'a',
  é: 'e', è: 'e', ë: 'e', ê: 'e',
  í: 'i', ì: 'i', ï: 'i', î: 'i',
  ó: 'o', ò: 'o', ö: 'o', ô: 'o', õ: 'o',
  ú: 'u', ù: 'u', ü: 'u', û: 'u',
  Á: 'A', À: 'A', Ä: 'A', Â: 'A', Ã: 'A',
  É: 'E', È: 'E', Ë: 'E', Ê: 'E',
  Í: 'I', Ì: 'I', Ï: 'I', Î: 'I',
  Ó: 'O', Ò: 'O', Ö: 'O', Ô: 'O', Õ: 'O',
  Ú: 'U', Ù: 'U', Ü: 'U', Û: 'U',
};

/**
 * Pliega acentos preservando ñ. **LENGTH-PRESERVING** (1 code unit → 1 code
 * unit): cada clave y valor es un único char BMP, así que `foldAccents(s)` tiene
 * el mismo largo que `s` y `foldAccents(s)[i]` alinea con `s[i]`. Eso permite
 * comparar sobre el string plegado pero marcar/seleccionar el substring ORIGINAL
 * (con tilde) usando los mismos offsets — clave para que `offsetToPm` y los
 * `Range` DOM no se desfasen. Espejo de `fold_accents` en `search.rs`.
 *
 * (`toLowerCase()` también es length-preserving para el dominio ES/latino; el
 * código ya asumía esto al usar `t.length` post-lowercase.)
 */
export function foldAccents(s: string): string {
  let out = '';
  for (const ch of s) out += ACCENT_MAP[ch] ?? ch;
  return out;
}

/** Largo hasta el cual un término se exige como palabra COMPLETA. Buscar el
 *  prefijo `ya` o `que` no sirve para nada y matchea en media novela; buscar el
 *  prefijo `golpear` o `caballera` es justo lo que hace falta al corregir.
 *  Mismo umbral que `FUZZY_LEN_EXACT_MAX` en `search.rs`. */
const TERMINO_CORTO_MAX = 3;

/** True si `idx` cae en el arranque de una palabra dentro de `text`, o sea si
 *  el char anterior no es letra ni número. */
export function esInicioDePalabra(text: string, idx: number): boolean {
  if (idx <= 0) return true;
  return !/[\p{L}\p{N}]/u.test(text[idx - 1]);
}

/** True si `idx` cae en el final de una palabra, o sea si el char siguiente no
 *  es letra ni número. */
export function esFinDePalabra(text: string, idx: number): boolean {
  if (idx >= text.length) return true;
  return !/[\p{L}\p{N}]/u.test(text[idx]);
}

/**
 * True si `term` matchea en `text` arrancando en `idx` de forma aceptable.
 *
 * Los términos se buscan como substring para que el proofreading funcione
 * —`golpear` tiene que encontrar `golpearon`—, pero sin guarda un término corto
 * matchea en cualquier lado: buscando `y Ami ya está`, la `y` caía adentro de
 * `ayudó` Y en la `Y` de `Yiri`, y el resalto quedaba lleno de basura.
 *
 * Regla: siempre borde izquierdo (nunca en el medio de una palabra), y para
 * términos de hasta `TERMINO_CORTO_MAX` chars también borde derecho, o sea
 * palabra completa.
 */
export function esMatchDeTermino(text: string, idx: number, term: string): boolean {
  if (!esInicioDePalabra(text, idx)) return false;
  if (term.length > TERMINO_CORTO_MAX) return true;
  return esFinDePalabra(text, idx + term.length);
}

/** True si `term` matchea en `idx` como palabra COMPLETA, con borde a los dos
 *  lados. Es lo que hace ganar a `Seguid` sobre `seguida`. */
export function esPalabraCompleta(text: string, idx: number, term: string): boolean {
  return esInicioDePalabra(text, idx) && esFinDePalabra(text, idx + term.length);
}

/** Primer índice donde `term` aparece como palabra completa, o -1. */
export function buscarPalabraCompleta(text: string, term: string, from = 0): number {
  let at = from;
  for (;;) {
    const idx = text.indexOf(term, at);
    if (idx < 0) return -1;
    if (esPalabraCompleta(text, idx, term)) return idx;
    at = idx + 1;
  }
}

/** Primer índice donde `term` matchea `text` según `esMatchDeTermino`, o -1. */
export function buscarTermino(text: string, term: string, from = 0): number {
  let at = from;
  for (;;) {
    const idx = text.indexOf(term, at);
    if (idx < 0) return -1;
    if (esMatchDeTermino(text, idx, term)) return idx;
    at = idx + 1;
  }
}

/** Bloques donde puede caer un match. El subset XHTML del editor no tiene más
 *  contenedores de texto que estos. */
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, pre';

/**
 * Elige el bloque que MÁS términos distintos de la query contiene, y devuelve
 * su índice en `texts` (-1 si ninguno contiene nada).
 *
 * Prioridad: el literal completo de `rawQuery` (si tiene forma rica) gana de
 * una, porque es el match más específico posible. Si no, gana la cobertura:
 * cuántos términos distintos aparecen en el bloque. A igualdad, el más
 * temprano.
 *
 * Esto es el corazón del "el click no me lleva al resultado": elegir el primer
 * bloque que contenga CUALQUIER término manda al lector a la primera aparición
 * de la palabra más común de la query — casi siempre arriba de todo. Buscando
 * `Creo que se llamaba`, el primer `que` del capítulo gana sobre el párrafo que
 * tiene la frase entera.
 *
 * Función pura sobre los textos de los bloques: el walk del DOM lo hace
 * `highlightBestMatch`. Ver `scripts/run-search-locate-smoke.mjs`.
 */
export function pickBestBlock(
  texts: string[],
  terms: string[],
  rawQuery: string,
  fold = false,
): number {
  const norm = (s: string): string => (fold ? foldAccents(s) : s);
  const raw = (rawQuery ?? '').trim();
  const rawLower = norm(raw.toLowerCase());
  const hasRichForm =
    raw.length > 0 &&
    [...raw].some((c) => c !== c.toLowerCase() || /[^\p{L}\p{N}\s]/u.test(c));
  const lowerTerms = terms.map((t) => norm(t.toLowerCase())).filter((t) => t.length > 0);
  if (lowerTerms.length === 0 && !hasRichForm) return -1;

  let best = -1;
  // [literal, términos como palabra completa, términos incluyendo prefijos].
  let mejor: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < texts.length; i += 1) {
    const text = norm((texts[i] ?? '').toLowerCase());
    // 2 = el literal aparece como palabra/frase completa, 1 = como prefijo.
    // Buscando `Seguid`, el párrafo con `Seguid,` le gana al que tiene
    // `seguida` — que es un prefijo válido, pero no lo que se buscaba.
    let literal = 0;
    if (hasRichForm && rawLower.length > 0) {
      if (buscarPalabraCompleta(text, rawLower) >= 0) literal = 2;
      else if (text.includes(rawLower)) literal = 1;
    }
    let completos = 0;
    let conPrefijos = 0;
    for (const t of lowerTerms) {
      if (buscarPalabraCompleta(text, t) >= 0) {
        completos += 1;
        conPrefijos += 1;
      } else if (buscarTermino(text, t) >= 0) {
        conPrefijos += 1;
      }
    }
    if (literal === 0 && conPrefijos === 0) continue;
    const rank: [number, number, number] = [literal, completos, conPrefijos];
    if (esMejorRank(rank, mejor)) {
      mejor = rank;
      best = i;
    }
  }
  return best;
}

/** Compara rankings de bloque lexicográficamente. Estricto, así que a igualdad
 *  gana el que ya estaba, o sea el más temprano en el documento. */
function esMejorRank(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Salta al mejor match de la query dentro de `host`: primero elige el bloque
 * con más cobertura de términos (`pickBestBlock`), después el primer match
 * dentro de ese bloque. Si ningún bloque matchea, cae al host entero.
 */
export function highlightBestMatch(
  host: HTMLElement | null,
  terms: string[],
  rawQuery?: string,
  fold = false,
): boolean {
  if (!host) return false;
  // Sólo bloques hoja: un `<blockquote>` con `<p>` adentro aparece dos veces en
  // el querySelectorAll y el texto del padre incluye al hijo.
  const blocks = Array.from(host.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).filter(
    (el) => el.querySelector(BLOCK_SELECTOR) === null,
  );
  const idx = pickBestBlock(
    blocks.map((b) => b.textContent ?? ''),
    terms,
    rawQuery ?? '',
    fold,
  );
  // Un bloque por raíz, nunca el host entero: `selectFirstMatchIn` concatena
  // los text nodes de cada raíz, y concatenar bloques distintos pegaría el
  // final de un párrafo con el principio del siguiente ("la casa" + "grande"
  // ⇒ un match fantasma que no existe en el texto).
  const roots = idx >= 0 ? [blocks[idx]] : blocks.length > 0 ? blocks : [host];
  if (selectFirstMatchIn(roots, terms, rawQuery, fold)) return true;
  // Queda como red por si ninguna pasada encuentra nada (ej. el bloque ganó
  // por tokens sueltos que ninguna pasada acepta): llevar al párrafo correcto
  // y flashearlo es peor que seleccionar la frase, pero mejor que no moverse.
  if (idx >= 0) {
    blocks[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashElement(blocks[idx]);
    return true;
  }
  return false;
}

/**
 * Mapea un rango `[start, end)` sobre la concatenación de varios text nodes
 * de vuelta a los nodos que lo contienen. `end` es exclusivo.
 *
 * Es la mitad pura del arreglo del salto: una frase que cruza el borde de un
 * `<em>` —`libros de <em>Técnica Arcana</em>`— existe en la concatenación pero
 * no dentro de ningún nodo suelto, así que hace falta un `Range` con `setStart`
 * en un nodo y `setEnd` en otro. Devuelve índices dentro del array de nodos.
 *
 * Los nodos vacíos se saltean solos: su span es `[acc, acc)` y ningún offset
 * cae adentro.
 */
export function mapRangeToNodes(
  lengths: number[],
  start: number,
  end: number,
): { startIndex: number; startOffset: number; endIndex: number; endOffset: number } | null {
  if (end <= start || start < 0) return null;
  let startIndex = -1;
  let startOffset = 0;
  let endIndex = -1;
  let endOffset = 0;
  let acc = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    const from = acc;
    const to = acc + lengths[i];
    if (startIndex < 0 && start >= from && start < to) {
      startIndex = i;
      startOffset = start - from;
    }
    // `end` es exclusivo: el nodo que cierra el rango es el que contiene su
    // último carácter, y el offset se mide desde el arranque de ESE nodo.
    if (endIndex < 0 && end - 1 >= from && end - 1 < to) {
      endIndex = i;
      endOffset = end - from;
    }
    acc = to;
  }
  if (startIndex < 0 || endIndex < 0) return null;
  return { startIndex, startOffset, endIndex, endOffset };
}

/** Todos los text nodes de `root` en orden documental, con su texto. Se toman
 *  TODOS, whitespace incluido: la concatenación tiene que dar igual que el
 *  `textContent` con el que `pickBestBlock` eligió el bloque, o los offsets
 *  dejan de corresponderse. */
function textNodesOf(root: HTMLElement): { nodos: Text[]; textos: string[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodos: Text[] = [];
  const textos: string[] = [];
  let cur: Node | null = walker.nextNode();
  while (cur) {
    nodos.push(cur as Text);
    textos.push(cur.nodeValue ?? '');
    cur = walker.nextNode();
  }
  return { nodos, textos };
}

/**
 * Busca la query en cada raíz de `roots` y selecciona el primer match, con su
 * scroll y su flash.
 *
 * Dentro de cada raíz busca sobre la **concatenación** de sus text nodes, no
 * nodo por nodo: así una frase partida por un `<em>` se encuentra igual, y el
 * `Range` resultante puede arrancar en un nodo y terminar en otro.
 *
 * Si `rawQuery` viene con forma rica (mayúsculas o puntuación) y aparece
 * literal, gana sobre el match de tokens — así `¡Duendes!` cae sobre el grito
 * específico, no sobre el primer `duendes`.
 *
 * Fallback al primer `terms` que aparezca (caso legacy: query sin caracteres
 * especiales).
 */
function selectFirstMatchIn(
  roots: HTMLElement[],
  terms: string[],
  rawQuery?: string,
  fold = false,
): boolean {
  if (roots.length === 0) return false;
  // `fold` plega acentos (modo fuzzy) para comparar accent-insensitive; en modo
  // exacto NO se plega para no resaltar variantes con tilde que no se buscaron.
  // El fold es length-preserving ⇒ los offsets siguen válidos sobre el original.
  const norm = (s: string): string => (fold ? foldAccents(s) : s);
  const lowerTerms = terms.map((t) => norm(t.toLowerCase())).filter((t) => t.length > 0);
  const raw = (rawQuery ?? '').trim();
  const rawLower = norm(raw.toLowerCase());
  const hasRichForm =
    raw.length > 0 &&
    [...raw].some((c) => c !== c.toLowerCase() || /[^\p{L}\p{N}\s]/u.test(c));
  if (lowerTerms.length === 0 && !hasRichForm) return false;

  // Pasadas en orden de preferencia. Mismo criterio que `pickBestBlock`: la
  // palabra completa gana sobre el prefijo, y el literal de la query gana sobre
  // los tokens sueltos. Sin esto, buscando `Seguid` el salto cae en `seguida`.
  const pasadas: Array<(text: string) => { idx: number; len: number } | null> = [];
  if (hasRichForm && rawLower.length > 0) {
    pasadas.push((text) => {
      const idx = buscarPalabraCompleta(text, rawLower);
      return idx >= 0 ? { idx, len: raw.length } : null;
    });
    pasadas.push((text) => {
      const idx = text.indexOf(rawLower);
      return idx >= 0 ? { idx, len: raw.length } : null;
    });
  }
  if (lowerTerms.length > 0) {
    pasadas.push((text) => primerToken(text, lowerTerms, buscarPalabraCompleta));
    pasadas.push((text) => primerToken(text, lowerTerms, buscarTermino));
  }

  // Un walk del DOM por raíz, no uno por pasada: en el camino de fallback las
  // raíces son todos los bloques del capítulo y las pasadas son cuatro.
  const escaneadas = roots
    .map((root) => {
      const { nodos, textos } = textNodesOf(root);
      return {
        root,
        nodos,
        largos: textos.map((t) => t.length),
        texto: norm(textos.join('').toLowerCase()),
      };
    })
    .filter((r) => r.nodos.length > 0);

  // Las pasadas van por fuera de las raíces: un literal con forma rica en el
  // último bloque le gana a un token suelto en el primero, igual que antes.
  for (const buscar of pasadas) {
    for (const r of escaneadas) {
      const found = buscar(r.texto);
      if (!found) continue;
      const span = mapRangeToNodes(r.largos, found.idx, found.idx + found.len);
      if (!span) continue;
      if (seleccionar(r.root, r.nodos, span)) return true;
    }
  }
  return false;
}

/** Selecciona el rango, scrollea y flashea el párrafo. Separado para que
 *  `selectFirstMatchIn` se lea como lo que es: elegir el match. */
function seleccionar(
  root: HTMLElement,
  nodos: Text[],
  span: { startIndex: number; startOffset: number; endIndex: number; endOffset: number },
): boolean {
  try {
    const range = document.createRange();
    range.setStart(nodos[span.startIndex], span.startOffset);
    range.setEnd(nodos[span.endIndex], span.endOffset);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    // Se flashea el bloque, no el padre del text node: con el match adentro de
    // un `<em>` el padre es la itálica, y flashear tres palabras en bastardilla
    // no le dice a nadie dónde está el párrafo.
    root.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // La selección se borra cuando el usuario clickea fuera, pero el flash CSS
    // dura 2.5s y es claramente visible.
    flashElement(root);
    return true;
  } catch {
    return false;
  }
}

/** Primer token de `terms` que matchea `text` con el buscador dado, en orden de
 *  aparición en el texto (no en el orden de la query: si la query es `casa
 *  grande` y el párrafo dice "grande la casa", salta a `grande`). */
function primerToken(
  text: string,
  terms: string[],
  buscar: (text: string, term: string) => number,
): { idx: number; len: number } | null {
  let best: { idx: number; len: number } | null = null;
  for (const t of terms) {
    const idx = buscar(text, t);
    if (idx >= 0 && (best === null || idx < best.idx)) best = { idx, len: t.length };
  }
  return best;
}

/** Aplica clase `search-flash` al elemento durante 2.5s. Reusable: si se llama
 *  con flash ya activo, lo reinicia. */
export function flashElement(el: HTMLElement): void {
  el.classList.remove('search-flash');
  // Force reflow para que la animación se reinicie si el flash ya estaba activo.
  void el.offsetWidth;
  el.classList.add('search-flash');
  setTimeout(() => {
    el.classList.remove('search-flash');
  }, 2500);
}

/**
 * Devuelve todas las ocurrencias de la query dentro de `plain` como rangos
 * `[start, end)` no solapados. Misma prioridad que `highlightFirstMatch`:
 * si `rawQuery` tiene forma rica (mayúsculas o puntuación), busca ese literal
 * case-insensitive como única forma. Si no, busca cada token de `terms` y
 * combina los hits eliminando solapamientos (el más temprano gana).
 *
 * Útil para pintar todas las coincidencias visibles del término en un texto
 * — el editor las mapea a posiciones PM via `offsetToPm` y aplica
 * decoraciones inline.
 */
export function findAllMatchesInPlain(
  plain: string,
  terms: string[],
  rawQuery: string,
  fold = false,
): { start: number; end: number }[] {
  if (!plain) return [];
  const raw = (rawQuery ?? '').trim();
  // `fold` (modo fuzzy) plega acentos para comparar accent-insensitive; en modo
  // exacto NO se plega. El fold es length-preserving ⇒ los índices del string
  // plegado son válidos sobre `plain` original, así que los rangos devueltos
  // marcan el substring (con tilde) tal cual aparece.
  const norm = (s: string): string => (fold ? foldAccents(s) : s);
  const rawLower = norm(raw.toLowerCase());
  const hasRichForm =
    raw.length > 0 &&
    [...raw].some((c) => c !== c.toLowerCase() || /[^\p{L}\p{N}\s]/u.test(c));
  const lowerPlain = norm(plain.toLowerCase());
  const hits: { start: number; end: number }[] = [];

  if (hasRichForm) {
    const len = raw.length;
    let from = 0;
    while (from <= lowerPlain.length - len) {
      const idx = lowerPlain.indexOf(rawLower, from);
      if (idx < 0) break;
      hits.push({ start: idx, end: idx + len });
      from = idx + len;
    }
    return hits;
  }

  const lowerTerms = terms.map((t) => norm(t.toLowerCase())).filter((t) => t.length > 0);
  if (lowerTerms.length === 0) return [];

  const all: { start: number; end: number }[] = [];
  for (const t of lowerTerms) {
    const len = t.length;
    let from = 0;
    while (from <= lowerPlain.length - len) {
      const idx = buscarTermino(lowerPlain, t, from);
      if (idx < 0) break;
      all.push({ start: idx, end: idx + len });
      from = idx + len;
    }
  }
  // Resolver solapamientos: ordenar por start ascendente; al empate, ganador
  // el más largo. Descartar cualquier hit que solape con el anterior aceptado.
  all.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  let lastEnd = -1;
  for (const h of all) {
    if (h.start >= lastEnd) {
      hits.push(h);
      lastEnd = h.end;
    }
  }
  return hits;
}

/** Separa una query en términos individuales (split por whitespace, sin puntuación). */
export function tokenize(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/[.,;:!?¡¿"'`()[\]{}<>]/g, ''))
    .filter((t) => t.length > 0);
}
