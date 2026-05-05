import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from './settings-service';
import { TreeNode } from './types';

@Injectable({ providedIn: 'root' })
export class ProjectService {
  private settings = inject(SettingsService);

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
      await this.loadTree();
    }
  }
}
