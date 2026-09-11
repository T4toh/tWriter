import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { TreeNode } from './types';

export interface ExportEntry {
  name: string;
  path: string;
  size_bytes: number;
  modified_ms?: number | null;
}

@Injectable({ providedIn: 'root' })
export class ExportsService {
  private readonly cache = signal<Map<string, ExportEntry[]>>(new Map());

  /** Libro cuyo modal de export está abierto. null = cerrado. */
  readonly pendiente = signal<TreeNode | null>(null);
  /** Paths de los libros con un export en curso: la tarjeta bloquea su botón
   *  y muestra el spinner mientras dure. */
  readonly exportando = signal<ReadonlySet<string>>(new Set());

  abrirPara(node: TreeNode): void {
    if (node.kind !== 'book') return;
    this.pendiente.set(node);
  }

  cerrar(): void {
    this.pendiente.set(null);
  }

  marcarExportando(bookPath: string, activo: boolean): void {
    this.exportando.update((prev) => {
      const next = new Set(prev);
      if (activo) next.add(bookPath);
      else next.delete(bookPath);
      return next;
    });
  }

  get(bookPath: string): ExportEntry[] {
    return this.cache().get(bookPath) ?? [];
  }

  hasLoaded(bookPath: string): boolean {
    return this.cache().has(bookPath);
  }

  async refresh(bookPath: string): Promise<ExportEntry[]> {
    const entries = await invoke<ExportEntry[]>('list_exports', { bookPath });
    this.cache.update((m) => {
      const next = new Map(m);
      next.set(bookPath, entries);
      return next;
    });
    return entries;
  }

  clear(): void {
    this.cache.set(new Map());
  }
}
