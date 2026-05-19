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
import { SettingsService } from './core/settings-service';
import { ToastService } from './core/toast-service';
import { UpdaterService } from './core/updater-service';
import { Tree } from './tree/tree';
import { Editor } from './editor/editor';
import { NotesEditor } from './notes-editor/notes-editor';
import { DebugPanel } from './debug/debug-panel';
import { BookConfigModal } from './book-config/book-config-modal';
import { SagaConfigModal } from './saga-config/saga-config-modal';
import { DictionaryModal } from './dictionary/dictionary-modal';
import { SplitChapterModal } from './split-chapter/split-chapter-modal';
import { ThemeEditorModal } from './theme-editor/theme-editor-modal';
import { ImageViewer } from './image-viewer/image-viewer';
import { FontPreview } from './font-preview/font-preview';
import { MarkdownReader } from './markdown-reader/markdown-reader';
import { SearchPanel } from './search-panel/search-panel';
import { RaeAuditPanel } from './rae-audit/rae-audit-panel';
import { ToastContainer } from './toast/toast-container';
import { GrammarSettings } from './grammar-settings/grammar-settings';
import { ImportJoplin } from './import-joplin/import-joplin';
import { ImportWizard } from './import-wizard/import-wizard';
import { UpdateBanner } from './update-banner/update-banner';
import { StorageHelpModal } from './storage-help/storage-help-modal';
import { Spinner } from './shared/spinner';
import { ModalHost } from './shared/modal-host';
import { ModalService } from './shared/modal-service';
import { ContextMenuHost } from './shared/context-menu-host';
import { ContextMenuService } from './shared/context-menu-service';
import { TreeNode } from './core/types';

@Component({
  selector: 'app-root',
  imports: [Tree, Editor, NotesEditor, DebugPanel, BookConfigModal, SagaConfigModal, DictionaryModal, SplitChapterModal, ThemeEditorModal, ImageViewer, FontPreview, MarkdownReader, SearchPanel, RaeAuditPanel, ToastContainer, GrammarSettings, ImportWizard, ImportJoplin, UpdateBanner, StorageHelpModal, Spinner, ModalHost, ContextMenuHost],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  @ViewChild(GrammarSettings) private grammarSettings?: GrammarSettings;
  protected importWizard = inject(ImportWizardService);
  protected importJoplin = inject(ImportJoplinService);
  protected imageViewer = inject(ImageViewerService);
  protected fontPreview = inject(FontPreviewService);
  protected markdownReader = inject(MarkdownReaderService);
  protected search = inject(SearchService);
  protected raeAudit = inject(RaeAuditService);

  private project = inject(ProjectService);
  protected settings = inject(SettingsService);
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
  private toast = inject(ToastService);

  protected readonly dragOverCenter = signal<boolean>(false);

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
  protected readonly syncTitle = computed(() => {
    const s = this.git.state();
    const summary = this.git.summary();
    const err = this.git.error();
    if (err) return `Error: ${err.friendly}`;
    switch (s) {
      case 'syncing': return 'Sincronizando…';
      case 'pending': return summary + ' — click para sincronizar';
      case 'clean': return summary;
      case 'error': return `Error: ${err ? (err as GitError).friendly : 'desconocido'}`;
      default: return 'Estado desconocido';
    }
  });

  constructor() {
    inject(RustLogBridge);
    void this.bootstrap();
    void this.bindCloseFlush();
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
    // Mutex: search panel cierra image/font/md y viceversa.
    effect(() => {
      if (this.search.open()) {
        this.imageViewer.close();
        this.fontPreview.close();
        this.markdownReader.close();
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

  /** Flushea persist pendiente del SettingsService al cierre de ventana para
   *  no perder el último cursor pos del debounce 500ms. Sin esto, cerrar la
   *  app inmediatamente después de mover el cursor lo guarda al pos anterior. */
  private async bindCloseFlush(): Promise<void> {
    try {
      const win = getCurrentWindow();
      let closing = false;
      await win.onCloseRequested(async (event) => {
        if (closing) return;
        closing = true;
        event.preventDefault();
        try {
          await this.settings.flushPending();
        } catch {
          // Si falla, igual cerramos — no bloqueamos al usuario por un settings write.
        }
        await win.destroy();
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
    void this.git.syncNow();
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

  protected toggleDebug(): void {
    this.debug.toggle();
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

  protected openGrammarSettings(): void {
    this.grammarSettings?.show();
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

  @HostListener('window:keydown.control.f', ['$event'])
  protected onCtrlF(event: Event): void {
    event.preventDefault();
    this.search.toggle();
  }

  protected toggleSearch(): void {
    this.search.toggle();
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

  protected async createSaga(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    const name = await this.modal.prompt({
      title: 'Nueva saga / novela',
      placeholder: 'Nombre',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    await this.chapter.createDirectory(root, name.trim(), false);
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
