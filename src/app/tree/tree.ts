import { Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ChapterService } from '../core/chapter-service';
import { NavigationService } from '../core/navigation-service';
import { ProjectService } from '../core/project-service';
import { SettingsService } from '../core/settings-service';
import { TreeNode } from '../core/types';

interface ContextMenu {
  x: number;
  y: number;
  node: TreeNode | null;
}

@Component({
  selector: 'app-tree',
  imports: [NgTemplateOutlet],
  templateUrl: './tree.html',
  styleUrl: './tree.scss',
})
export class Tree {
  private project = inject(ProjectService);
  private chapter = inject(ChapterService);
  private settings = inject(SettingsService);
  private nav = inject(NavigationService);

  protected readonly root = this.project.tree;
  protected readonly loading = this.project.loading;
  protected readonly error = this.project.error;
  protected readonly activePath = computed(() => this.chapter.active()?.path ?? null);
  protected readonly browsingPath = this.nav.browsingPath;
  /** Path activo de UI (capítulo abierto si hay, si no path de browse). */
  protected readonly currentPath = computed(
    () => this.activePath() ?? this.browsingPath(),
  );
  /** Set de paths ancestros del current (para highlight tenue). */
  protected readonly ancestorPaths = computed(() => {
    const cur = this.currentPath();
    const root = this.root();
    if (!cur || !root) return new Set<string>();
    const set = new Set<string>();
    const walk = (n: TreeNode, acc: string[]): boolean => {
      if (n.path === cur) {
        for (const p of acc) set.add(p);
        return true;
      }
      for (const c of n.children) {
        if (walk(c, [...acc, n.path])) return true;
      }
      return false;
    };
    walk(root, []);
    return set;
  });
  protected readonly bulkProgress = this.chapter.bulkProgress;
  protected readonly menu = signal<ContextMenu | null>(null);

  /** Acciones disponibles para el nodo del menú. */
  protected readonly menuActions = computed(() => {
    const m = this.menu();
    if (!m) return null;
    const node = m.node;
    if (!node) {
      return {
        importThis: false,
        deleteOriginal: false,
        deleteFile: false,
        deleteDir: false,
        importBulk: 0,
        cleanupBulk: 0,
        createChapter: false,
        createSection: false,
        createBook: false,
        createSaga: !!this.settings.root(),
        moveable: false,
      };
    }
    if (node.kind === 'chapter') {
      const isImportable = node.ext === 'odt' || node.ext === 'docx';
      const hasHtml = isImportable && this.hasHtmlSibling(node);
      return {
        importThis: isImportable && !node.editable,
        deleteOriginal: isImportable && hasHtml,
        deleteFile: true,
        deleteDir: false,
        importBulk: 0,
        cleanupBulk: 0,
        createChapter: false,
        createSection: false,
        createBook: false,
        createSaga: false,
        moveable: this.isMoveable(node),
      };
    }
    const importable = this.collectImportable(node);
    const cleanable = this.collectCleanable(node);
    return {
      importThis: false,
      deleteOriginal: false,
      deleteFile: false,
      deleteDir: true,
      importBulk: importable.length,
      cleanupBulk: cleanable.length,
      createChapter: node.kind === 'book' || node.kind === 'section',
      createSection: node.kind === 'book',
      createBook: node.kind === 'saga',
      createSaga: false,
      moveable: node.kind !== 'saga' && this.isMoveable(node),
    };
  });

  private isMoveable(node: TreeNode): boolean {
    if (node.kind === 'chapter') {
      return /^\d+$/.test(node.name);
    }
    return /^\d+\s*-/.test(node.name);
  }

  /** Paths cuyo estado es OPUESTO al default (default: sagas/books expanded, sections collapsed). */
  private readonly toggled = signal<Set<string>>(new Set());
  /** Override global. null = usa defaults + toggled. */
  private readonly forceState = signal<'collapsed' | 'expanded' | null>(null);

  protected isExpanded(node: TreeNode): boolean {
    const force = this.forceState();
    if (force === 'collapsed') return false;
    if (force === 'expanded') return true;
    const explicitToggle = this.toggled().has(node.path);
    const isAncestor = this.ancestorPaths().has(node.path);
    const defaultExpanded =
      node.kind === 'saga' || node.kind === 'book' || isAncestor;
    return explicitToggle ? !defaultExpanded : defaultExpanded;
  }

  protected toggle(node: TreeNode): void {
    // Click en dir → setea browse + cierra capítulo activo para revelar landing.
    this.nav.setBrowsing(node.path);
    this.chapter.close();
    // Si había override global, volvemos a modo manual respetando lo que se ve.
    if (this.forceState() !== null) {
      const wasExpanded = this.forceState() === 'expanded';
      this.forceState.set(null);
      const desired = !wasExpanded;
      const defaultExpanded = node.kind === 'saga' || node.kind === 'book';
      this.toggled.update((s) => {
        const next = new Set(s);
        if (desired === defaultExpanded) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        return next;
      });
      return;
    }
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

  protected collapseAll(): void {
    this.toggled.set(new Set());
    this.forceState.set('collapsed');
  }

  protected expandAll(): void {
    this.toggled.set(new Set());
    this.forceState.set('expanded');
  }

  protected async select(node: TreeNode): Promise<void> {
    if (node.kind === 'chapter') {
      // Setear browsing al dir padre para que al cerrar el cap se vea el contexto correcto
      const parentPath = node.path.replace(/\/[^/]+$/, '');
      this.nav.setBrowsing(parentPath);
      await this.chapter.open(node);
    }
  }

  protected onContextMenu(event: MouseEvent, node: TreeNode): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({ x: event.clientX, y: event.clientY, node });
  }

