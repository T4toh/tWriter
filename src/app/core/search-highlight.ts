/**
 * Busca el primer text node dentro de `host` que matchee alguno de `terms`
 * (case-insensitive). Si lo encuentra: lo selecciona y hace scroll al medio.
 * Devuelve true si hubo match.
 */
export function highlightFirstMatch(host: HTMLElement | null, terms: string[]): boolean {
  if (!host || terms.length === 0) return false;
  const lowerTerms = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (lowerTerms.length === 0) return false;

  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue && node.nodeValue.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });

  let bestNode: Text | null = null;
  let bestOffset = -1;
  let bestLen = 0;

  // Recorrer todos los text nodes, encontrar el primero (en orden documental)
  // que contenga uno de los términos. Para nodos múltiples con el mismo
  // término, devolver el de menor offset.
  let cur: Node | null = walker.nextNode();
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
    cur = walker.nextNode();
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
