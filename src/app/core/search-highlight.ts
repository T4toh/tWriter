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
  let bestHits = 0;
  for (let i = 0; i < texts.length; i += 1) {
    const text = norm((texts[i] ?? '').toLowerCase());
    if (hasRichForm && rawLower.length > 0 && text.includes(rawLower)) return i;
    let hits = 0;
    for (const t of lowerTerms) {
      if (text.includes(t)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = i;
    }
  }
  return best;
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
  return selectFirstMatchIn(idx >= 0 ? blocks[idx] : host, terms, rawQuery, fold);
}

/**
 * Busca el primer text node dentro de `root` que matchee la query, lo
 * selecciona y scrollea.
 *
 * Si `rawQuery` viene con forma rica (mayúsculas o puntuación) y aparece
 * literal en algún text node, gana sobre el match de tokens — así
 * `¡Duendes!` cae sobre el grito específico, no sobre el primer `duendes`.
 *
 * Fallback al primer text node que contenga alguno de `terms` (caso
 * legacy: query sin caracteres especiales).
 */
function selectFirstMatchIn(
  host: HTMLElement | null,
  terms: string[],
  rawQuery?: string,
  fold = false,
): boolean {
  if (!host) return false;
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

  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue && node.nodeValue.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });

  let bestNode: Text | null = null;
  let bestOffset = -1;
  let bestLen = 0;

  // Pasada 1: buscar el literal `rawQuery` si tiene forma rica. Walker
  // recorre en orden documental → primer match gana.
  if (hasRichForm) {
    let cur: Node | null = walker.nextNode();
    while (cur) {
      const text = norm((cur.nodeValue ?? '').toLowerCase());
      const idx = text.indexOf(rawLower);
      if (idx >= 0) {
        bestNode = cur as Text;
        bestOffset = idx;
        bestLen = raw.length;
        break;
      }
      cur = walker.nextNode();
    }
  }

  // Pasada 2 (fallback): primer text node que contenga algún token.
  if (!bestNode && lowerTerms.length > 0) {
    // Reset walker: createTreeWalker no se rebobina; nuevo.
    const walker2 = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue && node.nodeValue.trim().length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    let cur: Node | null = walker2.nextNode();
    while (cur) {
      const text = norm((cur.nodeValue ?? '').toLowerCase());
      for (const t of lowerTerms) {
        const idx = text.indexOf(t);
        if (idx >= 0) {
          bestNode = cur as Text;
          bestOffset = idx;
          bestLen = t.length;
          break;
        }
      }
      if (bestNode) break;
      cur = walker2.nextNode();
    }
  }

  if (!bestNode) return false;

  try {
    const range = document.createRange();
    range.setStart(bestNode, bestOffset);
    range.setEnd(bestNode, bestOffset + bestLen);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const parentEl = bestNode.parentElement;
    if (parentEl) {
      parentEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Flash visual del párrafo: la selección se borra cuando el usuario
      // clickea fuera, pero el flash CSS dura 2.5s y es claramente visible.
      flashElement(parentEl);
    }
    return true;
  } catch {
    return false;
  }
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
      const idx = lowerPlain.indexOf(t, from);
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
