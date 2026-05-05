import { Component, computed, inject, signal } from '@angular/core';
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

  protected readonly root = this.project.tree;
  protected readonly loading = this.project.loading;
  protected readonly error = this.project.error;
  protected readonly activePath = computed(() => this.chapter.active()?.path ?? null);

  /** Paths cuyo estado es OPUESTO al default (default: sagas/books expanded, sections collapsed). */
  private readonly toggled = signal<Set<string>>(new Set());

  protected isExpanded(node: TreeNode): boolean {
    const explicitToggle = this.toggled().has(node.path);
    const defaultExpanded = node.kind === 'saga' || node.kind === 'book';
    return explicitToggle ? !defaultExpanded : defaultExpanded;
  }

  protected toggle(node: TreeNode): void {
    this.toggled.update((s) => {
      const next = new Set(s);
      if (next.has(node.path)) {
        next.delete(node.path);
      } else {
        next.add(node.path);
      }
      return next;
    });
  }

  protected async select(node: TreeNode): Promise<void> {
    if (node.kind === 'chapter') {
      await this.chapter.open(node);
    }
  }
}
