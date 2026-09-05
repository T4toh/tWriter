/**
 * Contexto de una ocurrencia sobre el texto plano de un capítulo: el snippet que
 * se muestra en la lista y el ancla con la que se salta al lugar.
 *
 * Sale de `rae-audit-panel`, que lo tenía adentro. Lo comparte ahora el panel de
 * repeticiones, que necesita exactamente lo mismo: mostrar la oración con la
 * marca señalada y después llevar al editor a ese punto.
 *
 * Función pura: sin DOM, sin ProseMirror, para que entre en un smoke runner de
 * node (`scripts/run-audit-snippet-smoke.mjs`).
 */

/** Chars de contexto a cada lado de la ocurrencia. */
export const AUDIT_MARGIN = 40;

/**
 * La oración alrededor de `[offset, offset+length)` con la ocurrencia marcada
 * entre `‹…›`, y `…` en las puntas si se recortó.
 *
 * A diferencia del ancla, el snippet SÍ puede cruzar el borde de un bloque: es
 * texto para leer, no para matchear, y cortarlo en el `\n\n` dejaría snippets
 * mutilados al principio y al final de cada párrafo.
 */
export function auditSnippet(
  plain: string,
  offset: number,
  length: number,
  margin = AUDIT_MARGIN,
): string {
  const start = Math.max(0, offset - margin);
  const end = Math.min(plain.length, offset + length + margin);
  const before = plain.slice(start, offset);
  const highlight = plain.slice(offset, offset + length);
  const after = plain.slice(offset + length, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < plain.length ? '…' : '';
  return `${prefix}${before}‹${highlight}›${after}${suffix}`;
}

/**
 * Ancla de texto para saltar al lugar: contexto alrededor de la ocurrencia SIN
 * cruzar el borde del bloque (`\n\n`).
 *
 * Por qué un ancla y no el offset crudo: los offsets de la auditoría se calculan
 * sobre `dialogos/htmlToPlain`, que dropea los `<hr>`, mientras el editor vive
 * en el espacio de `extractPlainText`, que mete `* * *` por cada uno. Los dos
 * planos se desfasan 7 chars por corte de escena, así que el offset cae al lado.
 * El texto de alrededor, en cambio, es idéntico en los dos.
 *
 * Y no cruza el `\n\n` porque el highlighter compara contra el texto de UN
 * párrafo del DOM: un literal que abarque dos no matchearía nunca. Cuanto más
 * largo, más único — con la frase entera el bloque gana por cobertura de
 * términos aunque el literal se parta adentro de un `<em>`.
 */
export function auditAnchor(
  plain: string,
  offset: number,
  length: number,
  margin = AUDIT_MARGIN,
): string {
  const blockStart = plain.lastIndexOf('\n\n', Math.max(0, offset - 1));
  const from = blockStart < 0 ? 0 : blockStart + 2;
  const blockEnd = plain.indexOf('\n\n', offset + length);
  const to = blockEnd < 0 ? plain.length : blockEnd;
  const start = Math.max(from, offset - margin);
  const end = Math.min(to, offset + length + margin);
  return plain.slice(start, end).trim();
}

/** El nombre de capítulo que se muestra en la lista: el archivo sin `.html`. */
export function auditTitleFromPath(path: string): string {
  const parts = path.split(/[\\/]/);
  const file = parts[parts.length - 1] ?? path;
  return file.replace(/\.html$/i, '');
}
