import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { convert } from '../dialogos/converter';
import { ProjectService } from './project-service';
import { ToastService } from './toast-service';

export interface HtmlBlock {
  id: number;
  html: string;
  is_candidate: boolean;
  candidate_reason: string | null;
}

export interface SplitPreview {
  blocks: HtmlBlock[];
  default_folder_name: string;
  idioma: string | null;
  source_path: string;
}

export interface SplitPlan {
  source_path: string;
  folder_name: string;
  split_indices: number[];
  idioma: string | null;
}

export interface SplitResult {
  folder_created: string;
  parts_written: number;
  original_archived_to: string;
}

export interface SplitEditingState {
  preview: SplitPreview;
  queueIndex: number;
  queueTotal: number;
  /** Booleans paralelos a `preview.blocks`: si `boundaries[i]` es true, la parte n+1 arranca en el bloque `i`. `boundaries[0]` siempre false (no se puede arrancar parte 2 en índice 0). */
  boundaries: boolean[];
  folderName: string;
}

@Injectable({ providedIn: 'root' })
export class SplitChapterService {
  private project = inject(ProjectService);
  private toast = inject(ToastService);

  /** Estado actual del modal. null = cerrado. */
  readonly editing = signal<SplitEditingState | null>(null);
  readonly loading = signal(false);
  readonly applying = signal(false);
  /** Resultado del último split aplicado (folder + partes). Habilita el botón "Aplicar RAE a partes" post-apply. Se limpia al cerrar o avanzar al próximo capítulo en bulk. */
  readonly lastResult = signal<SplitResult | null>(null);
  /** Cola de paths pendientes (solo modo bulk). El path actual ya fue removido de la cola. */
  private queue = signal<string[]>([]);
  private totalInBatch = signal(0);

  readonly bulkMode = computed(() => this.totalInBatch() > 1);

  async startSingle(path: string): Promise<void> {
    this.queue.set([]);
    this.totalInBatch.set(1);
    await this.loadCurrent(path, 0);
  }

  async startBulk(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    this.totalInBatch.set(paths.length);
    const [first, ...rest] = paths;
    this.queue.set(rest);
    await this.loadCurrent(first, 0);
  }

  private async loadCurrent(path: string, queueIndex: number): Promise<void> {
    this.loading.set(true);
    try {
      const preview = await invoke<SplitPreview>('split_chapter_preview', { path });
      const boundaries = defaultBoundaries(preview.blocks);
      this.editing.set({
        preview,
        queueIndex,
        queueTotal: this.totalInBatch(),
        boundaries,
        folderName: preview.default_folder_name,
      });
    } catch (e) {
      this.toast.error(`No se pudo previsualizar: ${e}`);
      this.close();
    } finally {
      this.loading.set(false);
    }
  }

  toggleBoundary(index: number): void {
    if (index <= 0) return;
    this.editing.update((s) => {
      if (!s) return s;
      const next = s.boundaries.slice();
      next[index] = !next[index];
      return { ...s, boundaries: next };
    });
  }

  setFolderName(name: string): void {
    this.editing.update((s) => (s ? { ...s, folderName: name } : s));
  }

  partCount(): number {
    const s = this.editing();
    if (!s) return 0;
    return 1 + s.boundaries.filter((b) => b).length;
  }

  splitIndices(): number[] {
    const s = this.editing();
    if (!s) return [];
    const out: number[] = [];
    s.boundaries.forEach((b, i) => {
      if (b) out.push(i);
    });
    return out;
  }

  async apply(): Promise<void> {
    const s = this.editing();
    if (!s) return;
    const plan: SplitPlan = {
      source_path: s.preview.source_path,
      folder_name: s.folderName.trim(),
      split_indices: this.splitIndices(),
      idioma: s.preview.idioma,
    };
    this.applying.set(true);
    try {
      const result = await invoke<SplitResult>('split_chapter_apply', { plan });
      this.toast.success(`Capítulo dividido en ${result.parts_written} parte(s).`);
      this.lastResult.set(result);
      await this.project.loadTree();
    } catch (e) {
      this.toast.error(`No se pudo aplicar: ${e}`);
    } finally {
      this.applying.set(false);
    }
  }

  /** Aplica el converter RAE (D1–D5) sobre cada parte del último split. Silencioso: solo toast con conteo final. */
  async applyRaeToParts(): Promise<void> {
    const result = this.lastResult();
    if (!result) return;
    this.applying.set(true);
    try {
      const partPaths = await invoke<string[]>('list_part_paths', {
        folder: result.folder_created,
      });
      let partsChanged = 0;
      for (const p of partPaths) {
        const html = await invoke<string>('read_chapter', { path: p });
        const conv = convert(html);
        if (conv.changes > 0) {
          await invoke('write_chapter', { path: p, html: conv.text });
          partsChanged++;
        }
      }
      if (partsChanged === 0) {
        this.toast.info('RAE: sin cambios.');
      } else {
        this.toast.success(
          `RAE: ${partsChanged} parte${partsChanged === 1 ? '' : 's'} modificada${partsChanged === 1 ? '' : 's'}.`,
        );
      }
      this.lastResult.set(null);
      await this.advanceOrClose();
    } catch (e) {
      this.toast.error(`RAE: ${e}`);
    } finally {
      this.applying.set(false);
    }
  }

  async skip(): Promise<void> {
    this.lastResult.set(null);
    await this.advanceOrClose();
  }

  /** Avanza al próximo capítulo de la cola sin aplicar RAE. */
  async continueWithoutRae(): Promise<void> {
    this.lastResult.set(null);
    await this.advanceOrClose();
  }

  abortRest(): void {
    this.queue.set([]);
    this.totalInBatch.set(0);
    this.close();
  }

  close(): void {
    this.editing.set(null);
    this.lastResult.set(null);
    this.queue.set([]);
    this.totalInBatch.set(0);
  }

  private async advanceOrClose(): Promise<void> {
    const rest = this.queue();
    if (rest.length === 0) {
      this.close();
      return;
    }
    const [next, ...remaining] = rest;
    this.queue.set(remaining);
    const current = this.editing();
    const nextIndex = (current?.queueIndex ?? 0) + 1;
    await this.loadCurrent(next, nextIndex);
  }
}

/**
 * Marca boundaries por defecto sobre los candidatos del backend, pero:
 * - Nunca en índice 0 (no hay parte vacía antes).
 * - Si block 0 parece título (heading, párrafo corto ≤4 palabras), el
 *   primer candidato siguiente NO genera boundary — el "1" / "Parte 1"
 *   inicial es el ARRANQUE de la parte 1, no el final de una parte 0.
 *   Sin esto, `1.html` quedaba con solo el título (vacío en el editor).
 */
function defaultBoundaries(blocks: HtmlBlock[]): boolean[] {
  const block0 = blocks[0];
  const block0LooksLikeTitle =
    !!block0 && (block0.is_candidate || isShortParagraph(block0.html));

  let candidatesAfterStart = 0;
  return blocks.map((b, i) => {
    if (i === 0) return false;
    if (!b.is_candidate) return false;
    candidatesAfterStart++;
    if (block0LooksLikeTitle && candidatesAfterStart === 1) return false;
    return true;
  });
}

function isShortParagraph(html: string): boolean {
  const text = html.replace(/<[^>]*>/g, '').trim();
  if (text.length === 0) return false;
  return text.split(/\s+/).length <= 4;
}
