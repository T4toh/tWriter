import { Component, computed, effect, inject, signal } from '@angular/core';
import { BookConfigService } from '../core/book-config-service';
import { ChapterService } from '../core/chapter-service';
import { NavigationService } from '../core/navigation-service';
import { ProjectService } from '../core/project-service';
import { SagaConfigService } from '../core/saga-config-service';
import { TreeNode } from '../core/types';
import { ModalService } from '../shared/modal-service';
import { ContextMenuService } from '../shared/context-menu-service';
import { NodeActionsService } from '../shared/node-actions-service';
import { BookCard } from './book-card';
import { CreateCard } from './create-card';
import { SagaCard } from './saga-card';
import { SagaHeader } from './saga-header';

interface Crumb {
  label: string;
  node: TreeNode | null;
}

@Component({
  selector: 'app-landing',
  imports: [BookCard, SagaCard, SagaHeader, CreateCard],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
})
export class Landing {
  private project = inject(ProjectService);
  private chapter = inject(ChapterService);
  private nav = inject(NavigationService);
  private bookCfg = inject(BookConfigService);
  private sagaCfg = inject(SagaConfigService);
  private modal = inject(ModalService);
  private ctxMenu = inject(ContextMenuService);
  private actions = inject(NodeActionsService);

  protected readonly browsing = this.nav.browsingPath;
  protected readonly creating = signal<boolean>(false);

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
    if (!node) {
      return [...target.children].sort((a, b) => {
        const am = a.modifiedMs ?? 0;
        const bm = b.modifiedMs ?? 0;
        return bm - am;
      });
    }
    return target.children;
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

  protected readonly bookContextPath = computed<string | null>(() => {
    const node = this.currentNode();
    if (!node) return null;
    if (node.kind === 'book') return node.path;
    if (node.kind === 'section') {
      const root = this.project.tree();
      if (!root) return null;
      const chain = pathChain(root, node.path);
      for (const n of chain) {
        if (n.kind === 'book') return n.path;
      }
    }
    return null;
  });

  protected readonly sagaContextPath = computed<string | null>(() => {
    const node = this.currentNode();
    return node && node.kind === 'saga' ? node.path : null;
  });

  protected readonly bookFinalizada = signal<boolean>(false);
  protected readonly sagaFinalizada = signal<boolean>(false);
  protected readonly bookEpilogoPath = signal<string | null>(null);

  protected readonly canCreateCapitulo = computed<boolean>(() => {
    const node = this.currentNode();
    if (!node || node.kind !== 'book') return false;
    return !this.bookFinalizada();
  });

  protected readonly canCreateEpilogo = computed<boolean>(() => {
    const node = this.currentNode();
    if (!node || node.kind !== 'book') return false;
    if (this.bookFinalizada()) return false;
    return this.bookEpilogoPath() === null;
  });

  protected readonly canCreateParte = computed<boolean>(() => {
    const node = this.currentNode();
    if (!node || node.kind !== 'section') return false;
    return !this.bookFinalizada();
  });

  protected readonly canCreateBook = computed<boolean>(() => {
    const node = this.currentNode();
    if (!node || node.kind !== 'saga') return false;
    return !this.sagaFinalizada();
  });

  constructor() {
    effect(() => {
      const path = this.bookContextPath();
      this.bookCfg.savedAt();
      if (!path) {
        this.bookFinalizada.set(false);
        return;
      }
      void this.loadBookFinalizada(path);
    });
    effect(() => {
      const path = this.sagaContextPath();
      this.sagaCfg.savedAt();
      if (!path) {
        this.sagaFinalizada.set(false);
        return;
      }
      void this.loadSagaFinalizada(path);
    });
  }

  private async loadBookFinalizada(path: string): Promise<void> {
    try {
      const cfg = await this.bookCfg.load(path);
      this.bookFinalizada.set(!!cfg.finalizada);
      const ep = cfg.epilogo?.trim();
      this.bookEpilogoPath.set(ep && ep.length > 0 ? ep : null);
    } catch {
      this.bookFinalizada.set(false);
      this.bookEpilogoPath.set(null);
    }
  }

  private async loadSagaFinalizada(path: string): Promise<void> {
    try {
      const cfg = await this.sagaCfg.load(path);
      this.sagaFinalizada.set(!!cfg.finalizada);
    } catch {
      this.sagaFinalizada.set(false);
    }
  }

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

  protected onCardContextMenu(event: MouseEvent, node: TreeNode): void {
    this.ctxMenu.open(event, this.actions.buildNodeMenu(node));
  }

  /** Click derecho en el área vacía (sin items y sin saga current) → ofrece crear saga. */
  protected onEmptyContext(event: MouseEvent): void {
    const node = this.currentNode();
    if (node) return; // dejá burbujar; el menú del header del nodo aplica si quieren editar
    const items = this.actions.buildEmptyMenu();
    if (items.length === 0) return;
    this.ctxMenu.open(event, items);
  }

  protected async createCapituloHere(): Promise<void> {
    const node = this.currentNode();
    if (!node || node.kind !== 'book' || this.creating()) return;
    const name = await this.modal.prompt({
      title: 'Nuevo capítulo',
      message: 'Sin número, se prepende automático.',
      placeholder: 'Nombre',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    this.creating.set(true);
    try {
      await this.chapter.createDirectory(node.path, name.trim(), true);
    } finally {
      this.creating.set(false);
    }
  }

  protected async createEpilogoHere(): Promise<void> {
    const node = this.currentNode();
    if (!node || node.kind !== 'book' || this.creating()) return;
    if (this.bookEpilogoPath() !== null) return;
    const name = await this.modal.prompt({
      title: 'Nuevo epílogo',
      defaultValue: 'Epílogo',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    const dirName = name.trim();
    this.creating.set(true);
    try {
      const dirPath = await this.chapter.createDirectory(node.path, dirName, false);
      if (!dirPath) return;
      const cfg = await this.bookCfg.load(node.path);
      await this.bookCfg.save(node.path, { ...cfg, epilogo: dirName });
      this.bookEpilogoPath.set(dirName);
    } finally {
      this.creating.set(false);
    }
  }

  protected async createParteHere(): Promise<void> {
    const node = this.currentNode();
    if (!node || node.kind !== 'section' || this.creating()) return;
    this.creating.set(true);
    try {
      await this.chapter.createChapter(node.path);
    } finally {
      this.creating.set(false);
    }
  }

  protected async createBookHere(): Promise<void> {
    const node = this.currentNode();
    if (!node || node.kind !== 'saga' || this.creating()) return;
    const name = await this.modal.prompt({
      title: 'Nueva novela',
      message: 'Sin número, se prepende automático.',
      placeholder: 'Nombre',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    this.creating.set(true);
    try {
      await this.chapter.createBook(node.path, name.trim());
    } finally {
      this.creating.set(false);
    }
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
