import { Component, HostListener, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { BookConfigService } from '../core/book-config-service';
import { ChapterService } from '../core/chapter-service';
import { ExtraEntry, ExtrasService } from '../core/extras-service';
import { ExportEntry, ExportsService } from '../core/exports-service';
import { ImageViewerService } from '../core/image-viewer-service';
import { NavigationService } from '../core/navigation-service';
import { SagaConfigService } from '../core/saga-config-service';
import { ProjectService } from '../core/project-service';
import { SettingsService } from '../core/settings-service';
import { ToastService } from '../core/toast-service';
import { TreeNode } from '../core/types';

interface ContextMenu {
  x: number;
  y: number;
  node: TreeNode | null;
  extra: { scopePath: string; entry: ExtraEntry } | null;
}

@Component({
  selector: 'app-tree',
  imports: [NgTemplateOutlet],
  templateUrl: './tree.html',
  styleUrl: './tree.scss',
})
export class Tree implements OnDestroy {
  private project = inject(ProjectService);
  private chapter = inject(ChapterService);
  private settings = inject(SettingsService);
  private nav = inject(NavigationService);
  private bookCfg = inject(BookConfigService);
  private sagaCfg = inject(SagaConfigService);
  private extras = inject(ExtrasService);
  private exports = inject(ExportsService);
  private imageViewer = inject(ImageViewerService);
  private toast = inject(ToastService);

  protected readonly root = this.project.tree;
  protected readonly loading = this.project.loading;
  protected readonly error = this.project.error;
  protected readonly activePath = computed(() => this.chapter.active()?.path ?? null);
  protected readonly browsingPath = this.nav.browsingPath;
  protected readonly currentPath = computed(
    () => this.activePath() ?? this.browsingPath(),
  );
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
  protected readonly menu = signal<ContextMenu | null>(null);
  /** Path del scope (saga/book) que está siendo target de drag&drop OS files. */
  protected readonly dragOverScope = signal<string | null>(null);

  private dragUnlisten: (() => void) | null = null;

  constructor() {
    void this.bindDragDrop();
    effect(() => {
      // Limpiar cache cuando cambia el root del proyecto
      this.project.root();
      this.extras.clear();
      this.exports.clear();
    });
  }

  ngOnDestroy(): void {
    this.dragUnlisten?.();
  }

  protected getExtras(scopePath: string): ExtraEntry[] {
    return this.extras.get(scopePath);
  }

  protected hasLoadedExtras(scopePath: string): boolean {
    return this.extras.hasLoaded(scopePath);
  }

  protected getExports(bookPath: string): ExportEntry[] {
    return this.exports.get(bookPath);
  }

  protected hasLoadedExports(bookPath: string): boolean {
    return this.exports.hasLoaded(bookPath);
  }

  /** Acciones disponibles para el nodo del menú. */
  protected readonly menuActions = computed(() => {
    const m = this.menu();
    if (!m) return null;
    if (m.extra) {
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
        createSaga: false,
        moveable: false,
        exportEpub: false,
        configBook: false,
        configSaga: false,
        excludable: false,
        includable: false,
        addExtra: false,
        openExtra: true,
        renameExtra: true,
        removeExtra: true,
        markAsEpilogo: false,
        renameable: false,
      };
    }
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
        configSaga: false,
        excludable: false,
        includable: false,
        addExtra: false,
        openExtra: false,
        renameExtra: false,
        removeExtra: false,
        markAsEpilogo: false,
        renameable: false,
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
        configSaga: false,
        excludable: false,
        includable: false,
        addExtra: false,
        openExtra: false,
        renameExtra: false,
        removeExtra: false,
        markAsEpilogo: false,
        renameable: true,
      };
    }
    const importable = this.collectImportable(node);
    const cleanable = this.collectCleanable(node);
    const isExcluded = !!node.excluded;
    const canAddExtra = !isExcluded && (node.kind === 'saga' || node.kind === 'book');
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
      configSaga: !isExcluded && node.kind === 'saga',
      excludable: !isExcluded,
      includable: isExcluded,
      addExtra: canAddExtra,
      openExtra: false,
      renameExtra: false,
      removeExtra: false,
      markAsEpilogo: !isExcluded && node.kind === 'section' && isEpilogoName(node.name),
      renameable: !isExcluded,
    };
  });

  private isMoveable(node: TreeNode): boolean {
    if (node.kind === 'chapter') {
      return /^\d+$/.test(node.name);
    }
    return /^\d+\s*-/.test(node.name);
  }

  private readonly explicit = signal<Map<string, boolean>>(new Map());
  private readonly forceState = signal<'collapsed' | 'expanded' | null>(null);
  /** Estado expand/collapse de la sección Extras por scopePath. Default: collapsed. */
  private readonly extrasExpanded = signal<Set<string>>(new Set());
  /** Estado expand/collapse de la sección Exportados por bookPath. Default: collapsed. */
  private readonly exportsExpanded = signal<Set<string>>(new Set());

  protected isExpanded(node: TreeNode): boolean {
    const force = this.forceState();
    if (force === 'collapsed') return false;
    if (force === 'expanded') return true;
    const e = this.explicit().get(node.path);
    if (e !== undefined) return e;
    if (node.kind === 'saga' || node.kind === 'book') return true;
    return this.ancestorPaths().has(node.path);
  }

  protected isExtrasExpanded(scopePath: string): boolean {
    return this.extrasExpanded().has(scopePath);
  }

  protected toggleExtras(scopePath: string): void {
    const expanded = this.extrasExpanded().has(scopePath);
    this.extrasExpanded.update((s) => {
      const next = new Set(s);
      if (expanded) next.delete(scopePath);
      else next.add(scopePath);
      return next;
    });
    if (!expanded && !this.extras.hasLoaded(scopePath)) {
      void this.refreshExtras(scopePath);
    }
  }

  private async refreshExtras(scopePath: string): Promise<void> {
    try {
      await this.extras.refresh(scopePath);
    } catch (e) {
      this.toast.error(`No se pudieron cargar extras: ${e}`);
    }
  }

  protected isExportsExpanded(bookPath: string): boolean {
    return this.exportsExpanded().has(bookPath);
  }

  protected toggleExports(bookPath: string): void {
    const expanded = this.exportsExpanded().has(bookPath);
    this.exportsExpanded.update((s) => {
      const next = new Set(s);
      if (expanded) next.delete(bookPath);
      else next.add(bookPath);
      return next;
    });
    if (!expanded && !this.exports.hasLoaded(bookPath)) {
      void this.refreshExports(bookPath);
    }
  }

  private async refreshExports(bookPath: string): Promise<void> {
    try {
      await this.exports.refresh(bookPath);
    } catch (e) {
      this.toast.error(`No se pudieron cargar exportados: ${e}`);
    }
  }

  protected async openExportEntry(entry: ExportEntry): Promise<void> {
    try {
      await openPath(entry.path);
    } catch (e) {
      this.toast.error(`No se pudo abrir: ${e}`);
    }
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
    this.extrasExpanded.set(new Set());
    this.exportsExpanded.set(new Set());
  }

  protected expandAll(): void {
    this.explicit.set(new Map());
    this.forceState.set('expanded');
  }

  protected async select(node: TreeNode): Promise<void> {
    if (node.kind === 'chapter') {
      const parentPath = node.path.replace(/\/[^/]+$/, '');
      this.nav.setBrowsing(parentPath);
      await this.chapter.open(node);
    }
  }

  protected onContextMenu(event: MouseEvent, node: TreeNode): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({ x: event.clientX, y: event.clientY, node, extra: null });
  }

  protected onExtraContextMenu(event: MouseEvent, scopePath: string, entry: ExtraEntry): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({ x: event.clientX, y: event.clientY, node: null, extra: { scopePath, entry } });
  }

  protected onEmptyContext(event: MouseEvent): void {
    event.preventDefault();
    this.menu.set({ x: event.clientX, y: event.clientY, node: null, extra: null });
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
    await this.chapter.createBook(m.node.path, name.trim());
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

  protected configSaga(): void {
    const m = this.menu();
    if (!m || !m.node) return;
    this.closeMenu();
    this.sagaCfg.openFor(m.node);
  }

  protected async renameNode(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    const node = m.node;
    this.closeMenu();
    await this.renameNodeFor(node);
  }

  @HostListener('window:keydown.F2', ['$event'])
  protected onF2(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (target && target.matches('input, textarea, [contenteditable="true"]')) {
      return;
    }
    const m = this.menu();
    const node = m?.node ?? this.chapter.active() ?? this.findNodeByPath(this.root(), this.browsingPath() ?? '');
    if (!node) return;
    event.preventDefault();
    if (m) this.closeMenu();
    void this.renameNodeFor(node);
  }

  private async renameNodeFor(node: TreeNode): Promise<void> {
    const current = node.kind === 'chapter' && node.ext
      ? `${node.name}.${node.ext}`
      : node.name;
    const input = prompt('Nuevo nombre:', current);
    if (!input) return;
    const trimmed = input.trim();
    if (!trimmed || trimmed === current) return;
    const wasActive = this.chapter.active()?.path === node.path;
    try {
      const newPath = await invoke<string>('rename_node', {
        path: node.path,
        newName: trimmed,
      });
      await this.project.loadTree();
      if (wasActive) {
        const newNode = this.findNodeByPath(this.root(), newPath);
        if (newNode) await this.chapter.open(newNode);
      }
      this.toast.success(`Renombrado a "${trimmed}"`);
    } catch (err) {
      this.toast.error(`Renombrar: ${err}`);
    }
  }

  private findNodeByPath(root: TreeNode | null, path: string): TreeNode | null {
    if (!root) return null;
    if (root.path === path) return root;
    for (const c of root.children) {
      const found = this.findNodeByPath(c, path);
      if (found) return found;
    }
    return null;
  }

  protected async markAsEpilogo(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node || m.node.kind !== 'section') return;
    const section = m.node;
    this.closeMenu();
    try {
      await invoke<string>('mark_as_epilogo', { sectionPath: section.path });
      await this.project.loadTree();
      this.toast.success(`"${section.name}" marcado como epílogo`);
    } catch (err) {
      this.toast.error(`Marcar epílogo: ${err}`);
    }
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

  protected async addExtraFromMenu(): Promise<void> {
    const m = this.menu();
    if (!m || !m.node) return;
    const scopePath = m.node.path;
    this.closeMenu();
    await this.pickAndAddExtras(scopePath);
  }

  private async pickAndAddExtras(scopePath: string): Promise<void> {
    const result = await openDialog({
      multiple: true,
      directory: false,
      title: 'Agregar extra(s)',
    });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    await this.addExtraFiles(scopePath, paths);
  }

  private async addExtraFiles(scopePath: string, paths: string[]): Promise<void> {
    let added = 0;
    let failed = 0;
    for (const p of paths) {
      try {
        await this.extras.addFromPath(scopePath, p);
        added++;
      } catch (e) {
        failed++;
        this.toast.error(`Falló agregar ${p}: ${e}`);
      }
    }
    if (added > 0) {
      this.extrasExpanded.update((s) => new Set([...s, scopePath]));
      this.toast.info(`Agregado${added === 1 ? '' : 's'} ${added} extra${added === 1 ? '' : 's'}.`);
    }
    if (failed > 0 && added === 0) {
      this.toast.error(`No se pudo agregar ningún extra.`);
    }
  }

  protected async openExtra(): Promise<void> {
    const m = this.menu();
    if (!m || !m.extra) return;
    const entry = m.extra.entry;
    this.closeMenu();
    if (entry.kind === 'image') {
      void this.imageViewer.open(entry);
      return;
    }
    try {
      await openPath(entry.path);
    } catch (e) {
      this.toast.error(`No se pudo abrir: ${e}`);
    }
  }

  protected async renameExtra(): Promise<void> {
    const m = this.menu();
    if (!m || !m.extra) return;
    const { scopePath, entry } = m.extra;
    this.closeMenu();
    const newName = prompt('Nuevo nombre del archivo:', entry.name);
    if (!newName?.trim() || newName.trim() === entry.name) return;
    try {
      await this.extras.rename(scopePath, entry.relative_path, newName.trim());
    } catch (e) {
      this.toast.error(`No se pudo renombrar: ${e}`);
    }
  }

  protected async removeExtra(): Promise<void> {
    const m = this.menu();
    if (!m || !m.extra) return;
    const { scopePath, entry } = m.extra;
    this.closeMenu();
    if (!confirm(`Borrar extra "${entry.name}"?\nEl archivo se borra de disco.`)) return;
    try {
      await this.extras.remove(scopePath, entry.relative_path);
    } catch (e) {
      this.toast.error(`No se pudo borrar: ${e}`);
    }
  }

  protected async openExtraEntry(_scopePath: string, entry: ExtraEntry): Promise<void> {
    if (entry.kind === 'image') {
      void this.imageViewer.open(entry);
      return;
    }
    try {
      await openPath(entry.path);
    } catch (e) {
      this.toast.error(`No se pudo abrir: ${e}`);
    }
  }

  private async bindDragDrop(): Promise<void> {
    try {
      const webview = getCurrentWebview();
      const unlisten = await webview.onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') {
          const scope = this.scopeAtPosition(payload.position.x, payload.position.y);
          this.dragOverScope.set(scope);
        } else if (payload.type === 'drop') {
          const scope = this.scopeAtPosition(payload.position.x, payload.position.y);
          this.dragOverScope.set(null);
          if (scope && payload.paths.length > 0) {
            void this.addExtraFiles(scope, payload.paths);
          }
        } else {
          this.dragOverScope.set(null);
        }
      });
      this.dragUnlisten = unlisten;
    } catch {
      // En tests/SSR / no-Tauri queda sin drag&drop; ok.
    }
  }

  /** Convierte coordenadas físicas del webview a CSS y devuelve scopePath del nodo target. */
  private scopeAtPosition(physX: number, physY: number): string | null {
    const dpr = window.devicePixelRatio || 1;
    const x = physX / dpr;
    const y = physY / dpr;
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const row = (el as HTMLElement).closest<HTMLElement>('[data-extra-scope]');
    if (!row) return null;
    return row.dataset['extraScope'] ?? null;
  }

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

function isEpilogoName(name: string): boolean {
  const stripped = name.replace(/^\d+\s*-\s*/, '').trim().toLowerCase();
  const flat = stripped.normalize('NFD').replace(/\p{M}/gu, '');
  return flat === 'epilogo' || flat === 'epilogue';
}
