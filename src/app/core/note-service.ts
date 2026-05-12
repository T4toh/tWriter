import { Injectable, WritableSignal, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ChapterService, PaneId } from './chapter-service';
import { DebugService } from './debug-service';
import { GitService } from './git-service';
import { ProjectService } from './project-service';

const AUTOSAVE_MS = 1500;
const PANE_IDS: readonly PaneId[] = [0, 1] as const;

export interface NoteTarget {
  path: string;
  name: string;
}

interface NotePane {
  active: WritableSignal<NoteTarget | null>;
  content: WritableSignal<string>;
  dirty: WritableSignal<boolean>;
  saving: WritableSignal<boolean>;
  error: WritableSignal<string | null>;
  lastSavedAt: WritableSignal<number | null>;
  loadedAt: WritableSignal<number>;
  autosaveTimer: ReturnType<typeof setTimeout> | null;
}

function makeNotePane(): NotePane {
  return {
    active: signal<NoteTarget | null>(null),
    content: signal<string>(''),
    dirty: signal<boolean>(false),
    saving: signal<boolean>(false),
    error: signal<string | null>(null),
    lastSavedAt: signal<number | null>(null),
    loadedAt: signal<number>(0),
    autosaveTimer: null,
  };
}

@Injectable({ providedIn: 'root' })
export class NoteService {
  private chapter = inject(ChapterService);
  private debug = inject(DebugService);
  private project = inject(ProjectService);
  private git = inject(GitService);

  /** Dos panes. pane 0 = principal. pane 1 = secundario (split). */
  readonly panes: readonly [NotePane, NotePane] = [makeNotePane(), makeNotePane()];

  // Backward-compat aliases a pane 0.
  readonly active = this.panes[0].active;
  readonly content = this.panes[0].content;
  readonly dirty = this.panes[0].dirty;
  readonly saving = this.panes[0].saving;
  readonly error = this.panes[0].error;
  readonly lastSavedAt = this.panes[0].lastSavedAt;
  readonly loadedAt = this.panes[0].loadedAt;

  // ──────── API legacy (pane 0) ────────

  async open(target: NoteTarget): Promise<void> {
    return this.openInPane(target, 0);
  }

  close(): void {
    this.closeInPane(0);
  }

  updateContent(md: string): void {
    this.updateContentInPane(md, 0);
  }

  async save(): Promise<void> {
    return this.saveInPane(0);
  }

  // ──────── API pane-aware ────────

  async openInPane(target: NoteTarget, paneId: PaneId): Promise<void> {
    const pane = this.panes[paneId];
    await this.flushPendingInPane(paneId);
    this.chapter.closeInPane(paneId);
    pane.error.set(null);
    try {
      const md = await invoke<string>('read_note', { path: target.path });
      pane.content.set(md);
      pane.dirty.set(false);
      pane.active.set(target);
      pane.loadedAt.set(Date.now());
    } catch (err) {
      pane.error.set(String(err));
      pane.content.set('');
      pane.dirty.set(false);
      pane.active.set(target);
      pane.loadedAt.set(Date.now());
    }
  }

  closeInPane(paneId: PaneId): void {
    const pane = this.panes[paneId];
    this.cancelAutosaveInPane(paneId);
    pane.active.set(null);
    pane.content.set('');
    pane.dirty.set(false);
    pane.error.set(null);
    pane.loadedAt.set(Date.now());
  }

  updateContentInPane(md: string, paneId: PaneId): void {
    const pane = this.panes[paneId];
    if (!pane.active()) return;
    if (pane.content() === md) return;
    pane.content.set(md);
    pane.dirty.set(true);
    this.scheduleAutosaveInPane(paneId);
  }

  async saveInPane(paneId: PaneId): Promise<void> {
    const pane = this.panes[paneId];
    const target = pane.active();
    if (!target || !pane.dirty()) return;
    this.cancelAutosaveInPane(paneId);
    pane.saving.set(true);
    try {
      await invoke('write_note', { path: target.path, content: pane.content() });
      pane.dirty.set(false);
      pane.lastSavedAt.set(Date.now());
    } catch (err) {
      pane.error.set(String(err));
      this.debug.error('note', String(err));
    } finally {
      pane.saving.set(false);
    }
  }

  /** Devuelve el primer paneId que tiene ese path activo, o null. */
  findPaneByPath(path: string): PaneId | null {
    for (const i of PANE_IDS) {
      if (this.panes[i].active()?.path === path) return i;
    }
    return null;
  }

  // ──────── Operaciones globales ────────

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
      this.panes[0].error.set(String(err));
      return null;
    }
  }

  async deleteNote(target: NoteTarget): Promise<boolean> {
    try {
      await invoke('delete_note', { path: target.path });
      this.debug.info('note', `Nota borrada: ${target.path}`);
      for (const i of PANE_IDS) {
        if (this.panes[i].active()?.path === target.path) this.closeInPane(i);
      }
      await this.project.loadTree();
      void this.git.refreshStatus();
      return true;
    } catch (err) {
      this.debug.error('note', `${target.name}: ${err}`);
      this.panes[0].error.set(String(err));
      return false;
    }
  }

  // ──────── Autosave per-pane ────────

  private scheduleAutosaveInPane(paneId: PaneId): void {
    this.cancelAutosaveInPane(paneId);
    this.panes[paneId].autosaveTimer = setTimeout(
      () => void this.saveInPane(paneId),
      AUTOSAVE_MS,
    );
  }

  private cancelAutosaveInPane(paneId: PaneId): void {
    const pane = this.panes[paneId];
    if (pane.autosaveTimer != null) {
      clearTimeout(pane.autosaveTimer);
      pane.autosaveTimer = null;
    }
  }

  private async flushPendingInPane(paneId: PaneId): Promise<void> {
    if (this.panes[paneId].dirty()) {
      await this.saveInPane(paneId);
    } else {
      this.cancelAutosaveInPane(paneId);
    }
  }
}
