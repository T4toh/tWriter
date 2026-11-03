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
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorProps } from '@tiptap/pm/view';
import { LucideChevronDown, LucideFilePen } from '@lucide/angular';
import { NotificacionesBell } from '../notificaciones/notificaciones-bell';
import { PaneId } from '../core/chapter-service';
import { CursorRestoreService } from '../core/cursor-restore-service';
import { GrammarService } from '../core/grammar-service';
import { NoteService } from '../core/note-service';
import { SagaContextService } from '../core/saga-context-service';
import { SearchService } from '../core/search-service';
import {
  PARAGRAPH_SPACING_EM,
  SettingsService,
  resolveEditorFontStack,
} from '../core/settings-service';
import { TesauroService } from '../core/tesauro-service';
import { ToastService } from '../core/toast-service';
import { RespuestaTesauro } from '../core/types';
import { suggestFromDictionary } from '../dictionary/suggest';
import { buildEditorProps } from '../editor/editor-props';
import { withFreshHistory } from '../editor/fresh-history';
import {
  Grammar,
  GrammarMatchPos,
  TextRange,
  mapMatchesToPm,
  setGrammarMatches,
} from '../editor/grammar-extension';
import { GrammarPopover } from '../editor/grammar-popover';
import { palabraEn } from '../editor/palabra-en';
import { AnchorBox } from '../editor/popover-position';
import { RepeticionesPopover } from '../editor/repeticiones-popover';
import { atajo } from '../shared/atajo';
import { ContextMenuService, CtxMenuEntry } from '../shared/context-menu-service';
import { vistaMenu } from '../shared/vista-menu';
import {
  GuionTeclas,
  Linea,
  Resaltado,
  docDesdeLineas,
  lineasDesdeDoc,
} from './guion-extensiones';
import { partirLineas, partirPegado, unirLineas } from './lineas';
import { textoParaCorregir } from './texto-para-corregir';

/** Una palabra del documento con su rango, para consultarle el tesauro. */
interface ObjetivoTesauro {
  from: number;
  to: number;
  palabra: string;
}

/** Mismo debounce que el editor de capítulos. */
const GRAMMAR_DEBOUNCE_MS = 2000;

/**
 * Editor de guion: texto plano, un nodo por línea, resaltado del formato de
 * escenas del juego. Mismo pane y mismo `NoteService` que las notas (autosave,
 * dirty, cierre); lo que cambia es que acá no hay Markdown: lo que se guarda es
 * `lineasDesdeDoc(doc).join('\n')`, idéntico a lo que se abrió salvo lo que el
 * autor tocó.
 *
 * El corrector es el mismo LanguageTool de los capítulos, pero solo sobre lo
 * hablado (`textoParaCorregir`): nombres, gestos, instrucciones y comentarios
 * no van nunca. El diccionario es el de la carpeta marcada (`SagaContextService`
 * con `guionDir`). Spec: `docs/superpowers/specs/2026-11-03-editor-de-guion-design.md`.
 */
@Component({
  selector: 'app-guion-editor',
  imports: [LucideChevronDown, LucideFilePen, NotificacionesBell, GrammarPopover, RepeticionesPopover],
  templateUrl: './guion-editor.html',
  styleUrl: './guion-editor.scss',
})
export class GuionEditor implements AfterViewInit, OnDestroy {
  protected readonly atajo = atajo;
  protected note = inject(NoteService);
  protected settings = inject(SettingsService);
  protected grammar = inject(GrammarService);
  private sagaCtx = inject(SagaContextService);
  private tesauro = inject(TesauroService);
  private toast = inject(ToastService);
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
  protected readonly width = this.settings.editorWidth;
  protected readonly fontSize = this.settings.editorFontSize;
  protected readonly fontStack = computed(() =>
    resolveEditorFontStack(this.settings.editorFontFamily()),
  );
  protected readonly paragraphSpacingEm = computed(
    () => PARAGRAPH_SPACING_EM[this.settings.editorParagraphSpacing()],
  );
  protected readonly canUndo = signal(false);
  protected readonly canRedo = signal(false);
  protected readonly hasSelection = signal(false);

