import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { LucideBookOpen, LucideSettings } from '@lucide/angular';
import { BookConfigService } from '../core/book-config-service';
import { CoverCache } from '../core/cover-cache';
import { DictionaryService } from '../core/dictionary-service';
import { sinPrefijoNumerico } from '../core/nombre-carpeta';
import { SagaConfig, SagaConfigService } from '../core/saga-config-service';
import { TreeNode } from '../core/types';

/** Tapas visibles en el mazo, contando la del frente. */
const MAX_DECK = 3;

@Component({
  selector: 'app-saga-header',
  imports: [LucideBookOpen, LucideSettings],
  templateUrl: './saga-header.html',
  styleUrl: './saga-header.scss',
})
export class SagaHeader {
  private cfgService = inject(SagaConfigService);
  private bookCfgService = inject(BookConfigService);
  private dictSvc = inject(DictionaryService);
  private coverCache = inject(CoverCache);

  readonly node = input.required<TreeNode>();

  protected readonly config = signal<SagaConfig | null>(null);
  /** Mazo de tapas: `[0]` es la del frente, el resto asoma detrás. */
  protected readonly covers = signal<string[]>([]);
  protected readonly coverFromBook = signal<boolean>(false);

  protected readonly displayName = computed(() => {
    const cfg = this.config();
    if (cfg?.nombre) return cfg.nombre;
    return sinPrefijoNumerico(this.node().name);
  });

  protected readonly author = computed(() => this.config()?.autor ?? null);
  protected readonly idioma = computed(() => this.config()?.idioma ?? null);
  // Solo libros: los hijos incluyen la carpeta notas/ y los .md sueltos.
  protected readonly bookCount = computed(
    () => this.node().children.filter((c) => c.kind === 'book').length,
  );
  protected readonly dictCount = signal<number>(0);
  protected readonly hasDictionary = computed(() => this.dictCount() > 0);
  protected readonly dictSize = computed(() => this.dictCount());

  constructor() {
    effect(() => {
      const n = this.node();
      // Re-load on save (saga, any book, o el diccionario dedicado)
      this.cfgService.savedAt();
      this.bookCfgService.savedAt();
      this.dictSvc.savedAt();
      void this.load(n);
    });
  }

  protected formatLang(lang: string | null): string {
    if (!lang) return '';
    const map: Record<string, string> = { es: 'español', en: 'inglés' };
    return map[lang] ?? lang;
  }

  protected openConfig(event: MouseEvent): void {
    event.stopPropagation();
    this.cfgService.openFor(this.node());
  }

  protected openDictionary(event: MouseEvent): void {
    event.stopPropagation();
    void this.dictSvc.openFor(this.node());
  }

  private async load(node: TreeNode): Promise<void> {
    try {
      const cfg = await this.cfgService.load(node.path);
      this.config.set(cfg);
      try {
        const words = await invoke<string[]>('get_saga_dictionary', { sagaPath: node.path });
        this.dictCount.set(words.length);
      } catch {
        this.dictCount.set(0);
      }
      await this.loadCovers(node, cfg.tapa ?? null);
    } catch {
      this.config.set(null);
      this.dictCount.set(0);
      this.covers.set([]);
      this.coverFromBook.set(false);
    }
  }

  private async loadCovers(saga: TreeNode, tapa: string | null): Promise<void> {
    const sagaVer = this.cfgService.savedAt();
    const bookVer = this.bookCfgService.savedAt();
    const deck: string[] = [];
    if (tapa && tapa.trim()) {
      const fullPath = tapa.startsWith('/') ? tapa : `${saga.path}/${tapa}`;
      try {
        deck.push(await this.coverCache.urlFor(fullPath, sagaVer));
      } catch {
        // sin tapa propia usable — el frente lo pone el primer libro
      }
    }
    // La saga sin tapa propia hereda la del primer libro; el resto de los
    // libros con tapa completa el mazo para que se vea que hay más de uno.
    const heredada = deck.length === 0;
    for (const child of saga.children) {
      if (deck.length >= MAX_DECK) break;
      if (child.kind !== 'book') continue;
      try {
        const btapa = (await this.bookCfgService.load(child.path)).tapa;
        if (!btapa || !btapa.trim()) continue;
        const fullPath = btapa.startsWith('/') ? btapa : `${child.path}/${btapa}`;
        deck.push(await this.coverCache.urlFor(fullPath, bookVer));
      } catch {
        // probar siguiente
      }
    }
    this.covers.set(deck);
    this.coverFromBook.set(heredada && deck.length > 0);
  }
}
