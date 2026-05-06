import { Component, computed, inject } from '@angular/core';
import { GitService } from './core/git-service';
import { ProjectService } from './core/project-service';
import { SettingsService } from './core/settings-service';
import { Tree } from './tree/tree';
import { Editor } from './editor/editor';

@Component({
  selector: 'app-root',
  imports: [Tree, Editor],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private project = inject(ProjectService);
  private settings = inject(SettingsService);
  protected git = inject(GitService);

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
  }

  private async bootstrap(): Promise<void> {
    await this.settings.load();
    if (this.settings.root()) {
      await this.project.loadTree();
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
}
