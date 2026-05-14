import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DebugService } from './debug-service';
import { tokenize } from './search-highlight';
import { SettingsService } from './settings-service';

export interface SearchHit {
  path: string;
  kind: string;
  title: string;
  snippet: string;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
}

interface ReindexProgress {
  done: number;
  total: number;
  current: string;
}

/** Pedido pendiente de "saltar al primer match" para un path. El editor / reader
 *  que corresponde al path lo consume con `consumePendingHighlight()` cuando
 *  termina de renderizar el contenido. `requestId` evita doble-consumo. */
export interface PendingHighlight {
  path: string;
  terms: string[];
  /** Query raw sin tokenizar (preserva mayúsculas, `¡!`, `?`). El highlighter
   *  busca este literal primero — `¡Duendes!` cae en el grito, no en el
   *  primer `duendes` lowercase del párrafo. Vacío si la query es trivial. */
  rawQuery: string;
  requestId: number;
}

const DEBOUNCE_MS = 200;

@Injectable({ providedIn: 'root' })
export class SearchService {
  private settings = inject(SettingsService);
  private debug = inject(DebugService);

  readonly open = signal<boolean>(false);
  readonly query = signal<string>('');
  readonly results = signal<SearchHit[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly reindexing = signal<boolean>(false);
  readonly reindexProgress = signal<ReindexProgress | null>(null);
  readonly hasResults = computed(() => this.results().length > 0);
  readonly pendingHighlight = signal<PendingHighlight | null>(null);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentRequestId = 0;
  private highlightCounter = 0;

  constructor() {
    void this.bindProgressListener();
  }

  toggle(): void {
    this.open.update((o) => !o);
  }

  show(): void {
    this.open.set(true);
  }

  hide(): void {
    this.open.set(false);
  }

  setQuery(q: string): void {
    if (this.query() === q) return;
    this.query.set(q);
    this.scheduleSearch();
  }

  clear(): void {
    this.query.set('');
    this.results.set([]);
    this.error.set(null);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private scheduleSearch(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runSearch();
    }, DEBOUNCE_MS);
  }

  private async runSearch(): Promise<void> {
    const q = this.query().trim();
    if (!q) {
      this.results.set([]);
      this.error.set(null);
      this.loading.set(false);
      return;
    }
    const id = ++this.currentRequestId;
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await invoke<SearchResult>('search_query', { query: q, limit: 50 });
      if (id !== this.currentRequestId) return;
      this.results.set(res.hits);
    } catch (err) {
      if (id !== this.currentRequestId) return;
      this.error.set(String(err));
      this.results.set([]);
      this.debug.error('search', String(err));
    } finally {
      if (id === this.currentRequestId) this.loading.set(false);
    }
  }

  /** Encola un highlight pendiente para `path`. Tokeniza la query actual.
   *  El editor / reader correspondiente al path llama `consumePendingHighlight()`
   *  cuando termina de renderizar y aplica el scroll + selección. */
  requestHighlight(path: string, queryOverride?: string): void {
    const q = (queryOverride ?? this.query()).trim();
    if (!q) return;
    const terms = tokenize(q);
    if (terms.length === 0) return;
    this.pendingHighlight.set({
      path,
      terms,
      rawQuery: q,
      requestId: ++this.highlightCounter,
    });
  }

  /** Si hay un pending highlight para `path`, lo devuelve y lo limpia.
   *  Caller aplica el highlight DOM-level. Idempotente: una sola toma. */
  consumePendingHighlight(path: string): PendingHighlight | null {
    const pending = this.pendingHighlight();
    if (!pending || pending.path !== path) return null;
    this.pendingHighlight.set(null);
    return pending;
  }

  async reindex(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    this.reindexing.set(true);
    this.reindexProgress.set(null);
    try {
      const total = await invoke<number>('search_reindex', { root });
      this.debug.info('search', `reindex completo: ${total} docs`);
      // Re-correr query actual si hay una.
      if (this.query().trim()) await this.runSearch();
    } catch (err) {
      this.debug.error('search', `reindex falló: ${err}`);
    } finally {
      this.reindexing.set(false);
      this.reindexProgress.set(null);
    }
  }

  private async bindProgressListener(): Promise<void> {
    try {
      // El listener vive toda la sesión; SearchService es providedIn 'root'.
      await listen<ReindexProgress>('search-reindex-progress', (event) => {
        this.reindexProgress.set(event.payload);
      });
    } catch {
      // SSR / no-Tauri: sin listener.
    }
  }
}
