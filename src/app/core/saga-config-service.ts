import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { TreeNode } from './types';

export interface SagaConfig {
  nombre: string;
  autor?: string | null;
  idioma?: string | null;
  tapa?: string | null;
  diccionario?: string[] | null;
}

@Injectable({ providedIn: 'root' })
export class SagaConfigService {
  /** Nodo de saga cuyo modal está abierto. null = cerrado. */
  readonly editing = signal<TreeNode | null>(null);
  /** Bumpea con cada save para que cards/header re-loaden. */
  readonly savedAt = signal<number>(0);

  async load(sagaPath: string): Promise<SagaConfig> {
    return await invoke<SagaConfig>('get_saga_config', { sagaPath });
  }

  async save(sagaPath: string, config: SagaConfig): Promise<void> {
    await invoke('set_saga_config', { sagaPath, config });
    this.savedAt.set(Date.now());
  }

  openFor(node: TreeNode): void {
    if (node.kind !== 'saga') return;
    this.editing.set(node);
  }

  close(): void {
    this.editing.set(null);
  }
}
