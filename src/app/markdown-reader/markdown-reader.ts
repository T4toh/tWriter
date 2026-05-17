import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Editor as TipTapEditor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { MarkdownReaderService } from '../core/markdown-reader-service';
import { SearchService } from '../core/search-service';
import {
  findAllMatchesInPlain,
  highlightFirstMatch,
} from '../core/search-highlight';
import { SettingsService } from '../core/settings-service';
import { extractPlainText, offsetToPm } from '../editor/grammar-extension';
import {
  SearchHighlight,
  setSearchHighlights,
} from '../editor/search-highlight-extension';

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  codeBlock: boolean;
}

const EMPTY_STATE: ToolbarState = {
  bold: false,
  italic: false,
  h1: false,
  h2: false,
  h3: false,
  bulletList: false,
  orderedList: false,
  blockquote: false,
  codeBlock: false,
};

@Component({
  selector: 'app-markdown-reader',
  templateUrl: './markdown-reader.html',
  styleUrl: './markdown-reader.scss',
})
export class MarkdownReader implements AfterViewInit, OnDestroy {
  private svc = inject(MarkdownReaderService);
  private settings = inject(SettingsService);
  private search = inject(SearchService);

  @ViewChild('host', { static: true })
  hostRef!: ElementRef<HTMLDivElement>;

  protected readonly viewing = this.svc.viewing;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;
  protected readonly editing = this.svc.editing;
  protected readonly dirty = this.svc.dirty;
  protected readonly saving = this.svc.saving;
  protected readonly rightPanelWidth = this.settings.rightPanelWidth;
  protected readonly state = signal<ToolbarState>(EMPTY_STATE);
  protected readonly widthIcon = computed(() => {
    switch (this.rightPanelWidth()) {
      case 'compact':
        return '◧';
      case 'normal':
        return '▢';
      case 'wide':
        return '◨';
      case 'full':
        return '⛶';
    }
  });
  protected readonly widthLabel = computed(() => {
    switch (this.rightPanelWidth()) {
      case 'compact':
        return 'compacto';
      case 'normal':
        return 'normal';
      case 'wide':
        return 'ancho';
      case 'full':
        return 'pantalla';
    }
  });

  private viewReady = signal(false);
  private tiptap: TipTapEditor | null = null;
  private lastLoadedAt = 0;
  private currentEditable = false;

  constructor() {
    // Effect: cuando cambia la nota (loadedAt) o el modo edit, resincroniza.
    effect(() => {
      const at = this.svc.loadedAt();
      const wantEditable = this.svc.editing();
      const ready = this.viewReady();
      if (!ready) return;
      const target = untracked(() => this.svc.viewing());
      if (!target) {
        if (this.tiptap) {
          this.tiptap.destroy();
          this.tiptap = null;
        }
        this.lastLoadedAt = at;
        this.currentEditable = false;
        this.state.set(EMPTY_STATE);
        return;
      }

      const reloaded = at !== this.lastLoadedAt;
      const editableChanged = wantEditable !== this.currentEditable;

      if (reloaded || editableChanged || !this.tiptap) {
        // Recrear editor para applicar editable correctamente (setEditable
        // existe en TipTap, pero recrear nos permite también swap del
        // contenido limpio y atajos del modo edit).
        if (this.tiptap) {
          this.tiptap.destroy();
          this.tiptap = null;
        }
        const md = untracked(() => this.svc.content());
        this.createEditor(md, wantEditable);
        this.currentEditable = wantEditable;
      }

      this.lastLoadedAt = at;
      this.refreshState();

      // Highlight pendiente desde Ctrl+F: salta al primer match. Solo cuando
      // recién se cargó la nota (no en cada toggle de edit mode).
      if (reloaded && target.path) {
        const pending = this.search.consumePendingHighlight(target.path);
        if (pending) {
          setTimeout(() => {
            highlightFirstMatch(this.hostRef.nativeElement, pending.terms, pending.rawQuery);
          }, 0);
        }
      }
    });

    // Resalto de todas las ocurrencias mientras el panel esté abierto.
    effect(() => {
      const terms = this.search.highlightTerms();
      const target = this.viewing();
      this.svc.loadedAt();
      if (!this.viewReady() || !this.tiptap) return;
      if (!terms || !target) {
        this.applySearchDecorations([]);
        return;
      }
      this.recomputeSearchDecorations(terms.terms, terms.rawQuery);
    });

    // Pending highlight para nota ya visible (click sobre hit del mismo path).
    effect(() => {
      const pending = this.search.pendingHighlight();
      const target = this.viewing();
      if (!pending || !target || pending.path !== target.path) return;
      if (!this.viewReady() || !this.tiptap) return;
      const consumed = this.search.consumePendingHighlight(target.path);
      if (!consumed) return;
      setTimeout(() => {
        highlightFirstMatch(this.hostRef.nativeElement, consumed.terms, consumed.rawQuery);
      }, 0);
    });
  }

