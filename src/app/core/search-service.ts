import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChapterService } from './chapter-service';
import type { PullPathChange } from './types';
import { DebugService } from './debug-service';
import { MarkdownReaderService } from './markdown-reader-service';
import { NoteService } from './note-service';
import { ProjectService } from './project-service';
import { findAllMatchesInPlain, tokenize } from './search-highlight';
import { SearchScope as SearchScopeKey, SettingsService } from './settings-service';

const CURRENT_FILE_MAX_PARAGRAPH_HITS = 200;

export type FocusedSurface = 'chapter' | 'note' | 'mdReader';

interface ActiveFile {
  path: string;
  kind: 'chapter' | 'note';
  /** Texto plano del archivo (HTML stripped o markdown crudo) listo para scan. */
  plain: string;
  /** Plain text dividido en párrafos para snippets de "Archivo actual". */
  paragraphs: { text: string; offset: number }[];
  title: string;
}

export interface SearchHit {
  path: string;
  kind: string;
  title: string;
  snippet: string;
  score: number;
  /** Palabras reales del doc que matchearon (resueltas vía fold+fuzzy en el
   *  backend). Ej: `["Kallai"]` cuando se tipeó `kellai`. Se usan para resaltar
   *  el término existente al abrir el hit, en vez del literal tipeado que puede
   *  no estar en el doc. Ausente en hits client-side ("Archivo actual"). */
  matchedTerms?: string[];
  /** Score BM25 puro antes de boosts client-side. Solo presente cuando el
   *  modo debug está on (settings.searchDebug). */
  bm25_score?: number;
}

/** Qué tan bien matchean los hits devueltos. El panel avisa en los dos niveles
 *  flojos: sin eso, una lista de resultados mediocres se lee igual que una
 *  buena. Ver `MatchLevel` en `search.rs`. */
export type MatchLevel = 'phrase' | 'nearby' | 'allWords' | 'someWords';

/** Lo que se descartó por tener las palabras desperdigadas. Presente sólo con
 *  `matchLevel === 'allWords'`, donde no se devuelve ningún hit. */
export interface Scattered {
  docs: number;
  minSpan: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  matchLevel?: MatchLevel;
  scattered?: Scattered;
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
  /** Si true, el matching del highlight plega acentos (modo fuzzy). En exacto
   *  va false ⇒ accent-sensitive, no resalta variantes con tilde no buscadas. */
  fold: boolean;
  requestId: number;
}

const DEBOUNCE_MS = 200;

@Injectable({ providedIn: 'root' })
export class SearchService {
  private settings = inject(SettingsService);
  private debug = inject(DebugService);
  private project = inject(ProjectService);
  private chapter = inject(ChapterService);
  private note = inject(NoteService);
  private mdReader = inject(MarkdownReaderService);

