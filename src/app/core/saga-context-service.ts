import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { existsCaseInsensitive, validateWord } from '../dictionary/word-validator';
import { isCompound } from '../dictionary/compound-terms';
import {
  DictLookup,
  IdiomaFlexion,
  idiomaFlexionDe,
  makeDictLookup,
  stripInflection,
} from '../dictionary/derived-forms';
import { ChapterService } from './chapter-service';
import { ReglaDesactivada } from './types';

export interface SagaConfig {
  nombre: string;
  autor?: string | null;
  idioma?: string | null;
  variante_es?: string | null;
  variante_en?: string | null;
  diccionario?: string[] | null;
  reglas_lt_desactivadas?: ReglaDesactivada[] | null;
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
  /** Las entradas de más de una palabra (`Kun Lian`, `Tres Torres`). No sirven
   *  a los consumidores token-level —ni `dictionary` ni `lookup` las van a
   *  matchear nunca— así que van por su propio camino: se buscan como frase
   *  sobre el texto plano y devuelven rangos. Ver `dictionary/compound-terms.ts`. */
  readonly compoundTerms = computed<string[]>(() => this.dictWords().filter(isCompound));
  /** Índice para el pelado de flexión. Se rearma cuando cambia el diccionario. */
  private readonly lookup = computed<DictLookup>(() => makeDictLookup(this.dictWords()));
  /** Idioma de la saga reducido a las dos familias de reglas de flexión.
   *  Tolera variantes tipo `es-AR`. Null si la saga no declara idioma: en ese
   *  caso no se pela nada y el filtro se comporta como antes. */
  readonly idiomaFlexion = computed<IdiomaFlexion | null>(() =>
    idiomaFlexionDe(this.config()?.idioma),
  );
  readonly varianteEs = computed<string | null>(() => {
    const v = this.config()?.variante_es;
    return v && v.trim() ? v : null;
  });
  readonly varianteEn = computed<string | null>(() => {
    const v = this.config()?.variante_en;
    return v && v.trim() ? v : null;
  });
  /** Reglas de LT desactivadas en la saga activa. `GrammarService` manda los
   *  ids como `disabledRules`; el modal de config de saga muestra la lista
   *  entera para poder revivir una. */
  readonly reglasLtDesactivadas = computed<ReglaDesactivada[]>(
    () => this.config()?.reglas_lt_desactivadas ?? [],
  );

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

  /** Mata una regla de LT para esta saga. Guarda la oración que la disparó
   *  como registro del falso positivo. Idempotente: si el id ya estaba, no
   *  reescribe (el ejemplo viejo es el primero que se vio, y sirve igual). */
  async setReglaLtDesactivada(
    regla: string,
    ejemplo: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const path = this.sagaPath();
    const cfg = this.config();
    if (!path || !cfg) return { ok: false, reason: 'No hay novela activa' };
    const actuales = cfg.reglas_lt_desactivadas ?? [];
    if (actuales.some((r) => r.regla === regla)) return { ok: true };
    const next: SagaConfig = {
      ...cfg,
      reglas_lt_desactivadas: [...actuales, { regla, ejemplo }],
    };
    return this.persistConfig(path, next);
  }

  /** Revive una regla desactivada (desde el modal de config de saga). */
  async quitarReglaLtDesactivada(regla: string): Promise<{ ok: boolean; reason?: string }> {
    const path = this.sagaPath();
    const cfg = this.config();
    if (!path || !cfg) return { ok: false, reason: 'No hay novela activa' };
    const next: SagaConfig = {
      ...cfg,
      reglas_lt_desactivadas: (cfg.reglas_lt_desactivadas ?? []).filter(
        (r) => r.regla !== regla,
      ),
    };
    return this.persistConfig(path, next);
  }

  /** Misma guarda que `addToDictionary`: si el autor cambió de saga mientras
   *  el invoke estaba en vuelo, `next` es de la saga anterior y no se instala. */
  private async persistConfig(
    path: string,
    next: SagaConfig,
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      await invoke('set_saga_config', { sagaPath: path, config: next });
      if (this.sagaPath() === path) this.config.set(next);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
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
      // Solo instalar la lista si seguimos en la misma saga: si el autor cambió
      // de saga mientras el invoke estaba en vuelo, `next` es de la saga
      // anterior y una escritura posterior la persistiría sobre la nueva.
      if (this.sagaPath() === path) this.dictWords.set(next);
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
      // Misma guarda que `addToDictionary`: la lista es de `path`, no de la
      // saga que esté activa cuando el invoke termine.
      if (this.sagaPath() === path) this.dictWords.set(next);
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
