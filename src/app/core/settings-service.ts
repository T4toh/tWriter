import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { NativeDialogsService } from './native-dialogs-service';
import { GrammarMode } from './types';
import {
  EXCEPCIONES_DEFAULT,
  ExcepcionesDeliberadas,
} from '../repeticiones/detector';

export type EditorWidth = 'narrow' | 'wide' | 'full';
export type ParagraphSpacing = 'tight' | 'normal' | 'loose';
export type RightPanelWidth = 'compact' | 'normal' | 'wide' | 'full';
/** Scope del panel de búsqueda (Ctrl+F). `saga`/`book` se resuelven contra
 *  el capítulo activo del pane principal; si no hay cap, caen a `all`. */
export type SearchScope = 'all' | 'saga' | 'book' | 'notes' | 'chapters' | 'current';
/** Los 4 keywords de preset siguen siendo válidos como valor. Cualquier otro
 *  string se interpreta como nombre de familia (OS o pool del repo). */
export type EditorFontPreset = 'serif' | 'sans' | 'mono' | 'system';
export type EditorFontFamily = string;

const FONT_MIN = 12;
const FONT_MAX = 28;
const FONT_DEFAULT = 17; // Espejado en caret-scrolloff.ts::FALLBACK_FONT_SIZE (import-free por diseño, no puede importar esto).
const SPACING_DEFAULT: ParagraphSpacing = 'tight';
const RIGHT_PANEL_DEFAULT: RightPanelWidth = 'normal';
const SEARCH_SCOPE_DEFAULT: SearchScope = 'all';
const FONT_FAMILY_DEFAULT: EditorFontPreset = 'serif';
const FONT_RECENTS_MAX = 5;
const NOTES_PANE_HEIGHT_DEFAULT = 200;
const NOTES_PANE_HEIGHT_MIN = 80;
const NOTES_PANE_HEIGHT_MAX = 600;

/** Stack CSS para cada preset del editor. Solo el editor; EPUB y UI tienen
 *  su propio CSS y no se ven afectados. */
export const EDITOR_FONT_STACK: Record<EditorFontPreset, string> = {
  serif: "'Merriweather', Georgia, 'Times New Roman', serif",
  sans: "'Lato', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'Roboto Mono', ui-monospace, monospace",
  system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
};

export const EDITOR_FONT_LABEL: Record<EditorFontPreset, string> = {
  serif: 'Serif',
  sans: 'Sans',
  mono: 'Mono',
  system: 'Sistema',
};

export const EDITOR_FONT_PRESETS: ReadonlyArray<EditorFontPreset> = [
  'serif',
  'sans',
  'mono',
  'system',
];

export function isEditorFontPreset(value: string): value is EditorFontPreset {
  return value === 'serif' || value === 'sans' || value === 'mono' || value === 'system';
}

/** Resuelve un valor de `editorFontFamily` al stack CSS final que se aplica
 *  al editor. Preset → stack hardcoded. Cualquier otro string → la familia
 *  envuelta en comillas + fallback serif (para que el editor no rompa si la
 *  fuente no está disponible en la PC actual). */
export function resolveEditorFontStack(value: EditorFontFamily): string {
  if (isEditorFontPreset(value)) return EDITOR_FONT_STACK[value];
  // Cita el nombre para soportar familias con espacios ("EB Garamond").
  return `'${value.replace(/'/g, "\\'")}', ${EDITOR_FONT_STACK.serif}`;
}

/** em entre `<p>` en el editor por nivel. EPUB no se ve afectado — usa su propio CSS. */
export const PARAGRAPH_SPACING_EM: Record<ParagraphSpacing, number> = {
  tight: 0,
  normal: 0.3,
  loose: 0.6,
};

/** Última sesión del pane 0: cap activo + posición absoluta del cursor en el
 *  doc ProseMirror (state.selection.from). Se restaura al boot si el archivo
 *  sigue existiendo. Si `pmPos` cae fuera del doc actual (cap más corto), se
 *  clampea al final. */
