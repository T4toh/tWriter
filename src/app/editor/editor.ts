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
import { SagaContextService } from '../core/saga-context-service';
import { GrammarService } from '../core/grammar-service';
import { SettingsService } from '../core/settings-service';
import { GrammarMatch } from '../core/types';
import { convert as convertRae } from '../dialogos/converter';
import { Landing } from '../landing/landing';
import {
  Grammar,
  GrammarMatchPos,
  extractPlainText,
  mapMatchesToPm,
  setGrammarMatches,
} from './grammar-extension';
import { GrammarPopover } from './grammar-popover';

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
  imports: [Landing, GrammarPopover],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
})
export class Editor implements AfterViewInit, OnDestroy {
  protected chapter = inject(ChapterService);
  protected settings = inject(SettingsService);
  protected grammar = inject(GrammarService);
  protected sagaCtx = inject(SagaContextService);

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
  protected readonly canCheckGrammar = computed(() => {
    if (!this.canEdit()) return false;
    if (!this.grammar.available()) return false;
    const lang = this.chapter.meta().idioma;
    return lang === 'es' || lang === 'en' || lang === null || lang === undefined;
  });
  protected readonly grammarChecking = this.grammar.checking;
  protected readonly grammarError = this.grammar.lastError;
  protected readonly grammarMatches = signal<GrammarMatchPos[]>([]);
  protected readonly grammarPopover = signal<{ match: GrammarMatch; x: number; y: number; from: number; to: number } | null>(null);
  protected readonly grammarBannerDismissed = signal<boolean>(false);
  private grammarUsed = signal<boolean>(false);
  protected readonly showPrivacyBanner = computed(() =>
    this.grammar.mode() === 'public' &&
    this.grammarUsed() &&
    !this.grammarBannerDismissed(),
  );
  protected readonly autoGrammar = this.grammar.autoEnabled;
  protected readonly canAutoGrammar = this.grammar.canAutoCheck;
  protected readonly width = this.settings.editorWidth;
  protected readonly fontSize = this.settings.editorFontSize;
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
  private grammarHostListener: ((e: MouseEvent) => void) | null = null;
  private grammarDebounceHandle: ReturnType<typeof setTimeout> | null = null;
  private skipNextGrammarRemap = false;

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
    void this.grammar.ping();
  }

  ngOnDestroy(): void {
    if (this.grammarHostListener) {
      this.hostRef.nativeElement.removeEventListener('click', this.grammarHostListener);
      this.grammarHostListener = null;
    }
    if (this.grammarDebounceHandle !== null) {
      clearTimeout(this.grammarDebounceHandle);
      this.grammarDebounceHandle = null;
    }
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

  protected fontBump(delta: number): void {
    this.settings.bumpFontSize(delta);
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

  protected toggleLang(): void {
    const current = this.chapter.meta().idioma;
    void this.chapter.setLanguage(current === 'en' ? 'es' : 'en');
  }

  protected async checkGrammar(): Promise<void> {
    if (!this.tiptap || !this.canCheckGrammar()) return;
    const meta = this.chapter.meta().idioma;
    const lang: 'es' | 'en' | 'auto' = meta === 'es' || meta === 'en' ? meta : 'auto';
    const { plain, ranges } = extractPlainText(this.tiptap.state.doc);
    if (!plain.trim()) {
      this.grammarMatches.set([]);
      this.applyDecorations([]);
      return;
    }
    this.grammarUsed.set(true);
    try {
      const matches = await this.grammar.check(plain, lang);
      const positioned = mapMatchesToPm(matches, ranges, this.tiptap.state.doc, plain);
      const filtered = positioned.filter((m) => {
        if (m.category !== 'TYPOS') return true;
        const word = plain.slice(m.offset, m.offset + m.length);
        return !this.sagaCtx.isInDictionary(word);
      });
      this.grammarMatches.set(filtered);
      this.applyDecorations(filtered);
    } catch {
      // grammar.lastError ya tiene el mensaje
    }
  }

  protected toggleAutoGrammar(): void {
    this.grammar.toggleAuto();
    if (!this.grammar.autoEnabled()) {
      this.grammarMatches.set([]);
      this.applyDecorations([]);
    } else {
      void this.checkGrammar();
    }
  }

  protected dismissPrivacyBanner(): void {
    this.grammarBannerDismissed.set(true);
  }

  protected applyGrammarReplacement(replacement: string): void {
    const popover = this.grammarPopover();
    if (!popover || !this.tiptap) return;
    const dismissedId = (popover.match as GrammarMatchPos).id;
    this.tiptap
      .chain()
      .focus()
      .setTextSelection({ from: popover.from, to: popover.to })
      .insertContent(replacement)
      .run();
    this.grammarPopover.set(null);
    this.grammarMatches.update((list) => list.filter((m) => m.id !== dismissedId));
    this.applyDecorations(this.grammarMatches());
    if (this.grammar.autoEnabled() && this.canAutoGrammar()) {
      this.scheduleGrammarRecheck();
    }
  }

  protected dismissGrammarMatch(): void {
    const popover = this.grammarPopover();
    if (!popover) return;
    const dismissedId = (popover.match as GrammarMatchPos).id;
    this.grammarMatches.update((list) => list.filter((m) => m.id !== dismissedId));
    this.applyDecorations(this.grammarMatches());
    this.grammarPopover.set(null);
  }

  protected async addCurrentToDictionary(): Promise<void> {
    const popover = this.grammarPopover();
    if (!popover || !this.tiptap) return;
    const word = this.tiptap.state.doc.textBetween(popover.from, popover.to, ' ').trim();
    if (!word) return;
    await this.sagaCtx.addToDictionary(word);
    this.grammarMatches.update((list) =>
      list.filter((m) => {
        if (m.category !== 'TYPOS') return true;
        const w = this.tiptap!.state.doc.textBetween(m.from, m.to, ' ').trim();
        return w.toLowerCase() !== word.toLowerCase();
      }),
    );
    this.applyDecorations(this.grammarMatches());
    this.grammarPopover.set(null);
  }

  protected closeGrammarPopover(): void {
    this.grammarPopover.set(null);
  }

  private applyDecorations(matches: GrammarMatchPos[]): void {
    const view = (this.tiptap as unknown as { view?: { dispatch: (tr: unknown) => void; state: { tr: unknown } } } | null)?.view;
    if (!view) return;
    setGrammarMatches(view, matches);
  }

  private scheduleGrammarRecheck(): void {
    if (this.grammarDebounceHandle !== null) {
      clearTimeout(this.grammarDebounceHandle);
    }
    this.grammarDebounceHandle = setTimeout(() => {
      this.grammarDebounceHandle = null;
      void this.checkGrammar();
    }, 2000);
  }

  private onGrammarHostClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const span = target?.closest('.grammar-error') as HTMLElement | null;
    if (!span) {
      if (this.grammarPopover()) this.closeGrammarPopover();
      return;
    }
    const idx = parseInt(span.dataset['grammarIdx'] ?? '-1', 10);
    const m = this.grammarMatches()[idx];
    if (!m) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = span.getBoundingClientRect();
    this.grammarPopover.set({
      match: m,
      x: Math.min(rect.left, window.innerWidth - 340),
      y: rect.bottom + 4,
      from: m.from,
      to: m.to,
    });
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
        Grammar,
      ],
      content,
      editable,
      autofocus: editable ? 'end' : false,
      onUpdate: ({ editor }) => {
        this.chapter.updateContent(editor.getHTML());
      },
      onSelectionUpdate: () => this.refreshState(),
      onTransaction: ({ transaction }) => {
        this.refreshState();
        if (!transaction.docChanged) return;
        if (this.skipNextGrammarRemap) {
          this.skipNextGrammarRemap = false;
        } else if (this.grammarMatches().length > 0) {
          const docSize = transaction.doc.content.size;
          const remapped = this.grammarMatches()
            .map((m) => ({
              ...m,
              from: transaction.mapping.map(m.from, -1),
              to: transaction.mapping.map(m.to, 1),
            }))
            .filter((m) => m.from < m.to && m.to <= docSize);
          this.grammarMatches.set(remapped);
          this.applyDecorations(remapped);
        }
        if (this.grammarPopover()) this.grammarPopover.set(null);
        if (this.grammar.autoEnabled() && this.canAutoGrammar() && this.canCheckGrammar()) {
          this.scheduleGrammarRecheck();
        }
      },
    });
    if (this.grammarHostListener) {
      this.hostRef.nativeElement.removeEventListener('click', this.grammarHostListener);
    }
    this.grammarHostListener = (e) => this.onGrammarHostClick(e);
    this.hostRef.nativeElement.addEventListener('click', this.grammarHostListener);
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
