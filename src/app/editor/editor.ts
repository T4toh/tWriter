import {
  AfterViewInit,
  Component,
  ElementRef,
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
import TextAlign from '@tiptap/extension-text-align';
import { ChapterService } from '../core/chapter-service';
import { SettingsService } from '../core/settings-service';
import { convert as convertRae } from '../dialogos/converter';

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  alignLeft: boolean;
  alignCenter: boolean;
  alignRight: boolean;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const EMPTY_STATE: ToolbarState = {
  bold: false,
  italic: false,
  underline: false,
  alignLeft: false,
  alignCenter: false,
  alignRight: false,
  hasSelection: false,
  canUndo: false,
  canRedo: false,
};

@Component({
  selector: 'app-editor',
  imports: [],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
})
export class Editor implements AfterViewInit, OnDestroy {
  private chapter = inject(ChapterService);
  private settings = inject(SettingsService);

  @ViewChild('host', { static: true })
  hostRef!: ElementRef<HTMLDivElement>;

  protected readonly active = this.chapter.active;
  protected readonly canEdit = this.chapter.canEdit;
  protected readonly wordCount = this.chapter.wordCount;
  protected readonly dirty = this.chapter.dirty;
  protected readonly saving = this.chapter.saving;
  protected readonly chapterError = this.chapter.error;
  protected readonly state = signal<ToolbarState>(EMPTY_STATE);
  protected readonly menu = signal<{ x: number; y: number } | null>(null);
  protected readonly rae = signal<{ original: string; converted: string } | null>(null);
  protected readonly importing = this.chapter.importing;
  protected readonly canApplyRae = computed(() => {
    if (!this.canEdit()) return false;
    const lang = this.chapter.meta().idioma;
    return lang === null || lang === 'es' || lang === undefined;
  });
  protected readonly width = this.settings.editorWidth;
  protected readonly widthLabel = computed(() => {
    switch (this.width()) {
      case 'narrow': return 'página';
      case 'wide': return 'ancho';
      case 'full': return 'lleno';
    }
  });
  protected readonly widthIcon = computed(() => {
    switch (this.width()) {
      case 'narrow': return '▯';
      case 'wide': return '▭';
      case 'full': return '▬';
    }
  });

  private viewReady = signal(false);
  private tiptap: TipTapEditor | null = null;
  private lastLoadedAt = 0;

  constructor() {
    effect(() => {
      const at = this.chapter.loadedAt();
      const ready = this.viewReady();
      if (!ready || at === this.lastLoadedAt) {
        return;
      }
      const node = untracked(() => this.chapter.active());
      const html = untracked(() => this.chapter.content());
      const editable = !!node?.editable;

      if (!this.tiptap) {
        this.createEditor(editable ? html : '', editable);
      } else {
        this.tiptap.commands.setContent(editable ? html : '', { emitUpdate: false });
        this.tiptap.setEditable(editable);
      }
      this.lastLoadedAt = at;
      this.refreshState();
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
    if (!this.canEdit() || !this.tiptap) {
      return;
    }
    event.preventDefault();
    this.refreshState();
    this.menu.set({ x: event.clientX, y: event.clientY });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  protected toggleBold(): void {
    this.tiptap?.chain().focus().toggleBold().run();
    this.closeMenu();
  }

  protected toggleItalic(): void {
    this.tiptap?.chain().focus().toggleItalic().run();
    this.closeMenu();
  }

  protected toggleUnderline(): void {
    this.tiptap?.chain().focus().toggleUnderline().run();
    this.closeMenu();
  }

  protected setAlign(align: 'left' | 'center' | 'right'): void {
    this.tiptap?.chain().focus().setTextAlign(align).run();
    this.closeMenu();
  }

  protected insertSceneBreak(): void {
    this.tiptap?.chain().focus().setHorizontalRule().run();
    this.closeMenu();
  }

  protected undo(): void {
    this.tiptap?.chain().focus().undo().run();
    this.closeMenu();
  }

  protected redo(): void {
    this.tiptap?.chain().focus().redo().run();
    this.closeMenu();
  }

  protected async cut(): Promise<void> {
    await this.copySelection();
    this.tiptap?.chain().focus().deleteSelection().run();
    this.closeMenu();
  }

  protected async copy(): Promise<void> {
    await this.copySelection();
    this.closeMenu();
  }

  protected async paste(): Promise<void> {
    if (!this.tiptap) return;
    try {
      const text = await navigator.clipboard.readText();
      this.tiptap.chain().focus().insertContent(text).run();
    } catch {
      // permisos denegados o sin texto en clipboard
    }
    this.closeMenu();
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
      // ignorar errores de permisos
    }
  }

  protected async pastePlain(): Promise<void> {
    if (!this.tiptap) return;
    try {
      const text = await navigator.clipboard.readText();
      const paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.replace(/\n/g, ' ').trim())
        .filter(Boolean);
      const html = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
      this.tiptap.chain().focus().insertContent(html).run();
    } catch {
      // ignorar
    }
    this.closeMenu();
  }

  protected selectAll(): void {
    this.tiptap?.chain().focus().selectAll().run();
    this.closeMenu();
  }

  protected cycleWidth(): void {
    this.settings.cycleEditorWidth();
  }

  protected openRae(): void {
    if (!this.tiptap || !this.canApplyRae()) return;
    const original = this.tiptap.getHTML();
    const result = convertRae(original);
    this.rae.set({ original, converted: result.text });
  }

  protected acceptRae(): void {
    const m = this.rae();
    if (!m || !this.tiptap) return;
    this.tiptap.commands.setContent(m.converted, { emitUpdate: true });
    this.rae.set(null);
  }

  protected cancelRae(): void {
    this.rae.set(null);
  }

  protected importNow(): void {
    const node = this.active();
    if (!node) return;
    void this.chapter.importChapter(node);
  }

  private createEditor(content: string, editable: boolean): void {
    this.tiptap = new TipTapEditor({
      element: this.hostRef.nativeElement,
      extensions: [
        StarterKit.configure({
          link: { autolink: false, openOnClick: false },
        }),
        Typography,
        TextAlign.configure({ types: ['paragraph', 'heading'] }),
      ],
      content,
      editable,
      autofocus: editable ? 'end' : false,
      onUpdate: ({ editor }) => {
        this.chapter.updateContent(editor.getHTML());
        this.refreshState();
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
      underline: e.isActive('underline'),
      alignLeft: e.isActive({ textAlign: 'left' }),
      alignCenter: e.isActive({ textAlign: 'center' }),
      alignRight: e.isActive({ textAlign: 'right' }),
      hasSelection: !empty && from !== to,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
