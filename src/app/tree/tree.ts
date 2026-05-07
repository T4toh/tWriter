import { Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { BookConfigService } from '../core/book-config-service';
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
  private bookCfg = inject(BookConfigService);

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
        exportEpub: false,
        configBook: false,
        excludable: false,
        includable: false,
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
        exportEpub: false,
        configBook: false,
        excludable: false,
        includable: false,
      };
    }
    const importable = this.collectImportable(node);
    const cleanable = this.collectCleanable(node);
    const isExcluded = !!node.excluded;
    return {
      importThis: false,
      deleteOriginal: false,
      deleteFile: false,
      deleteDir: true,
      importBulk: isExcluded ? 0 : importable.length,
      cleanupBulk: isExcluded ? 0 : cleanable.length,
      createChapter: !isExcluded && (node.kind === 'book' || node.kind === 'section'),
      createSection: !isExcluded && node.kind === 'book',
      createBook: !isExcluded && node.kind === 'saga',
      createSaga: false,
      moveable: !isExcluded && node.kind !== 'saga' && this.isMoveable(node),
      exportEpub: !isExcluded && node.kind === 'book',
      configBook: !isExcluded && node.kind === 'book',
      excludable: !isExcluded,
      includable: isExcluded,
    };
  });

  private isMoveable(node: TreeNode): boolean {
    if (node.kind === 'chapter') {
      return /^\d+$/.test(node.name);
    }
    return /^\d+\s*-/.test(node.name);
  }

  /** Estado explícito por path: true = expanded, false = collapsed. Si no está en el map, usa default. */
  private readonly explicit = signal<Map<string, boolean>>(new Map());
  /** Override global. null = usa defaults + explicit. */
  private readonly forceState = signal<'collapsed' | 'expanded' | null>(null);

  protected isExpanded(node: TreeNode): boolean {
    const force = this.forceState();
    if (force === 'collapsed') return false;
    if (force === 'expanded') return true;
    const e = this.explicit().get(node.path);
    if (e !== undefined) return e;
    if (node.kind === 'saga' || node.kind === 'book') return true;
    return this.ancestorPaths().has(node.path);
  }

  protected toggle(node: TreeNode): void {
    this.nav.setBrowsing(node.path);
    this.chapter.close();
    const wasExpanded = this.isExpanded(node);
    if (this.forceState() !== null) {
      this.forceState.set(null);
    }
    this.explicit.update((m) => {
      const next = new Map(m);
      next.set(node.path, !wasExpanded);
      return next;
    });
  }

  protected collapseAll(): void {
    this.explicit.set(new Map());
    this.forceState.set('collapsed');
  }

  protected expandAll(): void {
    this.explicit.set(new Map());
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

  protected async exportEpub(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    this.closeMenu();
    await this.chapter.exportEpub(m.node);
  }

  protected configBook(): void {
    const m = this.menu();
    if (!m || !m.node) return;
    this.closeMenu();
    this.bookCfg.openFor(m.node);
  }

  protected async excludeFolder(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    const node = m.node;
    this.closeMenu();
    const msg = `Excluir "${node.name}" del export EPUB?\nSigue visible en el árbol pero no se incluye al armar el libro.`;
    if (!confirm(msg)) return;
    try {
      await invoke('set_directory_excluded', { path: node.path, excluded: true });
      await this.project.loadTree();
    } catch (e) {
      alert(`No se pudo excluir: ${e}`);
    }
  }

  protected async includeFolder(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    const node = m.node;
    this.closeMenu();
    try {
      await invoke('set_directory_excluded', { path: node.path, excluded: false });
      await this.project.loadTree();
    } catch (e) {
      alert(`No se pudo incluir: ${e}`);
    }
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
