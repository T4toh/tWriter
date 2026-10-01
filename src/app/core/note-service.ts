import { Injectable, WritableSignal, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ChapterService, PaneId } from './chapter-service';
import { DebugService } from './debug-service';
import { GitService } from './git-service';
import { ProjectService } from './project-service';
import { ToastService } from './toast-service';

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
  /** Mismo descarte de aperturas tardías que `ChapterPane.openGen`. */
  openGen: number;
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
    openGen: 0,
  };
}

@Injectable({ providedIn: 'root' })
export class NoteService {
  private chapter = inject(ChapterService);
  private debug = inject(DebugService);
  private project = inject(ProjectService);
  private git = inject(GitService);
  private toast = inject(ToastService);

  /** Ver `ChapterService.closeWrites`. */
  private closeWrites: Promise<unknown> = Promise.resolve();

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
    const gen = ++pane.openGen;
    await this.flushPendingInPane(paneId);
    if (gen !== pane.openGen) return;
    this.chapter.closeInPane(paneId);
    pane.error.set(null);
    try {
      await this.closeWrites;
      const md = await invoke<string>('read_note', { path: target.path });
      if (gen !== pane.openGen) return;
      pane.content.set(md);
      pane.dirty.set(false);
      pane.active.set(target);
      pane.loadedAt.set(Date.now());
    } catch (err) {
      if (gen !== pane.openGen) return;
      pane.error.set(String(err));
      pane.content.set('');
      pane.dirty.set(false);
      pane.active.set(target);
      pane.loadedAt.set(Date.now());
    }
  }

  /** Mismo criterio que `ChapterService.closeInPane`: guarda lo pendiente en
   *  segundo plano, salvo `discardPending` cuando la nota ya no existe. */
  closeInPane(paneId: PaneId, discardPending = false): void {
    const pane = this.panes[paneId];
    pane.openGen++;
    const target = pane.active();
    if (!discardPending && target && pane.dirty()) {
      const write = invoke('write_note', { path: target.path, content: pane.content() })
        .then(() => void this.git.refreshStatus())
        .catch((err) => {
          this.debug.error('note', String(err));
          this.toast.error(`No se pudo guardar «${target.name}» al cerrarla: ${String(err)}`);
        });
      this.closeWrites = Promise.all([this.closeWrites, write]);
    }
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
      // Refresh reactivo del status git para mantener el indicador honesto
      // (ver chapter-service.saveInPane para el rationale).
      void this.git.refreshStatus();
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

  /** Crea `<parentDir>/<name>.md` (creando `notas/` si hace falta) y abre la nota.
   *  `body` = markdown inicial de una plantilla; si es null el backend escribe
   *  `# <name>` solo (ver `shared/note-templates.ts`). */
  async createNote(
    parentDir: string,
    name: string,
    body: string | null = null,
  ): Promise<string | null> {
    try {
      const result = await invoke<{ path: string }>('create_note', {
        parentDir,
        name,
        body,
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

  /** Crea `<parentDir>/<name>/` y refresca el tree. No abre nada. */
  async createFolder(parentDir: string, name: string): Promise<string | null> {
    try {
      const path = await invoke<string>('create_folder', { parentDir, name });
      this.debug.info('note', `Carpeta creada: ${path}`);
      await this.project.loadTree();
      void this.git.refreshStatus();
      return path;
    } catch (err) {
      this.debug.error('note', String(err));
      this.panes[0].error.set(String(err));
      throw err;
    }
  }

  async deleteNote(target: NoteTarget): Promise<boolean> {
    try {
      await invoke('delete_note', { path: target.path });
      this.debug.info('note', `Nota borrada: ${target.path}`);
      for (const i of PANE_IDS) {
        if (this.panes[i].active()?.path === target.path) this.closeInPane(i, true);
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

  /** Flushea autosave de TODOS los panes con dirty. No-op si ningún pane
   *  está dirty. Usado por GitService.flushAndSync antes de commit+push. */
  async flushAllDirty(): Promise<void> {
    await Promise.all([this.closeWrites, ...PANE_IDS.map((id) => this.flushPendingInPane(id))]);
  }
}
