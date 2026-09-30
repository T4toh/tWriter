import { EditorState } from '@tiptap/pm/state';

/**
 * El mismo documento, con la misma selección y los mismos plugins, pero con
 * el historial de deshacer vacío.
 *
 * El editor no se recrea al cambiar de capítulo: le hace `setContent`, y esa
 * transacción entra al historial. Sin esto, Ctrl+Z en el capítulo recién
 * abierto trae el texto del anterior, y el autosave lo guarda encima del
 * archivo abierto. Marcar la transacción con `addToHistory: false` no alcanza:
 * los pasos viejos quedan en la pila (`undoDepth` > 0).
 */
export function withFreshHistory(state: EditorState): EditorState {
  return EditorState.create({
    doc: state.doc,
    selection: state.selection,
    plugins: state.plugins,
  });
}
