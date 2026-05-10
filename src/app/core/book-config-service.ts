import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ThemeRef, TreeNode } from './types';

export type ChapterPrefix = 'none' | 'decimal' | 'roman';

export interface BookConfig {
  titulo: string;
  subtitulo?: string | null;
  autor?: string | null;
  idioma?: string | null;
  isbn?: string | null;
  tapa?: string | null;
  contratapa?: string | null;
  copyright_anio?: number | null;
  derechos_reservados?: boolean | null;
  dedicatoria?: string | null;
  imprenta?: string | null;
  serie?: string | null;
  numero_en_serie?: number | null;
  mostrar_titulo_capitulo?: boolean | null;
  prefijo_capitulo?: ChapterPrefix | null;
  dropcap?: boolean | null;
  mostrar_numero_parte?: boolean | null;
  formato_parte?: 'raw' | 'parte' | 'punto' | null;
  template?: '6x9' | '5x8' | 'a5' | null;
  finalizada?: boolean | null;
  epilogo?: string | null;
  theme?: ThemeRef | null;
}

@Injectable({ providedIn: 'root' })
export class BookConfigService {
  /** Nodo del libro cuyo modal está abierto. null = cerrado. */
  readonly editing = signal<TreeNode | null>(null);
  /** Bumpea con cada save para que los cards re-loaden. */
  readonly savedAt = signal<number>(0);

  async load(bookPath: string): Promise<BookConfig> {
    return await invoke<BookConfig>('get_book_config', { bookPath });
  }

  async save(bookPath: string, config: BookConfig): Promise<void> {
    await invoke('set_book_config', { bookPath, config });
    this.savedAt.set(Date.now());
  }

  openFor(node: TreeNode): void {
    if (node.kind !== 'book') return;
    this.editing.set(node);
  }

  close(): void {
    this.editing.set(null);
  }
}
