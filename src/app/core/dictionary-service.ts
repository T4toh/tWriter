import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import {
  ProblematicEntry,
  cleanList,
  compareWords,
  detectProblematic,
  existsCaseInsensitive,
  validateWord,
} from '../dictionary/word-validator';
import { IdiomaFlexion, idiomaFlexionDe } from '../dictionary/derived-forms';
import { SagaConfig, SagaContextService } from './saga-context-service';
import { TreeNode } from './types';

export interface DictionaryTarget {
  path: string;
  nombre: string;
}

export interface OpResult {
  ok: boolean;
  reason?: string;
}

@Injectable({ providedIn: 'root' })
export class DictionaryService {
  private sagaCtx = inject(SagaContextService);

  readonly editing = signal<DictionaryTarget | null>(null);
  readonly words = signal<string[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  /** Bumpea con cada save para que el badge del saga-header re-loadee el conteo. */
  readonly savedAt = signal<number>(0);

  /** Idioma de la saga que el modal está editando — NO el de la saga del
   *  capítulo abierto. El panel de formas derivadas depende de este: con un
   *  capítulo de Meridian abierto y el diccionario de Milky Way en pantalla, el
   *  otro idioma es el equivocado, y sin capítulo abierto no hay ninguno. */
  private readonly idioma = signal<IdiomaFlexion | null>(null);
  readonly idiomaFlexion = this.idioma.asReadonly();

  readonly count = computed(() => this.words().length);
  readonly problematic = computed<ProblematicEntry[]>(() => detectProblematic(this.words()));

  async openFor(node: TreeNode): Promise<void> {
    if (node.kind !== 'saga') return;
    this.editing.set({ path: node.path, nombre: node.name });
    this.loading.set(true);
    this.error.set(null);
    try {
      const cfg = await invoke<SagaConfig>('get_saga_config', { sagaPath: node.path });
      this.idioma.set(idiomaFlexionDe(cfg.idioma));
    } catch {
      this.idioma.set(null);
    }
    try {
      const existing = await invoke<string[]>('get_saga_dictionary', { sagaPath: node.path });
      this.words.set([...existing].sort(compareWords));
    } catch (err) {
      this.error.set(String(err));
      this.words.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  close(): void {
    this.editing.set(null);
    this.words.set([]);
    this.error.set(null);
    this.idioma.set(null);
  }

  /** Agrega varias palabras en UNA sola escritura, sobre la saga que este
   *  service está editando. Descarta en silencio las inválidas y las que ya
   *  están: el panel de formas derivadas ya las muestra como «ya está». */
  async addManyWords(words: readonly string[]): Promise<OpResult & { added: number }> {
    const next = [...this.words()];
    let added = 0;
    for (const raw of words) {
      const result = validateWord(raw);
      if (!result.ok) continue;
      if (existsCaseInsensitive(next, result.value)) continue;
      next.push(result.value);
      added += 1;
    }
    if (added === 0) return { ok: true, added: 0 };
    const r = await this.persist(next.sort(compareWords));
    return { ...r, added: r.ok ? added : 0 };
  }

  async addWord(raw: string): Promise<OpResult> {
    const result = validateWord(raw);
    if (!result.ok) return { ok: false, reason: result.reason };
    if (existsCaseInsensitive(this.words(), result.value)) {
      return { ok: false, reason: 'Ya existe en el diccionario' };
    }
    const next = [...this.words(), result.value].sort(compareWords);
    return this.persist(next);
  }

  async removeWord(word: string): Promise<OpResult> {
    const next = this.words().filter((w) => w !== word);
    if (next.length === this.words().length) {
      return { ok: false, reason: 'No se encontró la palabra' };
    }
    return this.persist(next);
  }

  async editWord(oldWord: string, newRaw: string): Promise<OpResult> {
    const result = validateWord(newRaw);
    if (!result.ok) return { ok: false, reason: result.reason };
    const others = this.words().filter((w) => w !== oldWord);
    if (existsCaseInsensitive(others, result.value)) {
      return { ok: false, reason: 'Ya existe en el diccionario' };
    }
    const next = [...others, result.value].sort(compareWords);
    return this.persist(next);
  }

  async cleanAll(): Promise<OpResult & { removed: number }> {
    const before = this.words();
    const cleaned = cleanList(before);
    const removed = before.length - cleaned.length;
    const r = await this.persist(cleaned);
    return { ...r, removed };
  }

  private async persist(next: string[]): Promise<OpResult> {
    const editing = this.editing();
    if (!editing) {
      return { ok: false, reason: 'No hay saga abierta' };
    }
    try {
      await invoke('set_saga_dictionary', { sagaPath: editing.path, words: next });
      // El modal pudo cambiar de saga mientras el invoke estaba en vuelo: sin
      // esta guarda, la lista de la saga anterior queda mostrada — y editable —
      // sobre la nueva.
      if (this.editing()?.path !== editing.path) return { ok: true };
      this.words.set(next);
      this.savedAt.set(Date.now());
      // Refrescar la saga activa si coincide para que el live-filter del editor
      // reaccione sin tener que recargar el capítulo.
      if (this.sagaCtx.sagaPath() === editing.path) {
        this.sagaCtx.updateDictionary(next);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }
}
