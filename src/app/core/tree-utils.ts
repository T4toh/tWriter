import { TreeNode } from './types';

/**
 * El nodo del árbol con ese `path`, o `null`.
 *
 * Estaba copiada y pegada en `app.ts`, `tree.ts`, `search-panel.ts`,
 * `rae-audit-panel.ts` y `node-actions-service.ts` — cinco veces la misma
 * recursión. Se saca acá al sumar el sexto llamador (el panel de repeticiones);
 * migrados por ahora los dos archivos que esa PR ya tocaba, para no mezclar un
 * refactor mecánico de cuatro archivos ajenos con el feature. Los que faltan son
 * `app.ts`, `tree.ts` y `search-panel.ts`.
 */
export function findNodeByPath(root: TreeNode | null, path: string): TreeNode | null {
  if (!root) return null;
  if (root.path === path) return root;
  for (const c of root.children) {
    const found = findNodeByPath(c, path);
    if (found) return found;
  }
  return null;
}
