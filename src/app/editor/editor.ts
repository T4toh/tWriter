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
import TextAlign from '@tiptap/extension-text-align';
import { ChapterService, PaneId } from '../core/chapter-service';
import { SagaContextService } from '../core/saga-context-service';
import { GrammarService } from '../core/grammar-service';
import { PARAGRAPH_SPACING_EM, SettingsService } from '../core/settings-service';
import { GrammarMatch } from '../core/types';
import { convert as convertRae } from '../dialogos/converter';
import { Landing } from '../landing/landing';
import {
  ContextMenuService,
  CtxMenuEntry,
} from '../shared/context-menu-service';
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
  private ctxMenu = inject(ContextMenuService);

  /** Pane que renderiza este editor. Default 0 = principal. 1 = secundario (split). */
  readonly paneId = input<PaneId>(0);

  @ViewChild('host', { static: true })
  hostRef!: ElementRef<HTMLDivElement>;

  /** Estado del pane que renderiza este editor. */
  private readonly pane = computed(() => this.chapter.panes[this.paneId()]);
  protected readonly active = computed(() => this.pane().active());
  protected readonly canEdit = computed(() => this.pane().canEdit());
  protected readonly wordCount = computed(() => this.pane().wordCount());
  protected readonly dirty = computed(() => this.pane().dirty());
  protected readonly chapterError = computed(() => this.pane().error());
  protected readonly meta = computed(() => this.pane().meta());
  protected readonly state = signal<ToolbarState>(EMPTY_STATE);
  protected readonly rae = signal<{ original: string; converted: string } | null>(null);
  protected readonly importing = this.chapter.importing;
  protected readonly canApplyRae = computed(() => {
    if (!this.canEdit()) return false;
    const lang = this.meta().idioma;
    return lang === null || lang === 'es' || lang === undefined;
  });
  protected readonly canCheckGrammar = computed(() => {
    if (!this.canEdit()) return false;
    if (!this.grammar.available()) return false;
    const lang = this.meta().idioma;
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
  protected readonly paragraphSpacing = this.settings.editorParagraphSpacing;
  protected readonly paragraphSpacingEm = computed(() => PARAGRAPH_SPACING_EM[this.paragraphSpacing()]);
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
  protected readonly paragraphSpacingLabel = computed(() => {
    switch (this.paragraphSpacing()) {
      case 'tight': return 'apretado';
      case 'normal': return 'normal';
      case 'loose': return 'amplio';
    }
  });
  protected readonly paragraphSpacingIcon = computed(() => {
    switch (this.paragraphSpacing()) {
      case 'tight': return '≣';
      case 'normal': return '≡';
      case 'loose': return '☰';
    }
  });

  private viewReady = signal(false);
  private tiptap: TipTapEditor | null = null;
  private lastLoadedAt = 0;
  private grammarHostListener: ((e: MouseEvent) => void) | null = null;
  private grammarDebounceHandle: ReturnType<typeof setTimeout> | null = null;
  private skipNextGrammarRemap = false;
  private lastAutoEnabled = false;
  private lastCheckedPlain: string | null = null;

  constructor() {
    effect(() => {
      const at = this.pane().loadedAt();
      const ready = this.viewReady();
      if (!ready || at === this.lastLoadedAt) {
        return;
      }
      const node = untracked(() => this.pane().active());
      const html = untracked(() => this.pane().content());
      const editable = !!node?.editable;

      // Limpiar las marcas del capítulo anterior antes de cargar el nuevo
      // para que no se vea "todo marcado" durante el round-trip a LT.
      this.grammarMatches.set([]);
      this.applyDecorations([]);
      this.grammarPopover.set(null);
      this.lastCheckedPlain = null;
      if (this.grammarDebounceHandle !== null) {
        clearTimeout(this.grammarDebounceHandle);
        this.grammarDebounceHandle = null;
      }
      this.skipNextGrammarRemap = true;

      if (!this.tiptap) {
        this.createEditor(editable ? html : '', editable);
      } else {
        this.tiptap.commands.setContent(editable ? html : '', { emitUpdate: false });
        this.tiptap.setEditable(editable);
      }
      this.lastLoadedAt = at;
      this.refreshState();

      // Si el auto-check está prendido, lanzar el chequeo del nuevo capítulo
      // de inmediato (sin debounce) para que las marcas reaparezcan rápido y
      // el spinner del botón LT haga el "loading" desde el cambio de archivo.
      if (
        editable &&
        this.grammar.autoEnabled() &&
        this.canAutoGrammar() &&
        this.canCheckGrammar()
      ) {
        void this.checkGrammar();
      }
    });

    // Auto-check de gramática: cuando LT pasa a disponible (y el modo lo
    // permite + el user no lo destrabó), arrancamos solos. Al apagarse,
    // limpiamos las marcas.
    effect(() => {
      const on = this.grammar.autoEnabled();
      if (on === this.lastAutoEnabled) return;
      this.lastAutoEnabled = on;
      if (!this.viewReady() || !this.tiptap) return;
      if (on) {
        if (this.canCheckGrammar()) void this.checkGrammar();
      } else {
        this.grammarMatches.set([]);
        this.applyDecorations([]);
      }
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
      return; // dejá burbujar al handler global de App
    }
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
      { label: 'Pegar como texto plano', kbd: 'Ctrl+Shift+V', onClick: () => this.pastePlain() },
      { label: 'Seleccionar todo', kbd: 'Ctrl+A', onClick: () => this.selectAll() },
    ];
    if (s.hasSelection) {
      entries.push(
        { kind: 'separator' },
        { label: 'Negrita', kbd: 'Ctrl+B', onClick: () => this.toggleBold() },
        { label: 'Itálica', kbd: 'Ctrl+I', onClick: () => this.toggleItalic() },
        { label: 'Subrayado', kbd: 'Ctrl+U', onClick: () => this.toggleUnderline() },
      );
    }
    entries.push(
      { kind: 'separator' },
      { label: 'Salto de escena', kbd: '— —', onClick: () => this.insertSceneBreak() },
    );
    return entries;
  }

  protected toggleBold(): void {
    this.tiptap?.chain().focus().toggleBold().run();
  }

  protected toggleItalic(): void {
    this.tiptap?.chain().focus().toggleItalic().run();
  }

  protected toggleUnderline(): void {
    this.tiptap?.chain().focus().toggleUnderline().run();
  }

  protected setAlign(align: 'left' | 'center' | 'right'): void {
    this.tiptap?.chain().focus().setTextAlign(align).run();
  }

  protected insertSceneBreak(): void {
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
      // permisos denegados o sin texto en clipboard
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

  protected readonly resolvedVariant = computed<string>(() => {
    const idioma = this.meta().idioma;
    if (idioma === 'en') {
      return this.sagaCtx.varianteEn() ?? this.settings.grammarVariantEn();
    }
    if (idioma === 'es') {
      return this.sagaCtx.varianteEs() ?? this.settings.grammarVariantEs();
    }
    return this.sagaCtx.varianteEs() ?? this.settings.grammarVariantEs();
  });

  private static readonly VARIANT_PICKER_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
    { code: 'es-AR', label: 'es-AR — Argentina (voseo)' },
    { code: 'es-ES', label: 'es-ES — España' },
    { code: 'en-US', label: 'en-US — Inglés (US)' },
    { code: 'en-GB', label: 'en-GB — Inglés (UK)' },
  ];

  protected openVariantPicker(event: MouseEvent): void {
    const current = this.resolvedVariant();
    const entries: CtxMenuEntry[] = Editor.VARIANT_PICKER_OPTIONS.map((opt) => ({
      label: opt.label + (opt.code === current ? '  ✓' : ''),
      onClick: () => this.pickVariant(opt.code),
    }));
    this.ctxMenu.open(event, entries);
  }

  private async pickVariant(code: string): Promise<void> {
    const base: 'es' | 'en' = code.startsWith('en') ? 'en' : 'es';
    const current = this.meta().idioma;
    if (current !== base) {
      await this.chapter.setLanguageInPane(base, this.paneId());
    }
    await this.sagaCtx.setVariante(base, code);
    if (this.grammar.autoEnabled() && this.canAutoGrammar()) {
      void this.checkGrammar();
    }
  }

  protected async checkGrammar(force = false): Promise<void> {
    if (!this.tiptap || !this.canCheckGrammar()) return;
    const meta = this.meta().idioma;
    const lang: 'es' | 'en' | 'auto' = meta === 'es' || meta === 'en' ? meta : 'auto';
    const { plain, ranges } = extractPlainText(this.tiptap.state.doc);
    if (!plain.trim()) {
      this.grammarMatches.set([]);
      this.applyDecorations([]);
      this.lastCheckedPlain = '';
      return;
    }
    // Skip si el texto plano no cambió desde el último check (cursor moves,
    // ediciones que no tocan texto, etc). Evita round-trips innecesarios a LT
    // y el costo de re-aplicar decorations.
    if (!force && plain === this.lastCheckedPlain) {
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
      this.lastCheckedPlain = plain;
    } catch {
      // grammar.lastError ya tiene el mensaje
    }
  }

  protected toggleAutoGrammar(): void {
    this.grammar.toggleAuto();
    // El effect en el constructor reacciona al cambio de `autoEnabled` y
    // dispara checkGrammar() o limpia las marcas según corresponda.
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
        this.chapter.updateContentInPane(editor.getHTML(), this.paneId());
      },
      onSelectionUpdate: () => this.refreshState(),
      onTransaction: ({ transaction }) => {
        this.refreshState();
        if (!transaction.docChanged) return;
        if (this.skipNextGrammarRemap) {
          // Transacción inducida por el cambio de capítulo: no remapear,
          // no agendar recheck (el effect ya disparó el check inmediato).
          this.skipNextGrammarRemap = false;
          if (this.grammarPopover()) this.grammarPopover.set(null);
          return;
        }
        if (this.grammarMatches().length > 0) {
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
