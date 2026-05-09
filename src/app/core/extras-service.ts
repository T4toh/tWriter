import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

export type ExtraKind = 'image' | 'document' | 'text' | 'other';

export interface ExtraEntry {
  name: string;
  path: string;
  relative_path: string;
  size_bytes: number;
  kind: ExtraKind;
  ext?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ExtrasService {
  /** Map de scopePath → entries cacheadas. Bumpea con cada list. */
  private readonly cache = signal<Map<string, ExtraEntry[]>>(new Map());

  /** Devuelve la lista cacheada (vacía si nunca se cargó). */
  get(scopePath: string): ExtraEntry[] {
    return this.cache().get(scopePath) ?? [];
  }

  /** Devuelve true si se cargó alguna vez (incluso si está vacía). */
  hasLoaded(scopePath: string): boolean {
    return this.cache().has(scopePath);
  }

  async refresh(scopePath: string): Promise<ExtraEntry[]> {
    const entries = await invoke<ExtraEntry[]>('list_extras', { scopePath });
    this.cache.update((m) => {
      const next = new Map(m);
      next.set(scopePath, entries);
      return next;
    });
    return entries;
  }

  async addFromPath(
    scopePath: string,
    sourcePath: string,
    targetName?: string,
  ): Promise<ExtraEntry> {
    const entry = await invoke<ExtraEntry>('add_extra', {
      scopePath,
      sourcePath,
      targetName: targetName ?? null,
    });
    await this.refresh(scopePath);
    return entry;
  }

  async remove(scopePath: string, relativePath: string): Promise<void> {
    await invoke('remove_extra', { scopePath, relativePath });
    await this.refresh(scopePath);
  }

  async rename(
    scopePath: string,
    relativePath: string,
    newName: string,
  ): Promise<ExtraEntry> {
    const entry = await invoke<ExtraEntry>('rename_extra', {
      scopePath,
      relativePath,
      newName,
    });
    await this.refresh(scopePath);
    return entry;
  }

  /** Olvida todo el cache. Llamar al cambiar de root. */
  clear(): void {
    this.cache.set(new Map());
  }
}
