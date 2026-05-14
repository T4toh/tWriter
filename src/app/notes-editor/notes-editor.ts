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
import { NoteService } from '../core/note-service';
import { SearchService } from '../core/search-service';
import { highlightFirstMatch } from '../core/search-highlight';
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
      this.lastLoadedAt = at;
      this.refreshState();

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
      ],
      content,
      editable,
      autofocus: editable ? 'end' : false,
      onUpdate: ({ editor }) => {
        const storage = (editor.storage as { markdown?: { getMarkdown: () => string } }).markdown;
        const md = storage ? storage.getMarkdown() : '';
        this.note.updateContentInPane(md, this.paneId());
      },
      onSelectionUpdate: () => this.refreshState(),
      onTransaction: () => this.refreshState(),
    });
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
  }
}
