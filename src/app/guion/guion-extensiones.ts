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
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
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

/** Tab = dos espacios (la sangría del formato); Shift+Tab los saca; Enter
 *  copia la sangría de la línea de arriba, que es lo que más se escribe en
 *  los bloques anidados (opciones, éxito/falla, [si]). */
export const GuionTeclas = Extension.create({
  name: 'guionTeclas',
  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.insertContent('  '),
      'Shift-Tab': () =>
        this.editor.commands.command(({ state, tr, dispatch }) => {
          const $from = state.selection.$from;
          const m = /^ {1,2}/.exec($from.parent.textContent);
          if (!m) return false;
          if (dispatch) tr.delete($from.start(), $from.start() + m[0].length);
          return true;
        }),
      Enter: () => {
        const parent = this.editor.state.selection.$from.parent;
        const sangria = SANGRIA.exec(parent.textContent)?.[0] ?? '';
        const chain = this.editor.chain().splitBlock();
        return (sangria ? chain.insertContent(sangria) : chain).run();
      },
    };
  },
});

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
