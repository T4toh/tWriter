import type { NodeType, ResolvedPos } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { canJoin, findWrapping, liftTarget } from '@tiptap/pm/transform';

/**
 * Toggle del bloque de verso (`blockquote`) que deja siempre UN bloque.
 *
 * El `toggleBlockquote` de StarterKit envuelve la selección tal cual: si la
 * selección ya incluía un bloque de verso quedaba un `blockquote` adentro de
 * otro, y si el párrafo estaba pegado a un bloque existente quedaban dos
 * hermanos. Los dos casos se ven igual, como aire de más entre versos
 * (`margin: 1.6em` de cada bloque). Acá:
 *
 * - Selección entera adentro de un bloque → se desenvuelve (toggle off).
 * - Si no: se desenvuelve todo bloque que la selección toque, se envuelve el
 *   rango completo en uno solo y se funde con el bloque vecino de arriba y/o
 *   de abajo si los hay.
 *
 * Mitad pura, sin `@tiptap/core`, para correr desde node
 * (`scripts/run-verso-smoke.mjs`). Devuelve `null` si no se pudo aplicar.
 */
export function toggleVerso(tr: Transaction, type: NodeType): Transaction | null {
  const { $from, $to } = tr.selection;

  if (bloqueQueContiene($from, $to, type) !== null) {
    const range = $from.blockRange($to);
    const target = range ? liftTarget(range) : null;
    if (!range || target === null) return null;
    return tr.lift(range, target);
  }

  let a = $from.pos;
  let b = $to.pos;
  const tocados: { pos: number; end: number }[] = [];
  tr.doc.nodesBetween(a, b, (node, pos) => {
    if (node.type !== type) return true;
    tocados.push({ pos, end: pos + node.nodeSize });
    return false;
  });
  for (const t of tocados) {
    a = Math.min(a, t.pos + 1);
    b = Math.max(b, t.end - 1);
  }

  // De atrás para adelante: cada lift solo mueve posiciones posteriores.
  const desde = tr.steps.length;
  for (const t of tocados.reverse()) {
    const range = tr.doc.resolve(t.pos + 1).blockRange(tr.doc.resolve(t.end - 1));
    const target = range ? liftTarget(range) : null;
    if (range && target !== null) tr.lift(range, target);
  }
  const map = tr.mapping.slice(desde);
  const range = tr.doc.resolve(map.map(a)).blockRange(tr.doc.resolve(map.map(b)));
  const wrapping = range ? findWrapping(range, type) : null;
  if (!range || !wrapping) return null;
  tr.wrap(range, wrapping);

  // Fundir con los vecinos. Primero el de abajo, que no mueve `start`.
  const start = range.start;
  const end = start + (range.end - range.start) + 2;
  if (tr.doc.resolve(end).nodeAfter?.type === type && canJoin(tr.doc, end)) tr.join(end);
  if (tr.doc.resolve(start).nodeBefore?.type === type && canJoin(tr.doc, start)) tr.join(start);
  return tr;
}

/** Profundidad del bloque de verso que contiene a los dos extremos, o null. */
function bloqueQueContiene($from: ResolvedPos, $to: ResolvedPos, type: NodeType): number | null {
  for (let d = $from.sharedDepth($to.pos); d > 0; d--) {
    if ($from.node(d).type === type) return d;
  }
  return null;
}
