/**
 * Piezas de ProseMirror/TipTap del editor de guion: el nodo `linea`, las
 * teclas de sangría y el plugin de resaltado. Lo puro (regex, líneas) vive en
 * `resaltar.ts` y `lineas.ts`; esto es el pegamento con el schema.
 *
 * El doc es `linea+`, una por línea del archivo, sin marcas: el texto del
 * archivo es exactamente `lineasDesdeDoc(doc).join('\n')`.
 */
import { Extension, JSONContent, Node } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { cuantoDesindentar } from './lineas';
import { resaltar } from './resaltar';

const SANGRIA = /^[ \t]*/;

export const Linea = Node.create({
  name: 'linea',
  group: 'block',
  content: 'text*',
  parseHTML() {
    return [{ tag: 'div.linea' }];
  },
  renderHTML() {
    return ['div', { class: 'linea' }, 0];
  },
});

/** Tab = dos espacios (la sangría del formato); Shift+Tab los saca; con
 *  líneas seleccionadas, las dos teclas reindentan cada línea del bloque
 *  (reindentar después de agregar un `[si:]` es de lo más común). Enter copia
 *  la sangría que hay antes del cursor, que es lo que más se escribe en los
 *  bloques anidados (opciones, éxito/falla, [si]); al principio de una línea
 *  sangrada abre una línea vacía arriba sin duplicar la sangría. */
export const GuionTeclas = Extension.create({
  name: 'guionTeclas',
  addKeyboardShortcuts() {
    return {
      Tab: () =>
        this.editor.commands.command(({ state, tr, dispatch }) => {
          if (state.selection.empty) {
            if (dispatch) tr.insertText('  ');
            return true;
          }
          if (dispatch) {
            // De atrás para adelante, así las posiciones de arriba no se corren.
            for (const pos of inicioDeLineas(state).reverse()) tr.insertText('  ', pos);
          }
          return true;
        }),
      'Shift-Tab': () =>
        this.editor.commands.command(({ state, tr, dispatch }) => {
          if (dispatch) {
            for (const pos of inicioDeLineas(state).reverse()) {
              const n = cuantoDesindentar(state.doc.resolve(pos).parent.textContent);
              if (n > 0) tr.delete(pos, pos + n);
            }
          }
          // Siempre true: si no hay nada que sacar, que el foco no se vaya del editor.
          return true;
        }),
      Enter: () => {
        const $from = this.editor.state.selection.$from;
        const sangria = (SANGRIA.exec($from.parent.textContent)?.[0] ?? '').slice(0, $from.parentOffset);
        const chain = this.editor.chain().splitBlock();
        return (sangria ? chain.insertContent(sangria) : chain).run();
      },
    };
  },
});

/** Posición del primer carácter de cada `linea` que toca la selección. */
function inicioDeLineas(state: EditorState): number[] {
  const { from, to } = state.selection;
  const out: number[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'linea') out.push(pos + 1);
    return false;
  });
  return out;
}

const resaltadoKey = new PluginKey<DecorationSet>('guionResaltado');

/** Una clase `g-<clase>` por span de `resaltar`; la prosa que sigue a `>`
 *  lleva además `g-texto--narracion` para ir en itálica. */
function decorar(doc: PmNode): DecorationSet {
  const decos: Decoration[] = [];
  let enComentario = false;
  doc.forEach((linea, offset) => {
    const r = resaltar(linea.textContent, enComentario);
    enComentario = r.enComentario;
    let previa = '';
    for (const s of r.spans) {
      const narracion = s.clase === 'texto' && previa === 'narracion';
      decos.push(
        Decoration.inline(offset + 1 + s.desde, offset + 1 + s.hasta, {
          class: narracion ? 'g-texto g-texto--narracion' : `g-${s.clase}`,
        }),
      );
      previa = s.clase;
    }
  });
  return DecorationSet.create(doc, decos);
}

export const Resaltado = Extension.create({
  name: 'guionResaltado',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: resaltadoKey,
        state: {
          init: (_, state) => decorar(state.doc),
          apply: (tr, viejo) => (tr.docChanged ? decorar(tr.doc) : viejo),
        },
        props: {
          decorations(state) {
            return resaltadoKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function docDesdeLineas(lineas: string[]): JSONContent {
  return {
    type: 'doc',
    content: lineas.map((l) =>
      l ? { type: 'linea', content: [{ type: 'text', text: l }] } : { type: 'linea' },
    ),
  };
}

export function lineasDesdeDoc(doc: PmNode): string[] {
  const out: string[] = [];
  doc.forEach((linea) => out.push(linea.textContent));
  return out;
}
