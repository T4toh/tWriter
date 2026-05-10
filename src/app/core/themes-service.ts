import { effect, inject, Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from './settings-service';
import { FontEntry, Theme, ThemeMeta } from './types';

@Injectable({ providedIn: 'root' })
export class ThemesService {
  private settings = inject(SettingsService);

  /** Cache de la lista de temas del root actual. null = sin cargar. */
  private readonly cache = signal<ThemeMeta[] | null>(null);
  /** Bumpea con cada cambio para que el tree y los modales re-rendericen. */
  readonly savedAt = signal<number>(0);
  /** Id del tema cuyo editor está abierto. null = cerrado. */
  readonly editing = signal<string | null>(null);

  constructor() {
    // El root vive en SettingsService. Cuando cambia, invalidamos el cache.
    effect(() => {
      this.settings.root();
      this.cache.set(null);
    });
  }

  getRoot(): string | null {
    return this.settings.root();
  }

  list(): ThemeMeta[] {
    return this.cache() ?? [];
  }

  hasLoaded(): boolean {
    return this.cache() !== null;
  }

  async refresh(): Promise<ThemeMeta[]> {
    const root = this.getRoot();
    if (!root) {
      this.cache.set([]);
      return [];
    }
    const themes = await invoke<ThemeMeta[]>('list_themes', { rootPath: root });
    this.cache.set(themes);
    return themes;
  }

  async get(id: string): Promise<Theme> {
    const root = this.requireRoot();
    return await invoke<Theme>('get_theme', { rootPath: root, id });
  }

  async save(id: string, theme: Theme): Promise<void> {
    const root = this.requireRoot();
    await invoke('set_theme', { rootPath: root, id, theme });
    await this.refresh();
    this.savedAt.set(Date.now());
  }

  async create(id: string, theme: Theme): Promise<void> {
    const root = this.requireRoot();
    await invoke('create_theme', { rootPath: root, id, theme });
    await this.refresh();
    this.savedAt.set(Date.now());
  }

  async rename(oldId: string, newId: string): Promise<void> {
    const root = this.requireRoot();
    await invoke('rename_theme', { rootPath: root, oldId, newId });
    await this.refresh();
    this.savedAt.set(Date.now());
  }

  async duplicate(srcId: string, dstId: string): Promise<void> {
    const root = this.requireRoot();
    await invoke('duplicate_theme', { rootPath: root, srcId, dstId });
    await this.refresh();
    this.savedAt.set(Date.now());
  }

  async delete(id: string): Promise<void> {
    const root = this.requireRoot();
    await invoke('delete_theme', { rootPath: root, id });
    await this.refresh();
    this.savedAt.set(Date.now());
  }

  // ───────── Theme fonts ─────────

  async listFonts(id: string): Promise<FontEntry[]> {
    const root = this.requireRoot();
    return await invoke<FontEntry[]>('list_theme_fonts', { rootPath: root, id });
  }

  async addFont(id: string, sourcePath: string, targetName?: string): Promise<FontEntry> {
    const root = this.requireRoot();
    return await invoke<FontEntry>('add_theme_font', {
      rootPath: root,
      id,
      sourcePath,
      targetName: targetName ?? null,
    });
  }

  async removeFont(id: string, relativePath: string): Promise<void> {
    const root = this.requireRoot();
    await invoke('remove_theme_font', { rootPath: root, id, relativePath });
  }

  async renameFont(
    id: string,
    relativePath: string,
    newName: string,
  ): Promise<FontEntry> {
    const root = this.requireRoot();
    return await invoke<FontEntry>('rename_theme_font', {
      rootPath: root,
      id,
      relativePath,
      newName,
    });
  }

  openEditor(id: string): void {
    this.editing.set(id);
  }

  closeEditor(): void {
    this.editing.set(null);
  }

  private requireRoot(): string {
    const r = this.getRoot();
    if (!r) {
      throw new Error('themes-service: rootPath no está seteado');
    }
    return r;
  }
}