export interface LastSession {
  chapterPath: string;
  pmPos: number;
}

export type NotasTab = 'libro' | 'todas';

interface Settings {
  root: string | null;
  editorWidth?: EditorWidth;
  editorFontSize?: number;
  editorFontFamily?: EditorFontFamily;
  editorFontRecents?: string[];
  editorParagraphSpacing?: ParagraphSpacing;
  grammarMode?: GrammarMode;
  grammarCustomUrl?: string | null;
  grammarLtUsername?: string | null;
  grammarVariantEs?: string | null;
  grammarVariantEn?: string | null;
  grammarPicky?: boolean;
  grammarAutoDisabled?: boolean;
  raeAutoDisabled?: boolean;
  repeticionesAutoDisabled?: boolean;
  repeticionesExcepciones?: ExcepcionesDeliberadas;
  rightPanelWidth?: RightPanelWidth;
  searchScope?: SearchScope;
  /** Si está true, cada hit del panel de búsqueda muestra su score BM25 debajo
   *  del título — útil para diagnosticar ranking. Off por default. */
  searchDebug?: boolean;
  /** Modo de búsqueda flojo (fuzzy + acentos): tolera typos y tildes. Off por
   *  default — el default es exacto/literal (sirve para corregir errores). */
  searchFuzzy?: boolean;
  /** Toggle `Aa` del reemplazo: distinguir mayúsculas de minúsculas. */
  replaceCaseSensitive?: boolean;
  /** Toggle `ab` del reemplazo: exigir palabra completa. Default ON — sin
   *  esto, reemplazar `golpear` convierte `golpearon` en `golpeóon`. */
  replaceWholeWord?: boolean;
  lastSession?: LastSession;
  treeExpanded?: string[];
  treeExtrasExpanded?: string[];
  treeExtrasDirsExpanded?: string[];
  treeExportsExpanded?: string[];
  /** Paths expandidos del árbol secundario de notas (variante 'notes'). */
  treeNotesExpanded?: string[];
  /** Panel de notas (segundo árbol) colapsado. */
  notesPaneCollapsed?: boolean;
  /** Alto en px del panel de notas abierto. */
  notesPaneHeight?: number;
  /** Tab activa del panel de notas: 'libro' (notas del libro que se está
   *  escribiendo) o 'todas' (el árbol completo). */
  notasTab?: NotasTab;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private dialogs = inject(NativeDialogsService);
  readonly root = signal<string | null>(null);
  readonly editorWidth = signal<EditorWidth>('narrow');
  readonly editorFontSize = signal<number>(FONT_DEFAULT);
  readonly editorFontFamily = signal<EditorFontFamily>(FONT_FAMILY_DEFAULT);
  readonly editorFontRecents = signal<string[]>([]);
  readonly editorParagraphSpacing = signal<ParagraphSpacing>(SPACING_DEFAULT);
  readonly grammarMode = signal<GrammarMode>('public');
  readonly grammarCustomUrl = signal<string | null>(null);
  readonly grammarLtUsername = signal<string | null>(null);
  readonly grammarVariantEs = signal<string>('es-AR');
  readonly grammarVariantEn = signal<string>('en-US');
  /** `level=picky` en LanguageTool: reglas extra de texto formal. Off por
   *  default — en prosa de novela las oraciones largas son deliberadas, y
   *  además el ruleset picky de LT solo agrega algo en inglés. */
  readonly grammarPicky = signal<boolean>(false);
  /** Auto-check de gramática desactivado por el usuario. Persiste cross-session. */
  readonly grammarAutoDisabled = signal<boolean>(false);
  /** Auto-check del validador RAE desactivado por el usuario. Persiste cross-session. */
  readonly raeAutoDisabled = signal<boolean>(false);
  /** Detector de repeticiones cercanas desactivado por el usuario. */
  readonly repeticionesAutoDisabled = signal<boolean>(false);
  /** Formas de repetición deliberada que se filtran. Las tres prendidas por
   *  default: son legítimas y marcarlas hace ruido. */
  readonly repeticionesExcepciones = signal<ExcepcionesDeliberadas>(EXCEPCIONES_DEFAULT);
  readonly rightPanelWidth = signal<RightPanelWidth>(RIGHT_PANEL_DEFAULT);
  readonly searchScope = signal<SearchScope>(SEARCH_SCOPE_DEFAULT);
  readonly searchDebug = signal<boolean>(false);
  readonly searchFuzzy = signal<boolean>(false);
  readonly replaceCaseSensitive = signal<boolean>(false);
  readonly replaceWholeWord = signal<boolean>(true);
  /** Última sesión del pane 0 al cerrar la app. Null si nunca se abrió un cap
   *  o si el cap se cerró sin reemplazo. */
  readonly lastSession = signal<LastSession | null>(null);
  /** Paths de nodos del tree (saga/libro/sección/folder libre) que estaban
   *  expandidos en la sesión anterior. Apply al cargar el tree. */
  readonly treeExpanded = signal<Set<string>>(new Set());
  readonly treeExtrasExpanded = signal<Set<string>>(new Set());
  /** Keys `<scopePath>::<relPath>` de subdirs Extras expandidos. */
  readonly treeExtrasDirsExpanded = signal<Set<string>>(new Set());
  readonly treeExportsExpanded = signal<Set<string>>(new Set());
  /** Paths expandidos del árbol secundario de notas. Aparte de treeExpanded
   *  para que el árbol principal y el de notas no se pisen al persistir. */
  readonly treeNotesExpanded = signal<Set<string>>(new Set());
  /** Panel de notas (segundo árbol) colapsado. Default false (abierto). */
  readonly notesPaneCollapsed = signal<boolean>(false);
  /** Alto en px del panel de notas cuando está abierto. */
  readonly notesPaneHeight = signal<number>(NOTES_PANE_HEIGHT_DEFAULT);
  /** Tab activa del panel de notas. Default 'libro': escribiendo, lo que se
   *  necesita es la ficha del libro abierto, no el árbol entero. */
  readonly notasTab = signal<NotasTab>('libro');
  readonly focusMode = signal<boolean>(false);
  readonly loaded = signal<boolean>(false);
  /** Timer del persist debounced (cursor moves). */
  private persistDebounceHandle: ReturnType<typeof setTimeout> | null = null;

