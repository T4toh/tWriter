import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  effect,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  LucideBookMarked,
  LucideBug,
  LucideDynamicIcon,
  LucideFile,
  LucideFilePen,
  LucideFolder,
  LucideLibrary,
  LucideList,
  LucideNotebook,
  LucideRefreshCw,
  LucideSearch,
  LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { ChapterService } from '../core/chapter-service';
import { MarkdownReaderService } from '../core/markdown-reader-service';
import { NavigationService } from '../core/navigation-service';
import { NoteService } from '../core/note-service';
import { ProjectService } from '../core/project-service';
import { findAllMatchesInPlain, tokenize } from '../core/search-highlight';
import { SearchHit, SearchService } from '../core/search-service';
import { SearchScope, SettingsService } from '../core/settings-service';
import { Select, SelectOption } from '../shared/select';
import { TreeNode } from '../core/types';
import { atajo } from '../shared/atajo';

@Component({
  selector: 'app-search-panel',
  imports: [
    FormsModule, Select,
    LucideBug, LucideDynamicIcon, LucideRefreshCw, LucideSearch, LucideX,
  ],
  templateUrl: './search-panel.html',
  styleUrl: './search-panel.scss',
})
export class SearchPanel implements AfterViewInit {
  /** Etiquetas de atajos por plataforma (⌘ en Mac). Ver `shared/atajo.ts`. */
  protected readonly atajo = atajo;
  private svc = inject(SearchService);
  private chapter = inject(ChapterService);
  private mdReader = inject(MarkdownReaderService);
  private note = inject(NoteService);
  private nav = inject(NavigationService);
  private project = inject(ProjectService);
  private settings = inject(SettingsService);

  @ViewChild('input', { static: true })
  inputRef!: ElementRef<HTMLInputElement>;

  protected readonly query = this.svc.query;
  protected readonly results = this.svc.results;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;
  protected readonly reindexing = this.svc.reindexing;
  protected readonly reindexProgress = this.svc.reindexProgress;
  protected readonly count = computed(() => this.results().length);
  /** Agrupa hits por `path` preservando el orden de primera aparición. Por
   *  archivo: 1 grupo con `hits[]`, `kind`, `title`, y `defaultOpen` (true si
   *  el grupo tiene ≤10 hits — para 'Archivo actual' con 30+ matches por
   *  capítulo, default colapsado evita pared de texto). */
  protected readonly groups = computed<Array<{
    path: string;
    kind: string;
    title: string;
    hits: SearchHit[];
    defaultOpen: boolean;
  }>>(() => {
    const byPath = new Map<string, { path: string; kind: string; title: string; hits: SearchHit[] }>();
    for (const hit of this.results()) {
      const existing = byPath.get(hit.path);
      if (existing) {
        existing.hits.push(hit);
      } else {
        byPath.set(hit.path, {
          path: hit.path,
          kind: hit.kind,
          title: this.displayTitleFor(hit),
          hits: [hit],
        });
      }
    }
    const out: Array<{ path: string; kind: string; title: string; hits: SearchHit[]; defaultOpen: boolean }> = [];
    for (const g of byPath.values()) {
      out.push({ ...g, defaultOpen: g.hits.length <= 10 });
    }
    return out;
  });

  /** Construye un título legible para el header del grupo. Capítulos con
   *  meta.titulo vacío vienen con `hit.title = '5'` (file stem), lo cual
   *  parece "Capítulo 5" pero pegado al badge `1` (count) se lee como
   *  "Capítulo 1". Solución: cuando el título es solo el stem numérico,
   *  prepender el dir contenedor (sección o libro). */
  private displayTitleFor(hit: SearchHit): string {
    const raw = (hit.title || '').trim();
    if (hit.kind !== 'chapter') {
      return raw || hit.path.split('/').pop() || hit.path;
    }
    // Si el título no es solo un número, asumir que es titulo real del meta.
    if (raw && !/^\d+$/.test(raw)) return raw;
    // Stem numérico: agregar dir padre para contexto. Path típico:
    //   /.../<libro>/<sección o nada>/<n>.html
    // Devolvemos `<padre> — <n>` o `<abuelo> · <padre> — <n>` si padre es
    // genérico (un número). Strip prefijos "1 - ", "07 - " para limpiar.
    const parts = hit.path.split('/');
    const file = parts.pop() || '';
    const stem = file.replace(/\.html$/i, '') || raw;
    const parent = stripOrderPrefix(parts.pop() || '');
    const grand = stripOrderPrefix(parts.pop() || '');
    if (parent && /^\d+$/.test(parent) && grand) {
      return `${grand} · ${parent} — ${stem}`;
    }
    if (parent) return `${parent} — ${stem}`;
    return stem;
  }
  protected readonly scope = this.settings.searchScope;
  protected readonly searchDebug = this.settings.searchDebug;
  protected readonly searchFuzzy = this.settings.searchFuzzy;
  protected readonly scopeNeedsContext = this.svc.scopeNeedsContext;

