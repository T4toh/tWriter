import type { TreeNode } from './types';

/** Posición que se le asigna a un path que no está en el árbol. Los deja al
 *  final sin romper el orden relativo que ya tenían: `sort` de JS es estable, y
 *  dos paths desconocidos comparan 0 entre sí. */
export const POSICION_DESCONOCIDA = Number.MAX_SAFE_INTEGER;

/**
 * Mapa `path → posición` según el recorrido en profundidad del árbol, que es el
 * orden en que se lee: saga, libro, sección, capítulo. El backend ya devuelve
 * los `children` ordenados —es el orden que muestra el panel izquierdo—, así
 * que alcanza con recorrerlos.
 *
 * Sirve para ordenar resultados de búsqueda por estructura en vez de por score
 * BM25: buscando una frase literal, "el más relevante primero" no aporta nada,
 * y lo que se quiere es recorrer los hits en el orden del libro.
 */
export function ordenDeEstructura(root: TreeNode | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!root) return map;
  let i = 0;
  const walk = (node: TreeNode): void => {
    map.set(node.path, i);
    i += 1;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return map;
}

/** Comparador de paths por posición en la estructura. Los que no están en el
 *  árbol van al final. Pensado para `sort` sobre listas ya ordenadas por
 *  relevancia: el empate preserva ese orden. */
export function compararPorEstructura(
  orden: Map<string, number>,
  a: string,
  b: string,
): number {
  const pa = orden.get(a) ?? POSICION_DESCONOCIDA;
  const pb = orden.get(b) ?? POSICION_DESCONOCIDA;
  return pa - pb;
}