  readonly open = signal<boolean>(false);
  readonly query = signal<string>('');
  readonly results = signal<SearchHit[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly reindexing = signal<boolean>(false);
  readonly reindexProgress = signal<ReindexProgress | null>(null);
  /** Qué tan bien matchean los resultados actuales (ver `MatchLevel`). */
  readonly matchLevel = signal<MatchLevel>('phrase');
  /** Docs que tenían todas las palabras pero lejos, y por eso no se muestran. */
  readonly scattered = signal<Scattered | null>(null);
  readonly hasResults = computed(() => this.results().length > 0);
  readonly pendingHighlight = signal<PendingHighlight | null>(null);
  /** Última superficie con foco. Define qué archivo es "el actual" para el
   *  scope `current` y para el resalto de todas las ocurrencias cuando hay
   *  más de un doc abierto (capítulo + nota en md-reader, etc.). Cada
   *  superficie llama `setFocused()` en `focusin`. */
  readonly lastFocusedSurface = signal<FocusedSurface | null>(null);
  /** Archivo "actual": resuelto contra `lastFocusedSurface` con fallback en
   *  orden chapter → note → mdReader. Null si no hay nada abierto. El plain
   *  se computa una vez (HTML stripped o markdown crudo) y se reutiliza para
   *  resultados y para resalto. */
  readonly activeFile = computed<ActiveFile | null>(() => {
    const focus = this.lastFocusedSurface();
    const order: FocusedSurface[] = focus
      ? [focus, ...(['chapter', 'note', 'mdReader'] as FocusedSurface[]).filter((s) => s !== focus)]
      : ['chapter', 'note', 'mdReader'];
    for (const s of order) {
      const f = this.resolveSurface(s);
      if (f) return f;
    }
    return null;
  });
  /** True cuando el scope seteado en settings exige contexto (saga/book/current)
   *  pero el contexto no existe. La UI muestra un hint sutil; saga/book caen a
   *  scope='all' (fallback en `resolveScope`). 'current' devuelve resultados
   *  vacíos. */
  readonly scopeNeedsContext = computed(() => {
    const s = this.settings.searchScope();
    if (s === 'current') return this.activeFile() == null;
    if (s !== 'saga' && s !== 'book') return false;
    return this.chapter.panes[0].active() == null;
  });
  /** Términos a resaltar (vivos) en el archivo activo mientras el panel esté
   *  abierto y la query tenga contenido. Independiente del scope: aplica en
   *  cualquier modo. Las superficies del editor leen este signal y aplican
   *  decoraciones PM. */
  readonly highlightTerms = computed<{ terms: string[]; rawQuery: string; fold: boolean } | null>(
    () => {
      if (!this.open()) return null;
      const q = this.query().trim();
      if (!q) return null;
      const fold = this.settings.searchFuzzy();
      const terms = tokenize(q);
      if (terms.length === 0) {
        // Query sin tokens (solo puntuación) — sigue siendo válida si tiene
        // forma rica; el highlighter usa rawQuery como literal.
        return { terms: [], rawQuery: q, fold };
      }
      return { terms, rawQuery: q, fold };
    },
  );

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentRequestId = 0;
  private highlightCounter = 0;

  constructor() {
    void this.bindProgressListener();
    // Re-corre la query cuando cambia el scope, el debug o el archivo activo
    // ("saga actual" depende del cap del pane 0; "current" depende del archivo
    // resuelto por activeFile, que incluye notas y md-reader).
    effect(() => {
      this.settings.searchScope();
      this.settings.searchDebug();
      this.settings.searchFuzzy();
      this.chapter.panes[0].active();
      this.chapter.panes[0].content();
      this.note.panes[0].active();
      this.note.panes[0].content();
      this.mdReader.viewing();
      this.mdReader.content();
      this.lastFocusedSurface();
      if (this.query().trim()) {
        this.scheduleSearch();
      }
    });
  }

  setFocused(surface: FocusedSurface): void {
    if (this.lastFocusedSurface() === surface) return;
    this.lastFocusedSurface.set(surface);
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
    this.matchLevel.set('phrase');
    this.scattered.set(null);
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
      this.matchLevel.set('phrase');
      this.scattered.set(null);
      this.error.set(null);
      this.loading.set(false);
      return;
    }
    const id = ++this.currentRequestId;
    this.loading.set(true);
    this.error.set(null);
    // Scope 'current' es client-side: lee el buffer vivo del editor, no toca
    // tantivy. Esto incluye ediciones sin guardar.
    if (this.settings.searchScope() === 'current') {
      this.matchLevel.set('phrase');
      this.scattered.set(null);
      this.runCurrentFileSearch(q);
      if (id === this.currentRequestId) this.loading.set(false);
      return;
    }
    const scope = this.resolveScope();
    const debug = this.settings.searchDebug();
    try {
      const res = await invoke<SearchResult>('search_query', {
        query: q,
        limit: 50,
        scope,
        debug,
        fuzzy: this.settings.searchFuzzy(),
      });
      if (id !== this.currentRequestId) return;
      this.results.set(res.hits);
      this.matchLevel.set(res.matchLevel ?? 'phrase');
      this.scattered.set(res.scattered ?? null);
    } catch (err) {
      if (id !== this.currentRequestId) return;
      this.error.set(String(err));
      this.results.set([]);
      this.matchLevel.set('phrase');
      this.scattered.set(null);
      this.debug.error('search', String(err));
    } finally {
      if (id === this.currentRequestId) this.loading.set(false);
    }
  }

  /** Búsqueda client-side sobre el archivo activo. Cada párrafo con match es
   *  un hit independiente (mismo path repetido). Snippet centrado en el primer
   *  match con `<mark>` sobre cada ocurrencia del párrafo. */
  private runCurrentFileSearch(q: string): void {
    const file = this.activeFile();
    if (!file) {
      this.results.set([]);
      return;
    }
    const terms = tokenize(q);
    const fold = this.settings.searchFuzzy();
    const hits: SearchHit[] = [];
    let total = 0;
    for (const para of file.paragraphs) {
      if (total >= CURRENT_FILE_MAX_PARAGRAPH_HITS) break;
      const matches = findAllMatchesInPlain(para.text, terms, q, fold);
      if (matches.length === 0) continue;
      hits.push({
        path: file.path,
        kind: file.kind,
        title: file.title,
        snippet: snippetWithMarks(para.text, matches),
        score: -total,
      });
      total++;
    }
    this.results.set(hits);
  }

