import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { existsCaseInsensitive, validateWord } from '../dictionary/word-validator';
import { ChapterService } from './chapter-service';

export interface SagaConfig {
  nombre: string;
  autor?: string | null;
  idioma?: string | null;
  variante_es?: string | null;
  variante_en?: string | null;
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
  readonly varianteEs = computed<string | null>(() => {
    const v = this.config()?.variante_es;
    return v && v.trim() ? v : null;
  });
  readonly varianteEn = computed<string | null>(() => {
    const v = this.config()?.variante_en;
    return v && v.trim() ? v : null;
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

  async setVariante(base: 'es' | 'en', code: string | null): Promise<void> {
    const path = this.sagaPath();
    const cfg = this.config();
    if (!path || !cfg) return;
    const key = base === 'es' ? 'variante_es' : 'variante_en';
    const current = cfg[key] ?? null;
    if (current === code) return;
    const next: SagaConfig = { ...cfg, [key]: code };
    await invoke('set_saga_config', { sagaPath: path, config: next });
    this.config.set(next);
  }

  async addToDictionary(word: string): Promise<{ ok: boolean; reason?: string }> {
    const path = this.sagaPath();
    const cfg = this.config();
    if (!path || !cfg) return { ok: false, reason: 'No hay saga activa' };
    const result = validateWord(word);
    if (!result.ok) return { ok: false, reason: result.reason };
    const existing = cfg.diccionario ?? [];
    if (existsCaseInsensitive(existing, result.value)) {
      return { ok: false, reason: 'Ya existe en el diccionario' };
    }
    const next: SagaConfig = { ...cfg, diccionario: [...existing, result.value] };
    try {
      await invoke('set_saga_config', { sagaPath: path, config: next });
      this.config.set(next);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  /** Reemplaza solo la lista de palabras del diccionario in-memory. Usado por
   *  DictionaryService después de persistir cambios desde el modal dedicado,
   *  para que el live-filter del editor reaccione sin recargar el capítulo. */
  updateDictionary(words: string[]): void {
    const cur = this.config();
    if (!cur) return;
    this.config.set({ ...cur, diccionario: words.length > 0 ? words : null });
  }
}