  async load(): Promise<void> {
    try {
      const s = await invoke<Settings>('get_settings');
      this.root.set(s.root ?? null);
      this.editorWidth.set(s.editorWidth ?? 'narrow');
      this.editorFontSize.set(clampFont(s.editorFontSize ?? FONT_DEFAULT));
      this.editorFontFamily.set(s.editorFontFamily ?? FONT_FAMILY_DEFAULT);
      this.editorFontRecents.set(
        Array.isArray(s.editorFontRecents) ? s.editorFontRecents.slice(0, FONT_RECENTS_MAX) : [],
      );
      this.editorParagraphSpacing.set(s.editorParagraphSpacing ?? SPACING_DEFAULT);
      this.grammarMode.set((s.grammarMode as GrammarMode) ?? 'public');
      this.grammarCustomUrl.set(s.grammarCustomUrl ?? null);
      this.grammarLtUsername.set(s.grammarLtUsername ?? null);
      this.grammarVariantEs.set(s.grammarVariantEs ?? 'es-AR');
      this.grammarVariantEn.set(s.grammarVariantEn ?? 'en-US');
      this.grammarPicky.set(s.grammarPicky ?? false);
      this.grammarAutoDisabled.set(s.grammarAutoDisabled ?? false);
      this.raeAutoDisabled.set(s.raeAutoDisabled ?? false);
      this.repeticionesAutoDisabled.set(s.repeticionesAutoDisabled ?? false);
      this.repeticionesExcepciones.set({
        ...EXCEPCIONES_DEFAULT,
        ...(s.repeticionesExcepciones ?? {}),
      });
      this.rightPanelWidth.set(s.rightPanelWidth ?? RIGHT_PANEL_DEFAULT);
      this.searchScope.set(s.searchScope ?? SEARCH_SCOPE_DEFAULT);
      this.searchDebug.set(s.searchDebug ?? false);
      this.searchFuzzy.set(s.searchFuzzy ?? false);
      this.replaceCaseSensitive.set(s.replaceCaseSensitive ?? false);
      this.replaceWholeWord.set(s.replaceWholeWord ?? true);
      this.lastSession.set(s.lastSession ?? null);
      this.treeExpanded.set(new Set(Array.isArray(s.treeExpanded) ? s.treeExpanded : []));
      this.treeExtrasExpanded.set(
        new Set(Array.isArray(s.treeExtrasExpanded) ? s.treeExtrasExpanded : []),
      );
      this.treeExtrasDirsExpanded.set(
        new Set(Array.isArray(s.treeExtrasDirsExpanded) ? s.treeExtrasDirsExpanded : []),
      );
      this.treeExportsExpanded.set(
        new Set(Array.isArray(s.treeExportsExpanded) ? s.treeExportsExpanded : []),
      );
      this.treeNotesExpanded.set(
        new Set(Array.isArray(s.treeNotesExpanded) ? s.treeNotesExpanded : []),
      );
      this.notesPaneCollapsed.set(s.notesPaneCollapsed ?? false);
      this.notesPaneHeight.set(clampNotesHeight(s.notesPaneHeight ?? NOTES_PANE_HEIGHT_DEFAULT));
      this.notasTab.set(s.notasTab === 'todas' ? 'todas' : 'libro');
    } catch {
      this.root.set(null);
    } finally {
      this.loaded.set(true);
    }
  }

