import { FechaCortaPipe } from '../shared/fecha-corta-pipe';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { LucideArrowDownToLine, LucideListChecks, LucideSettings } from '@lucide/angular';
import { BookConfig, BookConfigService } from '../core/book-config-service';
import { ChapterService } from '../core/chapter-service';
import { CoverCache } from '../core/cover-cache';
import { sinPrefijoNumerico } from '../core/nombre-carpeta';
import { RevisionLibroService } from '../core/revision-libro-service';
import { TreeNode } from '../core/types';
import { Spinner } from '../shared/spinner';

@Component({
  selector: 'app-book-card',
  imports: [FechaCortaPipe, Spinner, LucideArrowDownToLine, LucideListChecks, LucideSettings],
  templateUrl: './book-card.html',
  styleUrl: './book-card.scss',
})
export class BookCard {
  private cfgService = inject(BookConfigService);
  private chapter = inject(ChapterService);
  private coverCache = inject(CoverCache);
  private revision = inject(RevisionLibroService);

  readonly node = input.required<TreeNode>();
  /** `vertical` (default) es la tarjeta de la grilla: portada arriba a todo el
   *  ancho y texto abajo, que es donde el texto tiene lugar. `horizontal` es la
   *  del header del libro, que es una sola y llega a 720px — ahí una portada a
   *  todo el ancho sería absurda. */
  readonly layout = input<'vertical' | 'horizontal'>('vertical');
  readonly select = output<TreeNode>();
  protected readonly exporting = signal<boolean>(false);

  protected readonly config = signal<BookConfig | null>(null);
  protected readonly coverDataUrl = signal<string | null>(null);
  protected readonly loading = signal<boolean>(false);

  protected readonly displayTitle = computed(() => {
    const cfg = this.config();
    if (cfg?.titulo) return cfg.titulo;
    return sinPrefijoNumerico(this.node().name);
  });

  protected readonly subtitle = computed(() => {
    const cfg = this.config();
    if (cfg?.subtitulo) return cfg.subtitulo;
    if (cfg?.serie && cfg.numero_en_serie) return `${cfg.serie} #${cfg.numero_en_serie}`;
    return null;
  });

  protected readonly author = computed(() => this.config()?.autor ?? null);

  // Cuenta capítulos de verdad: un libro partido trae carpetas `section` y los
  // capítulos están un nivel abajo. Contar hijos directos daba el número de
  // partes ("3 cap." por 3 partes de 8). Filtrar por `chapter` también deja
  // afuera las notas sin nombrarlas, y las secciones excluidas del EPUB suman 0
  // porque Rust las manda con `children: []`.
  protected readonly chapterCount = computed(() =>
    this.node().children.reduce(
      (total, hijo) =>
        total +
        (hijo.kind === 'section'
          ? hijo.children.filter((nieto) => nieto.kind === 'chapter').length
          : Number(hijo.kind === 'chapter')),
      0,
    ),
  );

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


  protected onClick(): void {
    this.select.emit(this.node());
  }

  protected openConfig(event: MouseEvent): void {
    event.stopPropagation();
    this.cfgService.openFor(this.node());
  }

  protected abrirRevision(event: MouseEvent): void {
    event.stopPropagation();
    this.revision.abrirPara(this.node());
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
      const url = await this.coverCache.urlFor(fullPath, this.cfgService.savedAt());
      this.coverDataUrl.set(url);
    } catch {
      this.coverDataUrl.set(null);
    }
  }
}
