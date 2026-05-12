import { Component, ViewChild, computed, effect, HostListener, inject } from '@angular/core';
import { ChapterService } from './core/chapter-service';
import { DebugService } from './core/debug-service';
import { FontPreviewService } from './core/font-preview-service';
import { NoteService } from './core/note-service';
import { GitService } from './core/git-service';
import { GrammarService } from './core/grammar-service';
import { ImageViewerService } from './core/image-viewer-service';
import { ImportWizardService } from './core/import-wizard-service';
import { ProjectService } from './core/project-service';
import { RustLogBridge } from './core/rust-log-bridge';
import { SettingsService } from './core/settings-service';
import { UpdaterService } from './core/updater-service';
import { Tree } from './tree/tree';
import { Editor } from './editor/editor';
import { NotesEditor } from './notes-editor/notes-editor';
import { DebugPanel } from './debug/debug-panel';
import { BookConfigModal } from './book-config/book-config-modal';
import { SagaConfigModal } from './saga-config/saga-config-modal';
import { ThemeEditorModal } from './theme-editor/theme-editor-modal';
import { ImageViewer } from './image-viewer/image-viewer';
import { FontPreview } from './font-preview/font-preview';
import { ToastContainer } from './toast/toast-container';
import { GrammarSettings } from './grammar-settings/grammar-settings';
import { ImportWizard } from './import-wizard/import-wizard';
import { UpdateBanner } from './update-banner/update-banner';
import { Spinner } from './shared/spinner';
import { ModalHost } from './shared/modal-host';
import { ModalService } from './shared/modal-service';
import { ContextMenuHost } from './shared/context-menu-host';
import { ContextMenuService } from './shared/context-menu-service';
import { TreeNode } from './core/types';

@Component({
  selector: 'app-root',
  imports: [Tree, Editor, NotesEditor, DebugPanel, BookConfigModal, SagaConfigModal, ThemeEditorModal, ImageViewer, FontPreview, ToastContainer, GrammarSettings, ImportWizard, UpdateBanner, Spinner, ModalHost, ContextMenuHost],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  @ViewChild(GrammarSettings) private grammarSettings?: GrammarSettings;
  protected importWizard = inject(ImportWizardService);
  protected imageViewer = inject(ImageViewerService);
  protected fontPreview = inject(FontPreviewService);

  private project = inject(ProjectService);
  protected settings = inject(SettingsService);
  protected chapter = inject(ChapterService);
  protected note = inject(NoteService);
  protected git = inject(GitService);
  protected debug = inject(DebugService);
  private grammar = inject(GrammarService);
  private updater = inject(UpdaterService);
  private modal = inject(ModalService);
  private ctxMenu = inject(ContextMenuService);

  protected readonly saving = computed(() => this.chapter.saving() || this.note.saving());
  protected readonly bulkProgress = this.chapter.bulkProgress;

  private lastChapterErr: string | null = null;
  private lastNoteErr: string | null = null;
  private lastProjectErr: string | null = null;
  private lastGitErr: string | null = null;

  protected readonly root = this.project.root;
  protected readonly syncTitle = computed(() => {
    const s = this.git.state();
    const summary = this.git.summary();
    const err = this.git.error();
    if (err) return `Error: ${err}`;
    switch (s) {
      case 'syncing': return 'Sincronizando…';
      case 'pending': return summary + ' — click para sincronizar';
      case 'clean': return summary;
      case 'error': return `Error: ${err ?? 'desconocido'}`;
      default: return 'Estado desconocido';
    }
  });

  constructor() {
    inject(RustLogBridge);
    void this.bootstrap();
    effect(() => {
      const e = this.chapter.error();
      if (e && e !== this.lastChapterErr) this.debug.error('chapter', e);
      this.lastChapterErr = e;
    });
    effect(() => {
      const e = this.note.error();
      if (e && e !== this.lastNoteErr) this.debug.error('note', e);
      this.lastNoteErr = e;
    });
    // Mutex inverso: cuando se abre un capítulo, la nota se cierra.
    effect(() => {
      if (this.chapter.active()) {
        this.note.close();
      }
    });
    // Mutex del panel derecho: image viewer y font preview no conviven.
    effect(() => {
      if (this.imageViewer.viewing()) this.fontPreview.close();
    });
    effect(() => {
      if (this.fontPreview.viewing()) this.imageViewer.close();
    });
    effect(() => {
      const e = this.project.error();
      if (e && e !== this.lastProjectErr) this.debug.error('project', e);
      this.lastProjectErr = e;
    });
    effect(() => {
      const e = this.git.error();
      if (e && e !== this.lastGitErr) this.debug.error('git', e);
      this.lastGitErr = e;
    });
  }

  private async bootstrap(): Promise<void> {
    await this.settings.load();
    if (this.settings.root()) {
      await this.project.loadTree();
    }
    setTimeout(() => void this.updater.chequear(), 5000);
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

  @HostListener('window:keydown.Escape')
  protected onEsc(): void {
    if (this.settings.focusMode()) {
      this.settings.toggleFocusMode();
    }
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