  ngAfterViewInit(): void {
    this.viewReady.set(true);
  }

  ngOnDestroy(): void {
    if (this.svc.dirty()) {
      void this.svc.flushPending();
    }
    this.tiptap?.destroy();
    this.tiptap = null;
  }

  protected close(): void {
    this.svc.close();
  }

  protected toggleEdit(): void {
    if (this.svc.editing()) {
      void this.svc.exitEdit();
    } else {
      this.svc.enterEdit();
    }
  }

  protected cycleWidth(): void {
    this.settings.cycleRightPanelWidth();
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (!this.svc.isOpen()) return;
    if (this.svc.editing()) {
      void this.svc.exitEdit();
    } else {
      this.svc.close();
    }
  }

  protected toggleBold(): void {
    this.tiptap?.chain().focus().toggleBold().run();
  }
  protected toggleItalic(): void {
    this.tiptap?.chain().focus().toggleItalic().run();
  }
  protected setHeading(level: 1 | 2 | 3): void {
    this.tiptap?.chain().focus().toggleHeading({ level }).run();
  }
  protected toggleBulletList(): void {
    this.tiptap?.chain().focus().toggleBulletList().run();
  }
  protected toggleOrderedList(): void {
    this.tiptap?.chain().focus().toggleOrderedList().run();
  }
  protected toggleBlockquote(): void {
    this.tiptap?.chain().focus().toggleBlockquote().run();
  }
  protected toggleCodeBlock(): void {
    this.tiptap?.chain().focus().toggleCodeBlock().run();
  }

  private createEditor(content: string, editable: boolean): void {
    this.tiptap = new TipTapEditor({
      element: this.hostRef.nativeElement,
      extensions: [
        StarterKit.configure({
          link: { autolink: false, openOnClick: false },
        }),
        Typography,
        Markdown.configure({
          html: false,
          tightLists: true,
          bulletListMarker: '-',
          linkify: false,
          breaks: false,
          transformPastedText: editable,
          transformCopiedText: editable,
        }),
        SearchHighlight,
      ],
      content,
      editable,
      autofocus: editable ? 'end' : false,
      onUpdate: ({ editor }) => {
        if (!editable) return;
        const storage = (editor.storage as { markdown?: { getMarkdown: () => string } }).markdown;
        const md = storage ? storage.getMarkdown() : '';
        this.svc.updateContent(md);
      },
      onSelectionUpdate: () => {
        this.refreshState();
        this.search.setFocused('mdReader');
      },
      onTransaction: () => this.refreshState(),
    });
  }

  private applySearchDecorations(ranges: { from: number; to: number }[]): void {
    const view = (this.tiptap as unknown as { view?: { dispatch: (tr: unknown) => void; state: { tr: unknown } } } | null)?.view;
    if (!view) return;
    setSearchHighlights(view, ranges);
  }

  private recomputeSearchDecorations(terms: string[], rawQuery: string): void {
    if (!this.tiptap) return;
    const { plain, ranges } = extractPlainText(this.tiptap.state.doc);
    if (!plain) {
      this.applySearchDecorations([]);
      return;
    }
    const hits = findAllMatchesInPlain(plain, terms, rawQuery);
    const positioned: { from: number; to: number }[] = [];
    for (const h of hits) {
      const from = offsetToPm(h.start, ranges);
      const to = offsetToPm(h.end, ranges);
      if (from === null || to === null || to <= from) continue;
      positioned.push({ from, to });
    }
    this.applySearchDecorations(positioned);
  }

  private refreshState(): void {
    const e = this.tiptap;
    if (!e || !this.svc.editing()) {
      this.state.set(EMPTY_STATE);
      return;
    }
    this.state.set({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
    });
  }
}