  // ── Gramática ──
  protected readonly grammarMatches = signal<GrammarMatchPos[]>([]);
  protected readonly grammarPopover = signal<{
    match: GrammarMatchPos;
    anchor: AnchorBox;
    from: number;
    to: number;
    dictSuggestions: string[];
  } | null>(null);
  protected readonly grammarChecking = this.grammar.checking;
  protected readonly grammarError = this.grammar.lastError;
  /** Modo público: el texto hablado viaja a api.languagetool.org. Mismo aviso
   *  que el editor de capítulos. */
  private readonly grammarUsed = signal(false);
  private readonly grammarBannerDismissed = signal(false);
  protected readonly showPrivacyBanner = computed(
    () => this.grammar.mode() === 'public' && this.grammarUsed() && !this.grammarBannerDismissed(),
  );
  private grammarDebounceHandle: ReturnType<typeof setTimeout> | null = null;
  private lastCheckedPlain = '';

  // ── Tesauro ──
  protected readonly repPopover = signal<{
    palabra: string;
    anchor: AnchorBox;
    from: number;
    to: number;
  } | null>(null);
  protected readonly repResultado = signal<RespuestaTesauro | null>(null);

  private viewReady = signal(false);
  private tiptap: TipTapEditor | null = null;
  private lastLoadedAt = 0;

  constructor() {
    effect(() => {
      const at = this.pane().loadedAt();
      if (!this.viewReady() || at === this.lastLoadedAt) return;
      const texto = untracked(() => this.pane().content());
      const target = untracked(() => this.pane().active());
      const editable = !!target;
      const doc = docDesdeLineas(partirLineas(texto));
      this.cerrarPopovers();
      this.grammarMatches.set([]);
      this.lastCheckedPlain = '';
      if (!this.tiptap) {
        this.createEditor(doc, editable);
      } else {
        this.tiptap.commands.setContent(doc, { emitUpdate: false });
        this.tiptap.setEditable(editable, false);
        // Ctrl+Z no cruza de un archivo al otro (ver fresh-history.ts).
        this.tiptap.view.updateState(withFreshHistory(this.tiptap.state));
      }
      this.hostRef.nativeElement.scrollTop = 0;
      this.lastLoadedAt = at;
      this.refreshState();
      // El diccionario del guion: solo el pane principal manda.
      if (this.paneId() === 0) this.sagaCtx.guionDir.set(target?.guion ?? null);

      if (target?.path && this.paneId() === 0 && this.tiptap) {
        const restore = this.cursorRestore.consume(target.path);
        if (restore) {
          const docSize = this.tiptap.state.doc.content.size;
          const pos = Math.max(0, Math.min(restore.pmPos, Math.max(0, docSize - 1)));
          this.tiptap
            .chain()
            .focus(undefined, { scrollIntoView: false })
            .setTextSelection({ from: pos, to: pos })
            .run();
          this.hostRef.nativeElement.scrollTop = 0;
        }
      }
      if (editable) this.scheduleGrammarRecheck();
    });

    effect(() => {
      const fontSizePx = this.fontSize();
      const editor = this.tiptap;
      if (!editor) return;
      editor.setOptions({ editorProps: this.props(editor.view.dom, fontSizePx) });
    });
  }

  ngAfterViewInit(): void {
    this.viewReady.set(true);
  }

  ngOnDestroy(): void {
    if (this.grammarDebounceHandle !== null) clearTimeout(this.grammarDebounceHandle);
    if (this.paneId() === 0) this.sagaCtx.guionDir.set(null);
    this.tiptap?.destroy();
    this.tiptap = null;
  }

  /** `buildEditorProps` devuelve todo (`setOptions` reemplaza la key entera),
   *  así que lo propio del guion se suma acá en cada reaplicación. */
  private props(dom: HTMLElement | null, fontSizePx: number): EditorProps {
    return {
      ...buildEditorProps(dom, fontSizePx),
      // Pegar: siempre texto plano, una `linea` por renglón, con las líneas
      // vacías intactas (el formato separa toques con renglones en blanco; el
      // parser de clipboard de ProseMirror las colapsaría).
      handlePaste: (_view, event) => {
        const texto = event.clipboardData?.getData('text/plain');
        if (!texto) return false;
        this.pegarTexto(texto);
        return true;
      },
      // Copiar: líneas con un solo `\n` entre medio, no el `\n\n` por defecto.
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n'),
    };
  }

