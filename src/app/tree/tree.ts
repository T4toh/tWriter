import { Component, computed, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ChapterService } from '../core/chapter-service';
import { ProjectService } from '../core/project-service';
import { TreeNode } from '../core/types';

@Component({
  selector: 'app-tree',
  imports: [NgTemplateOutlet],
  templateUrl: './tree.html',
  styleUrl: './tree.scss',
})
export class Tree {
  private project = inject(ProjectService);
  private chapter = inject(ChapterService);

  readonly root = this.project.tree;
  readonly loading = this.project.loading;
  readonly error = this.project.error;
  readonly activePath = computed(() => this.chapter.active()?.path ?? null);

  async select(node: TreeNode): Promise<void> {
    if (node.kind === 'chapter') {
      await this.chapter.open(node);
    }
  }

  refresh(): void {
    void this.project.loadTree();
  }
}
