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
import { FormsModule } from '@angular/forms';
import {
  LucideCheck,
  LucideCircleAlert,
  LucideDynamicIcon,
  LucideMenu,
  LucideRectangleHorizontal,
  LucideRectangleVertical,
  LucideSquare,
  LucideTextAlignJustify,
  type LucideIcon,
} from '@lucide/angular';
import { invoke } from '@tauri-apps/api/core';
import { Editor as TipTapEditor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Typography from '@tiptap/extension-typography';
import TextAlign from '@tiptap/extension-text-align';
import { ChapterService, PaneId } from '../core/chapter-service';
import { CursorRestoreService } from '../core/cursor-restore-service';
import { SagaContextService } from '../core/saga-context-service';
import { DebugService } from '../core/debug-service';
import { GrammarService } from '../core/grammar-service';
import { SearchService } from '../core/search-service';
import { ToastService } from '../core/toast-service';
import {
  findAllMatchesInPlain,
  highlightFirstMatch,
} from '../core/search-highlight';
import {
  EDITOR_FONT_LABEL,
  EDITOR_FONT_PRESETS,
  PARAGRAPH_SPACING_EM,
  SettingsService,
  isEditorFontPreset,
  resolveEditorFontStack,
} from '../core/settings-service';
import { SystemFontsService } from '../core/system-fonts-service';
import { FontsService } from '../core/fonts-service';
import { Select, SelectGroup, SelectOption } from '../shared/select';
import { GrammarMatch, RaeViolation } from '../core/types';
import { convert as convertRae } from '../dialogos/converter';
import { suggestFromDictionary } from '../dictionary/suggest';
import { educateQuotes } from '../quotes/educate';
import { validateRae } from '../dialogos/validator';
import { Landing } from '../landing/landing';
import { Spinner } from '../shared/spinner';
import {
  ContextMenuService,
  CtxMenuEntry,
} from '../shared/context-menu-service';
import {
  Grammar,
  GrammarMatchPos,
  extractPlainText,
  mapMatchesToPm,
  offsetToPm,
  setGrammarMatches,
} from './grammar-extension';
import { SearchHighlight, setSearchHighlights } from './search-highlight-extension';
import { AnchorBox } from './popover-position';
import { GrammarPopover } from './grammar-popover';
import {
  RaeExtension,
  RaeViolationPos,
  mapViolationsToPm,
  setRaeViolations,
} from './rae-extension';
import { RaePopover } from './rae-popover';

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
  imports: [
    Landing, GrammarPopover, RaePopover, Select, FormsModule,
    LucideCircleAlert, LucideDynamicIcon, Spinner,
  ],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
})
export class Editor implements AfterViewInit, OnDestroy {
  protected chapter = inject(ChapterService);
  protected settings = inject(SettingsService);
  protected grammar = inject(GrammarService);
  protected sagaCtx = inject(SagaContextService);
  protected systemFonts = inject(SystemFontsService);
  private fontsService = inject(FontsService);
  private ctxMenu = inject(ContextMenuService);
  private search = inject(SearchService);
  private cursorRestore = inject(CursorRestoreService);
  private debug = inject(DebugService);
  private toast = inject(ToastService);

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
  protected readonly saving = computed(() => this.pane().saving());
  protected readonly chapterError = computed(() => this.pane().error());
  protected readonly meta = computed(() => this.pane().meta());
  protected readonly state = signal<ToolbarState>(EMPTY_STATE);
  /** Posición del cursor para el footer: número de párrafo (1-based) y columna dentro del párrafo. */
  protected readonly cursorPos = signal<{ paragraph: number; col: number }>({ paragraph: 1, col: 0 });
  protected readonly rae = signal<{ original: string; converted: string } | null>(null);
  protected readonly quotes = signal<{ original: string; converted: string } | null>(null);
  protected readonly importing = this.chapter.importing;
  protected readonly canApplyRae = computed(() => {
    if (!this.canEdit()) return false;
    const lang = this.meta().idioma;
    return lang === null || lang === 'es' || lang === undefined;
  });
  protected readonly canApplyQuotes = computed(() => {
    if (!this.canEdit()) return false;
    return this.meta().idioma === 'en';
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
  protected readonly grammarPopover = signal<{ match: GrammarMatch; anchor: AnchorBox; from: number; to: number; dictSuggestions: string[] } | null>(null);
  protected readonly raeViolations = signal<RaeViolationPos[]>([]);
  protected readonly raePopover = signal<{ violation: RaeViolationPos; anchor: AnchorBox } | null>(null);
  protected readonly raeAuto = computed(() => {
    if (!this.canCheckRae()) return false;
    return !this.settings.raeAutoDisabled();
  });
  protected readonly canCheckRae = computed(() => {
    if (!this.canEdit()) return false;
    const lang = this.meta().idioma;
    return lang === 'es';
  });
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
  protected readonly fontFamily = this.settings.editorFontFamily;
  /** Stack CSS final aplicado al `--editor-font-family`. Para presets, usa el
   *  stack hardcoded; para nombres libres (OS / pool), envuelve la familia
   *  con fallback serif. */
  protected readonly fontStack = computed(() => resolveEditorFontStack(this.fontFamily()));
  /** Label legible para el trigger del dropdown: nombre del preset o la
   *  familia tal cual. */
  protected readonly fontFamilyLabel = computed(() => {
    const v = this.fontFamily();
    return isEditorFontPreset(v) ? EDITOR_FONT_LABEL[v] : v;
  });
  /** True si la familia configurada no es preset ni está en el OS ni en el
   *  pool del repo (típico al sincronizar settings entre PCs con distintas
   *  fuentes instaladas). El footer muestra un badge informativo. */
  protected readonly fontMissing = computed<string | null>(() => {
    const v = this.fontFamily();
    if (isEditorFontPreset(v)) return null;
    // Esperar a que ambos catálogos estén cargados antes de declarar la
    // fuente como faltante. Sin esto, al abrir el editor aparecía el badge
    // hasta que el dropdown se abriera y disparara el lazy-load.
    if (!this.systemFonts.loaded()) return null;
    const root = this.settings.root();
    if (root && !this.fontsService.hasLoaded(root)) return null;
    if (this.systemFonts.has(v)) return null;
    if (this.poolFamilies().some((p) => p.family === v)) return null;
    return v;
  });
  /** Fuentes del tema resuelto (saga/libro) para el capítulo activo. Se
   *  populan al cambiar `active()`. Vacío si el chapter no tiene tema
   *  aplicado o no pertenece a un libro. */
  protected readonly themeFonts = signal<{
    bodyFont?: string;
    headingFont?: string;
    editorialBodyFont?: string;
    editorialHeadingFont?: string;
  } | null>(null);
  /** Pool del repo deduplicado por familia. Cada item conserva el path de uno
   *  de sus faces (cualquiera sirve para registrar FontFace). */
  protected readonly poolFamilies = computed(() => {
    const root = this.settings.root();
    if (!root) return [] as Array<{ family: string; path: string }>;
    const entries = this.fontsService.get(root);
    const seen = new Map<string, string>();
    for (const e of entries) {
      if (!seen.has(e.family)) seen.set(e.family, e.path);
    }
    return Array.from(seen.entries()).map(([family, path]) => ({ family, path }));
  });
  /** Grupos para el `<app-select>` del toolbar. Recientes (filtra a familias
   *  válidas ahora) + Presets + Pool del repo + Sistema. Vacíos se ocultan. */
  protected readonly fontGroups = computed<SelectGroup[]>(() => {
    const groups: SelectGroup[] = [];
    const recents = this.settings.editorFontRecents();
    const sys = this.systemFonts.fonts();
    const pool = this.poolFamilies();
    const sysIndex = new Map(sys.map((f) => [f.family, f]));
    const poolIndex = new Map(pool.map((p) => [p.family, p.path]));

    if (recents.length > 0) {
      const items: SelectOption[] = [];
      for (const v of recents) {
        if (isEditorFontPreset(v)) {
          items.push({ value: v, label: EDITOR_FONT_LABEL[v] });
        } else if (poolIndex.has(v)) {
          items.push({
            value: v,
            label: v,
            data: { fontFamily: v, path: poolIndex.get(v) },
          });
        } else if (sysIndex.has(v)) {
          items.push({ value: v, label: v, data: { fontFamily: v } });
        }
      }
      if (items.length > 0) groups.push({ label: 'Recientes', options: items });
    }

    // Tema activo del capítulo (saga/libro). Sugiere body/heading para que el
    // autor pueda ver mientras escribe cómo va a verse en el EPUB exportado.
    // Si la fuente ya está en pool o sistema, el data lleva el path para que
    // el preview renderee en la propia tipografía; sino label plano.
    const theme = this.themeFonts();
    if (theme) {
      const seen = new Set<string>();
      const items: SelectOption[] = [];
      const push = (family: string | undefined, role: string): void => {
        if (!family || seen.has(family)) return;
        seen.add(family);
        const pathFromPool = poolIndex.get(family);
        const inSys = sysIndex.has(family);
        if (!pathFromPool && !inSys) {
          // Familia referenciada por el tema pero no instalada — la mostramos
          // igual para que el usuario sepa qué se va a usar en el EPUB.
        }
        items.push({
          value: family,
          label: `${role}: ${family}`,
          data: {
            fontFamily: family,
            path: pathFromPool ?? (inSys ? sysIndex.get(family)!.path : undefined),
          },
        });
      };
      push(theme.bodyFont, 'Cuerpo');
      push(theme.headingFont, 'Títulos');
      push(theme.editorialBodyFont, 'Editorial');
      if (items.length > 0) groups.push({ label: 'Del tema', options: items });
    }

    groups.push({
      label: 'Presets',
      options: EDITOR_FONT_PRESETS.map((p) => ({
        value: p,
        label: EDITOR_FONT_LABEL[p],
      })),
    });

    if (pool.length > 0) {
      const items = pool
        .map((p) => ({
          value: p.family,
          label: p.family,
          data: { fontFamily: p.family, path: p.path },
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      groups.push({ label: 'Pool del repo', options: items });
    }

    if (sys.length > 0) {
      const items = sys.map((f) => ({
        value: f.family,
        label: f.family,
        data: { fontFamily: f.family, path: f.path },
      }));
      groups.push({ label: `Sistema (${sys.length})`, options: items });
    }
    return groups;
  });
  protected readonly paragraphSpacing = this.settings.editorParagraphSpacing;
  protected readonly paragraphSpacingEm = computed(() => PARAGRAPH_SPACING_EM[this.paragraphSpacing()]);
  protected readonly widthLabel = computed(() => {
    switch (this.width()) {
      case 'narrow': return 'página';
      case 'wide': return 'ancho';
      case 'full': return 'lleno';
    }
  });
  protected readonly widthIcon = computed<LucideIcon>(() => {
    switch (this.width()) {
      case 'narrow': return LucideRectangleVertical;
      case 'wide': return LucideRectangleHorizontal;
      case 'full': return LucideSquare;
    }
  });
  protected readonly paragraphSpacingLabel = computed(() => {
    switch (this.paragraphSpacing()) {
      case 'tight': return 'apretado';
      case 'normal': return 'normal';
      case 'loose': return 'amplio';
    }
  });
  protected readonly paragraphSpacingIcon = computed<LucideIcon>(() => {
    switch (this.paragraphSpacing()) {
      case 'tight': return LucideTextAlignJustify;
      case 'normal': return LucideTextAlignJustify;
      case 'loose': return LucideMenu;
    }
  });

  private viewReady = signal(false);
  private tiptap: TipTapEditor | null = null;
  private lastLoadedAt = 0;
  private grammarHostListener: ((e: MouseEvent) => void) | null = null;
  private raeHostListener: ((e: MouseEvent) => void) | null = null;
  private popoverScrollListener: (() => void) | null = null;
  private grammarDebounceHandle: ReturnType<typeof setTimeout> | null = null;
  private raeDebounceHandle: ReturnType<typeof setTimeout> | null = null;
  private skipNextGrammarRemap = false;
  private skipNextRaeRemap = false;
  private lastGrammarUserDisabled = false;
  private lastGrammarAvailable = false;
  private lastCheckedPlain: string | null = null;
  private lastRaePlain: string | null = null;
  private lastRaeAuto = false;

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
      this.raeViolations.set([]);
      this.applyRaeDecorations([]);
      this.raePopover.set(null);
      this.lastRaePlain = null;
      if (this.grammarDebounceHandle !== null) {
        clearTimeout(this.grammarDebounceHandle);
        this.grammarDebounceHandle = null;
      }
      if (this.raeDebounceHandle !== null) {
        clearTimeout(this.raeDebounceHandle);
        this.raeDebounceHandle = null;
      }
      this.skipNextGrammarRemap = true;
      this.skipNextRaeRemap = true;

      if (!this.tiptap) {
        this.createEditor(editable ? html : '', editable);
      } else {
        this.tiptap.commands.setContent(editable ? html : '', { emitUpdate: false });
        // OJO: `setEditable(editable)` por default emite "update" (TipTap v3
        // `setEditable(editable, emitUpdate = true)`). Eso dispara onUpdate
        // → updateContentInPane → como el HTML canónico que TipTap mantiene
        // tras setContent difiere del HTML del disco (newlines/whitespace
        // dentro de bloques colapsados), el pane se marca `dirty` y autosave
        // pisa el archivo aunque el usuario no haya editado nada. Suprimir
        // el emit pasando `false`.
        this.tiptap.setEditable(editable, false);
      }
      // Adoptar el HTML canónico que TipTap mantiene en memoria como
      // baseline del pane. El archivo en disco puede tener formato
      // pretty-printed (newlines/whitespace dentro de bloques) que TipTap
      // colapsa al parsear; sin este reset, cualquier transacción posterior
      // que dispare `onUpdate` compararía el canónico vs el HTML del disco
      // y marcaría `dirty` aunque el usuario no haya editado nada.
      if (editable && this.tiptap) {
        this.chapter.setBaselineInPane(this.tiptap.getHTML(), this.paneId());
      }
      // El scroller (.editor-host) conserva su scrollTop entre capítulos, así
      // que al cambiar de archivo el usuario aparecía donde había dejado al
      // anterior. Reset explícito al tope. Si hay un highlight pendiente de
      // Ctrl+F, el setTimeout de abajo scrollea al match después.
      this.hostRef.nativeElement.scrollTop = 0;
      this.lastLoadedAt = at;
      this.refreshState();

      // Restaurar cursor (solo pane 0) si bootstrap encoló un pedido para este
      // path. Va antes del highlight de Ctrl+F: el highlight prevalece sobre la
      // posición guardada cuando el usuario llega via search.
      // NOTA: NO scrollIntoView — la vista arranca arriba (scrollTop=0 ya seteado).
      // Si cerrabas con el cursor al final, antes el cap reabría al final.
      // Ahora cursor preserva posición pero la vista muestra el inicio.
      if (this.tiptap) {
        const restore =
          node?.path && this.paneId() === 0 ? this.cursorRestore.consume(node.path) : null;
        if (restore) {
          const docSize = this.tiptap.state.doc.content.size;
          // Clamp si el cap se acortó entre sesiones (editado en otra PC).
          const pos = Math.max(0, Math.min(restore.pmPos, Math.max(0, docSize - 1)));
          this.tiptap
            .chain()
            .focus(undefined, { scrollIntoView: false })
            .setTextSelection({ from: pos, to: pos })
            .run();
          // Re-asegurar el reset (el focus puede haber gatillado scroll del browser
          // si el cursor cayó fuera del viewport visible).
          this.hostRef.nativeElement.scrollTop = 0;
        } else {
          // Navegación normal sin posición guardada. Tras setContent la
          // selección de ProseMirror puede quedar en un boundary de nodo y el
          // navegador dibuja un caret fantasma flotando en el margen superior
          // ("arriba del todo donde no hay nada"). Forzar selección a pos 1
          // (dentro del primer bloque de texto) la deja en una posición válida.
          // Sin .focus(): si el editor no tiene foco no se dibuja caret alguno.
          this.tiptap.commands.setTextSelection(1);
          this.hostRef.nativeElement.scrollTop = 0;
        }
      }

      // Si hay un highlight pendiente para este capítulo (viene de Ctrl+F),
      // saltar al primer match. setTimeout 0 para esperar el flush del DOM.
      if (node?.path) {
        const pending = this.search.consumePendingHighlight(node.path);
        if (pending) {
          setTimeout(() => {
            highlightFirstMatch(this.hostRef.nativeElement, pending.terms, pending.rawQuery, pending.fold);
          }, 0);
        }
      }

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
      if (editable && this.raeAuto()) {
        this.checkRae();
      }
    });

    // Toggle manual del usuario para auto-gramática. Reaccionamos SOLO al
    // toggle explícito (`grammarAutoDisabled`), NO a `autoEnabled` — porque
    // este último incluye `available`, y si LT cae transitoriamente no
    // queremos borrarle las marcas al usuario. Las marcas viejas quedan
    // visibles hasta que LT vuelva (el ping de recovery del service lo
    // detecta) y el siguiente check las reemplace.
    effect(() => {
      const userDisabled = this.settings.grammarAutoDisabled();
      if (userDisabled === this.lastGrammarUserDisabled) return;
      this.lastGrammarUserDisabled = userDisabled;
      if (!this.viewReady() || !this.tiptap) return;
      if (!userDisabled) {
        if (this.canCheckGrammar()) void this.checkGrammar();
      } else {
        this.grammarMatches.set([]);
        this.applyDecorations([]);
      }
    });

    // Recovery: cuando LT pasa de caído a disponible (polling del service o
    // ping manual lo detectó), disparamos un check para repoblar marcas. Solo
    // reaccionamos a la transición false→true. La transición true→false NO
    // borra marcas — quedan stale hasta que LT vuelva, por la razón del
    // effect de arriba.
    effect(() => {
      const avail = this.grammar.available();
      if (avail === this.lastGrammarAvailable) return;
      this.lastGrammarAvailable = avail;
      if (!avail) return;
      if (!this.viewReady() || !this.tiptap) return;
      if (this.canCheckGrammar()) void this.checkGrammar();
    });

    // Re-filtrado en vivo cuando el diccionario de la saga cambia. Caso
    // típico: al abrir un cap, `checkGrammar` corre antes de que
    // `SagaContextService.resolve` termine de cargar `saga.json`, así que
    // palabras propias del mundo aparecen marcadas como typo aunque estén
    // en el diccionario. Cuando el dict resuelve (o el usuario agrega una
    // palabra nueva), filtramos los TYPOS actuales contra el dict nuevo
    // sin volver a pegarle a LanguageTool.
    effect(() => {
      const dict = this.sagaCtx.dictionary();
      if (!this.viewReady() || !this.tiptap) return;
      const current = untracked(() => this.grammarMatches());
      if (current.length === 0) return;
      const editor = this.tiptap;
      const filtered = current.filter((m) => {
        if (m.category !== 'TYPOS') return true;
        const word = editor.state.doc.textBetween(m.from, m.to, ' ').trim();
        return !dict.has(word.toLowerCase());
      });
      if (filtered.length !== current.length) {
        this.grammarMatches.set(filtered);
        this.applyDecorations(filtered);
      }
    });

    // Tema activo del chapter: cuando cambia el path del capítulo activo,
    // resuelve las fuentes heredadas (root theme + saga overrides + book
    // overrides) y las expone vía signal `themeFonts` para que el dropdown
    // del editor las muestre en el grupo "Del tema".
    effect(() => {
      const node = this.active();
      const root = this.settings.root();
      if (!node?.path || !root) {
        this.themeFonts.set(null);
        return;
      }
      const path = node.path;
      void invoke<{
        bodyFont?: string;
        headingFont?: string;
        editorialBodyFont?: string;
        editorialHeadingFont?: string;
      }>('get_chapter_theme_fonts', { chapterPath: path, rootPath: root })
        .then((res) => {
          if (this.active()?.path !== path) return;
          const has =
            res.bodyFont || res.headingFont || res.editorialBodyFont || res.editorialHeadingFont;
          this.themeFonts.set(has ? res : null);
        })
        .catch(() => {
          this.themeFonts.set(null);
        });
    });

    // Resalto de todas las ocurrencias de la query mientras el panel de
    // búsqueda esté abierto. Reactivo a query + active path + edits del
    // doc (loadedAt + cualquier transacción remapea las decoraciones). Solo
    // pinta si el search apunta a este pane (vía `activeFile().path`) — si el
    // usuario abrió Ctrl+F desde otro pane, este no se mueve ni decora.
    effect(() => {
      const terms = this.search.highlightTerms();
      const node = this.active();
      // Touch loadedAt para re-aplicar cuando se reemplaza el contenido.
      this.pane().loadedAt();
      if (!this.viewReady() || !this.tiptap) return;
      const activeFile = this.search.activeFile();
      const matchesPane = !!node && !!activeFile && activeFile.path === node.path;
      if (!terms || !node || !matchesPane) {
        this.applySearchDecorations([]);
        return;
      }
      this.recomputeSearchDecorations(terms.terms, terms.rawQuery, terms.fold);
    });

    // Pending highlight (scroll-to-match) cuando el archivo YA está abierto.
    // El consume del loadedAt-effect maneja el caso recién-cargado; este
    // cubre el caso "click en hit del mismo archivo abierto" donde no hay
    // recarga ni nuevo loadedAt.
    effect(() => {
      const pending = this.search.pendingHighlight();
      const node = this.active();
      if (!pending || !node || pending.path !== node.path) return;
      if (!this.viewReady() || !this.tiptap) return;
      const consumed = this.search.consumePendingHighlight(node.path);
      if (!consumed) return;
      setTimeout(() => {
        highlightFirstMatch(this.hostRef.nativeElement, consumed.terms, consumed.rawQuery, consumed.fold);
      }, 0);
    });

    // Auto-check RAE: igual patrón. Si el toggle está prendido y el capítulo
    // es ES, marca. Si se apaga, limpia.
    effect(() => {
      const on = this.raeAuto();
      if (on === this.lastRaeAuto) return;
      this.lastRaeAuto = on;
      if (!this.viewReady() || !this.tiptap) return;
      if (on) {
        // Force=true porque el plain no cambió entre toggle-off y toggle-on;
        // sin force, checkRae() vería `plain === lastRaePlain` y skipearía,
        // dejando el editor sin decoraciones.
        this.checkRae(true);
      } else {
        this.raeViolations.set([]);
        this.applyRaeDecorations([]);
        this.raePopover.set(null);
        this.lastRaePlain = null;
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady.set(true);
    void this.grammar.ping();
    // Eager load del catálogo de fuentes (OS + pool del root) para que
    // `fontMissing` resuelva al boot sin esperar a que el usuario abra el
    // dropdown. Sin esto, el badge "⚠ fuente" aparecía hasta el primer open.
    void this.systemFonts.ensureLoaded();
    const root = this.settings.root();
    if (root && !this.fontsService.hasLoaded(root)) {
      void this.fontsService.refresh(root);
    }
  }

  ngOnDestroy(): void {
    if (this.grammarHostListener) {
      this.hostRef.nativeElement.removeEventListener('click', this.grammarHostListener);
      this.grammarHostListener = null;
    }
    if (this.raeHostListener) {
      this.hostRef.nativeElement.removeEventListener('click', this.raeHostListener);
      this.raeHostListener = null;
    }
    if (this.popoverScrollListener) {
      this.hostRef.nativeElement.removeEventListener('scroll', this.popoverScrollListener);
      this.popoverScrollListener = null;
    }
    if (this.grammarDebounceHandle !== null) {
      clearTimeout(this.grammarDebounceHandle);
      this.grammarDebounceHandle = null;
    }
    if (this.raeDebounceHandle !== null) {
      clearTimeout(this.raeDebounceHandle);
      this.raeDebounceHandle = null;
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

  /** Lazy load del listado del OS + pool en la primera apertura del dropdown
   *  para evitar bloquear el boot con ~400ms de enumeración fontconfig. */
  protected async onFontDropdownOpen(): Promise<void> {
    void this.systemFonts.ensureLoaded();
    const root = this.settings.root();
    if (root && !this.fontsService.hasLoaded(root)) {
      void this.fontsService.refresh(root);
    }
  }

  /** Aplicado al hover dentro del dropdown: registra la FontFace de la
   *  familia (solo no-presets) para que el preview del nombre renderee en
   *  la propia tipografía. Idempotente. */
  protected onFontItemHover(opt: SelectOption): void {
    const data = opt.data as { fontFamily?: string; path?: string } | undefined;
    if (!data?.fontFamily || !data.path) return;
    void this.systemFonts.loadFace(data.fontFamily, data.path);
  }

  protected onFontSelect(family: string): void {
    if (!family) return;
    this.settings.setEditorFontFamily(family);
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

  protected openQuotes(): void {
    if (!this.tiptap || !this.canApplyQuotes()) return;
    const original = this.tiptap.getHTML();
    const result = educateQuotes(original);
    this.quotes.set({ original, converted: result.text });
  }

  protected acceptQuotes(): void {
    const m = this.quotes();
    if (!m || !this.tiptap) return;
    this.tiptap.commands.setContent(m.converted, { emitUpdate: true });
    this.quotes.set(null);
  }

  protected cancelQuotes(): void {
    this.quotes.set(null);
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
      label: opt.label,
      icon: opt.code === current ? LucideCheck : undefined,
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
      const positioned = mapMatchesToPm(
        matches,
        ranges,
        this.tiptap.state.doc,
        plain,
        (info) => {
          this.debug.warn(
            'grammar:offset',
            `mismatch lt=${info.ltOffset}+${info.ltLength} pm=${info.from}..${info.to}`,
            JSON.stringify({ expected: info.expected, actual: info.actual }),
          );
        },
      );
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
    // Trace de offsets: lo que ProseMirror tiene en `popover.from..to` vs lo
    // que LT pidió desde su plain (`popover.match.offset+length`). Si difieren,
    // el squiggle está sobre la palabra equivocada (bug intermitente, README).
    const { plain } = extractPlainText(this.tiptap.state.doc);
    const ltSlice = plain.slice(
      popover.match.offset,
      popover.match.offset + popover.match.length,
    );
    const pmSlice = this.tiptap.state.doc.textBetween(popover.from, popover.to, '\n');
    this.debug.info(
      'grammar:offset',
      `popover-apply from=${popover.from} to=${popover.to} drift=${ltSlice !== pmSlice}`,
      JSON.stringify({
        matchId: dismissedId,
        ltOffset: popover.match.offset,
        ltLength: popover.match.length,
        ltSlice,
        pmSlice,
        replacement,
        category: popover.match.category,
      }),
    );
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
    const result = await this.sagaCtx.addToDictionary(word);
    if (!result.ok) {
      this.toast.error(result.reason ?? 'No se pudo agregar al diccionario');
      this.grammarPopover.set(null);
      return;
    }
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

  private applySearchDecorations(ranges: { from: number; to: number }[]): void {
    const view = (this.tiptap as unknown as { view?: { dispatch: (tr: unknown) => void; state: { tr: unknown } } } | null)?.view;
    if (!view) return;
    setSearchHighlights(view, ranges);
  }

  private recomputeSearchDecorations(terms: string[], rawQuery: string, fold: boolean): void {
    if (!this.tiptap) return;
    const { plain, ranges } = extractPlainText(this.tiptap.state.doc);
    if (!plain) {
      this.applySearchDecorations([]);
      return;
    }
    const hits = findAllMatchesInPlain(plain, terms, rawQuery, fold);
    const positioned: { from: number; to: number }[] = [];
    for (const h of hits) {
      const from = offsetToPm(h.start, ranges);
      const to = offsetToPm(h.end, ranges);
      if (from === null || to === null || to <= from) continue;
      positioned.push({ from, to });
    }
    this.applySearchDecorations(positioned);
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

  protected toggleAutoRae(): void {
    void this.settings.setRaeAutoDisabled(!this.settings.raeAutoDisabled());
  }

  protected checkRae(force = false): void {
    if (!this.tiptap || !this.canCheckRae()) return;
    const { plain, ranges } = extractPlainText(this.tiptap.state.doc);
    if (!plain.trim()) {
      this.raeViolations.set([]);
      this.applyRaeDecorations([]);
      this.lastRaePlain = '';
      return;
    }
    if (!force && plain === this.lastRaePlain) return;
    const lang = this.meta().idioma;
    const raw: RaeViolation[] = validateRae(plain, lang);
    const positioned = mapViolationsToPm(raw, ranges, this.tiptap.state.doc);
    this.raeViolations.set(positioned);
    this.applyRaeDecorations(positioned);
    this.lastRaePlain = plain;
  }

  protected applyRaeFix(): void {
    const popover = this.raePopover();
    if (!popover || !this.tiptap) return;
    const v = popover.violation;
    if (!v.autoFix || v.fixFrom === undefined || v.fixTo === undefined) return;
    this.tiptap
      .chain()
      .focus()
      .setTextSelection({ from: v.fixFrom, to: v.fixTo })
      .insertContent(v.autoFix.replacement)
      .run();
    this.raePopover.set(null);
    this.raeViolations.update((list) => list.filter((m) => m.id !== v.id));
    this.applyRaeDecorations(this.raeViolations());
    if (this.raeAuto()) this.scheduleRaeRecheck();
  }

  protected applyRaeParagraph(): void {
    const popover = this.raePopover();
    if (!popover || !this.tiptap) return;
    const v = popover.violation;
    if (v.paragraphFrom === undefined || v.paragraphTo === undefined) return;
    if (!v.autoFix) return;
    this.tiptap
      .chain()
      .focus()
      .setTextSelection({ from: v.paragraphFrom, to: v.paragraphTo })
      .insertContent(v.autoFix.replacement)
      .run();
    this.raePopover.set(null);
    this.raeViolations.update((list) => list.filter((m) => m.id !== v.id));
    this.applyRaeDecorations(this.raeViolations());
    if (this.raeAuto()) this.scheduleRaeRecheck();
  }

  protected dismissRae(): void {
    this.raePopover.set(null);
  }

  private applyRaeDecorations(violations: RaeViolationPos[]): void {
    const view = (this.tiptap as unknown as { view?: { dispatch: (tr: unknown) => void; state: { tr: unknown } } } | null)?.view;
    if (!view) return;
    setRaeViolations(view, violations);
  }

  private scheduleRaeRecheck(): void {
    if (this.raeDebounceHandle !== null) {
      clearTimeout(this.raeDebounceHandle);
    }
    this.raeDebounceHandle = setTimeout(() => {
      this.raeDebounceHandle = null;
      this.checkRae();
    }, 1500);
  }

  private onRaeHostClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const span = target?.closest('.rae-violation') as HTMLElement | null;
    if (!span) {
      if (this.raePopover()) this.raePopover.set(null);
      return;
    }
    const idx = parseInt(span.dataset['raeIdx'] ?? '-1', 10);
    const v = this.raeViolations()[idx];
    if (!v) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = span.getBoundingClientRect();
    this.raePopover.set({
      violation: v,
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
    });
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
    // El diccionario de la saga hasta ahora solo silenciaba falsos positivos.
    // Para los TYPOS también aporta candidatos: si el autor escribió mal un
    // nombre propio del mundo, LT nunca lo va a ofrecer.
    const word = this.tiptap?.state.doc.textBetween(m.from, m.to, ' ').trim() ?? '';
    const dictSuggestions =
      m.category === 'TYPOS' && word.length > 0
        ? suggestFromDictionary(word, this.sagaCtx.dictionaryWords(), 3).filter(
            (s) => !m.replacements.some((r) => r.toLowerCase() === s.toLowerCase()),
          )
        : [];
    this.grammarPopover.set({
      match: m,
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
      from: m.from,
      to: m.to,
      dictSuggestions,
    });
  }

  private createEditor(content: string, editable: boolean): void {
    this.tiptap = new TipTapEditor({
      element: this.hostRef.nativeElement,
      extensions: [
        StarterKit.configure({
          link: { autolink: false, openOnClick: false },
          // Gap cursor produce un marker vertical en zonas vacías del editor
          // (bug visible: caret huérfano arriba/al costado del texto).
          // Para novela no aporta — desactivado.
          gapcursor: false,
        }),
        Typography,
        TextAlign.configure({ types: ['paragraph', 'heading'] }),
        Grammar,
        RaeExtension,
        SearchHighlight,
      ],
      content,
      editable,
      // El OS no opina sobre el texto: sin corrector, sin autocorrección y sin
      // autocapitalización. Las comillas y rayas las hace Typography de TipTap.
      // Explícito acá además de heredado desde <html> como defensa en
      // profundidad: si algo intermedio (extensión, wrapper, un `<iframe>`)
      // rompiera la herencia de esos atributos, este bloque los repone.
      editorProps: {
        attributes: {
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          autocomplete: 'off',
          'data-gramm': 'false',
          'data-gramm_editor': 'false',
        },
      },
      // NO autofocus 'end': forzaba el cursor al final del cap al abrir (y
      // pisaba la restauración de posición). La posición se restaura abajo
      // vía cursorRestore; sin posición guardada arranca al inicio.
      autofocus: false,
      onUpdate: ({ editor }) => {
        this.chapter.updateContentInPane(editor.getHTML(), this.paneId());
      },
      onSelectionUpdate: () => {
        this.refreshState();
        // Marca este editor como la superficie con foco para search 'current'
        // y resaltado. Solo el pane 0 cuenta — el split secundario no debe
        // robarle foco al principal al cambiar de selección.
        if (this.paneId() === 0) this.search.setFocused('chapter');
      },
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

        if (this.skipNextRaeRemap) {
          this.skipNextRaeRemap = false;
          if (this.raePopover()) this.raePopover.set(null);
        } else {
          if (this.raeViolations().length > 0) {
            const docSize = transaction.doc.content.size;
            const remappedRae = this.raeViolations()
              .map((v) => ({
                ...v,
                from: transaction.mapping.map(v.from, -1),
                to: transaction.mapping.map(v.to, 1),
                fixFrom: v.fixFrom !== undefined ? transaction.mapping.map(v.fixFrom, -1) : undefined,
                fixTo: v.fixTo !== undefined ? transaction.mapping.map(v.fixTo, 1) : undefined,
                paragraphFrom: v.paragraphFrom !== undefined ? transaction.mapping.map(v.paragraphFrom, -1) : undefined,
                paragraphTo: v.paragraphTo !== undefined ? transaction.mapping.map(v.paragraphTo, 1) : undefined,
              }))
              .filter((v) => v.from < v.to && v.to <= docSize);
            this.raeViolations.set(remappedRae);
            this.applyRaeDecorations(remappedRae);
          }
          if (this.raePopover()) this.raePopover.set(null);
          if (this.raeAuto()) this.scheduleRaeRecheck();
        }
      },
    });
    if (this.grammarHostListener) {
      this.hostRef.nativeElement.removeEventListener('click', this.grammarHostListener);
    }
    this.grammarHostListener = (e) => this.onGrammarHostClick(e);
    this.hostRef.nativeElement.addEventListener('click', this.grammarHostListener);
    if (this.raeHostListener) {
      this.hostRef.nativeElement.removeEventListener('click', this.raeHostListener);
    }
    this.raeHostListener = (e) => this.onRaeHostClick(e);
    this.hostRef.nativeElement.addEventListener('click', this.raeHostListener);
    if (this.popoverScrollListener) {
      this.hostRef.nativeElement.removeEventListener('scroll', this.popoverScrollListener);
    }
    // Los popovers son position:fixed y no siguen al scroll: si el capítulo se
    // mueve, quedarían flotando lejos del span que los abrió.
    this.popoverScrollListener = () => {
      if (this.grammarPopover()) this.grammarPopover.set(null);
      if (this.raePopover()) this.raePopover.set(null);
    };
    this.hostRef.nativeElement.addEventListener('scroll', this.popoverScrollListener, { passive: true });
  }

  private refreshState(): void {
    const e = this.tiptap;
    if (!e) {
      this.state.set(EMPTY_STATE);
      this.cursorPos.set({ paragraph: 1, col: 0 });
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
    this.cursorPos.set(computeCursorPos(e));
    // Persist sesión: solo pane 0 (split secundario no se restaura al boot).
    // SettingsService debounce 500ms + early-return-if-equal mantiene el costo
    // bajo aun con onSelectionUpdate + onTransaction disparando seguido.
    if (this.paneId() === 0) {
      const node = this.pane().active();
      if (node?.path) {
        this.settings.setLastSession(node.path, from);
      }
    }
  }
}

function computeCursorPos(e: TipTapEditor): { paragraph: number; col: number } {
  const { $from } = e.state.selection;
  // Top-level depth = 0 (el doc). Cualquier nodo a depth 1 es bloque
  // top-level (paragraph, blockquote, heading, hr). Contamos cuántos vienen
  // antes para el número de párrafo, 1-based.
  let paragraph = 1;
  if ($from.depth >= 1) {
    const top = $from.before(1);
    e.state.doc.descendants((node, pos) => {
      if (pos >= top) return false;
      if (node.isBlock) paragraph++;
      return false; // solo top-level
    });
  }
  // Columna dentro del bloque que contiene al cursor (offset en chars).
  const col = $from.depth >= 1 ? $from.parentOffset : 0;
  return { paragraph, col };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
