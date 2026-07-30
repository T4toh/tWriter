/**
 * Mitad CON DOM del apply de RAE. Importa `@tiptap/core`, así que no se puede
 * cargar desde node: lo cubren `pnpm build` y la verificación manual. La lógica
 * testeable vive en `rae-convert.ts`.
 */
import { getHTMLFromFragment } from '@tiptap/core';
import { Node as PmNode, Schema } from '@tiptap/pm/model';

/**
 * HTML del rango `from..to` del documento, con el markup inline intacto.
 *
 * Es el rango y no el nodo: `extractPlainText` mapea cada `<br>` a `\n\n` y el
 * validador parte por `\n\n`, así que un "párrafo" del validador puede ser un
 * segmento adentro de un bloque con hard breaks. Reemplazar el `<p>` entero se
 * comería el otro segmento.
 */
export function serializeRange(
  doc: PmNode,
  from: number,
  to: number,
  schema: Schema,
): string {
  return getHTMLFromFragment(doc.slice(from, to).content, schema);
}
