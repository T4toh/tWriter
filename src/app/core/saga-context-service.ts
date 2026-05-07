import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ChapterService } from './chapter-service';

export interface SagaConfig {
  nombre: string;
  autor?: string | null;
  idioma?: string | null;
  diccionario?: string[] | null;
}

@Injectable({ providedIn: 'root' })
export class SagaContextService {
  private chapter = inject(ChapterService);

  readonly sagaPath = signal<string | null>(null);
  readonly config = signal<SagaConfig | null>(null);
  readonly dictionary = computed<Set<string>>(() => {
    const cfg = this.config();
    const list = cfg?.diccionario ?? [];
    return new Set(list.map((w) => w.toLowerCase()));
  });

  constructor() {
    effect(() => {
      const node = this.chapter.active();
      if (!node) {
        this.sagaPath.set(null);
        this.config.set(null);
        return;
      }
      void this.resolve(node.path);
    });
  }

  private async resolve(chapterPath: string): Promise<void> {
    try {
      const dir = await invoke<string | null>('find_saga_dir', { path: chapterPath });
      if (dir !== this.sagaPath()) {
        this.sagaPath.set(dir);
        if (dir) await this.reload(dir);
        else this.config.set(null);
      }
    } catch {
      this.sagaPath.set(null);
      this.config.set(null);
    }
  }

  private async reload(sagaDir: string): Promise<void> {
    try {
      const cfg = await invoke<SagaConfig>('get_saga_config', { sagaPath: sagaDir });
      this.config.set(cfg);
    } catch {
      this.config.set(null);
    }
  }

  isInDictionary(word: string): boolean {
    return this.dictionary().has(word.toLowerCase());
  }

  async addToDictionary(word: string): Promise<void> {
    const path = this.sagaPath();
    const cfg = this.config();
    if (!path || !cfg) return;
    const trimmed = word.trim();
    if (!trimmed) return;
    const existing = cfg.diccionario ?? [];
    if (existing.some((w) => w.toLowerCase() === trimmed.toLowerCase())) return;
    const next: SagaConfig = { ...cfg, diccionario: [...existing, trimmed] };
    await invoke('set_saga_config', { sagaPath: path, config: next });
    this.config.set(next);
  }
}
