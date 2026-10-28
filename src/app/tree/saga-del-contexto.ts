import { TreeNode } from '../core/types';

/** La saga de primer nivel que contiene `path` (o que es `path`), o null. Es
 *  la saga en la que "está parado" el autor, para ofrecerle crear una novela
 *  ahí desde el menú del espacio vacío del árbol. */
export function sagaDelContexto(root: TreeNode | null, path: string | null): TreeNode | null {
  if (!root || !path) return null;
  return (
    root.children.find(
      (n) =>
        n.kind === 'saga' &&
        (path === n.path || path.startsWith(n.path + '/') || path.startsWith(n.path + '\\')),
    ) ?? null
  );
}
