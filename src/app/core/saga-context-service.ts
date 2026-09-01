import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { existsCaseInsensitive, validateWord } from '../dictionary/word-validator';
import {
  DictLookup,
  IdiomaFlexion,
  makeDictLookup,
  stripInflection,
} from '../dictionary/derived-forms';
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
  readonly dictionaryWords = this.dictWords.asReadonly();
  /** Índice para el pelado de flexión. Se rearma cuando cambia el diccionario. */
  private readonly lookup = computed<DictLookup>(() => makeDictLookup(this.dictWords()));
  /** Idioma de la saga reducido a las dos familias de reglas de flexión.
   *  Tolera variantes tipo `es-AR`. Null si la saga no declara idioma: en ese
   *  caso no se pela nada y el filtro se comporta como antes. */
  readonly idiomaFlexion = computed<IdiomaFlexion | null>(() => {
    const raw = this.config()?.idioma?.trim().toLowerCase();
    if (!raw) return null;
    if (raw.startsWith('es')) return 'es';
    if (raw.startsWith('en')) return 'en';
    return null;
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
    if (this.dictionary().has(word.toLowerCase())) return true;
    const idioma = this.idiomaFlexion();
    if (!idioma) return false;
    return stripInflection(word, idioma, this.lookup()) !== null;
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

  /** Agrega varias palabras en una sola escritura. Descarta en silencio las
   *  inválidas y las que ya están — el panel de formas derivadas ya las muestra
   *  como "ya está", así que no hay nada que reportar. */
  async addManyToDictionary(
    words: readonly string[],
  ): Promise<{ ok: boolean; added: number; reason?: string }> {
    const path = this.sagaPath();
    if (!path) return { ok: false, added: 0, reason: 'No hay saga activa' };
    const next = [...this.dictWords()];
    let added = 0;
    for (const raw of words) {
      const result = validateWord(raw);
      if (!result.ok) continue;
      if (existsCaseInsensitive(next, result.value)) continue;
      next.push(result.value);
      added += 1;
    }
    if (added === 0) return { ok: true, added: 0 };
    try {
      await invoke('set_saga_dictionary', { sagaPath: path, words: next });
      this.dictWords.set(next);
      return { ok: true, added };
    } catch (err) {
      return { ok: false, added: 0, reason: String(err) };
    }
  }

  /** Reemplaza solo la lista de palabras del diccionario in-memory. Usado por
   *  DictionaryService después de persistir cambios desde el modal dedicado,
   *  para que el live-filter del editor reaccione sin recargar el capítulo. */
  updateDictionary(words: string[]): void {
    this.dictWords.set(words);
  }
}
