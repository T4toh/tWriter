import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChapterService } from './chapter-service';
import { DebugService } from './debug-service';
import { ProjectService } from './project-service';
import { tokenize } from './search-highlight';
import { SearchScope as SearchScopeKey, SettingsService } from './settings-service';

export interface SearchHit {
  path: string;
  kind: string;
  title: string;
  snippet: string;
  score: number;
  /** Score BM25 puro antes de boosts client-side. Solo presente cuando el
   *  modo debug está on (settings.searchDebug). */
  bm25_score?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
}

/** Filtro de scope que viaja al backend. Campos vacíos / undefined no filtran. */
export interface SearchScope {
  saga?: string;
  book?: string;
  kind?: 'note' | 'chapter';
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
  private project = inject(ProjectService);
  private chapter = inject(ChapterService);

  readonly open = signal<boolean>(false);
  readonly query = signal<string>('');
  readonly results = signal<SearchHit[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly reindexing = signal<boolean>(false);
  readonly reindexProgress = signal<ReindexProgress | null>(null);
  readonly hasResults = computed(() => this.results().length > 0);
  readonly pendingHighlight = signal<PendingHighlight | null>(null);
  /** True cuando el scope seteado en settings exige contexto (saga/book) pero
   *  no hay capítulo activo. La UI muestra un hint sutil; el search corre
   *  igual cayendo a scope='all' (fallback en `resolveScope`). */
  readonly scopeNeedsContext = computed(() => {
    const s = this.settings.searchScope();
    if (s !== 'saga' && s !== 'book') return false;
    return this.chapter.panes[0].active() == null;
  });

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentRequestId = 0;
  private highlightCounter = 0;

  constructor() {
    void this.bindProgressListener();
    // Re-corre la query cuando cambia el scope, el debug o el capítulo activo
    // (este último porque "saga actual" depende del cap abierto en pane 0).
    effect(() => {
      this.settings.searchScope();
      this.settings.searchDebug();
      this.chapter.panes[0].active();
      // Toca dependencias arriba; abajo se decide si hay algo que re-correr.
      if (this.query().trim()) {
        this.scheduleSearch();
      }
    });
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
    const scope = this.resolveScope();
    const debug = this.settings.searchDebug();
    try {
      const res = await invoke<SearchResult>('search_query', {
        query: q,
        limit: 50,
        scope,
        debug,
      });
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

  /**
   * Mapea `settings.searchScope` al filtro que va al backend.
   * - `all` → undefined (sin filtro).
   * - `notes` / `chapters` → filtro por kind.
   * - `saga` / `book` → walk del tree desde el capítulo activo del pane 0 para
   *   encontrar el ancestro de ese kind. Si no hay cap activo, cae a undefined
   *   y logea al panel 🐛 (la UI también muestra un hint).
   */
  private resolveScope(): SearchScope | undefined {
    const s: SearchScopeKey = this.settings.searchScope();
    if (s === 'all') return undefined;
    if (s === 'notes') return { kind: 'note' };
    if (s === 'chapters') return { kind: 'chapter' };
    const active = this.chapter.panes[0].active();
    if (!active) {
      this.debug.warn('search', `scope=${s} sin capítulo activo, fallback a 'all'`);
      return undefined;
    }
    if (s === 'saga') {
      const saga = this.project.findAncestorByKind(active.path, 'saga');
      if (!saga) {
        this.debug.warn('search', `scope=saga: no encontré ancestor saga para ${active.path}`);
        return undefined;
      }
      return { saga: saga.name };
    }
    // s === 'book'
    const book = this.project.findAncestorByKind(active.path, 'book');
    if (!book) {
      this.debug.warn('search', `scope=book: no encontré ancestor book para ${active.path}`);
      return undefined;
    }
    return { book: book.name };
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