  /** Setter del cursor del pane 0. Debounced 500ms — onSelectionUpdate dispara
   *  por cada keystroke / movimiento, no queremos un write por evento. */
  setLastSession(chapterPath: string, pmPos: number): void {
    const prev = this.lastSession();
    if (prev && prev.chapterPath === chapterPath && prev.pmPos === pmPos) return;
    this.lastSession.set({ chapterPath, pmPos });
    this.persistDebounced();
  }

  clearLastSession(): void {
    if (this.lastSession() === null) return;
    this.lastSession.set(null);
    this.persistDebounced();
  }

  setTreeExpanded(paths: Set<string>): void {
    this.treeExpanded.set(new Set(paths));
    void this.persist();
  }

  setTreeExtrasExpanded(paths: Set<string>): void {
    this.treeExtrasExpanded.set(new Set(paths));
    void this.persist();
  }

  setTreeExtrasDirsExpanded(paths: Set<string>): void {
    this.treeExtrasDirsExpanded.set(new Set(paths));
    void this.persist();
  }

  setTreeExportsExpanded(paths: Set<string>): void {
    this.treeExportsExpanded.set(new Set(paths));
    void this.persist();
  }

  setTreeNotesExpanded(paths: Set<string>): void {
    this.treeNotesExpanded.set(new Set(paths));
    void this.persist();
  }

  setNotasTab(tab: NotasTab): void {
    if (tab === this.notasTab()) return;
    this.notasTab.set(tab);
    void this.persist();
  }

  setNotesPaneCollapsed(collapsed: boolean): void {
    this.notesPaneCollapsed.set(collapsed);
    void this.persist();
  }

  /** Set del alto del panel de notas (clamp). Debounced — el drag del resizer
   *  dispara muchos cambios por segundo. */
  setNotesPaneHeight(px: number): void {
    const next = clampNotesHeight(px);
    if (next === this.notesPaneHeight()) return;
    this.notesPaneHeight.set(next);
    this.persistDebounced();
  }