  protected onEmptyContext(event: MouseEvent): void {
    event.preventDefault();
    this.menu.set({ x: event.clientX, y: event.clientY, node: null });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  protected async importThis(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    this.closeMenu();
    await this.chapter.importChapter(m.node);
  }

  protected async deleteOriginal(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    this.closeMenu();
    await this.chapter.deleteOriginal(m.node);
  }

  protected async importBulk(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    const nodes = this.collectImportable(m.node);
    this.closeMenu();
    if (nodes.length === 0) return;
    await this.chapter.bulkImport(nodes);
  }

  protected async cleanupBulk(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    const nodes = this.collectCleanable(m.node);
    this.closeMenu();
    if (nodes.length === 0) return;
    if (!confirm(`Borrar ${nodes.length} archivo${nodes.length === 1 ? '' : 's'} original${nodes.length === 1 ? '' : 'es'} (.odt/.docx)?\nSolo se borran los que ya tienen .html.`)) {
      return;
    }
    await this.chapter.bulkCleanup(nodes);
  }

  protected async deleteFile(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    this.closeMenu();
    if (!confirm(`Borrar ${m.node.name}.${m.node.ext}?\nSe borra el archivo y su .meta.json.`)) {
      return;
    }
    await this.chapter.deleteChapterFile(m.node);
  }

  protected async deleteDir(): Promise<void> {
    const m = this.menu();
    const root = this.settings.root();
    if (!m || !m.node || !root) return;
    const node = m.node;
    this.closeMenu();
    const msg = `BORRAR carpeta "${node.name}" y todo su contenido?\nEsto es irreversible. Si tenés sync git, podés recuperar haciendo git checkout.`;
    if (!confirm(msg)) return;
    await this.chapter.deleteDirectory(node, root);
  }

  protected async createChapter(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    this.closeMenu();
    await this.chapter.createChapter(m.node.path);
  }

  protected async createSection(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    const name = prompt('Nombre del capítulo (sin número, se prepende automático):');
    this.closeMenu();
    if (!name?.trim()) return;
    await this.chapter.createDirectory(m.node.path, name.trim(), true);
  }

  protected async createBook(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    const name = prompt('Nombre del libro (sin número, se prepende automático):');
    this.closeMenu();
    if (!name?.trim()) return;
    await this.chapter.createDirectory(m.node.path, name.trim(), true);
  }

  protected async createSaga(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    const name = prompt('Nombre de la saga / novela:');
    this.closeMenu();
    if (!name?.trim()) return;
    await this.chapter.createDirectory(root, name.trim(), false);
  }

  protected async moveUp(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    this.closeMenu();
    await this.chapter.moveNode(m.node, 'up');
  }

  protected async moveDown(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    this.closeMenu();
    await this.chapter.moveNode(m.node, 'down');
  }

  /** Devuelve todos los .odt/.docx descendientes que NO tienen .html sibling. */
  private collectImportable(root: TreeNode): TreeNode[] {
    const out: TreeNode[] = [];
    this.walk(root, (n) => {
      if (
        n.kind === 'chapter' &&
        (n.ext === 'odt' || n.ext === 'docx') &&
        !this.hasHtmlSibling(n, root)
      ) {
        out.push(n);
      }
    });
    return out;
  }

  /** Devuelve todos los .odt/.docx descendientes que SÍ tienen .html sibling. */
  private collectCleanable(root: TreeNode): TreeNode[] {
    const out: TreeNode[] = [];
    this.walk(root, (n) => {
      if (
        n.kind === 'chapter' &&
        (n.ext === 'odt' || n.ext === 'docx') &&
        this.hasHtmlSibling(n, root)
      ) {
        out.push(n);
      }
    });
    return out;
  }

  private hasHtmlSibling(node: TreeNode, root: TreeNode | null = this.root()): boolean {
    if (!root) return false;
    const parent = this.findParent(root, node);
    if (!parent) return false;
    const stem = node.name;
    return parent.children.some(
      (c) => c.kind === 'chapter' && c.ext === 'html' && c.name === stem,
    );
  }

  private findParent(node: TreeNode, target: TreeNode): TreeNode | null {
    for (const c of node.children) {
      if (c.path === target.path) return node;
      const found = this.findParent(c, target);
      if (found) return found;
    }
    return null;
  }

  private walk(node: TreeNode, fn: (n: TreeNode) => void): void {
    fn(node);
    for (const c of node.children) this.walk(c, fn);
  }
}
