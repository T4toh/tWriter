import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { TreeNode } from './types';

const DEFAULT_ROOT = '/home/tatoh/Repos/Personal/Novelas';

@Injectable({ providedIn: 'root' })
export class ProjectService {
  readonly root = signal<string>(DEFAULT_ROOT);
  readonly tree = signal<TreeNode | null>(null);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  async loadTree(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const node = await invoke<TreeNode>('get_tree', { root: this.root() });
      this.tree.set(node);
    } catch (err) {
      this.error.set(String(err));
      this.tree.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  setRoot(path: string): void {
    this.root.set(path);
    void this.loadTree();
  }
}