  /** Schedule un persist debounced 500ms. Acumula múltiples cambios rápidos en
   *  un solo write. */
  private persistDebounced(): void {
    if (this.persistDebounceHandle !== null) {
      clearTimeout(this.persistDebounceHandle);
    }
    this.persistDebounceHandle = setTimeout(() => {
      this.persistDebounceHandle = null;
      void this.persist();
    }, 500);
  }

  /** Fuerza un flush sync del persist debounced. Usado en onCloseRequested
   *  para no perder el último cursor pos pendiente. */
  async flushPending(): Promise<void> {
    if (this.persistDebounceHandle === null) return;
    clearTimeout(this.persistDebounceHandle);
    this.persistDebounceHandle = null;
    await this.persist();
  }

  async setRoot(path: string): Promise<void> {
    this.root.set(path);
    await this.persist();
  }

  async setEditorWidth(width: EditorWidth): Promise<void> {
    this.editorWidth.set(width);
    await this.persist();
  }

  cycleEditorWidth(): void {
    const order: EditorWidth[] = ['narrow', 'wide', 'full'];
    const next = order[(order.indexOf(this.editorWidth()) + 1) % order.length];
    void this.setEditorWidth(next);
  }

  bumpFontSize(delta: number): void {
    const next = clampFont(this.editorFontSize() + delta);
    if (next === this.editorFontSize()) return;
    this.editorFontSize.set(next);
    void this.persist();
  }

  /** Cambia la familia del editor y agrega el valor a la lista de recientes
   *  (unshift + dedupe + truncate a 5). Persiste settings.json. */
  setEditorFontFamily(family: EditorFontFamily): void {
    this.editorFontFamily.set(family);
    const recents = this.editorFontRecents();
    const next = [family, ...recents.filter((f) => f !== family)].slice(0, FONT_RECENTS_MAX);
    this.editorFontRecents.set(next);
    void this.persist();
  }

  cycleParagraphSpacing(): void {
    const order: ParagraphSpacing[] = ['tight', 'normal', 'loose'];
    const next = order[(order.indexOf(this.editorParagraphSpacing()) + 1) % order.length];
    this.editorParagraphSpacing.set(next);
    void this.persist();
  }

  async setGrammarMode(
    mode: GrammarMode,
    customUrl: string | null,
    ltUsername: string | null = null,
  ): Promise<void> {
    this.grammarMode.set(mode);
    this.grammarCustomUrl.set(customUrl);
    this.grammarLtUsername.set(ltUsername);
    await this.persist();
  }

  async setGrammarVariants(es: string, en: string): Promise<void> {
    this.grammarVariantEs.set(es);
    this.grammarVariantEn.set(en);
    await this.persist();
  }

  async setGrammarPicky(picky: boolean): Promise<void> {
    this.grammarPicky.set(picky);
    await this.persist();
  }

  async setGrammarAutoDisabled(disabled: boolean): Promise<void> {
    this.grammarAutoDisabled.set(disabled);
    await this.persist();
  }

  async setRaeAutoDisabled(disabled: boolean): Promise<void> {
    this.raeAutoDisabled.set(disabled);
    await this.persist();
  }

  async setRepeticionesAutoDisabled(disabled: boolean): Promise<void> {
    this.repeticionesAutoDisabled.set(disabled);
    await this.persist();
  }

  async setRepeticionesExcepciones(exc: ExcepcionesDeliberadas): Promise<void> {
    this.repeticionesExcepciones.set(exc);
    await this.persist();
  }

  async setRightPanelWidth(width: RightPanelWidth): Promise<void> {
    this.rightPanelWidth.set(width);
    await this.persist();
  }

