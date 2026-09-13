import type { Node as PmNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

/**
 * Reemplaza cada `hardBreak` del doc por un corte de párrafo real.
 *
 * El subset HTML de los capítulos no tiene `<br>`: en una novela un salto de
 * línea dentro del párrafo es siempre un párrafo nuevo. Sin esto, el `<br>` se
 * persiste tal cual y el EPUB lo muestra planchado a la izquierda, porque
 * `text-indent` solo sangra la primera línea del `<p>`. Los `<br>` llegaban por
 * tres caminos: Shift+Enter, HTML pegado, y Enter común cuando WebKitGTK acaba
 * de cerrar una composición del IME (ProseMirror se cree en Safari y le deja el
 * Enter al browser, que mete un `<br>`). Normalizar el doc los cubre a todos.
 *
 * Mitad pura, sin `@tiptap/core`, para que corra desde node
 * (`scripts/run-hardbreak-smoke.mjs`). `split` copia tipo y atributos del
 * bloque, así un `<p style="text-align: center">` se parte en dos centrados, y
 * las marcas siguen en los dos lados. Devuelve `null` si no había nada.
 */
export function splitHardBreaks(doc: PmNode, tr: Transaction): Transaction | null {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'hardBreak') positions.push(pos);
  });
  if (positions.length === 0) return null;
  // De atrás para adelante: cada corte solo mueve posiciones posteriores.
  for (const pos of positions.reverse()) {
    tr.delete(pos, pos + 1);
    tr.split(pos);
  }
  return tr;
}
