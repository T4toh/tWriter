import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Editor as TipTapEditor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { PaneId } from '../core/chapter-service';
import { CursorRestoreService } from '../core/cursor-restore-service';
import { NoteService } from '../core/note-service';
import { SearchService } from '../core/search-service';
import {
  findAllMatchesInPlain,
  highlightFirstMatch,
} from '../core/search-highlight';
import { extractPlainText, offsetToPm } from '../editor/grammar-extension';
import {
  SearchHighlight,
  setSearchHighlights,
} from '../editor/search-highlight-extension';
import { PARAGRAPH_SPACING_EM, SettingsService } from '../core/settings-service';
import {
  ContextMenuService,
  CtxMenuEntry,
} from '../shared/context-menu-service';

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  codeBlock: boolean;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const EMPTY_STATE: ToolbarState = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  h1: false,
  h2: false,
  h3: false,
  bulletList: false,
  orderedList: false,
  blockquote: false,
  codeBlock: false,
  hasSelection: false,
  canUndo: false,
  canRedo: false,
};

@Component({
  selector: 'app-notes-editor',
  templateUrl: './notes-editor.html',
  styleUrl: './notes-editor.scss',
})
export class NotesEditor implements AfterViewInit, OnDestroy {
  protected note = inject(NoteService);
  protected settings = inject(SettingsService);
  private ctxMenu = inject(ContextMenuService);
  private search = inject(SearchService);
  private cursorRestore = inject(CursorRestoreService);

  readonly paneId = input<PaneId>(0);

  @ViewChild('host', { static: true })
  hostRef!: ElementRef<HTMLDivElement>;

  private readonly pane = computed(() => this.note.panes[this.paneId()]);
  protected readonly active = computed(() => this.pane().active());
  protected readonly dirty = computed(() => this.pane().dirty());
  protected readonly noteError = computed(() => this.pane().error());
  protected readonly state = signal<ToolbarState>(EMPTY_STATE);
  protected readonly width = this.settings.editorWidth;
  protected readonly fontSize = this.settings.editorFontSize;
  protected readonly paragraphSpacing = this.settings.editorParagraphSpacing;
  protected readonly paragraphSpacingEm = computed(
    () => PARAGRAPH_SPACING_EM[this.paragraphSpacing()],
  );
  protected readonly widthLabel = computed(() => {
    switch (this.width()) {
      case 'narrow':
        return 'página';
      case 'wide':
        return 'ancho';
      case 'full':
        return 'lleno';
    }
  });
  protected readonly widthIcon = computed(() => {
    switch (this.width()) {
      case 'narrow':
        return '▯';
      case 'wide':
        return '▭';
      case 'full':
        return '▬';
    }
  });

  private viewReady = signal(false);
  private tiptap: TipTapEditor | null = null;
  private lastLoadedAt = 0;

