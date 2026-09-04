import { Component, ViewChild, computed, effect, HostListener, inject, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ChapterService } from './core/chapter-service';
import { CursorRestoreService } from './core/cursor-restore-service';
import { DebugService } from './core/debug-service';
import { FontPreviewService } from './core/font-preview-service';
import { MarkdownReaderService } from './core/markdown-reader-service';
import { NoteService } from './core/note-service';
import { GitError, GitService } from './core/git-service';
import { StorageService } from './core/storage-service';
import { StorageHelpService } from './core/storage-help-service';
import { GrammarService } from './core/grammar-service';
import { ImageViewerService } from './core/image-viewer-service';
import { ImportJoplinService } from './core/import-joplin-service';
import { ImportWizardService } from './core/import-wizard-service';
import { PaneSplitService } from './core/pane-split-service';
import { ProjectService } from './core/project-service';
import { RaeAuditService } from './core/rae-audit-service';
import { RustLogBridge } from './core/rust-log-bridge';
import { SearchService } from './core/search-service';
import { APP_FONT_VAR, AppFontSlot, resolveAppFontStack } from './core/app-fonts';
import { SettingsService } from './core/settings-service';
import { ToastService } from './core/toast-service';
import { UpdaterService } from './core/updater-service';
import { Tree } from './tree/tree';
import { Editor } from './editor/editor';
import { NotesEditor } from './notes-editor/notes-editor';
import { DebugPanel } from './debug/debug-panel';
import { BookConfigModal } from './book-config/book-config-modal';
import { RevisionLibroModal } from './revision-libro/revision-libro-modal';
import { SagaConfigModal } from './saga-config/saga-config-modal';
import { DictionaryModal } from './dictionary/dictionary-modal';
import { SplitChapterModal } from './split-chapter/split-chapter-modal';
import { NoteFormModal } from './note-form/note-form-modal';
import { ThemeEditorModal } from './theme-editor/theme-editor-modal';
import { ImageViewer } from './image-viewer/image-viewer';
import { FontPreview } from './font-preview/font-preview';
import { MarkdownReader } from './markdown-reader/markdown-reader';
import { SearchPanel } from './search-panel/search-panel';
import { RaeAuditPanel } from './rae-audit/rae-audit-panel';
import { ToastContainer } from './toast/toast-container';
import { SettingsModal } from './settings-modal/settings-modal';
import { ImportJoplin } from './import-joplin/import-joplin';
import { ImportWizard } from './import-wizard/import-wizard';
import { UpdateBanner } from './update-banner/update-banner';
import { StorageHelpModal } from './storage-help/storage-help-modal';
import { AboutModal } from './about/about-modal';
import { AutorModal } from './autor/autor-modal';
import { AboutService } from './core/about-service';
import { Spinner } from './shared/spinner';
import { ModalHost } from './shared/modal-host';
import { ModalService } from './shared/modal-service';
import { ContextMenuHost } from './shared/context-menu-host';
import { ContextMenuService } from './shared/context-menu-service';
import { NodeActionsService } from './shared/node-actions-service';
import { TreeNode } from './core/types';
import { atajo } from './shared/atajo';
import {
  LucideArrowDownToLine,
  LucideArrowUpDown,
  LucideInfo,
  LucideChevronDown,
  LucideChevronRight,
  LucideCircleQuestionMark,
  LucideDownload,
  LucideDynamicIcon,
  LucideFolder,
  LucideHouse,
  LucideMoveHorizontal,
  LucideMoveVertical,
  LucideNotebook,
  LucideNotebookPen,
  LucidePlus,
  LucideRefreshCw,
  LucideSearch,
  LucideSettings,
  LucideX,
} from '@lucide/angular';

