import type { EditorProps } from '@tiptap/pm/view';
import { FALLBACK_LINE_HEIGHT, caretScrolloff, lineHeightPxFrom } from './caret-scrolloff';

/**
 * Props de ProseMirror compartidas por las tres superficies tipeables
 * (capítulos, notas y el modo edit del markdown-reader). Son una función y no
 * un literal porque se reaplican al cambiar el tamaño de fuente: el respiro del
 * caret escala con la línea. (El markdown-reader no reaplica por fuente — la
 * tiene fija en el SCSS — pero sí tras instanciar, para leer el computado.)
 *
 * Ojo con `setOptions`: reemplaza la key `editorProps` entera en vez de
 * mergearla, así que esta función tiene que devolver **todo** — si faltaran los
 * `attributes`, un `setEditable()` posterior los borraría.
 *
 * El OS no opina sobre el texto: sin corrector, sin autocorrección y sin
 * autocapitalización. Las comillas y rayas las hace Typography de TipTap.
 * Explícito acá además de heredado desde <html> como defensa en profundidad: si
 * algo intermedio (extensión, wrapper, un `<iframe>`) rompiera la herencia de
 * esos atributos, este bloque los repone.
 *
 * @param dom El `view.dom` del editor, o `null` si todavía no existe (durante
 *   la construcción de la instancia). Sin él no hay `line-height` computado que
 *   leer y se cae al factor del SCSS; los componentes reaplican apenas
 *   instancian, con el valor real.
 */
export function buildEditorProps(dom: HTMLElement | null, fontSizePx: number): EditorProps {
  const lineHeightPx = dom
    ? lineHeightPxFrom(getComputedStyle(dom).lineHeight, fontSizePx)
    : fontSizePx * FALLBACK_LINE_HEIGHT;
  return {
    attributes: {
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      autocomplete: 'off',
      'data-gramm': 'false',
      'data-gramm_editor': 'false',
    },
    ...caretScrolloff(lineHeightPx),
  };
}
