import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ChapterService } from './chapter-service';
import { DebugService } from './debug-service';
import { GitService } from './git-service';
import { ProjectService } from './project-service';

const AUTOSAVE_MS = 1500;

export interface NoteTarget {
  path: string;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class NoteService {
  private chapter = inject(ChapterService);
  private debug = inject(DebugService);
  private project = inject(ProjectService);
  private git = inject(GitService);

  readonly active = signal<NoteTarget | null>(null);
  readonly content = signal<string>('');
  readonly dirty = signal<boolean>(false);
  readonly saving = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly lastSavedAt = signal<number | null>(null);
  /** Bumpea cada vez que se abre o cierra una nota. El editor lo observa para resincronizar. */
  readonly loadedAt = signal<number>(0);

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  async open(target: NoteTarget): Promise<void> {
    await this.flushPending();
    this.chapter.close();
    this.error.set(null);
    try {
      const md = await invoke<string>('read_note', { path: target.path });
      this.content.set(md);
      this.dirty.set(false);
      this.active.set(target);
      this.loadedAt.set(Date.now());
    } catch (err) {
      this.error.set(String(err));
      this.content.set('');
      this.dirty.set(false);
      this.active.set(target);
      this.loadedAt.set(Date.now());
    }
  }

  close(): void {
    this.cancelAutosave();
    this.active.set(null);
    this.content.set('');
    this.dirty.set(false);
    this.error.set(null);
    this.loadedAt.set(Date.now());
  }

  updateContent(md: string): void {
    if (!this.active()) return;
    if (this.content() === md) return;
    this.content.set(md);
    this.dirty.set(true);
    this.scheduleAutosave();
  }

  async save(): Promise<void> {
    const target = this.active();
    if (!target || !this.dirty()) return;
    this.cancelAutosave();
    this.saving.set(true);
    try {
      await invoke('write_note', { path: target.path, content: this.content() });
      this.dirty.set(false);
      this.lastSavedAt.set(Date.now());
    } catch (err) {
      this.error.set(String(err));
      this.debug.error('note', String(err));
    } finally {
      this.saving.set(false);
    }
  }

  /** Crea `<parentDir>/<name>.md` (creando `notas/` si hace falta) y abre la nota. */
  async createNote(parentDir: string, name: string): Promise<string | null> {
    try {
      const result = await invoke<{ path: string }>('create_note', {
        parentDir,
        name,
      });
      this.debug.info('note', `Nota creada: ${result.path}`);
      await this.project.loadTree();
      void this.git.refreshStatus();
      await this.open({ path: result.path, name });
      return result.path;
    } catch (err) {
      this.debug.error('note', String(err));
      this.error.set(String(err));
      return null;
    }
  }

  async deleteNote(target: NoteTarget): Promise<boolean> {
    try {
      await invoke('delete_note', { path: target.path });
      this.debug.info('note', `Nota borrada: ${target.path}`);
      if (this.active()?.path === target.path) {
        this.close();
      }
      await this.project.loadTree();
      void this.git.refreshStatus();
      return true;
    } catch (err) {
      this.debug.error('note', `${target.name}: ${err}`);
      this.error.set(String(err));
      return false;
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
