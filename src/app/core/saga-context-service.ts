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
  /** Palabras del diccionario de la saga activa. Fuente: `diccionario.txt`
   *  (comando `get_saga_dictionary`), ya no el campo legacy de saga.json. */
  private readonly dictWords = signal<string[]>([]);
  readonly dictionary = computed<Set<string>>(
    () => new Set(this.dictWords().map((w) => w.toLowerCase())),
  );
  /** Palabras del diccionario tal cual están escritas en `diccionario.txt`.
   *  `dictionary` (Set en minúscula) sirve para filtrar; para SUGERIR hace
   *  falta la forma original, que es la que se le ofrece al autor. */
  readonly dictionaryWords = computed<string[]>(() => this.dictWords());
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
        this.dictWords.set([]);
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
        if (dir) {
          await this.reload(dir);
        } else {
          this.config.set(null);
          this.dictWords.set([]);
        }
      }
    } catch {
      this.sagaPath.set(null);
      this.config.set(null);
      this.dictWords.set([]);
    }
  }

  private async reload(sagaDir: string): Promise<void> {
    try {
      const cfg = await invoke<SagaConfig>('get_saga_config', { sagaPath: sagaDir });
      this.config.set(cfg);
    } catch {
      this.config.set(null);
    }
    await this.loadDictionary(sagaDir);
  }

  private async loadDictionary(sagaDir: string): Promise<void> {
    try {
      const words = await invoke<string[]>('get_saga_dictionary', { sagaPath: sagaDir });
      this.dictWords.set(words);
    } catch {
      this.dictWords.set([]);
    }
  }

  /** Recarga el diccionario de la saga activa desde disco. Lo usa GitService
   *  tras un pull que tocó algún `diccionario.txt`, para que el live-filter del
   *  editor refleje las palabras sincronizadas sin reabrir la saga. */
  async reloadDictionary(): Promise<void> {
    const path = this.sagaPath();
    if (path) await this.loadDictionary(path);
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
    if (!path) return { ok: false, reason: 'No hay saga activa' };
    const result = validateWord(word);
    if (!result.ok) return { ok: false, reason: result.reason };
    const existing = this.dictWords();
    if (existsCaseInsensitive(existing, result.value)) {
      return { ok: false, reason: 'Ya existe en el diccionario' };
    }
    const next = [...existing, result.value];
    try {
      await invoke('set_saga_dictionary', { sagaPath: path, words: next });
      this.dictWords.set(next);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  /** Reemplaza solo la lista de palabras del diccionario in-memory. Usado por
   *  DictionaryService después de persistir cambios desde el modal dedicado,
   *  para que el live-filter del editor reaccione sin recargar el capítulo. */
  updateDictionary(words: string[]): void {
    this.dictWords.set(words);
  }
}
