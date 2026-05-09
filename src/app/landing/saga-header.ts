import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { BookConfigService } from '../core/book-config-service';
import { SagaConfig, SagaConfigService } from '../core/saga-config-service';
import { TreeNode } from '../core/types';

interface ImageData {
  mime: string;
  base64: string;
}

@Component({
  selector: 'app-saga-header',
  imports: [],
  templateUrl: './saga-header.html',
  styleUrl: './saga-header.scss',
})
export class SagaHeader {
  private cfgService = inject(SagaConfigService);
  private bookCfgService = inject(BookConfigService);

  readonly node = input.required<TreeNode>();

  protected readonly config = signal<SagaConfig | null>(null);
  protected readonly coverDataUrl = signal<string | null>(null);
  protected readonly coverFromBook = signal<boolean>(false);

  protected readonly displayName = computed(() => {
    const cfg = this.config();
    if (cfg?.nombre) return cfg.nombre;
    return this.node().name.replace(/^\d+\s*-\s*/, '');
  });

  protected readonly author = computed(() => this.config()?.autor ?? null);
  protected readonly idioma = computed(() => this.config()?.idioma ?? null);
  protected readonly bookCount = computed(() => this.node().children.length);
  protected readonly hasDictionary = computed(
    () => (this.config()?.diccionario?.length ?? 0) > 0,
  );
  protected readonly dictSize = computed(
    () => this.config()?.diccionario?.length ?? 0,
  );

  constructor() {
    effect(() => {
      const n = this.node();
      // Re-load on save (saga or any book)
      this.cfgService.savedAt();
      this.bookCfgService.savedAt();
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

  private async load(node: TreeNode): Promise<void> {
    try {
      const cfg = await this.cfgService.load(node.path);
      this.config.set(cfg);
      await this.loadCover(node, cfg.tapa ?? null);
    } catch {
      this.config.set(null);
      this.coverDataUrl.set(null);
    }
  }

  private async loadCover(saga: TreeNode, tapa: string | null): Promise<void> {
    if (tapa && tapa.trim()) {
      const fullPath = tapa.startsWith('/') ? tapa : `${saga.path}/${tapa}`;
      try {
        const img = await invoke<ImageData>('read_image', { path: fullPath });
        this.coverDataUrl.set(`data:${img.mime};base64,${img.base64}`);
        this.coverFromBook.set(false);
        return;
      } catch {
        // fall through al fallback
      }
    }
    // Fallback: tapa del primer libro con tapa
    for (const child of saga.children) {
      if (child.kind !== 'book') continue;
      try {
        const bcfg = await this.bookCfgService.load(child.path);
        const btapa = bcfg.tapa;
        if (btapa && btapa.trim()) {
          const fullPath = btapa.startsWith('/') ? btapa : `${child.path}/${btapa}`;
          const img = await invoke<ImageData>('read_image', { path: fullPath });
          this.coverDataUrl.set(`data:${img.mime};base64,${img.base64}`);
          this.coverFromBook.set(true);
          return;
        }
      } catch {
        // probar siguiente
      }
    }
    this.coverDataUrl.set(null);
    this.coverFromBook.set(false);
  }
}
