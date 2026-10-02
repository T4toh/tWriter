/**
 * Recorrido de los matches de LanguageTool uno por uno («Revisar» del toolbar).
 *
 * Sin DOM a propósito: entra la lista de matches ya posicionados en el doc,
 * sale cuál toca. El editor se encarga de seleccionar, scrollear y abrir el
 * popover. Los tests viven en `scripts/run-grammar-wizard-smoke.mjs`.
 */

interface ReviewMatch {
  id: string;
  from: number;
  to: number;
}

/** Orden de lectura: por `from`, y a igual inicio el más corto primero. */
function byPosition(a: ReviewMatch, b: ReviewMatch): number {
  return a.from - b.from || a.to - b.to || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * El próximo match a mostrar desde `desde` (incluido), salteando los que el
 * autor ya pasó con «Siguiente». Si no queda ninguno de ahí en adelante, vuelve
 * al principio: el autor puede haber clickeado un error más adelante a mitad
 * del recorrido y los de antes siguen sin ver. Termina igual, porque cada paso
 * resuelve un match (sale de la lista) o lo saltea (entra a `salteados`).
 */
export function nextReviewMatch<T extends ReviewMatch>(
  matches: readonly T[],
  desde: number,
  salteados: ReadonlySet<string>,
): T | null {
  const pendientes = matches.filter((m) => !salteados.has(m.id)).sort(byPosition);
  return pendientes.find((m) => m.from >= desde) ?? pendientes[0] ?? null;
}

/** «3 de 12» del encabezado: lugar del match en orden de lectura. */
export function reviewPosition(
  matches: readonly ReviewMatch[],
  id: string,
): { n: number; total: number } | null {
  const idx = [...matches].sort(byPosition).findIndex((m) => m.id === id);
  return idx < 0 ? null : { n: idx + 1, total: matches.length };
}
