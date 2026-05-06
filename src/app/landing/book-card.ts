import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { BookConfig, BookConfigService } from '../core/book-config-service';
import { ChapterService } from '../core/chapter-service';
import { TreeNode } from '../core/types';

interface ImageData {
  mime: string;
  base64: string;
}

@Component({
  selector: 'app-book-card',
  imports: [],
  templateUrl: './book-card.html',
  styleUrl: './book-card.scss',
})
export class BookCard {
  private cfgService = inject(BookConfigService);
  private chapter = inject(ChapterService);

  readonly node = input.required<TreeNode>();
  readonly select = output<TreeNode>();
  protected readonly exporting = signal<boolean>(false);

  protected readonly config = signal<BookConfig | null>(null);
  protected readonly coverDataUrl = signal<string | null>(null);
  protected readonly loading = signal<boolean>(false);

  protected readonly displayTitle = computed(() => {
    const cfg = this.config();
    if (cfg?.titulo) return cfg.titulo;
    return this.node().name.replace(/^\d+\s*-\s*/, '');
  });

  protected readonly subtitle = computed(() => {
    const cfg = this.config();
    if (cfg?.subtitulo) return cfg.subtitulo;
    if (cfg?.serie && cfg.numero_en_serie) return `${cfg.serie} #${cfg.numero_en_serie}`;
    return null;
  });

  protected readonly author = computed(() => this.config()?.autor ?? null);

  protected readonly isConfigured = computed(() => {
    const cfg = this.config();
    return !!(cfg && cfg.titulo && cfg.autor);
  });

  constructor() {
    effect(() => {
      const n = this.node();
      // Re-load cuando cambia el nodo o cuando se guardó el modal
      this.cfgService.savedAt();
      void this.load(n.path);
    });
  }

  protected formatWords(n: number | undefined): string {
    if (!n) return '';
    if (n < 1000) return `${n} palabras`;
    return `${Math.round(n / 100) / 10}k palabras`;
  }

  protected formatDate(ms: number | undefined): string {
    if (!ms) return 'sin editar';
    const now = Date.now();
    const diff = now - ms;
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < hour) {
      const m = Math.max(1, Math.floor(diff / min));
      return `hace ${m} min`;
    }
    if (diff < day) {
      const h = Math.floor(diff / hour);
      return `hace ${h} h`;
    }
    if (diff < 7 * day) {
      const d = Math.floor(diff / day);
      return `hace ${d} d`;
    }
    return new Date(ms).toLocaleDateString('es-AR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  protected onClick(): void {
    this.select.emit(this.node());
  }

  protected openConfig(event: MouseEvent): void {
    event.stopPropagation();
    this.cfgService.openFor(this.node());
  }

  protected async exportEpub(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.exporting()) return;
    this.exporting.set(true);
    try {
      await this.chapter.exportEpub(this.node());
    } finally {
      this.exporting.set(false);
    }
  }

  private async load(path: string): Promise<void> {
    this.loading.set(true);
    try {
      const cfg = await this.cfgService.load(path);
      this.config.set(cfg);
      await this.loadCover(path, cfg.tapa ?? null);
    } catch {
      this.config.set(null);
      this.coverDataUrl.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadCover(bookPath: string, tapa: string | null): Promise<void> {
    if (!tapa || !tapa.trim()) {
      this.coverDataUrl.set(null);
      return;
    }
    const fullPath = tapa.startsWith('/') ? tapa : `${bookPath}/${tapa}`;
    try {
      const img = await invoke<ImageData>('read_image', { path: fullPath });
      this.coverDataUrl.set(`data:${img.mime};base64,${img.base64}`);
    } catch {
      this.coverDataUrl.set(null);
    }
  }
}