  /** Inserta texto plano como líneas: la primera y la última se funden con
   *  la línea del cursor (slice abierto en las dos puntas), las del medio
   *  son líneas enteras. Es lo que usan Ctrl+V y «Pegar» del menú. */
  private pegarTexto(texto: string): void {
    const editor = this.tiptap;
    if (!editor) return;
    const { schema, tr } = editor.state;
    const nodos = partirPegado(texto).map((l) =>
      schema.nodes['linea'].create(null, l ? schema.text(l) : null),
    );
    editor.view.dispatch(tr.replaceSelection(new Slice(Fragment.from(nodos), 1, 1)).scrollIntoView());
  }

  private createEditor(doc: ReturnType<typeof docDesdeLineas>, editable: boolean): void {
    this.tiptap = new TipTapEditor({
      element: this.hostRef.nativeElement,
      extensions: [
        // Solo documento, texto y undo: el guion es texto plano.
        StarterKit.configure({
          blockquote: false,
          bold: false,
          bulletList: false,
          code: false,
          codeBlock: false,
          dropcursor: false,
          gapcursor: false,
          hardBreak: false,
          heading: false,
          horizontalRule: false,
          italic: false,
          link: false,
          listItem: false,
          listKeymap: false,
          orderedList: false,
          paragraph: false,
          strike: false,
          trailingNode: false,
          underline: false,
        }),
        Linea,
        GuionTeclas,
        Resaltado,
        Grammar,
      ],
      content: doc,
      editable,
      editorProps: this.props(null, untracked(() => this.fontSize())),
      autofocus: editable && this.paneId() === 0 ? 'end' : false,
      onUpdate: ({ editor }) => {
        this.note.updateContentInPane(unirLineas(lineasDesdeDoc(editor.state.doc)), this.paneId());
        this.scheduleGrammarRecheck();
      },
      onSelectionUpdate: () => {
        this.refreshState();
        if (this.paneId() === 0) this.search.setFocused('note');
      },
      onTransaction: () => this.refreshState(),
    });
    const editor = this.tiptap;
    editor.setOptions({
      editorProps: this.props(editor.view.dom, untracked(() => this.fontSize())),
    });
  }

  // ───── Gramática ─────

  private scheduleGrammarRecheck(): void {
    if (!this.grammar.autoEnabled() || !this.grammar.canAutoCheck()) return;
    if (this.grammarDebounceHandle !== null) clearTimeout(this.grammarDebounceHandle);
    this.grammarDebounceHandle = setTimeout(() => {
      this.grammarDebounceHandle = null;
      void this.checkGrammar();
    }, GRAMMAR_DEBOUNCE_MS);
  }

  protected revisarGramatica(): void {
    void this.checkGrammar(true);
  }

  /** Manda a LT solo lo hablado y mapea las marcas de vuelta al doc. */
  private async checkGrammar(force = false): Promise<void> {
    const editor = this.tiptap;
    if (!editor || !this.active()) return;
    if (!this.grammar.available()) {
      // Que el autor sepa por qué no pasa nada: el ping recalibra `available`
      // y, si LT sigue caído, el chip del footer abre la configuración.
      if (force) void this.grammar.ping();
      return;
    }
    const doc = editor.state.doc;
    const lineas = lineasDesdeDoc(doc);
    const { plain, tramos } = textoParaCorregir(lineas);
    if (!plain) {
      this.aplicarMarcas([]);
      this.lastCheckedPlain = '';
      return;
    }
    if (!force && plain === this.lastCheckedPlain) return;
    const posDeLinea: number[] = [];
    doc.forEach((_linea, offset) => posDeLinea.push(offset));
    const ranges: TextRange[] = tramos.map((t) => ({
      plainStart: t.plainStart,
      plainEnd: t.plainEnd,
      pmPos: posDeLinea[t.linea] + 1 + t.desde,
    }));
    this.grammarUsed.set(true);
    try {
      const matches = await this.grammar.check(plain, 'es');
      // Si el autor siguió escribiendo, los offsets ya no valen.
      if (!this.tiptap || this.tiptap.state.doc !== doc) {
        this.scheduleGrammarRecheck();
        return;
      }
      const positioned = mapMatchesToPm(matches, ranges, doc, plain);
      const filtered = positioned.filter((m) => {
        if (m.category !== 'TYPOS') return true;
        return !this.sagaCtx.isInDictionary(plain.slice(m.offset, m.offset + m.length));
      });
      this.aplicarMarcas(filtered);
      this.lastCheckedPlain = plain;
    } catch {
      // grammar.lastError ya tiene el mensaje
    }
  }

