import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { BookConfig, BookConfigService } from '../core/book-config-service';
import { TreeNode } from '../core/types';

@Component({
  selector: 'app-book-card',
  imports: [],
  templateUrl: './book-card.html',
  styleUrl: './book-card.scss',
})
export class BookCard {
  private cfgService = inject(BookConfigService);

  readonly node = input.required<TreeNode>();
  readonly select = output<TreeNode>();

  protected readonly config = signal<BookConfig | null>(null);
  protected readonly loading = signal<boolean>(false);

  protected readonly coverUrl = computed(() => {
    const cfg = this.config();
    const tapa = cfg?.tapa;
    if (!tapa || !tapa.trim()) return null;
    const path = tapa.startsWith('/') ? tapa : `${this.node().path}/${tapa}`;
    try {
      return convertFileSrc(path);
    } catch {
      return null;
    }
  });

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

  private async load(path: string): Promise<void> {
    this.loading.set(true);
    try {
      const cfg = await this.cfgService.load(path);
      this.config.set(cfg);
    } catch {
      this.config.set(null);
    } finally {
      this.loading.set(false);
    }
  }
}