  protected readonly scopeOptions: SelectOption[] = [
    { value: 'all', label: 'Todo el repo' },
    { value: 'saga', label: 'Saga actual' },
    { value: 'book', label: 'Libro actual' },
    { value: 'chapters', label: 'Solo capítulos' },
    { value: 'notes', label: 'Solo notas' },
    { value: 'current', label: 'Archivo actual' },
  ];

  protected readonly operatorsHelp = [
    'duendes mansión  → ambos términos (AND)',
    'duendes OR mansión  → cualquiera',
    '"casa encantada"  → frase exacta',
    '-trampa  → excluye el término',
    'kind:note  → solo notas',
    'kind:chapter  → solo capítulos',
  ].join('\n');

  constructor() {
    // Cuando el panel se muestra (open=true), enfocar el input. open vive en el service.
    effect(() => {
      if (this.svc.open()) {
        queueMicrotask(() => this.inputRef?.nativeElement.focus());
      }
    });
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => this.inputRef?.nativeElement.focus());
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.svc.setQuery(value);
  }

  protected clear(): void {
    this.svc.clear();
    this.inputRef?.nativeElement.focus();
  }

  protected close(): void {
    this.svc.hide();
  }

  protected reindex(): void {
    void this.svc.reindex();
  }

  protected onScopeChange(value: string): void {
    if (
      value !== 'all' &&
      value !== 'saga' &&
      value !== 'book' &&
      value !== 'notes' &&
      value !== 'chapters' &&
      value !== 'current'
    ) {
      return;
    }
    void this.settings.setSearchScope(value as SearchScope);
  }

  protected toggleDebug(): void {
    void this.settings.setSearchDebug(!this.searchDebug());
  }

  protected toggleFuzzy(): void {
    void this.settings.setSearchFuzzy(!this.searchFuzzy());
  }

  protected formatBm25(score: number | undefined): string {
    if (score == null) return '';
    return `BM25 ${score.toFixed(2)}`;
  }

  @HostListener('document:keydown.escape', ['$event'])
  protected onEsc(event: Event): void {
    if (!this.svc.open()) return;
    const target = event.target as HTMLElement | null;
    // Si está enfocado el input, primero limpia; si vacío, cierra.
    if (target === this.inputRef?.nativeElement) {
      if (this.query()) {
        this.svc.clear();
      } else {
        this.close();
      }
      event.preventDefault();
      return;
    }
    this.close();
    event.preventDefault();
  }

  protected iconFor(kind: string): LucideIcon | null {
    switch (kind) {
      case 'chapter':
        return LucideFile;
      case 'note':
        return LucideFilePen;
      case 'notes':
        return LucideNotebook;
      case 'folder':
        return LucideFolder;
      case 'saga':
        return LucideLibrary;
      case 'book':
        return LucideBookMarked;
      case 'section':
        return LucideList;
      default:
        return null;
    }
  }

  protected labelFor(kind: string): string {
    switch (kind) {
      case 'chapter':
        return 'capítulo';
      case 'note':
        return 'nota';
      case 'notes':
        return 'carpeta notas';
      case 'folder':
        return 'carpeta';
      case 'saga':
        return 'saga';
      case 'book':
        return 'novela';
      case 'section':
        return 'sección';
      default:
        return kind;
    }
  }

  protected async openHit(hit: SearchHit, event?: MouseEvent): Promise<void> {
    if (hit.kind === 'chapter') {
      // Si ya está abierto en pane 0, no recargues — perderías marcas y
      // tendrías que esperar el read del disco. Solo encolá el highlight; el
      // editor reacciona al pendingHighlight aunque el archivo ya esté abierto.
      if (this.chapter.panes[0].active()?.path === hit.path) {
        this.svc.requestHighlight(hit.path, undefined, hit.matchedTerms);
        return;
      }
      const node = findNodeByPath(this.project.tree(), hit.path);
      if (node) {
        const parent = hit.path.replace(/\/[^/]+$/, '');
        this.nav.setBrowsing(parent);
        // Pedir highlight ANTES del open: el editor lo consume al renderizar.
        this.svc.requestHighlight(hit.path, undefined, hit.matchedTerms);
        await this.chapter.open(node);
      }
      return;
    }
    if (hit.kind === 'note') {
      const name = hit.title || hit.path.split('/').pop() || hit.path;
      this.svc.requestHighlight(hit.path, undefined, hit.matchedTerms);
      if (event?.shiftKey) {
        // Shift+click: abrir en notes-editor central. Si ya está, no recargues.
        if (this.note.panes[0].active()?.path === hit.path) return;
        await this.openNoteInEditor(hit.path, name);
      } else {
        // Click normal: reader read-only en panel derecho. Idem guard.
        if (this.mdReader.viewing()?.path === hit.path) return;
        await this.mdReader.open({ path: hit.path, name });
      }
      return;
    }
    // Carpetas: navega y expande tree.
    this.nav.setBrowsing(hit.path);
  }

  /** Double-click sobre un hit: abre en el editor central directo. Para notas,
   *  equivale a Shift+click. Para capítulos hace lo mismo que click normal. */
  protected async openHitInEditor(hit: SearchHit): Promise<void> {
    if (hit.kind === 'chapter') {
      // Ya se abrió por el click previo; el highlight ya se pidió. Sin op.
      return;
    }
    if (hit.kind === 'note') {
      const name = hit.title || hit.path.split('/').pop() || hit.path;
      this.svc.requestHighlight(hit.path, undefined, hit.matchedTerms);
      await this.openNoteInEditor(hit.path, name);
    }
  }

  private async openNoteInEditor(path: string, name: string): Promise<void> {
    const parent = path.replace(/\/[^/]+$/, '');
    this.nav.setBrowsing(parent);
    this.mdReader.close();
    await this.note.open({ path, name });
  }

  protected highlightSnippet(hit: SearchHit, query: string): string {
    const snippet = hit.snippet;
    if (!snippet) return '';
    // Marca las palabras REALES que matchearon (matchedTerms del backend, ej.
    // "Kallai" para el typo "kellai"); fallback a los tokens tipeados. Usa el
    // matcher fold-aware (acentos) por rangos en vez de regex sobre la query —
    // así "mansión" se marca aunque se haya buscado "mansion".
    const override = hit.matchedTerms?.filter((t) => t.length > 0) ?? [];
    const terms = override.length > 0 ? override : tokenize(query);
    const rawQuery = override.length > 0 ? '' : query.trim();
    if (terms.length === 0 && !rawQuery) return escapeHtml(snippet);
    const ranges = findAllMatchesInPlain(snippet, terms, rawQuery);
    if (ranges.length === 0) return escapeHtml(snippet);
    let out = '';
    let cursor = 0;
    for (const r of ranges) {
      out += escapeHtml(snippet.slice(cursor, r.start));
      out += '<mark>' + escapeHtml(snippet.slice(r.start, r.end)) + '</mark>';
      cursor = r.end;
    }
    out += escapeHtml(snippet.slice(cursor));
    return out;
  }
}

/** "07 - Vuelta" → "Vuelta". Mantiene el nombre limpio para el header. */
function stripOrderPrefix(name: string): string {
  return name.replace(/^\d+\s*[-·]\s*/, '').trim();
}

function findNodeByPath(root: TreeNode | null, path: string): TreeNode | null {
  if (!root) return null;
  if (root.path === path) return root;
  for (const c of root.children) {
    const found = findNodeByPath(c, path);
    if (found) return found;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
