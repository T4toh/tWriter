import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from './settings-service';
import { NodeKind, TreeNode } from './types';
import { DebugService } from './debug-service';

@Injectable({ providedIn: 'root' })
export class ProjectService {
  private settings = inject(SettingsService);
  private debug = inject(DebugService);

  readonly root = computed(() => this.settings.root());
  readonly tree = signal<TreeNode | null>(null);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  async loadTree(): Promise<void> {
    const root = this.root();
    if (!root) {
      this.tree.set(null);
      this.error.set(null);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const node = await invoke<TreeNode>('get_tree', { root });
      this.tree.set(node);
      this.debug.info('project', `tree cargado (${this.countNodes(node)} nodos)`, root);
    } catch (err) {
      this.error.set(String(err));
      this.tree.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  async chooseRoot(): Promise<void> {
    const picked = await this.settings.pickRoot();
    if (picked) {
      this.debug.info('project', `root elegido`, picked);
      await this.loadTree();
    }
  }

  private countNodes(n: TreeNode): number {
    let total = 1;
    for (const c of n.children ?? []) total += this.countNodes(c);
    return total;
  }

  /**
   * Devuelve el ancestro del path indicado cuyo `kind` matchea, o null. Útil
   * para resolver "saga/libro actual" a partir del capítulo abierto.
   * El backend usa `directory name` como id de saga/book — devolvemos `name`
   * del nodo, que es exactamente el nombre del directorio.
   */
  findAncestorByKind(path: string, kind: NodeKind): TreeNode | null {
    const tree = this.tree();
    if (!tree || !path) return null;
    const chain: TreeNode[] = [];
    if (!collectAncestors(tree, path, chain)) return null;
    // chain[0] = root, chain[last] = el nodo mismo. Buscar del más cercano al más lejano.
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].kind === kind) return chain[i];
    }
    return null;
  }

  /** Actualiza `modifiedMs` del nodo con `path` indicado dentro del signal
   *  `tree`. No-op si el nodo no existe. Usado por `chapter-service` tras
   *  guardar para que el badge "recién editado" del árbol refleje la edición
   *  sin esperar a un `loadTree()` completo. */
  touchNodeModifiedMs(path: string, modifiedMs: number): void {
    this.tree.update((root) => {
      if (!root) return root;
      return patchNodeMtime(root, path, modifiedMs);
    });
  }
}

/**
 * Walk DFS apilando ancestros hasta encontrar `target`. Devuelve true si lo
 * encontró; `out` queda poblado con la cadena root → … → target. Si no lo
 * encuentra, `out` queda restaurado al estado pre-call.
 */
function collectAncestors(node: TreeNode, target: string, out: TreeNode[]): boolean {
  out.push(node);
  if (node.path === target) return true;
  for (const c of node.children ?? []) {
    if (collectAncestors(c, target, out)) return true;
  }
  out.pop();
  return false;
}

/**
 * Devuelve una copia del subtree con `modifiedMs` parcheado en el nodo cuyo
 * `path` coincide. Si no encuentra el path, devuelve la referencia original
 * (no muta ni crea copia) — así el signal `tree` queda igual y los OnPush
 * downstream no se invalidan al pedo.
 */
function patchNodeMtime(node: TreeNode, path: string, modifiedMs: number): TreeNode {
  if (node.path === path) {
    return { ...node, modifiedMs };
  }
  const children = node.children ?? [];
  let mutated = false;
  const next = children.map((c) => {
    const patched = patchNodeMtime(c, path, modifiedMs);
    if (patched !== c) mutated = true;
    return patched;
  });
  return mutated ? { ...node, children: next } : node;
}
