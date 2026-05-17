import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { DebugService } from './debug-service';
import { NoteTarget } from './note-service';

const AUTOSAVE_MS = 1500;

@Injectable({ providedIn: 'root' })
export class MarkdownReaderService {
  private debug = inject(DebugService);

  readonly viewing = signal<NoteTarget | null>(null);
  readonly content = signal<string>('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Bumpea cada vez que se abre/cierra una nota. El componente lo observa para resincronizar. */
  readonly loadedAt = signal<number>(0);

  // Edit mode state
  readonly editing = signal<boolean>(false);
  readonly dirty = signal<boolean>(false);
  readonly saving = signal<boolean>(false);
  readonly lastSavedAt = signal<number | null>(null);

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  async open(target: NoteTarget): Promise<void> {
    await this.flushPending();
    this.viewing.set(target);
    this.content.set('');
    this.error.set(null);
    this.editing.set(false);
    this.dirty.set(false);
    this.saving.set(false);
    this.lastSavedAt.set(null);
    this.loading.set(true);
    try {
      const md = await invoke<string>('read_note', { path: target.path });
      if (this.viewing()?.path !== target.path) return;
      this.content.set(md);
      this.loadedAt.set(Date.now());
    } catch (err) {
      if (this.viewing()?.path !== target.path) return;
      this.error.set(String(err));
    } finally {
      if (this.viewing()?.path === target.path) {
        this.loading.set(false);
      }
    }
  }

  close(): void {
    void this.flushPending();
    this.viewing.set(null);
    this.content.set('');
    this.error.set(null);
    this.loading.set(false);
    this.editing.set(false);
    this.dirty.set(false);
    this.saving.set(false);
    this.lastSavedAt.set(null);
    this.loadedAt.set(Date.now());
  }

  isOpen(): boolean {
    return this.viewing() !== null;
  }

  enterEdit(): void {
    if (!this.viewing()) return;
    this.editing.set(true);
  }

  async exitEdit(): Promise<void> {
    await this.flushPending();
    this.editing.set(false);
  }

  updateContent(md: string): void {
    if (!this.viewing()) return;
    if (this.content() === md) return;
    this.content.set(md);
    this.dirty.set(true);
    this.scheduleAutosave();
  }

  async save(): Promise<void> {
    const target = this.viewing();
    if (!target || !this.dirty()) return;
    this.cancelAutosave();
    this.saving.set(true);
    try {
      await invoke('write_note', { path: target.path, content: this.content() });
      if (this.viewing()?.path !== target.path) return;
      this.dirty.set(false);
      this.lastSavedAt.set(Date.now());
    } catch (err) {
      this.error.set(String(err));
      this.debug.error('note', String(err));
    } finally {
      this.saving.set(false);
    }
  }

  async flushPending(): Promise<void> {
    if (this.dirty()) {
      await this.save();
    } else {
      this.cancelAutosave();
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
}
