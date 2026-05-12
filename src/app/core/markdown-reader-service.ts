import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { NoteService, NoteTarget } from './note-service';

@Injectable({ providedIn: 'root' })
export class MarkdownReaderService {
  private notes = inject(NoteService);

  readonly viewing = signal<NoteTarget | null>(null);
  readonly content = signal<string>('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Bumpea cada vez que se abre/cierra una nota. El componente lo observa para resincronizar. */
  readonly loadedAt = signal<number>(0);

  async open(target: NoteTarget): Promise<void> {
    this.viewing.set(target);
    this.content.set('');
    this.error.set(null);
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
    this.viewing.set(null);
    this.content.set('');
    this.error.set(null);
    this.loading.set(false);
    this.loadedAt.set(Date.now());
  }

  isOpen(): boolean {
    return this.viewing() !== null;
  }

  /** Promueve la nota al notes-editor del centro para edición. Cierra el reader. */
  async promoteToCenter(): Promise<void> {
    const target = this.viewing();
    if (!target) return;
    this.close();
    await this.notes.open(target);
  }
}
