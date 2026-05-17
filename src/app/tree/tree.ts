import { Component, HostListener, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { ChapterService } from '../core/chapter-service';
import { DebugService } from '../core/debug-service';
import { buildExtrasTree, ExtraEntry, ExtrasNode, ExtrasService } from '../core/extras-service';
import { FontPreviewService } from '../core/font-preview-service';
import { NoteService } from '../core/note-service';
import { ExportEntry, ExportsService } from '../core/exports-service';
import { FontsService } from '../core/fonts-service';
import { NavigationService } from '../core/navigation-service';
import { PaneSplitService } from '../core/pane-split-service';
import { ProjectService } from '../core/project-service';
import { SettingsService } from '../core/settings-service';
import { ThemesService } from '../core/themes-service';
import { ToastService } from '../core/toast-service';
import { FontEntry, ThemeMeta, TreeNode } from '../core/types';
import { ModalService } from '../shared/modal-service';
import { ContextMenuService } from '../shared/context-menu-service';
import { NodeActionsService } from '../shared/node-actions-service';

const FONT_EXT_RE = /\.(ttf|otf|woff|woff2)$/i;
type DropScope =
  | { kind: 'fs'; path: string }
  | { kind: 'theme'; id: string };

type DropListChildKind = 'saga' | 'book' | 'section' | 'chapter' | 'note';

interface DropListData {
  parentPath: string;
  childKind: string;
}

@Component({
  selector: 'app-tree',
  imports: [NgTemplateOutlet, CdkDropList, CdkDrag],
  templateUrl: './tree.html',
  styleUrl: './tree.scss',
})
export class Tree implements OnDestroy {
  private project = inject(ProjectService);
  private chapter = inject(ChapterService);
  private note = inject(NoteService);
  private settings = inject(SettingsService);
  private nav = inject(NavigationService);
  private extras = inject(ExtrasService);
  private exports = inject(ExportsService);
  private fonts = inject(FontsService);
  private fontPreview = inject(FontPreviewService);
  private themesSvc = inject(ThemesService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private ctxMenu = inject(ContextMenuService);
  private actions = inject(NodeActionsService);
  private debug = inject(DebugService);
  private paneSplit = inject(PaneSplitService);

  /** Cache de fuentes per-scope (back-compat: el modal de novela todavía lee saga/book/fonts). */
  private readonly fontsLoaded = signal<Set<string>>(new Set());
  /** Estado expand/collapse del Fuentes global (single root pool). */
  protected readonly rootFontsExpanded = signal<boolean>(false);
  /** Familias en uso por algún tema/saga/libro (lowercase). */
  private readonly usedFamilies = signal<Set<string>>(new Set());
  /** Stems en uso (lowercase). */
  private readonly usedStems = signal<Set<string>>(new Set());
  /** Cantidad de fuentes del root pool sin uso conocido. */
  protected readonly unusedRootFontsCount = computed(() => {
    return this.getRootFonts().filter((f) => !this.isFontUsed(f)).length;
  });
  protected readonly themesExpanded = signal<boolean>(false);
  /** Path/id que está siendo target de drag&drop OS para themes. null = no theme target. */
  protected readonly dragOverTheme = signal<string | null>(null);

  protected readonly root = this.project.tree;
  protected readonly loading = this.project.loading;
  protected readonly error = this.project.error;
  protected readonly activePath = computed(
    () => this.note.active()?.path ?? this.chapter.active()?.path ?? null,
  );
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
  /** Path del scope (saga/book) que está siendo target de drag&drop OS files. */
  protected readonly dragOverScope = signal<string | null>(null);

  private readonly explicit = signal<Map<string, boolean>>(new Map());
  private readonly forceState = signal<'collapsed' | 'expanded' | null>(null);
  /** Estado expand/collapse de la sección Extras por scopePath. Default: collapsed. */
  private readonly extrasExpanded = signal<Set<string>>(new Set());
  /** Estado expand/collapse de subdirs dentro de Extras. Key: `${scopePath}::${relPath}`. */
  private readonly extrasDirsExpanded = signal<Set<string>>(new Set());
  /** Estado expand/collapse de la sección Exportados por bookPath. Default: collapsed. */
  private readonly exportsExpanded = signal<Set<string>>(new Set());

  private dragUnlisten: (() => void) | null = null;
  /** Guard para que la hidratación desde settings corra una sola vez al boot. */
  private hydratedFromSettings = false;

  constructor() {
    void this.bindDragDrop();
    effect(() => {
      // Limpiar cache cuando cambia el root del proyecto
      this.project.root();
      this.extras.clear();
      this.exports.clear();
      this.fonts.clear();
      this.fontsLoaded.set(new Set());
      this.rootFontsExpanded.set(false);
      this.themesExpanded.set(false);
    });
    // Hidrar estado de expansión desde settings.json (paths persistidos en la
    // sesión anterior). Una sola vez, después de que SettingsService.load()
    // termine — antes los signals son strings vacíos y limpiar acá pisaría
    // potenciales toggles que el usuario haga durante el boot.
    effect(() => {
      if (!this.settings.loaded() || this.hydratedFromSettings) return;
      this.hydratedFromSettings = true;
      const expanded = this.settings.treeExpanded();
      if (expanded.size > 0) {
        const m = new Map<string, boolean>();
        for (const path of expanded) m.set(path, true);
        this.explicit.set(m);
      }
      const extras = this.settings.treeExtrasExpanded();
      if (extras.size > 0) this.extrasExpanded.set(new Set(extras));
      const extrasDirs = this.settings.treeExtrasDirsExpanded();
      if (extrasDirs.size > 0) this.extrasDirsExpanded.set(new Set(extrasDirs));
      const exports = this.settings.treeExportsExpanded();
      if (exports.size > 0) this.exportsExpanded.set(new Set(exports));
    });
  }

  /** Persiste el subset del Map `explicit` con value=true como lista de paths.
   *  Excluye paths con value=false (collapse explícito sobre default expandido). */
  private persistExpanded(): void {
    const expanded = new Set<string>();
    for (const [path, value] of this.explicit().entries()) {
      if (value) expanded.add(path);
    }
    this.settings.setTreeExpanded(expanded);
  }

  ngOnDestroy(): void {
    this.dragUnlisten?.();
  }

  // ───── Extras / exports (left-click + UI state) ─────

  protected getExtras(scopePath: string): ExtraEntry[] {
    return this.extras.get(scopePath);
  }

  protected getExtrasTree(scopePath: string): ExtrasNode[] {
    return buildExtrasTree(this.extras.get(scopePath));
  }

  protected isExtrasDirExpanded(scopePath: string, relPath: string): boolean {
    return this.extrasDirsExpanded().has(`${scopePath}::${relPath}`);
  }

  protected toggleExtrasDir(scopePath: string, relPath: string): void {
    const key = `${scopePath}::${relPath}`;
    this.extrasDirsExpanded.update((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    this.settings.setTreeExtrasDirsExpanded(this.extrasDirsExpanded());
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
    this.settings.setTreeExtrasExpanded(this.extrasExpanded());
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
    this.settings.setTreeExportsExpanded(this.exportsExpanded());
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

  // ───── Drag interno (tree → center) para split ─────

  protected onNodeDragStart(event: DragEvent, node: TreeNode): void {
    if (node.kind !== 'chapter' && node.kind !== 'note') return;
    if (node.kind === 'chapter' && !node.editable) return;
    const payload = { path: node.path, kind: node.kind };
    if (event.dataTransfer) {
      event.dataTransfer.setData('application/x-twriter-node', JSON.stringify(payload));
      event.dataTransfer.effectAllowed = 'copy';
    }
    this.paneSplit.beginDrag(payload);
  }

  protected onNodeDragEnd(): void {
    this.paneSplit.endDrag();
  }

  // ───── CDK DnD interno (reorder + cross-parent) ─────

  protected dropListId(parentPath: string, childKind: string): string {
    return `dl::${childKind}::${parentPath}`;
  }

  /** Kind primario que el container acepta como children draggable. */
  protected childKindFor(parentKind: TreeNode['kind']): string | null {
    switch (parentKind) {
      case 'saga':
        return 'book';
      case 'book':
        return 'section';
      case 'section':
        return 'chapter';
      case 'notes':
      case 'folder':
        return 'note';
      default:
        return null;
    }
  }

  /** Filtra children por kind. Para casos como book con secciones + capítulos directos. */
  protected childrenOfKind(node: TreeNode, kind: string | null): TreeNode[] {
    if (!kind) return [];
    return node.children.filter((c) => c.kind === kind);
  }

  /** Children que NO son del kind primario (notes folders dentro de un libro, etc.). */
  protected childrenOfOtherKinds(
    node: TreeNode,
    primary: string | null,
  ): TreeNode[] {
    if (!primary) return node.children.slice();
    return node.children.filter((c) => c.kind !== primary);
  }

  protected readonly dropListIds = computed(() => {
    const r = this.root();
    const out: Record<DropListChildKind, string[]> = {
      saga: [],
      book: [],
      section: [],
      chapter: [],
      note: [],
    };
    if (!r) return out;
    out.saga.push(this.dropListId(r.path, 'saga'));
    const walk = (n: TreeNode): void => {
      if (n.kind === 'saga') out.book.push(this.dropListId(n.path, 'book'));
      if (n.kind === 'book') out.section.push(this.dropListId(n.path, 'section'));
      if (n.kind === 'section') out.chapter.push(this.dropListId(n.path, 'chapter'));
      if (n.kind === 'notes' || n.kind === 'folder') {
        out.note.push(this.dropListId(n.path, 'note'));
      }
      for (const c of n.children) walk(c);
    };
    walk(r);
    return out;
  });

  protected connectedFor(parentKind: TreeNode['kind']): string[] {
    const k = this.childKindFor(parentKind);
    if (!k) return [];
    const map = this.dropListIds() as Record<string, string[]>;
    return map[k] ?? [];
  }

  protected isDraggable(node: TreeNode): boolean {
    if (node.kind === 'notes' || node.kind === 'folder') return false;
    if (node.excluded) return false;
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async onDropList(event: CdkDragDrop<any>): Promise<void> {
    if (
      event.previousContainer === event.container &&
      event.previousIndex === event.currentIndex
    ) {
      return;
    }
    const dragged: TreeNode = event.item.data;
    const dst = event.container.data as DropListData;
    if (
      dst.parentPath === dragged.path ||
      dst.parentPath.startsWith(dragged.path + '/')
    ) {
      this.toast.error('No se puede mover un nodo dentro de sí mismo.');
      return;
    }
    await this.chapter.relocateNode(
      dragged.path,
      dst.parentPath,
      event.currentIndex,
    );
  }

  protected openExtraEntry(scopePath: string, entry: ExtraEntry, event?: MouseEvent): void {
    if (isMarkdownExt(entry.ext) && !event?.shiftKey) {
      void this.actions.openMdInReader({ path: entry.path, name: entry.name });
      return;
    }
    void this.actions.openExtra(scopePath, entry);
  }

  protected openExtraInEditor(scopePath: string, entry: ExtraEntry): void {
    if (!isMarkdownExt(entry.ext)) return;
    void this.actions.openExtra(scopePath, entry);
  }

  // ───── Fonts (single root pool) ─────

  /** Path del pool global de fuentes (<root>). null si no hay root elegido. */
  protected readonly rootFontsPath = computed(() => this.settings.root());

  protected getRootFonts(): FontEntry[] {
    const path = this.rootFontsPath();
    if (!path) return [];
    return this.fonts.get(path);
  }

  protected hasLoadedRootFonts(): boolean {
    const path = this.rootFontsPath();
    if (!path) return false;
    return this.fontsLoaded().has(path);
  }

  protected isRootFontsExpanded(): boolean {
    return this.rootFontsExpanded();
  }

  protected toggleRootFonts(): void {
    const expanded = this.rootFontsExpanded();
    this.rootFontsExpanded.set(!expanded);
    const path = this.rootFontsPath();
    if (!expanded && path && !this.hasLoadedRootFonts()) {
      void this.refreshRootFonts();
    }
  }

  private async refreshRootFonts(): Promise<void> {
    const path = this.rootFontsPath();
    if (!path) return;
    try {
      const [, usage] = await Promise.all([
        this.fonts.refresh(path),
        invoke<{ families: string[]; stems: string[] }>('list_font_usage', {
          rootPath: path,
        }),
      ]);
      this.usedFamilies.set(new Set(usage.families.map((s) => s.toLowerCase())));
      this.usedStems.set(new Set(usage.stems.map((s) => s.toLowerCase())));
      this.fontsLoaded.update((s) => new Set([...s, path]));
    } catch (e) {
      this.toast.error(`No se pudieron cargar fuentes: ${e}`);
    }
  }

  protected isFontUsed(entry: FontEntry): boolean {
    const fams = this.usedFamilies();
    const stems = this.usedStems();
    if (fams.has(entry.family.toLowerCase())) return true;
    const stem = entry.name.replace(/\.[^.]+$/, '').toLowerCase();
    return stems.has(stem);
  }

  protected async cleanupUnusedFonts(event: Event): Promise<void> {
    event.stopPropagation();
    const root = this.rootFontsPath();
    if (!root) {
      this.toast.error('Elegí una carpeta raíz primero.');
      return;
    }
    const unused = this.getRootFonts().filter((f) => !this.isFontUsed(f));
    if (unused.length === 0) {
      this.toast.info('No hay fuentes sin uso para borrar.');
      return;
    }
    const ok = await this.modal.confirm({
      title: 'Borrar fuentes sin uso',
      message: `Borrar ${unused.length} fuente${unused.length === 1 ? '' : 's'} que ningún tema, saga ni novela usa?\nSe eliminan del disco — operación irreversible.`,
      okLabel: 'Borrar',
      danger: true,
    });
    if (!ok) return;
    let done = 0;
    let failed = 0;
    for (const f of unused) {
      try {
        await this.fonts.remove(root, f.relative_path);
        done++;
      } catch (e) {
        failed++;
        this.debug.error('fonts', `cleanup ${f.name}: ${e}`);
      }
    }
    await this.refreshRootFonts();
    if (failed === 0) {
      this.toast.success(`${done} fuente${done === 1 ? '' : 's'} sin uso borrada${done === 1 ? '' : 's'}.`);
    } else {
      this.toast.warn(`${done} borradas, ${failed} fallaron — ver panel debug.`);
    }
  }

  protected openFont(entry: FontEntry): void {
    this.fontPreview.open(entry);
  }

  // ───── Themes (root level) ─────

  protected readonly themesList = computed(() => this.themesSvc.list());

  protected isThemesExpanded(): boolean {
    return this.themesExpanded();
  }

  protected toggleThemes(): void {
    const expanded = this.themesExpanded();
    this.themesExpanded.set(!expanded);
    if (!expanded && !this.themesSvc.hasLoaded()) {
      void this.refreshThemes();
    }
  }

  private async refreshThemes(): Promise<void> {
    try {
      await this.themesSvc.refresh();
    } catch (e) {
      this.toast.error(`No se pudieron cargar temas: ${e}`);
    }
  }

  protected openTheme(theme: ThemeMeta): void {
    this.themesSvc.openEditor(theme.id);
  }

  /** Crear tema desde plantilla. UI-specific por el auto-expand de la sección "Temas". */
  protected async createTheme(): Promise<void> {
    if (!this.settings.root()) {
      this.toast.error('Elegí una carpeta primero');
      return;
    }
    if (!this.themesSvc.hasLoaded()) {
      await this.themesSvc.refresh();
    }
    const themes = this.themesSvc.list();
    const opciones = [
      { value: '', label: '(vacío)' },
      ...themes.map((t) => ({
        value: t.id,
        label: t.nombre && t.nombre !== t.id ? `${t.id} — ${t.nombre}` : t.id,
      })),
    ];
    const res = await this.modal.selectPrompt({
      title: 'Nuevo tema',
      selectLabel: 'Plantilla',
      selectOptions: opciones,
      selectDefault: '',
      inputLabel: 'ID del tema (slug, sin espacios — ej: "reedsy-classic")',
      inputPlaceholder: 'reedsy-classic',
      okLabel: 'Crear',
      validate: ({ selected, value }) => {
        const t = value.trim();
        if (!t) return 'ID vacío';
        if (t.includes('/') || t.includes('\\')) return 'Sin barras / o \\';
        if (t.includes(' ')) return 'Sin espacios; usá guiones';
        if (t === selected) return 'Mismo ID que la plantilla';
        if (themes.some((x) => x.id === t)) return 'Ya existe un tema con ese ID';
        return null;
      },
    });
    if (!res) return;
    const slug = res.value.trim();
    try {
      if (res.selected) {
        await this.themesSvc.duplicate(res.selected, slug);
      } else {
        await this.themesSvc.create(slug, { id: slug, nombre: slug });
      }
      this.themesExpanded.set(true);
      this.themesSvc.openEditor(slug);
    } catch (e) {
      this.toast.error(`No se pudo crear: ${e}`);
    }
  }

  // ───── Tree expansion / navigation ─────

  protected displayName(node: TreeNode): string {
    return node.kind === 'saga'
      ? node.name.replace(/^\d+\s*-\s*/, '')
      : node.name;
  }

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
    this.note.close();
    const wasExpanded = this.isExpanded(node);
    if (this.forceState() !== null) {
      this.forceState.set(null);
    }
    this.explicit.update((m) => {
      const next = new Map(m);
      next.set(node.path, !wasExpanded);
      return next;
    });
    this.persistExpanded();
  }

  protected collapseAll(): void {
    this.explicit.set(new Map());
    this.forceState.set('collapsed');
    this.extrasExpanded.set(new Set());
    this.exportsExpanded.set(new Set());
    this.persistExpanded();
    this.settings.setTreeExtrasExpanded(new Set());
    this.settings.setTreeExportsExpanded(new Set());
  }

  protected expandAll(): void {
    this.explicit.set(new Map());
    this.forceState.set('expanded');
    this.persistExpanded();
  }

  protected async select(node: TreeNode, event?: MouseEvent): Promise<void> {
    if (node.kind === 'chapter') {
      const parentPath = node.path.replace(/\/[^/]+$/, '');
      this.nav.setBrowsing(parentPath);
      this.note.close();
      await this.chapter.open(node);
    } else if (node.kind === 'note') {
      if (event?.shiftKey) {
        const parentPath = node.path.replace(/\/[^/]+$/, '');
        this.nav.setBrowsing(parentPath);
        await this.note.open({ path: node.path, name: node.name });
        return;
      }
      // Reader en panel derecho — no toca el centro ni la navegación.
      await this.actions.openMdInReader({ path: node.path, name: node.name });
    }
  }

  /** Double-click: abre la nota en el editor central, ahorrando el "click + ✏️"
   *  del reader. Mismo efecto que Shift+click. */
  protected async openNoteInEditor(node: TreeNode): Promise<void> {
    if (node.kind !== 'note') return;
    const parentPath = node.path.replace(/\/[^/]+$/, '');
    this.nav.setBrowsing(parentPath);
    await this.note.open({ path: node.path, name: node.name });
  }

  // ───── Context menus (delegan al NodeActionsService) ─────

  protected onContextMenu(event: MouseEvent, node: TreeNode): void {
    this.ctxMenu.open(event, this.actions.buildNodeMenu(node));
  }

  protected onExtraContextMenu(event: MouseEvent, scopePath: string, entry: ExtraEntry): void {
    this.ctxMenu.open(event, this.actions.buildExtraMenu(scopePath, entry));
  }

  protected onEmptyContext(event: MouseEvent): void {
    const items = this.actions.buildEmptyMenu();
    if (items.length === 0) return; // dejá burbujar al handler global
    this.ctxMenu.open(event, items);
  }

  protected onThemeContextMenu(event: MouseEvent, theme: ThemeMeta): void {
    this.ctxMenu.open(event, this.actions.buildThemeMenu(theme));
  }

  protected onFontContextMenu(event: MouseEvent, scopePath: string, entry: FontEntry): void {
    this.ctxMenu.open(event, this.actions.buildFontMenu(scopePath, entry));
  }

  @HostListener('window:keydown.F2', ['$event'])
  protected onF2(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (target && target.matches('input, textarea, [contenteditable="true"]')) {
      return;
    }
    const node = this.chapter.active() ?? findNodeByPath(this.root(), this.browsingPath() ?? '');
    if (!node) return;
    event.preventDefault();
    this.ctxMenu.close();
    void this.actions.renameNode(node);
  }

  // ───── Drag & drop OS files (tree-specific UI integration) ─────

  private async bindDragDrop(): Promise<void> {
    try {
      const webview = getCurrentWebview();
      const unlisten = await webview.onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') {
          const scope = this.scopeAtPosition(payload.position.x, payload.position.y);
          if (scope?.kind === 'fs') {
            this.dragOverScope.set(scope.path);
            this.dragOverTheme.set(null);
          } else if (scope?.kind === 'theme') {
            this.dragOverScope.set(null);
            this.dragOverTheme.set(scope.id);
          } else {
            this.dragOverScope.set(null);
            this.dragOverTheme.set(null);
          }
        } else if (payload.type === 'drop') {
          const scope = this.scopeAtPosition(payload.position.x, payload.position.y);
          this.dragOverScope.set(null);
          this.dragOverTheme.set(null);
          if (scope && payload.paths.length > 0) {
            void this.routeDroppedFiles(scope, payload.paths);
          }
        } else {
          this.dragOverScope.set(null);
          this.dragOverTheme.set(null);
        }
      });
      this.dragUnlisten = unlisten;
    } catch {
      // En tests/SSR / no-Tauri queda sin drag&drop; ok.
    }
  }

  /** Convierte coordenadas físicas del webview a CSS y devuelve scope target (saga/book o theme). */
  private scopeAtPosition(physX: number, physY: number): DropScope | null {
    const dpr = window.devicePixelRatio || 1;
    const x = physX / dpr;
    const y = physY / dpr;
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const themeRow = (el as HTMLElement).closest<HTMLElement>('[data-theme-scope]');
    if (themeRow?.dataset['themeScope']) {
      return { kind: 'theme', id: themeRow.dataset['themeScope']! };
    }
    const fsRow = (el as HTMLElement).closest<HTMLElement>('[data-extra-scope]');
    if (fsRow?.dataset['extraScope']) {
      return { kind: 'fs', path: fsRow.dataset['extraScope']! };
    }
    return null;
  }

  /** Rutea archivos arrastrados según scope y extensión.
   *  Fonts → pool global `<root>/fonts/` (independiente del scope, incluso si el
   *  drop fue sobre un tema). Resto → extras del scope. */
  private async routeDroppedFiles(scope: DropScope, paths: string[]): Promise<void> {
    if (scope.kind === 'theme') {
      const fontPaths = paths.filter((p) => FONT_EXT_RE.test(p));
      if (fontPaths.length !== paths.length) {
        this.toast.warn('Solo fuentes .ttf/.otf/.woff/.woff2 al pool global');
      }
      if (fontPaths.length > 0) {
        await this.addRootFontFiles(fontPaths);
      }
      return;
    }
    const fontPaths: string[] = [];
    const extraPaths: string[] = [];
    for (const p of paths) {
      if (FONT_EXT_RE.test(p)) fontPaths.push(p);
      else extraPaths.push(p);
    }
    if (fontPaths.length > 0) {
      await this.addRootFontFiles(fontPaths);
    }
    if (extraPaths.length > 0) {
      const added = await this.actions.addExtraFiles(scope.path, extraPaths);
      if (added > 0) {
        this.extrasExpanded.update((s) => new Set([...s, scope.path]));
      }
    }
  }

  private async addRootFontFiles(paths: string[]): Promise<void> {
    const root = this.rootFontsPath();
    if (!root) {
      this.toast.error('Elegí una carpeta raíz primero.');
      return;
    }
    let added = 0;
    let failed = 0;
    for (const p of paths) {
      try {
        await this.fonts.addFromPath(root, p);
        added++;
      } catch (e) {
        failed++;
        this.toast.error(`Falló agregar ${p}: ${e}`);
      }
    }
    if (added > 0) {
      this.fontsLoaded.update((s) => new Set([...s, root]));
      this.rootFontsExpanded.set(true);
      this.toast.info(`Agregada${added === 1 ? '' : 's'} ${added} fuente${added === 1 ? '' : 's'}.`);
    }
    if (failed > 0 && added === 0) {
      this.toast.error('No se pudo agregar ninguna fuente.');
    }
  }

  protected async consolidateFonts(event: Event): Promise<void> {
    event.stopPropagation();
    const root = this.rootFontsPath();
    if (!root) {
      this.toast.error('Elegí una carpeta raíz primero.');
      return;
    }
    try {
      const res = await invoke<{
        moved: number;
        deduped: number;
        kept: number;
        removed_dirs: number;
      }>('consolidate_fonts', { rootPath: root });
      this.fontsLoaded.update((s) => {
        const next = new Set(s);
        next.delete(root);
        return next;
      });
      await this.refreshRootFonts();
      this.rootFontsExpanded.set(true);
      const parts: string[] = [];
      if (res.moved > 0) parts.push(`${res.moved} movida${res.moved === 1 ? '' : 's'}`);
      if (res.deduped > 0) parts.push(`${res.deduped} dupe${res.deduped === 1 ? '' : 's'} borrada${res.deduped === 1 ? '' : 's'}`);
      if (res.removed_dirs > 0) parts.push(`${res.removed_dirs} carpeta${res.removed_dirs === 1 ? '' : 's'} vacía${res.removed_dirs === 1 ? '' : 's'} limpiada${res.removed_dirs === 1 ? '' : 's'}`);
      if (parts.length === 0) {
        this.toast.info('Nada que consolidar.');
      } else {
        this.toast.success(`Pool global actualizado: ${parts.join(', ')}.`);
      }
      if (res.kept > 0) {
        this.toast.warn(
          `${res.kept} fuente${res.kept === 1 ? '' : 's'} con colisión de nombre (tamaño distinto) — quedaron donde estaban. Revisalas a mano.`,
        );
      }
    } catch (e) {
      this.toast.error(`No se pudo consolidar: ${e}`);
    }
  }
}

function findNodeByPath(root: TreeNode | null, path: string): TreeNode | null {
  if (!root) return null;
  if (root.path === path) return root;
  for (const c of root.children) {
    const found = findNodeByPath(c, path);
    if (found) return found;
  }
  return null;
}

function isMarkdownExt(ext: string | null | undefined): boolean {
  if (!ext) return false;
  const e = ext.toLowerCase();
  return e === 'md' || e === 'markdown';
}
