import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { educateQuotes } from '../quotes/educate';
import { detectLang } from '../dialogos/detect';
import { ToastService } from './toast-service';
import { DebugService } from './debug-service';
import { ProjectService } from './project-service';
import { GitService } from './git-service';

interface ChapterPayload {
  path: string;
  html: string;
  idioma?: string | null;
}

/**
 * Aplica el educador de comillas tipográficas (inglés) en bloque sobre todos los
 * capítulos EN de un scope (saga/libro/sección). Reusa el comando Rust
 * `list_chapters_for_audit` para enumerar y `write_chapter` para persistir.
 */
@Injectable({ providedIn: 'root' })
export class QuotesFixService {
  private toast = inject(ToastService);
  private debug = inject(DebugService);
  private project = inject(ProjectService);
  private git = inject(GitService);

  readonly running = signal<boolean>(false);

  /** Cuántos capítulos EN hay en el scope (para el confirm previo). */
  async countEnglishChapters(scopePath: string): Promise<number> {
    const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
      scopePath,
    });
    return payloads.filter((p) => this.isEnglish(p)).length;
  }

  /** Educa comillas en todos los capítulos EN del scope. Escribe solo los que cambian. */
  async fixScope(scopePath: string): Promise<void> {
    this.running.set(true);
    try {
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath,
      });
      let processed = 0;
      let changed = 0;
      for (const payload of payloads) {
        if (!this.isEnglish(payload)) continue;
        const result = educateQuotes(payload.html);
        if (result.changes > 0) {
          await invoke('write_chapter', { path: payload.path, html: result.text });
          changed += 1;
        }
        processed += 1;
        if (processed % 5 === 0) await yieldToEventLoop();
      }
      this.debug.info(
        'quotes-fix',
        'fix completado',
        JSON.stringify({ scope: scopePath, procesados: processed, modificados: changed }),
      );
      if (changed === 0) {
        this.toast.info('Comillas: sin cambios.');
      } else {
        // Reescanea el FS para que el árbol refleje fecha/estado sin esperar al
        // próximo poll ni un recargar manual; y refresca el status git.
        await this.project.loadTree();
        void this.git.refreshStatus();
        this.toast.success(
          `Comillas: ${changed} capítulo${changed === 1 ? '' : 's'} modificado${changed === 1 ? '' : 's'}.`,
        );
      }
    } catch (e) {
      this.toast.error(`Comillas: ${e}`);
      this.debug.error('quotes-fix', 'fix falló', String(e));
    } finally {
      this.running.set(false);
    }
  }

  private isEnglish(p: ChapterPayload): boolean {
    const lang = p.idioma ?? detectLang(p.html);
    return lang === 'en';
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
