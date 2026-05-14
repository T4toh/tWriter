import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { htmlToPlain, validateRae } from '../dialogos/validator';
import { detectLang } from '../dialogos/detect';
import { RaeViolation } from './types';
import { FontPreviewService } from './font-preview-service';
import { ImageViewerService } from './image-viewer-service';
import { MarkdownReaderService } from './markdown-reader-service';
import { SearchService } from './search-service';
import { DebugService } from './debug-service';

interface ChapterPayload {
  path: string;
  html: string;
  idioma?: string | null;
}

export interface ChapterViolations {
  path: string;
  title: string;
  plain: string;
  violations: RaeViolation[];
}

export interface AuditScope {
  path: string;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class RaeAuditService {
  private search = inject(SearchService);
  private imageViewer = inject(ImageViewerService);
  private fontPreview = inject(FontPreviewService);
  private markdownReader = inject(MarkdownReaderService);
  private debug = inject(DebugService);

  readonly scope = signal<AuditScope | null>(null);
  readonly chapters = signal<ChapterViolations[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly progress = signal<{ done: number; total: number } | null>(null);

  readonly totalViolations = computed(() =>
    this.chapters().reduce((sum, c) => sum + c.violations.length, 0),
  );
  readonly autoFixableCount = computed(() => {
    let n = 0;
    for (const c of this.chapters()) {
      for (const v of c.violations) if (v.autoFix !== undefined) n += 1;
    }
    return n;
  });

  isOpen(): boolean {
    return this.scope() !== null;
  }

  async open(scope: AuditScope): Promise<void> {
    this.search.open.set(false);
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

      const accumulated: ChapterViolations[] = [];
      let processed = 0;
      for (const payload of payloads) {
        const lang = payload.idioma ?? detectLang(payload.html);
        if (lang !== 'es') {
          processed += 1;
          this.progress.set({ done: processed, total: payloads.length });
          continue;
        }
        const plain = htmlToPlain(payload.html);
        const violations = validateRae(plain, 'es');
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
        'rae-audit',
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
      this.debug.error('rae-audit', 'audit falló', String(err));
    } finally {
      this.loading.set(false);
      this.progress.set(null);
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
