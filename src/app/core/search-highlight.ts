/**
 * Busca el primer text node dentro de `host` que matchee la query.
 *
 * Si `rawQuery` viene con forma rica (mayúsculas o puntuación) y aparece
 * literal en algún text node, gana sobre el match de tokens — así
 * `¡Duendes!` cae sobre el grito específico, no sobre el primer `duendes`.
 *
 * Fallback al primer text node que contenga alguno de `terms` (caso
 * legacy: query sin caracteres especiales).
 */
export function highlightFirstMatch(
  host: HTMLElement | null,
  terms: string[],
  rawQuery?: string,
): boolean {
  if (!host) return false;
  const lowerTerms = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  const raw = (rawQuery ?? '').trim();
  const rawLower = raw.toLowerCase();
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
      const text = (cur.nodeValue ?? '').toLowerCase();
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
      const text = (cur.nodeValue ?? '').toLowerCase();
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
function flashElement(el: HTMLElement): void {
  el.classList.remove('search-flash');
  // Force reflow para que la animación se reinicie si el flash ya estaba activo.
  void el.offsetWidth;
  el.classList.add('search-flash');
  setTimeout(() => {
    el.classList.remove('search-flash');
  }, 2500);
}

/** Separa una query en términos individuales (split por whitespace, sin puntuación). */
export function tokenize(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/[.,;:!?¡¿"'`()[\]{}<>]/g, ''))
    .filter((t) => t.length > 0);
}
