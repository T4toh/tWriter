import { Injectable, computed, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ChapterMeta, EMPTY_META, TreeNode } from './types';

const AUTOSAVE_MS = 1500;

@Injectable({ providedIn: 'root' })
export class ChapterService {
  readonly active = signal<TreeNode | null>(null);
  readonly content = signal<string>('');
  readonly meta = signal<ChapterMeta>(EMPTY_META);
  readonly dirty = signal<boolean>(false);
  readonly saving = signal<boolean>(false);
  readonly lastSavedAt = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  /** Bumpea cada vez que se abre o cierra un capítulo. El editor lo observa para resincronizar. */
  readonly loadedAt = signal<number>(0);

  readonly wordCount = computed(() => countWords(this.content()));
  readonly canEdit = computed(() => !!this.active()?.editable);

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  async open(node: TreeNode): Promise<void> {
    if (node.kind !== 'chapter') {
      return;
    }
    await this.flushPending();
    this.error.set(null);

    if (!node.editable) {
      this.content.set('');
      this.meta.set(EMPTY_META);
      this.dirty.set(false);
      this.active.set(node);
      this.loadedAt.set(Date.now());
      return;
    }

    try {
      const [html, meta] = await Promise.all([
        invoke<string>('read_chapter', { path: node.path }),
        invoke<ChapterMeta>('read_meta', { chapterPath: node.path }),
      ]);
      this.content.set(html);
      this.meta.set(meta ?? EMPTY_META);
      this.dirty.set(false);
      this.active.set(node);
      this.loadedAt.set(Date.now());
    } catch (err) {
      this.error.set(String(err));
      this.active.set(node);
      this.loadedAt.set(Date.now());
    }
  }

  close(): void {
    this.cancelAutosave();
    this.active.set(null);
    this.content.set('');
    this.meta.set(EMPTY_META);
    this.dirty.set(false);
    this.error.set(null);
    this.loadedAt.set(Date.now());
  }

  updateContent(html: string): void {
    if (!this.canEdit()) {
      return;
    }
    if (this.content() === html) {
      return;
    }
    this.content.set(html);
    this.dirty.set(true);
    this.scheduleAutosave();
  }

  async save(): Promise<void> {
    const node = this.active();
    if (!node || !node.editable || !this.dirty()) {
      return;
    }
    this.cancelAutosave();
    this.saving.set(true);
    try {
      await invoke('write_chapter', { path: node.path, html: this.content() });
      const updated: ChapterMeta = {
        ...this.meta(),
        palabras: countWords(this.content()),
        ultima_edicion: new Date().toISOString(),
      };
      await invoke('write_meta', { chapterPath: node.path, meta: updated });
      this.meta.set(updated);
      this.dirty.set(false);
      this.lastSavedAt.set(Date.now());
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.saving.set(false);
    }
  }

  private scheduleAutosave(): void {
    this.cancelAutosave();
    this.autosaveTimer = setTimeout(() => void this.save(), AUTOSAVE_MS);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer != null) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  private async flushPending(): Promise<void> {
    if (this.dirty()) {
      await this.save();
    } else {
      this.cancelAutosave();
    }
  }
}

function countWords(html: string): number {
  if (!html) return 0;
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}