  /** Resuelve una superficie a un `ActiveFile`. Null si no tiene archivo abierto.
   *  Cap: HTML → plain stripped. Nota / md-reader: markdown crudo. */
  private resolveSurface(surface: FocusedSurface): ActiveFile | null {
    if (surface === 'chapter') {
      const node = this.chapter.panes[0].active();
      if (!node) return null;
      const html = this.chapter.panes[0].content();
      const plain = htmlToPlain(html);
      return {
        path: node.path,
        kind: 'chapter',
        plain,
        paragraphs: splitParagraphs(plain),
        title: this.chapter.panes[0].meta()?.titulo || node.name || node.path.split('/').pop() || node.path,
      };
    }
    if (surface === 'note') {
      const target = this.note.panes[0].active();
      if (!target) return null;
      const md = this.note.panes[0].content();
      return {
        path: target.path,
        kind: 'note',
        plain: md,
        paragraphs: splitParagraphs(md),
        title: target.name || target.path.split('/').pop() || target.path,
      };
    }
    // mdReader
    const viewing = this.mdReader.viewing();
    if (!viewing) return null;
    const md = this.mdReader.content();
    return {
      path: viewing.path,
      kind: 'note',
      plain: md,
      paragraphs: splitParagraphs(md),
      title: viewing.name || viewing.path.split('/').pop() || viewing.path,
    };
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
   *  cuando termina de renderizar y aplica el scroll + selección.
   *
   *  `termsOverride` son las palabras REALES del doc (matchedTerms del hit) — al
   *  abrir un resultado fuzzy, resaltamos `Kallai` (lo que existe) y no `kellai`
   *  (lo tipeado, que no está). En ese caso `rawQuery` va vacío para forzar el
   *  matching por token (sin la prioridad de literal-rico que no aplicaría). */
  requestHighlight(
    path: string,
    queryOverride?: string,
    termsOverride?: string[],
    foldOverride?: boolean,
  ): void {
    const q = (queryOverride ?? this.query()).trim();
    // El fold sale del toggle `≈`, salvo que el caller lo fije: un ancla exacta
    // (la auditoría RAE) no quiere que una variante sin tilde de un párrafo
    // anterior le gane al bloque correcto.
    const fold = foldOverride ?? this.settings.searchFuzzy();
    const override = termsOverride?.filter((t) => t.length > 0) ?? [];
    if (override.length > 0) {
      // Términos reales del doc (matchedTerms) — ya literales, sin fold.
      this.pendingHighlight.set({
        path,
        terms: override,
        rawQuery: '',
        fold: false,
        requestId: ++this.highlightCounter,
      });
      return;
    }
    if (!q) return;
    const terms = tokenize(q);
    if (terms.length === 0) return;
    this.pendingHighlight.set({
      path,
      terms,
      rawQuery: q,
      fold,
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

  /** Aplica cambios incrementales al índice tras un pull. Best-effort por path
   *  (errores se logean, no se propagan) y filtra a `.html` / `.md` — el resto
   *  (meta.json, book.json, fonts, etc.) no está indexado. */
  async applyPathChanges(changes: ReadonlyArray<PullPathChange>): Promise<void> {
    if (!changes.length) return;
    for (const c of changes) {
      const lower = c.path.toLowerCase();
      if (!lower.endsWith('.html') && !lower.endsWith('.md')) continue;
      try {
        await invoke('search_apply_path_change', { path: c.path, kind: c.kind });
      } catch (err) {
        this.debug.warn('search', `apply ${c.kind} en ${c.path} falló: ${err}`);
      }
    }
    // Re-correr query actual si hay una, para que la UI muestre el delta.
    if (this.query().trim()) await this.runSearch();
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

/** HTML del capítulo → texto plano. Preserva separación de párrafos entre
 *  bloques (`<p>`, `<hr/>`, `<blockquote>`, headings) con `\n\n` y collapsa
 *  whitespace. No usa DOMParser — el contenido siempre es el subset XHTML
 *  conocido del editor. Suficiente para scan de matches. */
function htmlToPlain(html: string): string {
  if (!html) return '';
  let s = html;
  s = s.replace(/<(?:\/p|\/h[1-6]|\/blockquote|\/li|br\s*\/?|hr\s*\/?)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]+\n/g, '\n').trim();
  return s;
}

/** Split por párrafos (`\n\n`). Devuelve cada párrafo con su offset original
 *  en el plain. */
function splitParagraphs(plain: string): { text: string; offset: number }[] {
  if (!plain) return [];
  const out: { text: string; offset: number }[] = [];
  const parts = plain.split(/\n\n+/);
  let offset = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      const leading = part.length - part.replace(/^\s+/, '').length;
      out.push({ text: trimmed, offset: offset + leading });
    }
    offset += part.length + 2;
  }
  return out;
}

/** Recorte de párrafo centrado en el primer match. Devuelve TEXTO PLANO con
 *  ellipsis — `search-panel.highlightSnippet` se encarga de envolver matches
 *  con `<mark>` después del escape HTML. Si pre-marcáramos acá, el escape de
 *  `highlightSnippet` convertiría los tags en texto literal. */
function snippetWithMarks(paragraph: string, matches: { start: number; end: number }[]): string {
  if (matches.length === 0) return paragraph.slice(0, 240);
  const first = matches[0];
  const len = paragraph.length;
  const half = Math.floor((240 - (first.end - first.start)) / 2);
  let start = Math.max(0, first.start - half);
  let end = Math.min(len, start + 240);
  if (end - start < 240) start = Math.max(0, end - 240);
  let out = paragraph.slice(start, end);
  if (start > 0) out = '…' + out;
  if (end < len) out = out + '…';
  return out;
}
