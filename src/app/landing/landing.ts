import { Component, computed, inject } from '@angular/core';
import { ChapterService } from '../core/chapter-service';
import { NavigationService } from '../core/navigation-service';
import { ProjectService } from '../core/project-service';
import { TreeNode } from '../core/types';
import { BookCard } from './book-card';
import { SagaCard } from './saga-card';

interface Crumb {
  label: string;
  node: TreeNode | null;
}

@Component({
  selector: 'app-landing',
  imports: [BookCard, SagaCard],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
})
export class Landing {
  private project = inject(ProjectService);
  private chapter = inject(ChapterService);
  private nav = inject(NavigationService);

  protected readonly browsing = this.nav.browsingPath;

  protected readonly currentNode = computed<TreeNode | null>(() => {
    const path = this.browsing();
    const root = this.project.tree();
    if (!path || !root) return null;
    return findNode(root, path);
  });

  protected readonly items = computed<TreeNode[]>(() => {
    const root = this.project.tree();
    if (!root) return [];
    const node = this.currentNode();
    const target = node ?? root;
    return [...target.children].sort((a, b) => {
      const am = a.modifiedMs ?? 0;
      const bm = b.modifiedMs ?? 0;
      return bm - am;
    });
  });

  protected readonly crumbs = computed<Crumb[]>(() => {
    const root = this.project.tree();
    if (!root) return [];
    const path = this.browsing();
    const list: Crumb[] = [{ label: 'Inicio', node: null }];
    if (!path) return list;
    const chain = pathChain(root, path);
    for (const n of chain) {
      list.push({ label: n.name, node: n });
    }
    return list;
  });

  protected onItemClick(node: TreeNode): void {
    if (node.kind === 'chapter') {
      void this.chapter.open(node);
    } else {
      this.nav.setBrowsing(node.path);
    }
  }

  protected onBookSelect(node: TreeNode): void {
    this.onItemClick(node);
  }

  protected goCrumb(crumb: Crumb): void {
    this.nav.setBrowsing(crumb.node?.path ?? null);
  }

  protected formatDate(ms: number | undefined): string {
    if (!ms) return 'sin editar';
    const now = Date.now();
    const diff = now - ms;
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < hour) {
      const m = Math.max(1, Math.floor(diff / min));
      return `hace ${m} min`;
    }
    if (diff < day) {
      const h = Math.floor(diff / hour);
      return `hace ${h} h`;
    }
    if (diff < 7 * day) {
      const d = Math.floor(diff / day);
      return `hace ${d} d`;
    }
    const date = new Date(ms);
    return date.toLocaleDateString('es-AR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  protected kindLabel(kind: string): string {
    switch (kind) {
      case 'saga': return 'colección';
      case 'book': return 'novela';
      case 'section': return 'capítulo';
      case 'chapter': return 'parte';
      default: return kind;
    }
  }
}

function findNode(root: TreeNode, path: string): TreeNode | null {
  if (root.path === path) return root;
  for (const c of root.children) {
    const found = findNode(c, path);
    if (found) return found;
  }
  return null;
}

function pathChain(root: TreeNode, targetPath: string): TreeNode[] {
  const search = (node: TreeNode, acc: TreeNode[]): TreeNode[] | null => {
    if (node.path === targetPath) {
      return [...acc, node];
    }
    for (const c of node.children) {
      const r = search(c, [...acc, node]);
      if (r) return r;
    }
    return null;
  };
  const found = search(root, []);
  if (!found) return [];
  return found.slice(1);
}
