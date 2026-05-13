import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { DebugService } from './debug-service';
import { ProjectService } from './project-service';
import { SettingsService } from './settings-service';

export type JoplinStep = 'source' | 'preview' | 'progreso' | 'completo';

export type ConflictPolicy = 'suffix' | 'skip' | 'overwrite';

export interface JoplinPreviewNode {
  name: string;
  rel_path: string;
  is_dir: boolean;
  bytes: number;
  empty: boolean;
  children: JoplinPreviewNode[];
}

export interface JoplinPreview {
  total_notes: number;
  total_folders: number;
  total_bytes: number;
  empty_notes: number;
  tree: JoplinPreviewNode[];
}

export interface JoplinImportOptions {
  skip_empty: boolean;
  on_conflict: ConflictPolicy;
}

export interface JoplinResult {
  copied: number;
  skipped: number;
  conflicts: number;
  dest_root: string;
}

interface JoplinProgress {
  done: number;
  total: number;
  current: string;
}

@Injectable({ providedIn: 'root' })
export class ImportJoplinService {
  private settings = inject(SettingsService);
  private project = inject(ProjectService);
  private debug = inject(DebugService);

  readonly open = signal<boolean>(false);
  readonly step = signal<JoplinStep>('source');
  readonly sourcePath = signal<string | null>(null);
  readonly destSubdir = signal<string>('Notas');
  readonly preview = signal<JoplinPreview | null>(null);
  readonly scanning = signal<boolean>(false);
  readonly applying = signal<boolean>(false);
  readonly progress = signal<JoplinProgress | null>(null);
  readonly result = signal<JoplinResult | null>(null);
  readonly error = signal<string | null>(null);
  readonly skipEmpty = signal<boolean>(false);
  readonly onConflict = signal<ConflictPolicy>('suffix');

  private unlisten: UnlistenFn | null = null;
  private lastProgressLog = 0;

  show(): void {
    this.reset();
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
    this.detach();
  }

  reset(): void {
    this.step.set('source');
    this.sourcePath.set(null);
    this.preview.set(null);
    this.scanning.set(false);
    this.applying.set(false);
    this.progress.set(null);
    this.result.set(null);
    this.error.set(null);
    this.destSubdir.set('Notas');
    this.skipEmpty.set(false);
    this.onConflict.set('suffix');
  }

  async scan(path: string): Promise<void> {
    this.sourcePath.set(path);
    this.scanning.set(true);
    this.error.set(null);
    this.debug.info('joplin', `scan iniciado`, path);
    try {
      const preview = await invoke<JoplinPreview>('joplin_scan', { source: path });
      this.preview.set(preview);
      // Default dest = nombre del folder source, sanitizado.
      const fallback = guessDestName(path);
      this.destSubdir.set(fallback);
      this.step.set('preview');
      this.debug.info(
        'joplin',
        `scan completo: ${preview.total_notes} notas, ${preview.total_folders} carpetas`,
      );
    } catch (e) {
      this.error.set(String(e));
      this.debug.error('joplin', `scan falló`, String(e));
    } finally {
      this.scanning.set(false);
    }
  }

  async apply(): Promise<void> {
    const src = this.sourcePath();
    const root = this.settings.root();
    const sub = this.destSubdir().trim();
    if (!src || !root) {
      this.error.set('Falta source o root.');
      return;
    }
    if (!sub) {
      this.error.set('Indicá carpeta destino dentro del repo.');
      return;
    }
    const dest = `${root.replace(/\/+$/, '')}/${sub}`;
    const options: JoplinImportOptions = {
      skip_empty: this.skipEmpty(),
      on_conflict: this.onConflict(),
    };
    this.applying.set(true);
    this.error.set(null);
    this.result.set(null);
    this.progress.set({ done: 0, total: this.preview()?.total_notes ?? 0, current: '' });
    this.step.set('progreso');
    await this.attach();
    this.debug.info('joplin', `apply iniciado → ${dest}`);
    try {
      const result = await invoke<JoplinResult>('joplin_import_apply', {
        source: src,
        dest,
        options,
      });
      this.result.set(result);
      this.step.set('completo');
      await this.project.loadTree();
      this.debug.info(
        'joplin',
        `apply listo: copied=${result.copied} skipped=${result.skipped} conflicts=${result.conflicts}`,
      );
    } catch (e) {
      this.error.set(String(e));
      this.step.set('preview');
      this.debug.error('joplin', `apply falló`, String(e));
    } finally {
      this.applying.set(false);
      this.detach();
    }
  }

  private async attach(): Promise<void> {
    this.detach();
    this.unlisten = await listen<JoplinProgress>('joplin-import-progress', (event) => {
      this.progress.set(event.payload);
      const now = Date.now();
      if (now - this.lastProgressLog >= 1000 || event.payload.done === event.payload.total) {
        this.lastProgressLog = now;
        this.debug.info(
          'joplin',
          `progreso ${event.payload.done}/${event.payload.total}`,
          event.payload.current,
        );
      }
    });
  }

  private detach(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }
}

function guessDestName(sourcePath: string): string {
  const trimmed = sourcePath.replace(/\/+$/, '');
  const last = trimmed.split('/').pop() || 'Notas';
  // Sanitiza nombres tipo "Joplin EXP" → "Joplin EXP" (sin / ni \).
  return last.replace(/[\\/]/g, '_').trim() || 'Notas';
}
