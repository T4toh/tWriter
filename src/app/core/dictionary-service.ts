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
import { SagaContextService } from './saga-context-service';
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

  readonly count = computed(() => this.words().length);
  readonly problematic = computed<ProblematicEntry[]>(() => detectProblematic(this.words()));

  async openFor(node: TreeNode): Promise<void> {
    if (node.kind !== 'saga') return;
    this.editing.set({ path: node.path, nombre: node.name });
    this.loading.set(true);
    this.error.set(null);
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
