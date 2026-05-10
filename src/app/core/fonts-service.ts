import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { FontEntry } from './types';

/** Override layer per-saga / per-book de fuentes. Mismo patrón que ExtrasService. */
@Injectable({ providedIn: 'root' })
export class FontsService {
  private readonly cache = signal<Map<string, FontEntry[]>>(new Map());

  get(scopePath: string): FontEntry[] {
    return this.cache().get(scopePath) ?? [];
  }

  hasLoaded(scopePath: string): boolean {
    return this.cache().has(scopePath);
  }

  async refresh(scopePath: string): Promise<FontEntry[]> {
    const entries = await invoke<FontEntry[]>('list_fonts', { scopePath });
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
  ): Promise<FontEntry> {
    const entry = await invoke<FontEntry>('add_font', {
      scopePath,
      sourcePath,
      targetName: targetName ?? null,
    });
    await this.refresh(scopePath);
    return entry;
  }

  async remove(scopePath: string, relativePath: string): Promise<void> {
    await invoke('remove_font', { scopePath, relativePath });
    await this.refresh(scopePath);
  }

  async rename(
    scopePath: string,
    relativePath: string,
    newName: string,
  ): Promise<FontEntry> {
    const entry = await invoke<FontEntry>('rename_font', {
      scopePath,
      relativePath,
      newName,
    });
    await this.refresh(scopePath);
    return entry;
  }

  clear(): void {
    this.cache.set(new Map());
  }
}
