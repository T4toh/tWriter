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
import { ChapterService } from '../core/chapter-service';
import { MarkdownReaderService } from '../core/markdown-reader-service';
import { NavigationService } from '../core/navigation-service';
import { NoteService } from '../core/note-service';
import { ProjectService } from '../core/project-service';
import { SearchHit, SearchService } from '../core/search-service';
import { TreeNode } from '../core/types';

@Component({
  selector: 'app-search-panel',
  templateUrl: './search-panel.html',
  styleUrl: './search-panel.scss',
})
export class SearchPanel implements AfterViewInit {
  private svc = inject(SearchService);
  private chapter = inject(ChapterService);
  private mdReader = inject(MarkdownReaderService);
  private note = inject(NoteService);
  private nav = inject(NavigationService);
  private project = inject(ProjectService);

  @ViewChild('input', { static: true })
  inputRef!: ElementRef<HTMLInputElement>;

  protected readonly query = this.svc.query;
  protected readonly results = this.svc.results;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;
  protected readonly reindexing = this.svc.reindexing;
  protected readonly reindexProgress = this.svc.reindexProgress;
  protected readonly count = computed(() => this.results().length);

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

  protected iconFor(kind: string): string {
    switch (kind) {
      case 'chapter':
        return '◆';
      case 'note':
        return '📝';
      case 'notes':
        return '📒';
      case 'folder':
        return '📁';
      case 'saga':
        return '📚';
      case 'book':
        return '📖';
      case 'section':
        return '▤';
      default:
        return '·';
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
      const node = findNodeByPath(this.project.tree(), hit.path);
      if (node) {
        const parent = hit.path.replace(/\/[^/]+$/, '');
        this.nav.setBrowsing(parent);
        // Pedir highlight ANTES del open: el editor lo consume al renderizar.
        this.svc.requestHighlight(hit.path);
        await this.chapter.open(node);
      }
      return;
    }
    if (hit.kind === 'note') {
      const name = hit.title || hit.path.split('/').pop() || hit.path;
      this.svc.requestHighlight(hit.path);
      if (event?.shiftKey) {
        // Shift+click: abrir en notes-editor central (mismo patrón que el tree).
        await this.openNoteInEditor(hit.path, name);
      } else {
        // Click normal: reader read-only en panel derecho.
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
      this.svc.requestHighlight(hit.path);
      await this.openNoteInEditor(hit.path, name);
    }
  }

  private async openNoteInEditor(path: string, name: string): Promise<void> {
    const parent = path.replace(/\/[^/]+$/, '');
    this.nav.setBrowsing(parent);
    this.mdReader.close();
    await this.note.open({ path, name });
  }

  protected highlightSnippet(snippet: string, query: string): string {
    if (!snippet || !query.trim()) return escapeHtml(snippet);
    const terms = query
      .trim()
      .split(/\s+/)
      .map((t) => t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .filter((t) => t.length > 0);
    if (terms.length === 0) return escapeHtml(snippet);
    const re = new RegExp(`(${terms.join('|')})`, 'gi');
    const escaped = escapeHtml(snippet);
    return escaped.replace(re, '<mark>$1</mark>');
  }
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
