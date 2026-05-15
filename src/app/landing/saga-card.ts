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
import { BookConfigService } from '../core/book-config-service';
import { TreeNode } from '../core/types';

interface ImageData {
  mime: string;
  base64: string;
}

interface BookThumb {
  node: TreeNode;
  title: string;
  cover: string | null;
}

const MAX_THUMBS = 6;

@Component({
  selector: 'app-saga-card',
  imports: [],
  templateUrl: './saga-card.html',
  styleUrl: './saga-card.scss',
})
export class SagaCard {
  private cfgService = inject(BookConfigService);

  readonly node = input.required<TreeNode>();
  readonly select = output<TreeNode>();

  protected readonly thumbs = signal<BookThumb[]>([]);

  protected readonly displayName = computed(() =>
    this.node().name.replace(/^\d+\s*-\s*/, ''),
  );

  protected readonly bookCount = computed(
    () => this.node().children.filter((c) => c.kind === 'book').length,
  );
  protected readonly extra = computed(() =>
    Math.max(0, this.bookCount() - MAX_THUMBS),
  );

  constructor() {
    effect(() => {
      const n = this.node();
      this.cfgService.savedAt();
      void this.loadThumbs(n);
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
    if (diff < hour) return `hace ${Math.max(1, Math.floor(diff / min))} min`;
    if (diff < day) return `hace ${Math.floor(diff / hour)} h`;
    if (diff < 7 * day) return `hace ${Math.floor(diff / day)} d`;
    return new Date(ms).toLocaleDateString('es-AR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  protected onClick(): void {
    this.select.emit(this.node());
  }

  private async loadThumbs(saga: TreeNode): Promise<void> {
    const books = saga.children.filter((c) => c.kind === 'book').slice(0, MAX_THUMBS);
    const out: BookThumb[] = [];
    for (const book of books) {
      const title = book.name.replace(/^\d+\s*-\s*/, '');
      let cover: string | null = null;
      try {
        const cfg = await this.cfgService.load(book.path);
        if (cfg.tapa && cfg.tapa.trim()) {
          const fullPath = cfg.tapa.startsWith('/')
            ? cfg.tapa
            : `${book.path}/${cfg.tapa}`;
          try {
            const img = await invoke<ImageData>('read_image', { path: fullPath });
            cover = `data:${img.mime};base64,${img.base64}`;
          } catch {
            cover = null;
          }
        }
      } catch {
        // sin config — solo placeholder
      }
      out.push({ node: book, title, cover });
    }
    this.thumbs.set(out);
  }
}
