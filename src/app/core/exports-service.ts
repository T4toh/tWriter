import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

export interface ExportEntry {
  name: string;
  path: string;
  size_bytes: number;
  modified_ms?: number | null;
}

@Injectable({ providedIn: 'root' })
export class ExportsService {
  private readonly cache = signal<Map<string, ExportEntry[]>>(new Map());

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
