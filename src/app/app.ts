import { Component, inject } from '@angular/core';
import { ProjectService } from './core/project-service';
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

  protected readonly root = this.project.root;

  constructor() {
    void this.project.loadTree();
  }
}
