import { Component, HostListener, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { openPath } from '@tauri-apps/plugin-opener';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { ChapterService } from '../core/chapter-service';
import { ExtraEntry, ExtrasService } from '../core/extras-service';
import { ExportEntry, ExportsService } from '../core/exports-service';
import { FontsService } from '../core/fonts-service';
import { NavigationService } from '../core/navigation-service';
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
  private extras = inject(ExtrasService);
  private exports = inject(ExportsService);
  private fonts = inject(FontsService);
  private themesSvc = inject(ThemesService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private ctxMenu = inject(ContextMenuService);
  private actions = inject(NodeActionsService);

  /** Cache de fuentes per-saga/per-book (mismo patrón que extras). */
  private readonly fontsLoaded = signal<Set<string>>(new Set());
  protected readonly fontsExpanded = signal<Set<string>>(new Set());
  protected readonly themesExpanded = signal<boolean>(false);
  /** Path/id que está siendo target de drag&drop OS para themes. null = no theme target. */
  protected readonly dragOverTheme = signal<string | null>(null);

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
  /** Path del scope (saga/book) que está siendo target de drag&drop OS files. */
  protected readonly dragOverScope = signal<string | null>(null);

  private readonly explicit = signal<Map<string, boolean>>(new Map());
  private readonly forceState = signal<'collapsed' | 'expanded' | null>(null);
  /** Estado expand/collapse de la sección Extras por scopePath. Default: collapsed. */
  private readonly extrasExpanded = signal<Set<string>>(new Set());
  /** Estado expand/collapse de la sección Exportados por bookPath. Default: collapsed. */
  private readonly exportsExpanded = signal<Set<string>>(new Set());

  private dragUnlisten: (() => void) | null = null;

  constructor() {
    void this.bindDragDrop();
    effect(() => {
      // Limpiar cache cuando cambia el root del proyecto
      this.project.root();
      this.extras.clear();
      this.exports.clear();
      this.fonts.clear();
      this.fontsLoaded.set(new Set());
      this.fontsExpanded.set(new Set());
      this.themesExpanded.set(false);
    });
  }

  ngOnDestroy(): void {
    this.dragUnlisten?.();
  }

  // ───── Extras / exports (left-click + UI state) ─────

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

  protected openExtraEntry(scopePath: string, entry: ExtraEntry): void {
    void this.actions.openExtra(scopePath, entry);
  }

  // ───── Fonts (per-saga/per-book) ─────

  protected getFonts(scopePath: string): FontEntry[] {
    return this.fonts.get(scopePath);
  }

  protected hasLoadedFonts(scopePath: string): boolean {
    return this.fontsLoaded().has(scopePath);
  }

  protected isFontsExpanded(scopePath: string): boolean {
    return this.fontsExpanded().has(scopePath);
  }

  protected toggleFonts(scopePath: string): void {
    const expanded = this.fontsExpanded().has(scopePath);
    this.fontsExpanded.update((s) => {
      const next = new Set(s);
      if (expanded) next.delete(scopePath);
      else next.add(scopePath);
      return next;
    });
    if (!expanded && !this.hasLoadedFonts(scopePath)) {
      void this.refreshFonts(scopePath);
    }
  }

  private async refreshFonts(scopePath: string): Promise<void> {
    try {
      await this.fonts.refresh(scopePath);
      this.fontsLoaded.update((s) => new Set([...s, scopePath]));
    } catch (e) {
      this.toast.error(`No se pudieron cargar fuentes: ${e}`);
    }
  }

  protected async openFont(_scopePath: string, entry: FontEntry): Promise<void> {
    try {
      await openPath(entry.path);
    } catch (e) {
      this.toast.error(`No se pudo abrir: ${e}`);
    }
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

  /** Rutea archivos arrastrados según scope y extensión. Fonts → fonts service; resto → extras. */
  private async routeDroppedFiles(scope: DropScope, paths: string[]): Promise<void> {
    if (scope.kind === 'theme') {
      await this.addThemeFonts(scope.id, paths);
      return;
    }
    const fontPaths: string[] = [];
    const extraPaths: string[] = [];
    for (const p of paths) {
      if (FONT_EXT_RE.test(p)) fontPaths.push(p);
      else extraPaths.push(p);
    }
    if (fontPaths.length > 0) {
      await this.addFontFiles(scope.path, fontPaths);
    }
    if (extraPaths.length > 0) {
      const added = await this.actions.addExtraFiles(scope.path, extraPaths);
      if (added > 0) {
        this.extrasExpanded.update((s) => new Set([...s, scope.path]));
      }
    }
  }

  private async addFontFiles(scopePath: string, paths: string[]): Promise<void> {
    let added = 0;
    let failed = 0;
    for (const p of paths) {
      try {
        await this.fonts.addFromPath(scopePath, p);
        added++;
      } catch (e) {
        failed++;
        this.toast.error(`Falló agregar ${p}: ${e}`);
      }
    }
    if (added > 0) {
      this.fontsLoaded.update((s) => new Set([...s, scopePath]));
      this.fontsExpanded.update((s) => new Set([...s, scopePath]));
      this.toast.info(`Agregada${added === 1 ? '' : 's'} ${added} fuente${added === 1 ? '' : 's'}.`);
    }
    if (failed > 0 && added === 0) {
      this.toast.error('No se pudo agregar ninguna fuente.');
    }
  }

  private async addThemeFonts(themeId: string, paths: string[]): Promise<void> {
    const fontPaths = paths.filter((p) => FONT_EXT_RE.test(p));
    if (fontPaths.length === 0) {
      this.toast.warn('Solo se aceptan fuentes .ttf/.otf/.woff/.woff2 en temas');
      return;
    }
    let added = 0;
    let failed = 0;
    for (const p of fontPaths) {
      try {
        await this.themesSvc.addFont(themeId, p);
        added++;
      } catch (e) {
        failed++;
        this.toast.error(`Falló agregar ${p}: ${e}`);
      }
    }
    if (added > 0) {
      await this.themesSvc.refresh();
      this.toast.info(`Agregada${added === 1 ? '' : 's'} ${added} fuente${added === 1 ? '' : 's'} al tema ${themeId}.`);
    }
    if (failed > 0 && added === 0) {
      this.toast.error('No se pudo agregar ninguna fuente al tema.');
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
