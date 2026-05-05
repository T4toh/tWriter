import { Component, inject } from '@angular/core';
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

  protected readonly root = this.project.root;
  protected readonly hasRoot = this.project.root;

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
}
