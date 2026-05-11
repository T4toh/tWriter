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
import { FontsService } from '../core/fonts-service';
import { ImageViewerService } from '../core/image-viewer-service';
import { NavigationService } from '../core/navigation-service';
import { SagaConfigService } from '../core/saga-config-service';
import { ProjectService } from '../core/project-service';
import { SettingsService } from '../core/settings-service';
import { ThemesService } from '../core/themes-service';
import { ToastService } from '../core/toast-service';
import { FontEntry, ThemeMeta, TreeNode } from '../core/types';
import { ModalService } from '../shared/modal-service';
import {
  ContextMenuService,
  CtxMenuEntry,
} from '../shared/context-menu-service';

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
  private bookCfg = inject(BookConfigService);
  private sagaCfg = inject(SagaConfigService);
  private extras = inject(ExtrasService);
  private exports = inject(ExportsService);
  private fonts = inject(FontsService);
  private themesSvc = inject(ThemesService);
  private imageViewer = inject(ImageViewerService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private ctxMenu = inject(ContextMenuService);

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

  protected onFontContextMenu(event: MouseEvent, scopePath: string, entry: FontEntry): void {
    this.ctxMenu.open(event, this.buildFontItems(scopePath, entry));
  }

  private buildFontItems(scopePath: string, entry: FontEntry): CtxMenuEntry[] {
    return [
      { label: 'Renombrar fuente…', onClick: () => this.renameFont(scopePath, entry) },
      { kind: 'separator' },
      { label: 'Borrar fuente', danger: true, onClick: () => this.removeFont(scopePath, entry) },
    ];
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

  protected onThemeContextMenu(event: MouseEvent, theme: ThemeMeta): void {
    this.ctxMenu.open(event, this.buildThemeItems(theme));
  }

  private buildThemeItems(theme: ThemeMeta): CtxMenuEntry[] {
    return [
      { label: 'Editar tema…', onClick: () => this.openTheme(theme) },
      { label: 'Renombrar ID…', onClick: () => this.renameTheme(theme) },
      { label: 'Duplicar…', onClick: () => this.duplicateTheme(theme) },
      { kind: 'separator' },
      { label: 'Borrar tema', danger: true, onClick: () => this.deleteTheme(theme) },
    ];
  }

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

  protected async renameTheme(theme: ThemeMeta): Promise<void> {
    const old = theme.id;
    const newId = await this.modal.prompt({
      title: 'Renombrar tema',
      message: 'Nuevo ID. Las sagas y libros que apunten al ID viejo quedarán dangling.',
      defaultValue: old,
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'ID vacío';
        if (t === old) return 'Mismo ID';
        if (t.includes('/') || t.includes('\\') || t.includes(' ')) return 'Inválido';
        return null;
      },
    });
    if (!newId?.trim() || newId.trim() === old) return;
    try {
      await this.themesSvc.rename(old, newId.trim());
      this.toast.warn(
        'Tema renombrado. Si alguna saga o novela apuntaba al ID viejo, ' +
          'tenés que actualizarla a mano.',
      );
    } catch (e) {
      this.toast.error(`No se pudo renombrar: ${e}`);
    }
  }

  protected async duplicateTheme(theme: ThemeMeta): Promise<void> {
    const src = theme.id;
    const dst = await this.modal.prompt({
      title: 'Duplicar tema',
      message: `Crear copia de "${src}" con qué ID?`,
      defaultValue: `${src}-copia`,
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'ID vacío';
        if (t === src) return 'Mismo ID que el origen';
        if (t.includes('/') || t.includes('\\') || t.includes(' ')) return 'Inválido';
        return null;
      },
    });
    if (!dst?.trim()) return;
    try {
      await this.themesSvc.duplicate(src, dst.trim());
      this.toast.success(`Tema "${dst.trim()}" creado`);
    } catch (e) {
      this.toast.error(`No se pudo duplicar: ${e}`);
    }
  }

  protected async deleteTheme(theme: ThemeMeta): Promise<void> {
    const id = theme.id;
    const ok = await this.modal.confirm({
      title: 'Borrar tema',
      message: `Borrar tema "${id}"? La carpeta themes/${id}/ y sus fuentes se eliminan del disco.`,
      danger: true,
    });
    if (!ok) return;
    try {
      await this.themesSvc.delete(id);
    } catch (e) {
      this.toast.error(`No se pudo borrar: ${e}`);
    }
  }

  // ───── Font context menu actions ─────

  protected async renameFont(scopePath: string, entry: FontEntry): Promise<void> {
    const newName = await this.modal.prompt({
      title: 'Renombrar fuente',
      defaultValue: entry.name,
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Nombre vacío';
        if (t === entry.name) return 'Mismo nombre';
        if (t.includes('/') || t.includes('\\')) return 'Sin barras / o \\';
        if (!FONT_EXT_RE.test(t)) return 'Extensión inválida (ttf/otf/woff/woff2)';
        return null;
      },
    });
    if (!newName?.trim() || newName.trim() === entry.name) return;
    try {
      await this.fonts.rename(scopePath, entry.relative_path, newName.trim());
    } catch (e) {
      this.toast.error(`No se pudo renombrar: ${e}`);
    }
  }

  protected async removeFont(scopePath: string, entry: FontEntry): Promise<void> {
    const ok = await this.modal.confirm({
      title: 'Borrar fuente',
      message: `Borrar "${entry.name}"? El archivo se elimina del disco.`,
      danger: true,
    });
    if (!ok) return;
    try {
      await this.fonts.remove(scopePath, entry.relative_path);
    } catch (e) {
      this.toast.error(`No se pudo borrar: ${e}`);
    }
  }

  /** Construye las entradas del menú según el tipo de nodo target. */
  private buildNodeItems(node: TreeNode): CtxMenuEntry[] {
    if (node.kind === 'chapter') {
      const isImportable = node.ext === 'odt' || node.ext === 'docx';
      const hasHtml = isImportable && this.hasHtmlSibling(node);
      const moveable = this.isMoveable(node);
      const entries: CtxMenuEntry[] = [];
      if (isImportable && !node.editable) {
        entries.push({
          label: 'Importar a HTML',
          kbd: `.${node.ext}`,
          onClick: () => this.importThis(node),
        });
      }
      if (isImportable && hasHtml) {
        entries.push({
          label: 'Borrar original (ya migrado)',
          danger: true,
          onClick: () => this.deleteOriginal(node),
        });
      }
      if (moveable) {
        if (entries.length > 0) entries.push({ kind: 'separator' });
        entries.push(
          { label: 'Subir', kbd: '▲', onClick: () => this.moveUp(node) },
          { label: 'Bajar', kbd: '▼', onClick: () => this.moveDown(node) },
        );
      }
      entries.push(
        { kind: 'separator' },
        { label: 'Renombrar…', kbd: 'F2', onClick: () => this.renameNode(node) },
        { kind: 'separator' },
        {
          label: 'Borrar archivo',
          kbd: `.${node.ext}`,
          danger: true,
          onClick: () => this.deleteFile(node),
        },
      );
      return entries;
    }

    const isExcluded = !!node.excluded;
    const importable = isExcluded ? [] : this.collectImportable(node);
    const cleanable = isExcluded ? [] : this.collectCleanable(node);
    const canAddExtra = !isExcluded && (node.kind === 'saga' || node.kind === 'book');
    const canCreateChapter = !isExcluded && (node.kind === 'book' || node.kind === 'section');
    const canCreateSection = !isExcluded && node.kind === 'book';
    const canCreateBook = !isExcluded && node.kind === 'saga';
    const canExport = !isExcluded && node.kind === 'book';
    const canConfigBook = !isExcluded && node.kind === 'book';
    const canConfigSaga = !isExcluded && node.kind === 'saga';
    const canMove = !isExcluded && node.kind !== 'saga' && this.isMoveable(node);
    const canMarkEpilogo =
      !isExcluded && node.kind === 'section' && isEpilogoName(node.name);

    const entries: CtxMenuEntry[] = [];

    if (canCreateChapter) {
      entries.push({ label: 'Crear parte', kbd: 'N.html', onClick: () => this.createChapter(node) });
    }
    if (canCreateSection) {
      entries.push({ label: 'Crear capítulo', onClick: () => this.createSection(node) });
    }
    if (canCreateBook) {
      entries.push({ label: 'Crear libro', onClick: () => this.createBook(node) });
    }

    const hasImports = importable.length > 0 || cleanable.length > 0;
    const hasOps = canAddExtra || hasImports;
    if ((canCreateChapter || canCreateSection || canCreateBook) && hasOps) {
      entries.push({ kind: 'separator' });
    }

    if (canAddExtra) {
      entries.push({
        label: 'Agregar extra…',
        kbd: 'extras/',
        onClick: () => this.addExtraFromMenu(node),
      });
    }
    if (importable.length > 0) {
      entries.push({
        label: 'Importar todos a HTML',
        kbd: String(importable.length),
        onClick: () => this.importBulk(node),
      });
    }
    if (cleanable.length > 0) {
      entries.push({
        label: 'Borrar originales migrados',
        kbd: String(cleanable.length),
        danger: true,
        onClick: () => this.cleanupBulk(node),
      });
    }

    if (canMove) {
      entries.push({ kind: 'separator' });
      entries.push(
        { label: 'Subir', kbd: '▲', onClick: () => this.moveUp(node) },
        { label: 'Bajar', kbd: '▼', onClick: () => this.moveDown(node) },
      );
    }

    if (!isExcluded) {
      entries.push({ kind: 'separator' });
      entries.push({
        label: 'Renombrar…',
        kbd: 'F2',
        onClick: () => this.renameNode(node),
      });
    }

    if (canMarkEpilogo) {
      entries.push({ kind: 'separator' });
      entries.push({
        label: 'Marcar como epílogo',
        kbd: 'book.json',
        onClick: () => this.markAsEpilogo(node),
      });
    }

    if (canConfigBook) {
      entries.push({ kind: 'separator' });
      entries.push({
        label: 'Configurar novela…',
        kbd: 'book.json',
        onClick: () => this.configBook(node),
      });
    }
    if (canConfigSaga) {
      entries.push({ kind: 'separator' });
      entries.push({
        label: 'Configurar saga…',
        kbd: 'saga.json',
        onClick: () => this.configSaga(node),
      });
    }
    if (canExport) {
      if (!canConfigBook) entries.push({ kind: 'separator' });
      entries.push({
        label: 'Exportar a EPUB',
        kbd: '.epub',
        onClick: () => this.exportEpub(node),
      });
    }

    if (!isExcluded) {
      entries.push({ kind: 'separator' });
      entries.push({
        label: 'Excluir del EPUB',
        kbd: '.twriter-ignore',
        onClick: () => this.excludeFolder(node),
      });
    } else {
      entries.push({ kind: 'separator' });
      entries.push({
        label: 'Incluir de nuevo',
        onClick: () => this.includeFolder(node),
      });
    }

    entries.push({ kind: 'separator' });
    entries.push({
      label: 'Borrar carpeta',
      danger: true,
      onClick: () => this.deleteDir(node),
    });

    return entries;
  }

  private buildExtraItems(scopePath: string, entry: ExtraEntry): CtxMenuEntry[] {
    return [
      { label: 'Abrir con sistema', onClick: () => this.openExtra(scopePath, entry) },
      { label: 'Renombrar…', onClick: () => this.renameExtra(scopePath, entry) },
      { kind: 'separator' },
      { label: 'Borrar extra', danger: true, onClick: () => this.removeExtra(scopePath, entry) },
    ];
  }

  private buildEmptyItems(): CtxMenuEntry[] {
    if (!this.settings.root()) return [];
    return [{ label: 'Crear saga / novela', onClick: () => this.createSaga() }];
  }

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
    this.ctxMenu.open(event, this.buildNodeItems(node));
  }

  protected onExtraContextMenu(event: MouseEvent, scopePath: string, entry: ExtraEntry): void {
    this.ctxMenu.open(event, this.buildExtraItems(scopePath, entry));
  }

  protected onEmptyContext(event: MouseEvent): void {
    const items = this.buildEmptyItems();
    if (items.length === 0) return; // dejá burbujar al handler global
    this.ctxMenu.open(event, items);
  }

  protected async importThis(node: TreeNode): Promise<void> {
    await this.chapter.importChapter(node);
  }

  protected async deleteOriginal(node: TreeNode): Promise<void> {
    await this.chapter.deleteOriginal(node);
  }

  protected async importBulk(node: TreeNode): Promise<void> {
    const nodes = this.collectImportable(node);
    if (nodes.length === 0) return;
    await this.chapter.bulkImport(nodes);
  }

  protected async cleanupBulk(node: TreeNode): Promise<void> {
    const nodes = this.collectCleanable(node);
    if (nodes.length === 0) return;
    const ok = await this.modal.confirm({
      title: 'Borrar originales',
      message: `Borrar ${nodes.length} archivo${nodes.length === 1 ? '' : 's'} original${nodes.length === 1 ? '' : 'es'} (.odt/.docx)?\nSolo se borran los que ya tienen .html.`,
      danger: true,
    });
    if (!ok) return;
    await this.chapter.bulkCleanup(nodes);
  }

  protected async deleteFile(node: TreeNode): Promise<void> {
    const ok = await this.modal.confirm({
      title: 'Borrar capítulo',
      message: `Borrar ${node.name}.${node.ext}?\nSe borra el archivo y su .meta.json.`,
      danger: true,
    });
    if (!ok) return;
    await this.chapter.deleteChapterFile(node);
  }

  protected async deleteDir(node: TreeNode): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    const ok = await this.modal.confirm({
      title: 'Borrar carpeta',
      message: `BORRAR carpeta "${node.name}" y todo su contenido?\nEsto es irreversible. Si tenés sync git, podés recuperar haciendo git checkout.`,
      danger: true,
    });
    if (!ok) return;
    await this.chapter.deleteDirectory(node, root);
  }

  protected async createChapter(node: TreeNode): Promise<void> {
    await this.chapter.createChapter(node.path);
  }

  protected async createSection(node: TreeNode): Promise<void> {
    const name = await this.modal.prompt({
      title: 'Nuevo capítulo',
      message: 'Sin número, se prepende automático.',
      placeholder: 'Nombre',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    await this.chapter.createDirectory(node.path, name.trim(), true);
  }

  protected async createBook(node: TreeNode): Promise<void> {
    const name = await this.modal.prompt({
      title: 'Nuevo libro',
      message: 'Sin número, se prepende automático.',
      placeholder: 'Nombre',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    await this.chapter.createBook(node.path, name.trim());
  }

  protected async createSaga(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    const name = await this.modal.prompt({
      title: 'Nueva saga / novela',
      placeholder: 'Nombre',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    await this.chapter.createDirectory(root, name.trim(), false);
  }

  protected async moveUp(node: TreeNode): Promise<void> {
    await this.chapter.moveNode(node, 'up');
  }

  protected async moveDown(node: TreeNode): Promise<void> {
    await this.chapter.moveNode(node, 'down');
  }

  protected async exportEpub(node: TreeNode): Promise<void> {
    await this.chapter.exportEpub(node);
  }

  protected configBook(node: TreeNode): void {
    this.bookCfg.openFor(node);
  }

  protected configSaga(node: TreeNode): void {
    this.sagaCfg.openFor(node);
  }

  protected async renameNode(node: TreeNode): Promise<void> {
    await this.renameNodeFor(node);
  }

  @HostListener('window:keydown.F2', ['$event'])
  protected onF2(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (target && target.matches('input, textarea, [contenteditable="true"]')) {
      return;
    }
    const node = this.chapter.active() ?? this.findNodeByPath(this.root(), this.browsingPath() ?? '');
    if (!node) return;
    event.preventDefault();
    this.ctxMenu.close();
    void this.renameNodeFor(node);
  }

  private async renameNodeFor(node: TreeNode): Promise<void> {
    const current = node.kind === 'chapter' && node.ext
      ? `${node.name}.${node.ext}`
      : node.name;
    const input = await this.modal.prompt({
      title: 'Renombrar',
      defaultValue: current,
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Nombre vacío';
        if (t === current) return 'Mismo nombre que el actual';
        if (t.includes('/') || t.includes('\\')) return 'Sin barras / o \\';
        return null;
      },
    });
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

  protected async markAsEpilogo(node: TreeNode): Promise<void> {
    if (node.kind !== 'section') return;
    try {
      await invoke<string>('mark_as_epilogo', { sectionPath: node.path });
      await this.project.loadTree();
      this.toast.success(`"${node.name}" marcado como epílogo`);
    } catch (err) {
      this.toast.error(`Marcar epílogo: ${err}`);
    }
  }

  protected async excludeFolder(node: TreeNode): Promise<void> {
    const ok = await this.modal.confirm({
      title: 'Excluir del EPUB',
      message: `Excluir "${node.name}" del export EPUB?\nSigue visible en el árbol pero no se incluye al armar el libro.`,
    });
    if (!ok) return;
    try {
      await invoke('set_directory_excluded', { path: node.path, excluded: true });
      await this.project.loadTree();
    } catch (e) {
      this.toast.error(`No se pudo excluir: ${e}`);
    }
  }

  protected async includeFolder(node: TreeNode): Promise<void> {
    try {
      await invoke('set_directory_excluded', { path: node.path, excluded: false });
      await this.project.loadTree();
    } catch (e) {
      this.toast.error(`No se pudo incluir: ${e}`);
    }
  }

  protected async addExtraFromMenu(node: TreeNode): Promise<void> {
    await this.pickAndAddExtras(node.path);
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

  protected async openExtra(_scopePath: string, entry: ExtraEntry): Promise<void> {
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

  protected async renameExtra(scopePath: string, entry: ExtraEntry): Promise<void> {
    const newName = await this.modal.prompt({
      title: 'Renombrar archivo',
      defaultValue: entry.name,
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Nombre vacío';
        if (t === entry.name) return 'Mismo nombre que el actual';
        if (t.includes('/') || t.includes('\\')) return 'Sin barras / o \\';
        return null;
      },
    });
    if (!newName?.trim() || newName.trim() === entry.name) return;
    try {
      await this.extras.rename(scopePath, entry.relative_path, newName.trim());
    } catch (e) {
      this.toast.error(`No se pudo renombrar: ${e}`);
    }
  }

  protected async removeExtra(scopePath: string, entry: ExtraEntry): Promise<void> {
    const ok = await this.modal.confirm({
      title: 'Borrar extra',
      message: `Borrar extra "${entry.name}"?\nEl archivo se borra de disco.`,
      danger: true,
    });
    if (!ok) return;
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
      await this.addExtraFiles(scope.path, extraPaths);
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
