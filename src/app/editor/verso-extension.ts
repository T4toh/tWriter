import { Extension, type Editor } from '@tiptap/core';
import { toggleVerso } from './verso';

/** Aplica el toggle de bloque de verso sobre la selección del editor. */
export function aplicarVerso(editor: Editor): boolean {
  const type = editor.schema.nodes['blockquote'];
  if (!type) return false;
  const tr = toggleVerso(editor.state.tr, type);
  if (!tr) return false;
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Le gana el `Mod-Shift-b` al Blockquote de StarterKit (por eso la prioridad
 * alta) para que el atajo pase por `toggleVerso` igual que el botón. La regla
 * de input `> ` sigue siendo la de StarterKit: ya funde con el bloque de
 * arriba por sí sola.
 */
export const Verso = Extension.create({
  name: 'verso',
  priority: 1000,
  addKeyboardShortcuts() {
    return { 'Mod-Shift-b': () => aplicarVerso(this.editor) };
  },
});