  constructor() {
    effect(() => {
      const at = this.pane().loadedAt();
      const ready = this.viewReady();
      if (!ready || at === this.lastLoadedAt) {
        return;
      }
      const md = untracked(() => this.pane().content());
      const target = untracked(() => this.pane().active());
      const editable = !!target;
      if (!this.tiptap) {
        this.createEditor(md, editable);
      } else {
        this.tiptap.commands.setContent(md, { emitUpdate: false });
        this.tiptap.setEditable(editable);
      }
      // Reset scroll al tope al cargar una nota — el host (.editor-host)
      // conserva `scrollTop` entre cargas si no se lo limpia explícitamente,
      // lo que daba la falsa impresión de que el lateral "seguía" el scroll
      // del editor principal. Si hay un pending highlight de Ctrl+F, el
      // setTimeout de abajo scrollea al match después.
      this.hostRef.nativeElement.scrollTop = 0;
      this.lastLoadedAt = at;
      this.refreshState();

      // Restaurar cursor (solo pane 0) si bootstrap encoló un pedido. Antes
      // del highlight de Ctrl+F — el search prevalece cuando el usuario llega
      // via search.
      if (target?.path && this.paneId() === 0 && this.tiptap) {
        const restore = this.cursorRestore.consume(target.path);
        if (restore) {
          const docSize = this.tiptap.state.doc.content.size;
          const pos = Math.max(0, Math.min(restore.pmPos, Math.max(0, docSize - 1)));
          this.tiptap
            .chain()
            .focus()
            .setTextSelection({ from: pos, to: pos })
            .scrollIntoView()
            .run();
        }
      }

      // Highlight pendiente desde Ctrl+F: salta al primer match.
      if (target?.path) {
        const pending = this.search.consumePendingHighlight(target.path);
        if (pending) {
          setTimeout(() => {
            highlightFirstMatch(this.hostRef.nativeElement, pending.terms, pending.rawQuery);
          }, 0);
        }
      }
    });

    // Resalto de todas las ocurrencias de la query mientras el panel esté
    // abierto. Reactivo a query + nota activa + loadedAt. Solo aplica si el
    // search apunta a la nota de ESTE pane (vía `activeFile().path`); si el
    // usuario abrió Ctrl+F desde el editor principal, el lateral no pinta ni
    // scrollea.
    effect(() => {
      const terms = this.search.highlightTerms();
      const target = this.active();
      this.pane().loadedAt();
      if (!this.viewReady() || !this.tiptap) return;
      const activeFile = this.search.activeFile();
      const matchesPane = !!target && !!activeFile && activeFile.path === target.path;
      if (!terms || !target || !matchesPane) {
        this.applySearchDecorations([]);
        return;
      }
      this.recomputeSearchDecorations(terms.terms, terms.rawQuery);
    });

    // Pending highlight para nota ya abierta (click sobre hit del mismo path).
    effect(() => {
      const pending = this.search.pendingHighlight();
      const target = this.active();
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
    this.tiptap?.destroy();
    this.tiptap = null;
  }

  protected onContextMenu(event: MouseEvent): void {
    if (!this.tiptap) return;
    this.refreshState();
    this.ctxMenu.open(event, this.buildEditorItems());
  }

  private buildEditorItems(): CtxMenuEntry[] {
    const s = this.state();
    const entries: CtxMenuEntry[] = [
      { label: 'Deshacer', kbd: 'Ctrl+Z', disabled: !s.canUndo, onClick: () => this.undo() },
      { label: 'Rehacer', kbd: 'Ctrl+Shift+Z', disabled: !s.canRedo, onClick: () => this.redo() },
      { kind: 'separator' },
      { label: 'Cortar', kbd: 'Ctrl+X', disabled: !s.hasSelection, onClick: () => this.cut() },
      { label: 'Copiar', kbd: 'Ctrl+C', disabled: !s.hasSelection, onClick: () => this.copy() },
      { label: 'Pegar', kbd: 'Ctrl+V', onClick: () => this.paste() },
      { label: 'Seleccionar todo', kbd: 'Ctrl+A', onClick: () => this.selectAll() },
    ];
    if (s.hasSelection) {
      entries.push(
        { kind: 'separator' },
        { label: 'Negrita', kbd: 'Ctrl+B', onClick: () => this.toggleBold() },
        { label: 'Itálica', kbd: 'Ctrl+I', onClick: () => this.toggleItalic() },
      );
    }
    return entries;
  }

  protected toggleBold(): void {
    this.tiptap?.chain().focus().toggleBold().run();
  }
  protected toggleItalic(): void {
    this.tiptap?.chain().focus().toggleItalic().run();
  }
  protected toggleStrike(): void {
    this.tiptap?.chain().focus().toggleStrike().run();
  }
  protected toggleCode(): void {
    this.tiptap?.chain().focus().toggleCode().run();
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
  protected insertHr(): void {
    this.tiptap?.chain().focus().setHorizontalRule().run();
  }
  protected undo(): void {
    this.tiptap?.chain().focus().undo().run();
  }
  protected redo(): void {
    this.tiptap?.chain().focus().redo().run();
  }

  protected async cut(): Promise<void> {
    await this.copySelection();
    this.tiptap?.chain().focus().deleteSelection().run();
  }
  protected async copy(): Promise<void> {
    await this.copySelection();
  }
  protected async paste(): Promise<void> {
    if (!this.tiptap) return;
    try {
      const text = await navigator.clipboard.readText();
      this.tiptap.chain().focus().insertContent(text).run();
    } catch {
      // permisos / sin texto
    }
  }
  private async copySelection(): Promise<void> {
    const e = this.tiptap;
    if (!e) return;
    const { from, to } = e.state.selection;
    if (from === to) return;
    const text = e.state.doc.textBetween(from, to, '\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignorar
    }
  }
  protected selectAll(): void {
    this.tiptap?.chain().focus().selectAll().run();
  }
  protected cycleWidth(): void {
    this.settings.cycleEditorWidth();
  }
  protected cycleParagraphSpacing(): void {
    this.settings.cycleParagraphSpacing();
  }
  protected fontBump(delta: number): void {
    this.settings.bumpFontSize(delta);
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
          transformPastedText: true,
          transformCopiedText: true,
        }),
        SearchHighlight,
      ],
      content,
      editable,
      // Solo el pane principal autofocusea — el lateral abre al tope sin
      // mover el cursor. Pane 0 además tiene cursor-restore que sobreescribe
      // el 'end' si había posición guardada para el path. Si autofocus 'end'
      // se aplicara al lateral, scrolleaba al final async DESPUÉS del
      // scrollTop=0 del effect de carga.
      autofocus: editable && this.paneId() === 0 ? 'end' : false,
      onUpdate: ({ editor }) => {
        const storage = (editor.storage as { markdown?: { getMarkdown: () => string } }).markdown;
        const md = storage ? storage.getMarkdown() : '';
        this.note.updateContentInPane(md, this.paneId());
      },
      onSelectionUpdate: () => {
        this.refreshState();
        if (this.paneId() === 0) this.search.setFocused('note');
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
    if (!e) {
      this.state.set(EMPTY_STATE);
      return;
    }
    const { from, to, empty } = e.state.selection;
    this.state.set({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      hasSelection: !empty && from !== to,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    });
    // Persist sesión: solo pane 0 — paridad con Editor. Sin esto la nota
    // abierta como lastSession no se acuerda del cursor entre boots.
    if (this.paneId() === 0) {
      const node = this.pane().active();
      if (node?.path) {
        this.settings.setLastSession(node.path, from);
      }
    }
  }
}
