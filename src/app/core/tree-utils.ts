import { TreeNode } from './types';

/**
 * El nodo del árbol con ese `path`, o `null`.
 *
 * Estaba copiada y pegada seis veces (`app.ts`, `tree.ts`, `search-panel.ts`,
 * `node-actions-service.ts`, `rae-audit-panel.ts` y el panel de repeticiones).
 * Ya no queda ninguna copia: todos los llamadores importan de acá.
 *
 * El `?? []` sobre `children` viene de la copia de `app.ts`, que era la única
 * que lo tenía. Hoy es defensa muerta — el campo es `children: Vec<TreeNode>`
 * en `fs.rs` sin `skip_serializing_if`, así que serde siempre lo manda, aunque
 * sea `[]`, y el tipo TS lo declara requerido. Se conserva igual porque cuesta
 * cinco caracteres y cubre el día que alguien arme un `TreeNode` a mano en el
 * front (hoy nadie lo hace).
 */
export function findNodeByPath(root: TreeNode | null, path: string): TreeNode | null {
  if (!root) return null;
  if (root.path === path) return root;
  for (const c of root.children ?? []) {
    const found = findNodeByPath(c, path);
    if (found) return found;
  }
  return null;
}