@Component({
  selector: 'app-root',
  imports: [
    Tree, Editor, NotesEditor, DebugPanel, BookConfigModal, RevisionLibroModal, SagaConfigModal, DictionaryModal, SplitChapterModal,
    NoteFormModal, ThemeEditorModal, ImageViewer, FontPreview, MarkdownReader, SearchPanel, RaeAuditPanel, ToastContainer,
    SettingsModal, ImportWizard, ImportJoplin, UpdateBanner, StorageHelpModal, AboutModal, AutorModal, Spinner, ModalHost, ContextMenuHost,
    LucideArrowDownToLine, LucideArrowUpDown, LucideChevronDown, LucideChevronRight,
    LucideCircleQuestionMark, LucideDownload, LucideDynamicIcon, LucideFolder, LucideHouse, LucideMoveHorizontal,
    LucideMoveVertical, LucideNotebook, LucideNotebookPen, LucidePlus, LucideRefreshCw,
    LucideSearch, LucideSettings, LucideX, LucideInfo,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  /** Etiquetas de atajos por plataforma (⌘ en Mac). Ver `shared/atajo.ts`. */
  protected readonly atajo = atajo;
  @ViewChild(SettingsModal) private settingsModal?: SettingsModal;
  protected importWizard = inject(ImportWizardService);
  protected importJoplin = inject(ImportJoplinService);
  protected imageViewer = inject(ImageViewerService);
  protected fontPreview = inject(FontPreviewService);
  protected markdownReader = inject(MarkdownReaderService);
  protected search = inject(SearchService);
  protected raeAudit = inject(RaeAuditService);

  private project = inject(ProjectService);
  protected settings = inject(SettingsService);
  private about = inject(AboutService);
  protected chapter = inject(ChapterService);
  protected note = inject(NoteService);
  private cursorRestore = inject(CursorRestoreService);
  protected git = inject(GitService);
  protected storage = inject(StorageService);
  protected storageHelp = inject(StorageHelpService);
  protected debug = inject(DebugService);
  protected paneSplit = inject(PaneSplitService);
  private grammar = inject(GrammarService);
  private updater = inject(UpdaterService);
  private modal = inject(ModalService);
  private ctxMenu = inject(ContextMenuService);
  private nodeActions = inject(NodeActionsService);
  private toast = inject(ToastService);

  protected readonly dragOverCenter = signal<boolean>(false);

  /** Activo mientras corre el flushAndSync del close-handler. Cuando es true
   *  el overlay "Subiendo cambios…" tapa la UI. */
  protected readonly closing = signal<boolean>(false);
  protected readonly closingMessage = signal<string>('Subiendo cambios…');

  /** Debounce del blur: solo dispara push si el blur dura >30s. Si el user
   *  vuelve a la ventana antes, se cancela. */
  private blurDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly BLUR_DEBOUNCE_MS = 30_000;
  /** Cooldown: tras un push exitoso, no re-pushear por blur durante 2min
   *  (evita ruido por alt-tab corto + push reciente). */
  private readonly BLUR_PUSH_COOLDOWN_MS = 120_000;

  protected readonly saving = computed(
    () =>
      this.chapter.panes[0].saving() ||
      this.chapter.panes[1].saving() ||
      this.note.panes[0].saving() ||
      this.note.panes[1].saving(),
  );
  protected readonly bulkProgress = this.chapter.bulkProgress;

  private lastChapterErr: string | null = null;
  private lastNoteErr: string | null = null;
  private lastProjectErr: string | null = null;
  private lastGitErr: GitError | null = null;

  protected readonly root = this.project.root;

  /** True si cualquier pane del editor (capítulos o notas) tiene dirty=true,
   *  o sea hay cambios tipeados todavía sin escribir al disco. Permite al
   *  dot del header reaccionar al primer keystroke sin esperar al autosave
   *  (1.5s) + refresh post-write. */
  protected readonly anyEditorDirty = computed<boolean>(
    () =>
      this.chapter.panes[0].dirty() ||
      this.chapter.panes[1].dirty() ||
      this.note.panes[0].dirty() ||
      this.note.panes[1].dirty(),
  );

  /** Estado efectivo que ve la UI. Mezcla `git.state()` con el dirty del
   *  editor: si git dice clean pero hay buffer dirty, mostramos pending
   *  para que el indicador no mienta entre keystroke y autosave. */
  protected readonly effectiveSyncState = computed(() => {
    const gs = this.git.state();
    if (gs === 'clean' && this.anyEditorDirty()) return 'pending';
    return gs;
  });

  /** Resumen para el header. Cuando hay dirty editor pero git todavía no se
   *  enteró (entre keystroke y refresh post-autosave), mostrar "cambios sin
   *  guardar" en vez de "sincronizado". */
  protected readonly effectiveSyncSummary = computed(() => {
    const gs = this.git.state();
    if (gs === 'clean' && this.anyEditorDirty()) {
      return 'cambios sin guardar';
    }
    return this.git.summary();
  });

  protected readonly syncTitle = computed(() => {
    const s = this.effectiveSyncState();
    const summary = this.effectiveSyncSummary();
    const err = this.git.error();
    if (err) return `Error: ${err.friendly}`;
    switch (s) {
      case 'syncing': return 'Sincronizando…';
      case 'pending': return summary + ' — click para sincronizar';
      case 'clean': return summary;
      case 'offline': return 'Sin conexión — los cambios quedan locales';
      case 'error': return `Error: ${err ? (err as GitError).friendly : 'desconocido'}`;
      default: return 'Estado desconocido';
    }
  });

  constructor() {
    inject(RustLogBridge);
    void this.bootstrap();
    void this.bindCloseFlush();
    void this.bindFocusSync();
    effect(() => {
      const e = this.chapter.panes[0].error() ?? this.chapter.panes[1].error();
      if (e && e !== this.lastChapterErr) this.debug.error('chapter', e);
      this.lastChapterErr = e;
    });
    effect(() => {
      const e = this.note.panes[0].error() ?? this.note.panes[1].error();
      if (e && e !== this.lastNoteErr) this.debug.error('note', e);
      this.lastNoteErr = e;
    });
    // El chequeo de gramática falló y el ping confirmó que LT no responde:
    // abrir el modal de config, que es donde está el remedio (estado del
    // runtime, botón de arranque, modo/URL). Antes fallaba silencioso con un
    // string en el footer.
    effect(() => {
      if (this.grammar.pedidoDeConfig() === 0) return;
      this.settingsModal?.show('gramatica');
    });
    // Las tres fuentes de la app van al `<html>`, no a un elemento de acá
    // adentro: `body { font-family: var(--font-ui) }` está por ENCIMA de
    // `<app-root>`, así que una custom property seteada más abajo no lo
    // alcanza y la mitad de la UI se quedaría con la fuente vieja. `null`
    // borra la property para que gane el default de `styles.scss` — no se
    // reescribe el stack default acá, que se desincronizaría solo.
    effect(() => {
      const root = document.documentElement;
      for (const slot of ['ui', 'body', 'mono'] as AppFontSlot[]) {
        const stack = resolveAppFontStack(slot, this.settings.appFont(slot));
        if (stack) root.style.setProperty(APP_FONT_VAR[slot], stack);
        else root.style.removeProperty(APP_FONT_VAR[slot]);
      }
    });
    // Mutex per-pane: cuando se abre un capítulo en un pane, la nota del MISMO pane se cierra.
    effect(() => {
      if (this.chapter.panes[0].active()) this.note.closeInPane(0);
    });
    effect(() => {
      if (this.chapter.panes[1].active()) this.note.closeInPane(1);
    });
    // Mutex reader vs notes-editor central: si la misma nota se abre en un
    // pane central, el reader del panel derecho cierra (flush si dirty).
    effect(() => {
      const readerPath = this.markdownReader.viewing()?.path;
      if (!readerPath) return;
      const inPane0 = this.note.panes[0].active()?.path === readerPath;
      const inPane1 = this.note.panes[1].active()?.path === readerPath;
      if (inPane0 || inPane1) this.markdownReader.close();
    });
    // Mutex del panel derecho tri-direccional: image / font preview / md reader
    // no conviven; quien abre, cierra a los otros.
    effect(() => {
      if (this.imageViewer.viewing()) {
        this.fontPreview.close();
        this.markdownReader.close();
      }
    });
    effect(() => {
      if (this.fontPreview.viewing()) {
        this.imageViewer.close();
        this.markdownReader.close();
      }
    });
    effect(() => {
      if (this.markdownReader.viewing()) {
        this.imageViewer.close();
        this.fontPreview.close();
        this.search.hide();
      }
    });
    // Mutex: search panel cierra image/font. El md-reader NO — la cadena
    // `@else if` del panel derecho ya prioriza la búsqueda, así que la nota
    // queda oculta pero viva y reaparece al cerrar el panel. Cerrarla acá era
    // destructivo justo en el flujo de corrección (la lista de cosas por
    // arreglar vive en una nota, se busca la frase, se arregla, y para el ítem
    // siguiente había que volver a abrir la nota a mano). El `search.hide()`
    // del efecto inverso se queda: clickear un hit de nota tiene que mostrar la
    // nota, y sin eso quedaría tapada por la búsqueda. No hay ping-pong porque
    // ese efecto depende de `viewing()`, que no cambia cuando la búsqueda abre.
    effect(() => {
      if (this.search.open()) {
        this.imageViewer.close();
        this.fontPreview.close();
      }
    });
    effect(() => {
      const e = this.project.error();
      if (e && e !== this.lastProjectErr) this.debug.error('project', e);
      this.lastProjectErr = e;
    });
    effect(() => {
      const e = this.git.error();
      if (e && e !== this.lastGitErr) {
        this.debug.error('git', `${e.friendly}\n${e.raw}`);
      }
      this.lastGitErr = e;
    });
  }

  private async bootstrap(): Promise<void> {
    await this.settings.load();
    if (this.settings.root()) {
      await this.project.loadTree();
      await this.restoreLastSession();
    }
    setTimeout(() => void this.updater.chequear(), 5000);
  }

  /** Abre el último cap/nota del pane 0 y encola el cursor restore para el
   *  editor / notes-editor que lo va a recibir. Si el path quedó dangling
   *  (cap borrado/renombrado entre sesiones), limpia el slot. */
  private async restoreLastSession(): Promise<void> {
    const ls = this.settings.lastSession();
    if (!ls) return;
    const tree = this.project.tree();
    if (!tree) return;
    const node = findNodeByPath(tree, ls.chapterPath);
    if (!node || (node.kind !== 'chapter' && node.kind !== 'note')) {
      this.settings.clearLastSession();
      return;
    }
    if (node.kind === 'chapter' && !node.editable) {
      // .docx/.odt sin .html sibling — no se puede abrir hasta importar.
      this.settings.clearLastSession();
      return;
    }
    // Encolar restore ANTES de abrir: el effect del editor consume el slot
    // recién después del setContent del cap.
    this.cursorRestore.request(ls.chapterPath, ls.pmPos);
    if (node.kind === 'chapter') {
      await this.chapter.openInPane(node, 0);
    } else {
      await this.note.openInPane({ path: node.path, name: node.name }, 0);
    }
  }

  /** Handler de cierre de ventana. Flushea settings + flushAndSync de git
   *  con un timeout de 10s. Si el sync falla (auth/network/conflict), modal
   *  de confirmación "¿Cerrar igual?". Si timea o sale OK, cierra. */
  private async bindCloseFlush(): Promise<void> {
    try {
      const win = getCurrentWindow();
      let closing = false;
      const CLOSE_PUSH_TIMEOUT_MS = 10_000;
      await win.onCloseRequested(async (event) => {
        if (closing) return;
        closing = true;
        event.preventDefault();
        this.closing.set(true);
        // Cancelar blur debounce si estaba corriendo.
        if (this.blurDebounceTimer) {
          clearTimeout(this.blurDebounceTimer);
          this.blurDebounceTimer = null;
        }
        // Settings flush (cheap, no necesita race).
        try {
          await this.settings.flushPending();
        } catch {
          // Si falla, igual seguimos — no bloqueamos por un settings write.
        }
        // Si no es repo git, no hay nada que pushear — flush autosave y listo.
        if (this.storage.backend() !== 'git') {
          try {
            await this.chapter.flushAllDirty();
            await this.note.flushAllDirty();
          } catch {
            // ignore
          }
          this.closing.set(false);
          await win.destroy();
          return;
        }
        // Race entre flushAndSync y timeout de 10s.
        type Outcome = 'ok' | 'timeout' | { error: unknown };
        const timeout = new Promise<Outcome>((resolve) =>
          setTimeout(() => resolve('timeout'), CLOSE_PUSH_TIMEOUT_MS),
        );
        const sync: Promise<Outcome> = this.git
          .flushAndSync()
          .then<Outcome>(() => 'ok')
          .catch<Outcome>((err) => ({ error: err }));
        const outcome = await Promise.race([sync, timeout]);
        this.closing.set(false);
        if (outcome === 'ok' || outcome === 'timeout') {
          // OK o timeout: cerrar. El timeout es best-effort; el próximo boot
          // recupera el estado vía bootstrapSync (fetch + auto-pull si behind).
          await win.destroy();
          return;
        }
        // Error real (auth/conflict/network): preguntar al usuario.
        const friendly = this.git.error()?.friendly ?? 'Error al sincronizar con git.';
        const ok = await this.modal.confirm({
          title: 'No se pudo subir',
          message: `${friendly}\n\n¿Querés cerrar igual? Los cambios quedan guardados localmente.`,
          okLabel: 'Cerrar igual',
          cancelLabel: 'Cancelar',
        });
        if (ok) {
          await win.destroy();
        } else {
          // Permitir reintentar el close (el user puede arreglar auth/red y volver a cerrar).
          closing = false;
        }
      });
    } catch {
      // En SSR / no-Tauri (tests), el listener no se setea.
    }
  }

  /** Listener de focus/blur de la ventana Tauri.
   *  - Focus: fetch silencioso + refresh status para detectar pushes desde
   *    otra PC mientras estábamos fuera.
   *  - Blur: arranca debounce 30s. Si el blur dura ese tiempo Y el último
   *    push fue hace >2min Y no hay otro sync en vuelo, flushea autosave +
   *    commit + push. Si vuelve el foco antes, se cancela. */
  private async bindFocusSync(): Promise<void> {
    try {
      const win = getCurrentWindow();
      await win.onFocusChanged(({ payload: focused }) => {
        if (focused) {
          if (this.blurDebounceTimer) {
            clearTimeout(this.blurDebounceTimer);
            this.blurDebounceTimer = null;
          }
          void this.git.fetchAndRefresh();
        } else {
          if (this.blurDebounceTimer) clearTimeout(this.blurDebounceTimer);
          this.blurDebounceTimer = setTimeout(() => {
            this.blurDebounceTimer = null;
            const last = this.git.lastPush;
            const elapsed = last === null ? Number.POSITIVE_INFINITY : Date.now() - last;
            if (elapsed < this.BLUR_PUSH_COOLDOWN_MS) return;
            if (this.git.syncing() || this.closing()) return;
            if (this.storage.backend() !== 'git') return;
            void this.git.flushAndSync().catch((err) => {
              console.debug('blur flushAndSync falló (silencioso)', err);
            });
          }, this.BLUR_DEBOUNCE_MS);
        }
      });
    } catch {
      // En SSR / no-Tauri (tests), el listener no se setea.
    }
  }

  protected refresh(): void {
    void this.project.loadTree();
  }

  protected pickFolder(): void {
    void this.project.chooseRoot();
  }

  protected syncNow(): void {
    // syncNow ahora throwea el error post-set en this.error. La UI consume
    // this.error directo; aquí solo lo silenciamos para evitar unhandled.
    void this.git.syncNow().catch(() => {});
  }

  protected pull(): void {
    void this.git.pull();
  }

  /** Trimea el root absoluto del path para mostrar `Saga/Libro/3.html`
   *  en vez de `/home/.../Novelas/Saga/Libro/3.html` en la lista de cambios. */
  protected relPath(absOrRel: string): string {
    const root = this.root();
    if (!root) return absOrRel;
    if (absOrRel.startsWith(root)) {
      return absOrRel.slice(root.length).replace(/^[\\/]+/, '');
    }
    return absOrRel;
  }

  protected captureSnapshot(): void {
    const tree = this.project.tree();
    const counts = tree ? countByKind(tree) : { sagas: 0, books: 0, sections: 0, chapters: 0 };
    this.debug.snapshot('Estado app', {
      settings: {
        root: this.settings.root(),
        focusMode: this.settings.focusMode(),
        editorWidth: this.settings.editorWidth(),
        editorFontSize: this.settings.editorFontSize(),
      },
      project: {
        loaded: tree !== null,
        loading: this.project.loading(),
        error: this.project.error(),
        ...counts,
      },
      chapter: {
        active: this.chapter.active()?.path ?? null,
        saving: this.chapter.saving(),
        error: this.chapter.error(),
      },
      git: {
        state: this.git.state(),
        summary: this.git.summary(),
        error: this.git.error(),
      },
      grammar: {
        mode: this.grammar.mode(),
        available: this.grammar.available(),
        autoEnabled: this.grammar.autoEnabled(),
        lastError: this.grammar.lastError(),
      },
      ua: navigator.userAgent,
    });
  }

  protected openSettings(): void {
    // General abierto y Gramática colapsada: es el bloque corto y el que
    // estrena contenido. La apertura automática por LT caído sigue pidiendo
    // `gramatica` explícito, que es donde está el remedio.
    this.settingsModal?.show('general');
  }

  protected openAbout(): void {
    void this.about.openAbout();
  }

  protected openImportWizard(): void {
    this.importWizard.show();
  }

  protected openImportJoplin(): void {
    this.importJoplin.show();
  }

  @HostListener('document:contextmenu', ['$event'])
  protected onGlobalContextMenu(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    this.ctxMenu.openDefault(event);
  }

  @HostListener('window:keydown.F11', ['$event'])
  protected onF11(event: Event): void {
    event.preventDefault();
    this.settings.toggleFocusMode();
  }

  // Los dos modificadores: Angular mapea `meta` a Cmd y `control` a Ctrl, y en
  // Mac buscar es ⌘F. Antes solo estaba `control`, así que el tooltip que ahora
  // dice ⌘F habría quedado mintiendo.
  @HostListener('window:keydown.meta.f', ['$event'])
  @HostListener('window:keydown.control.f', ['$event'])
  protected onCtrlF(event: Event): void {
    event.preventDefault();
    this.search.toggle();
  }

  protected toggleSearch(): void {
    this.search.toggle();
  }

  protected irAlInicio(): void {
    void this.nodeActions.irAlInicio();
  }

  // El modo focus esconde el panel izquierdo, o sea que el botón de casita
  // desaparece justo cuando más lejos estás de la raíz. Por eso el atajo.
  @HostListener('window:keydown.meta.shift.h', ['$event'])
  @HostListener('window:keydown.control.shift.h', ['$event'])
  protected onIrAlInicio(event: Event): void {
    event.preventDefault();
    // El botón del header está `[disabled]="!root()"`; sin esta guarda el
    // atajo haría lo que el botón tiene prohibido.
    if (!this.root()) return;
    this.irAlInicio();
  }

  @HostListener('window:keydown.Escape')
  protected onEsc(): void {
    if (this.settings.focusMode()) {
      this.settings.toggleFocusMode();
    }
  }

  // ──────── Drop zone center (split) ────────

  protected onCenterDragEnter(event: DragEvent): void {
    if (!this.paneSplit.draggingNode()) return;
    event.preventDefault();
    this.dragOverCenter.set(true);
  }

  protected onCenterDragOver(event: DragEvent): void {
    if (!this.paneSplit.draggingNode()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  protected onCenterDragLeave(event: DragEvent): void {
    // dragleave dispara para hijos también; sólo limpiar si salimos del shell.
    const related = event.relatedTarget as Node | null;
    const main = event.currentTarget as HTMLElement | null;
    if (main && related && main.contains(related)) return;
    this.dragOverCenter.set(false);
  }

  protected async onCenterDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragOverCenter.set(false);
    const dragging = this.paneSplit.draggingNode();
    this.paneSplit.endDrag();
    if (!dragging) return;

    const tree = this.project.tree();
    if (!tree) return;
    const node = findNodeByPath(tree, dragging.path);
    if (!node) {
      this.toast.error('No se encontró el archivo en el árbol.');
      return;
    }

    if (node.kind === 'chapter') {
      if (!node.editable) {
        this.toast.warn('Importá el archivo antes de abrirlo en split.');
        return;
      }
      // Validar que no esté ya en pane 0.
      if (this.chapter.panes[0].active()?.path === node.path) {
        this.toast.info('Ya está abierto en el pane izquierdo.');
        return;
      }
      // Importante: abrir en pane 1 ANTES de enableSplit() para evitar la
      // race con el effect "auto-disable si pane 1 vacío".
      await this.chapter.openInPane(node, 1);
      this.paneSplit.enableSplit();
      return;
    }

    if (node.kind === 'note') {
      if (this.note.panes[0].active()?.path === node.path) {
        this.toast.info('Ya está abierto en el pane izquierdo.');
        return;
      }
      await this.note.openInPane({ path: node.path, name: node.name }, 1);
      this.paneSplit.enableSplit();
      return;
    }

    this.toast.warn('Solo capítulos o notas se pueden abrir en split.');
  }

  protected closeSecondaryPane(): void {
    this.paneSplit.closeSecondary();
  }

  // ──────── Panel de notas (segundo árbol, abajo del principal) ────────

  /** True mientras se arrastra el divisor del panel de notas — desactiva la
   *  transición de alto para que el resize siga al puntero sin lag. */
  protected readonly notesResizing = signal<boolean>(false);
  private notesResizeStartY = 0;
  private notesResizeStartH = 0;

  protected toggleNotesPane(): void {
    this.settings.setNotesPaneCollapsed(!this.settings.notesPaneCollapsed());
  }

  /** Botón `+` del header del panel: crea la nota donde el usuario está
   *  parado, sin obligarlo a ir al menú contextual del árbol de arriba. */
  protected createNoteQuick(): void {
    void this.nodeActions.createNoteQuick();
  }

  /** Arranca el drag del divisor. Arrastrar hacia arriba agranda el panel de
   *  notas (vive abajo en la columna izquierda). */
  protected startNotesResize(event: PointerEvent): void {
    event.preventDefault();
    this.notesResizeStartY = event.clientY;
    this.notesResizeStartH = this.settings.notesPaneHeight();
    this.notesResizing.set(true);
    const onMove = (e: PointerEvent): void => {
      const dy = this.notesResizeStartY - e.clientY;
      this.settings.setNotesPaneHeight(this.notesResizeStartH + dy);
    };
    const onUp = (): void => {
      this.notesResizing.set(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  protected async createSaga(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    const name = await this.modal.prompt({
      title: 'Nueva saga / novela',
      placeholder: 'Nombre',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    // Numerada: el prefijo "N - " es lo que ordena el filesystem, que se
    // maneja también a mano por git. `displayName` lo esconde en el árbol.
    await this.chapter.createDirectory(root, name.trim(), true);
  }
}

function findNodeByPath(root: TreeNode | null, path: string): TreeNode | null {
  if (!root) return null;
  if (root.path === path) return root;
  for (const c of root.children ?? []) {
    const found = findNodeByPath(c, path);
    if (found) return found;
  }
  return null;
}

function countByKind(n: TreeNode): { sagas: number; books: number; sections: number; chapters: number } {
  const counts = { sagas: 0, books: 0, sections: 0, chapters: 0 };
  const walk = (node: TreeNode): void => {
    switch (node.kind) {
      case 'saga': counts.sagas++; break;
      case 'book': counts.books++; break;
      case 'section': counts.sections++; break;
      case 'chapter': counts.chapters++; break;
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(n);
  return counts;
}
