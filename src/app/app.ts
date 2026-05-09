import { Component, ViewChild, computed, effect, HostListener, inject } from '@angular/core';
import { ChapterService } from './core/chapter-service';
import { DebugService } from './core/debug-service';
import { GitService } from './core/git-service';
import { ImageViewerService } from './core/image-viewer-service';
import { ImportWizardService } from './core/import-wizard-service';
import { ProjectService } from './core/project-service';
import { SettingsService } from './core/settings-service';
import { UpdaterService } from './core/updater-service';
import { Tree } from './tree/tree';
import { Editor } from './editor/editor';
import { DebugPanel } from './debug/debug-panel';
import { BookConfigModal } from './book-config/book-config-modal';
import { ImageViewer } from './image-viewer/image-viewer';
import { ToastContainer } from './toast/toast-container';
import { GrammarSettings } from './grammar-settings/grammar-settings';
import { ImportWizard } from './import-wizard/import-wizard';
import { UpdateBanner } from './update-banner/update-banner';

@Component({
  selector: 'app-root',
  imports: [Tree, Editor, DebugPanel, BookConfigModal, ImageViewer, ToastContainer, GrammarSettings, ImportWizard, UpdateBanner],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  @ViewChild(GrammarSettings) private grammarSettings?: GrammarSettings;
  protected importWizard = inject(ImportWizardService);
  protected imageViewer = inject(ImageViewerService);

  private project = inject(ProjectService);
  protected settings = inject(SettingsService);
  private chapter = inject(ChapterService);
  protected git = inject(GitService);
  protected debug = inject(DebugService);
  private updater = inject(UpdaterService);

  private lastChapterErr: string | null = null;
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
    void this.bootstrap();
    effect(() => {
      const e = this.chapter.error();
      if (e && e !== this.lastChapterErr) this.debug.error('chapter', e);
      this.lastChapterErr = e;
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

  protected openGrammarSettings(): void {
    this.grammarSettings?.show();
  }

  protected openImportWizard(): void {
    this.importWizard.show();
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
    const name = prompt('Nombre de la saga / novela:');
    if (!name?.trim()) return;
    await this.chapter.createDirectory(root, name.trim(), false);
  }
}