  private aplicarMarcas(matches: GrammarMatchPos[]): void {
    this.grammarMatches.set(matches);
    if (this.tiptap) {
      setGrammarMatches(this.tiptap.view as unknown as Parameters<typeof setGrammarMatches>[0], matches);
    }
  }

  protected onHostClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const span = target?.closest('.grammar-error') as HTMLElement | null;
    const idx = span ? parseInt(span.dataset['grammarIdx'] ?? '-1', 10) : -1;
    const match = idx >= 0 ? this.grammarMatches()[idx] : undefined;
    if (match) {
      event.preventDefault();
      event.stopPropagation();
      this.abrirPopoverGramatica(match);
      return;
    }
    this.cerrarPopovers();
  }

  private abrirPopoverGramatica(m: GrammarMatchPos): void {
    this.cerrarPopovers();
    const word = this.tiptap?.state.doc.textBetween(m.from, m.to, ' ').trim() ?? '';
    const dictSuggestions =
      m.category === 'TYPOS' && word.length > 0
        ? suggestFromDictionary(word, this.sagaCtx.dictionaryWords(), 3).filter(
            (s) => !m.replacements.some((r) => r.toLowerCase() === s.toLowerCase()),
          )
        : [];
    this.grammarPopover.set({ match: m, anchor: this.anchorAt(m.from), from: m.from, to: m.to, dictSuggestions });
  }

  protected applyGrammarReplacement(replacement: string): void {
    const popover = this.grammarPopover();
    const editor = this.tiptap;
    if (!popover || !editor) return;
    const { from, to } = popover;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(replacement, from, to);
        return true;
      })
      .run();
    this.quitarMarca(popover.match.id);
    this.grammarPopover.set(null);
    this.scheduleGrammarRecheck();
  }

  protected dismissGrammarMatch(): void {
    const popover = this.grammarPopover();
    if (!popover) return;
    this.quitarMarca(popover.match.id);
    this.grammarPopover.set(null);
  }

  protected async addCurrentToDictionary(): Promise<void> {
    const popover = this.grammarPopover();
    const editor = this.tiptap;
    if (!popover || !editor) return;
    const word = editor.state.doc.textBetween(popover.from, popover.to, ' ').trim();
    if (!word) return;
    const result = await this.sagaCtx.addToDictionary(word);
    this.grammarPopover.set(null);
    if (!result.ok) {
      this.toast.error(result.reason ?? 'No se pudo agregar al diccionario');
      return;
    }
    this.aplicarMarcas(
      this.grammarMatches().filter((m) => {
        if (m.category !== 'TYPOS') return true;
        const w = editor.state.doc.textBetween(m.from, m.to, ' ').trim();
        return w.toLowerCase() !== word.toLowerCase();
      }),
    );
  }

  protected disableRuleNoAplica(): void {
    this.toast.info('Las reglas se desactivan por saga; en un guion no aplica.');
    this.grammarPopover.set(null);
  }

  protected dismissPrivacyBanner(): void {
    this.grammarBannerDismissed.set(true);
  }

  protected openGrammarConfig(): void {
    this.grammar.pedirConfig();
  }

  private quitarMarca(id: string): void {
    this.aplicarMarcas(this.grammarMatches().filter((m) => m.id !== id));
  }

  private anchorAt(pos: number): AnchorBox {
    const c = this.tiptap!.view.coordsAtPos(pos);
    return { left: c.left, top: c.top, bottom: c.bottom };
  }

  private cerrarPopovers(): void {
    this.grammarPopover.set(null);
    this.repPopover.set(null);
    this.repResultado.set(null);
  }

  // ───── Tesauro ─────

  private palabraEnPos(pos: number): ObjetivoTesauro | null {
    const editor = this.tiptap;
    if (!editor) return null;
    const $pos = editor.state.doc.resolve(pos);
    if (!$pos.parent.isTextblock) return null;
    const limites = palabraEn($pos.parent.textContent, $pos.parentOffset);
    if (!limites) return null;
    const inicio = $pos.start();
    const from = inicio + limites.inicio;
    const to = inicio + limites.fin;
    const palabra = editor.state.doc.textBetween(from, to, ' ').trim();
    return palabra.length > 0 ? { from, to, palabra } : null;
  }

  private abrirTesauro(objetivo: ObjetivoTesauro): void {
    this.cerrarPopovers();
    this.repPopover.set({
      palabra: objetivo.palabra,
      anchor: this.anchorAt(objetivo.from),
      from: objetivo.from,
      to: objetivo.to,
    });
    void this.cargarSinonimos(objetivo.palabra);
  }

  private async cargarSinonimos(palabra: string): Promise<void> {
    const res = await this.tesauro.lookup(palabra, 'es');
    if (this.repPopover()?.palabra !== palabra) return;
    this.repResultado.set(res);
  }

  protected reemplazarSinonimo(sinonimo: string): void {
    const popover = this.repPopover();
    const editor = this.tiptap;
    if (!popover || !editor || sinonimo.trim().length === 0) return;
    const original = popover.palabra;
    // Si la palabra abría oración va con mayúscula, y el sinónimo del tesauro
    // viene siempre en minúscula.
    const reemplazo =
      original.charAt(0) === original.charAt(0).toUpperCase() &&
      original.charAt(0) !== original.charAt(0).toLowerCase()
        ? sinonimo.charAt(0).toUpperCase() + sinonimo.slice(1)
        : sinonimo;
    const { from, to } = popover;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(reemplazo, from, to);
        return true;
      })
      .run();
    this.cerrarPopovers();
  }

  protected dismissTesauro(): void {
    this.cerrarPopovers();
  }

  // ───── Menú contextual y edición ─────

  protected onContextMenu(event: MouseEvent): void {
    const editor = this.tiptap;
    if (!editor) return;
    this.refreshState();
    const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
    this.ctxMenu.open(event, this.buildEditorItems(at ? this.palabraEnPos(at.pos) : null));
  }

  private buildEditorItems(tesauro: ObjetivoTesauro | null): CtxMenuEntry[] {
    const entries: CtxMenuEntry[] = [
      { label: 'Deshacer', kbd: atajo('Z'), disabled: !this.canUndo(), onClick: () => this.undo() },
      { label: 'Rehacer', kbd: atajo('Z', true), disabled: !this.canRedo(), onClick: () => this.redo() },
      { kind: 'separator' },
      { label: 'Cortar', kbd: atajo('X'), disabled: !this.hasSelection(), onClick: () => void this.cut() },
      { label: 'Copiar', kbd: atajo('C'), disabled: !this.hasSelection(), onClick: () => void this.copy() },
      { label: 'Pegar', kbd: atajo('V'), onClick: () => void this.paste() },
      { label: 'Seleccionar todo', kbd: atajo('A'), onClick: () => this.selectAll() },
    ];
    if (tesauro) {
      entries.push(
        { kind: 'separator' },
        { label: `Sinónimos de «${tesauro.palabra}»`, onClick: () => this.abrirTesauro(tesauro) },
      );
    }
    return entries;
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
      const texto = await navigator.clipboard.readText();
      this.tiptap.commands.focus();
      this.pegarTexto(texto);
    } catch {
      // permisos / sin texto
    }
  }
  private async copySelection(): Promise<void> {
    const e = this.tiptap;
    if (!e) return;
    const { from, to } = e.state.selection;
    if (from === to) return;
    try {
      await navigator.clipboard.writeText(e.state.doc.textBetween(from, to, '\n'));
    } catch {
      // ignorar
    }
  }
  protected selectAll(): void {
    this.tiptap?.chain().focus().selectAll().run();
  }
  protected openViewMenu(event: MouseEvent): void {
    this.ctxMenu.openBelow(event, vistaMenu(this.settings));
  }
  protected fontBump(delta: number): void {
    this.settings.bumpFontSize(delta);
  }

  private refreshState(): void {
    const e = this.tiptap;
    if (!e) return;
    const { from, to, empty } = e.state.selection;
    this.canUndo.set(e.can().undo());
    this.canRedo.set(e.can().redo());
    this.hasSelection.set(!empty && from !== to);
    if (this.paneId() === 0) {
      const node = this.pane().active();
      if (node?.path) this.settings.setLastSession(node.path, from);
    }
  }
}
