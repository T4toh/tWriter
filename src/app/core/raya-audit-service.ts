import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { htmlToPlain, nonProseSkip, validateRaya } from '../dialogos/validator';
import { detectMayusculasRancias } from '../dictionary/mayusculas-rancias';
import { resolverIdiomaEfectivo } from '../revision/deteccion';
import { BookConfigService } from './book-config-service';
import { RayaViolation } from './types';
import { FontPreviewService } from './font-preview-service';
import { ImageViewerService } from './image-viewer-service';
import { MarkdownReaderService } from './markdown-reader-service';
import { SearchService } from './search-service';
import { DebugService } from './debug-service';
import { yieldToEventLoop } from './yield-to-event-loop';

interface ChapterPayload {
  path: string;
  html: string;
  idioma?: string | null;
}

export interface ChapterViolations {
  path: string;
  title: string;
  plain: string;
  violations: RayaViolation[];
}

export interface AuditScope {
  path: string;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class RayaAuditService {
  private search = inject(SearchService);
  private imageViewer = inject(ImageViewerService);
  private fontPreview = inject(FontPreviewService);
  private markdownReader = inject(MarkdownReaderService);
  private debug = inject(DebugService);
  private bookConfig = inject(BookConfigService);

  readonly scope = signal<AuditScope | null>(null);
  readonly chapters = signal<ChapterViolations[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly progress = signal<{ done: number; total: number } | null>(null);

  /** Pedido de "abrime el popover sobre ESTA violación", que el editor consume
   *  al final de `checkRaya`. Mismo patrón que el de gramática: se identifica
   *  por `ruleId` + `anchor`, no por offset, porque el panel calcula sobre
   *  `htmlToPlain` y el editor sobre `extractPlainText`. */
  readonly pendingPopover = signal<{ path: string; ruleId: string; anchor: string } | null>(
    null,
  );

  pedirPopover(path: string, ruleId: string, anchor: string): void {
    this.pendingPopover.set({ path, ruleId, anchor });
  }

  limpiarPopoverPendiente(): void {
    this.pendingPopover.set(null);
  }

  readonly totalViolations = computed(() =>
    this.chapters().reduce((sum, c) => sum + c.violations.length, 0),
  );
  /** Las mayúsculas rancias traen `autoFix` para el popover del editor, pero
   *  ningún bulk las aplica, así que acá no cuentan como auto-fixables. */
  readonly autoFixableCount = computed(() => {
    let n = 0;
    for (const c of this.chapters()) {
      for (const v of c.violations) {
        if (v.autoFix !== undefined && !v.autoFix.manual && v.category !== 'mayusculas') n += 1;
      }
    }
    return n;
  });

  /** Idioma declarado en `book.json`, si el alcance está adentro de un libro.
   *  Un fallo acá no es un error del escaneo: se cae al idioma del capítulo y
   *  después a `detectLang` (ver `resolverIdiomaEfectivo`). */
  private async idiomaDelLibro(path: string): Promise<string | null> {
    try {
      return (await this.bookConfig.load(path)).idioma ?? null;
    } catch {
      return null;
    }
  }

  isOpen(): boolean {
    return this.scope() !== null;
  }

  async open(scope: AuditScope): Promise<void> {
    this.search.hide();
    this.imageViewer.close();
    this.fontPreview.close();
    this.markdownReader.close();

    this.scope.set(scope);
    this.chapters.set([]);
    this.loading.set(true);
    this.error.set(null);
    this.progress.set(null);

    try {
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath: scope.path,
      });
      this.progress.set({ done: 0, total: payloads.length });
      const dictWords = await this.palabrasDeLaSaga(scope.path);
      const idiomaLibro = await this.idiomaDelLibro(scope.path);

      const accumulated: ChapterViolations[] = [];
      let processed = 0;
      for (const payload of payloads) {
        // El libro manda, como en los otros dos paneles de auditoría.
        const lang = resolverIdiomaEfectivo(idiomaLibro, payload.idioma, payload.html);
        const plain = htmlToPlain(payload.html);
        // La raya es solo español; las mayúsculas rancias no tienen idioma.
        const violations = [
          ...(lang === 'es' ? validateRaya(plain, 'es', nonProseSkip(payload.html)) : []),
          ...detectMayusculasRancias(plain, dictWords),
        ].sort((a, b) => a.offset - b.offset);
        if (violations.length > 0) {
          accumulated.push({
            path: payload.path,
            title: titleFromPath(payload.path),
            plain,
            violations,
          });
          this.chapters.set([...accumulated]);
        }
        processed += 1;
        this.progress.set({ done: processed, total: payloads.length });
        if (processed % 5 === 0) await yieldToEventLoop();
      }

      this.debug.info(
        'raya-audit',
        'audit completado',
        JSON.stringify({
          scope: scope.path,
          chapters: payloads.length,
          withViolations: accumulated.length,
          total: this.totalViolations(),
        }),
      );
    } catch (err) {
      this.error.set(String(err));
      this.debug.error('raya-audit', 'audit falló', String(err));
    } finally {
      this.loading.set(false);
      this.progress.set(null);
    }
  }

  /** Diccionario de la saga que contiene al alcance auditado. Mismo patrón que
   *  `RevisionLibroService.palabrasDeLaSaga`: `find_saga_dir` (Rust) resuelve
   *  por filesystem, así sirve aunque el alcance no sea la saga activa. */
  private async palabrasDeLaSaga(path: string): Promise<string[]> {
    try {
      const sagaPath = await invoke<string | null>('find_saga_dir', { path });
      if (!sagaPath) return [];
      return await invoke<string[]>('get_saga_dictionary', { sagaPath });
    } catch {
      return [];
    }
  }

  close(): void {
    this.scope.set(null);
    this.chapters.set([]);
    this.loading.set(false);
    this.error.set(null);
    this.progress.set(null);
  }
}

function titleFromPath(path: string): string {
  const parts = path.split(/[\\/]/);
  const file = parts[parts.length - 1] ?? path;
  return file.replace(/\.html$/i, '');
}
