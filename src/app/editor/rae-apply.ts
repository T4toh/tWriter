/**
 * Mitad CON DOM del apply de RAE. Importa `@tiptap/core`, así que no se puede
 * cargar desde node: lo cubren `pnpm build` y la verificación manual. La lógica
 * testeable vive en `rae-convert.ts`.
 */
import { createNodeFromContent, getHTMLFromFragment } from '@tiptap/core';
import { Fragment, Node as PmNode, Schema } from '@tiptap/pm/model';

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

/**
 * HTML convertido → contenido de ProseMirror listo para insertar.
 *
 * No se le puede pasar el string crudo a `insertContentAt`: cuando el HTML
 * parsea a un único text node sin marcas, tiptap toma su rama
 * `isOnlyTextContent` y hace `tr.insertText(value, …)` con el **string sin
 * decodificar**. Y `getHTMLFromFragment` serializa con `innerHTML`, que escapa
 * `&`, `<`, `>` y el espacio duro (U+00A0 → `&nbsp;`), habitual en un `.docx`
 * importado por Pandoc. Resultado: el literal `&nbsp;` adentro del documento, y
 * `&amp;nbsp;` al volver a aplicar. Pasando el `Fragment` ya parseado, tiptap lo
 * usa tal cual (`createNodeFromContent` devuelve un `Node`/`Fragment` sin
 * tocarlo) y el texto llega decodificado por el parser del DOM.
 */
export function parseFragmentHtml(
  html: string,
  schema: Schema,
): PmNode | Fragment {
  return createNodeFromContent(html, schema, {
    slice: true,
    parseOptions: { preserveWhitespace: 'full' },
  });
}