  cycleRightPanelWidth(): void {
    const order: RightPanelWidth[] = ['compact', 'normal', 'wide', 'full'];
    const next = order[(order.indexOf(this.rightPanelWidth()) + 1) % order.length];
    void this.setRightPanelWidth(next);
  }

  toggleFocusMode(): void {
    this.focusMode.update((v) => !v);
  }

  async setSearchScope(scope: SearchScope): Promise<void> {
    this.searchScope.set(scope);
    await this.persist();
  }

  async setSearchDebug(enabled: boolean): Promise<void> {
    this.searchDebug.set(enabled);
    await this.persist();
  }

  async setSearchFuzzy(enabled: boolean): Promise<void> {
    this.searchFuzzy.set(enabled);
    await this.persist();
  }

  async setReplaceCaseSensitive(enabled: boolean): Promise<void> {
    this.replaceCaseSensitive.set(enabled);
    await this.persist();
  }

  async setReplaceWholeWord(enabled: boolean): Promise<void> {
    this.replaceWholeWord.set(enabled);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const expanded = Array.from(this.treeExpanded());
    const extrasExp = Array.from(this.treeExtrasExpanded());
    const extrasDirsExp = Array.from(this.treeExtrasDirsExpanded());
    const exportsExp = Array.from(this.treeExportsExpanded());
    const notesExp = Array.from(this.treeNotesExpanded());
    const settings: Settings = {
      root: this.root(),
      editorWidth: this.editorWidth(),
      editorFontSize: this.editorFontSize(),
      editorFontFamily: this.editorFontFamily(),
      editorFontRecents: this.editorFontRecents().length ? this.editorFontRecents() : undefined,
      editorParagraphSpacing: this.editorParagraphSpacing(),
      grammarMode: this.grammarMode(),
      grammarCustomUrl: this.grammarCustomUrl(),
      grammarLtUsername: this.grammarLtUsername(),
      grammarVariantEs: this.grammarVariantEs(),
      grammarVariantEn: this.grammarVariantEn(),
      grammarPicky: this.grammarPicky() || undefined,
      grammarAutoDisabled: this.grammarAutoDisabled(),
      raeAutoDisabled: this.raeAutoDisabled(),
      repeticionesAutoDisabled: this.repeticionesAutoDisabled() || undefined,
      repeticionesExcepciones: this.repeticionesExcepciones(),
      rightPanelWidth: this.rightPanelWidth(),
      searchScope: this.searchScope(),
      searchDebug: this.searchDebug() || undefined,
      searchFuzzy: this.searchFuzzy() || undefined,
      replaceCaseSensitive: this.replaceCaseSensitive() || undefined,
      // OJO: wholeWord es true por default, así que el `|| undefined` de
      // searchFuzzy NO sirve acá — borraría el false.
      replaceWholeWord: this.replaceWholeWord(),
      lastSession: this.lastSession() ?? undefined,
      treeExpanded: expanded.length ? expanded : undefined,
      treeExtrasExpanded: extrasExp.length ? extrasExp : undefined,
      treeExtrasDirsExpanded: extrasDirsExp.length ? extrasDirsExp : undefined,
      treeExportsExpanded: exportsExp.length ? exportsExp : undefined,
      treeNotesExpanded: notesExp.length ? notesExp : undefined,
      notesPaneCollapsed: this.notesPaneCollapsed() || undefined,
      notesPaneHeight: this.notesPaneHeight(),
      notasTab: this.notasTab(),
    };
    await invoke('set_settings', { settings });
  }

  async pickRoot(): Promise<string | null> {
    const result = await this.dialogs.pickFolder({
      title: 'Carpeta raíz de novelas',
      defaultPath: this.root() ?? undefined,
    });
    if (result === null) return null;
    await this.setRoot(result);
    return result;
  }
}

function clampFont(n: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}

function clampNotesHeight(n: number): number {
  return Math.max(NOTES_PANE_HEIGHT_MIN, Math.min(NOTES_PANE_HEIGHT_MAX, Math.round(n)));
}
