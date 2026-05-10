import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { TreeNode } from './types';

export type ChapterPrefix = 'none' | 'decimal' | 'roman';

export interface SagaConfig {
  nombre: string;
  autor?: string | null;
  idioma?: string | null;
  tapa?: string | null;
  diccionario?: string[] | null;
  imprenta?: string | null;
  template?: '6x9' | '5x8' | 'a5' | null;
  mostrar_titulo_capitulo?: boolean | null;
  prefijo_capitulo?: ChapterPrefix | null;
  dropcap?: boolean | null;
  mostrar_numero_parte?: boolean | null;
  formato_parte?: 'raw' | 'parte' | 'punto' | null;
  finalizada?: boolean | null;
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
