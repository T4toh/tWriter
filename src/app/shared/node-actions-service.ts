import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import {
  LucideArrowDown,
  LucideArrowUp,
  LucideBookOpen,
  LucideEye,
  LucideFolder,
  LucideFolderOpen,
  LucideNotebook,
  LucidePencil,
  LucideQuote,
  LucideRuler,
} from '@lucide/angular';
import { BookConfigService } from '../core/book-config-service';
import { ChapterService } from '../core/chapter-service';
import { ExtraEntry, ExtrasService } from '../core/extras-service';
import { FontsService } from '../core/fonts-service';
import { ImageViewerService } from '../core/image-viewer-service';
import { MarkdownReaderService } from '../core/markdown-reader-service';
import { RaeAuditService } from '../core/rae-audit-service';
import { QuotesFixService } from '../core/quotes-fix-service';
import { NativeDialogsService } from '../core/native-dialogs-service';
import { NoteService, NoteTarget } from '../core/note-service';
import { ProjectService } from '../core/project-service';
import { DictionaryService } from '../core/dictionary-service';
import { SagaConfigService } from '../core/saga-config-service';
import { SettingsService } from '../core/settings-service';
import { SplitChapterService } from '../core/split-chapter-service';
import { ThemesService } from '../core/themes-service';
import { ToastService } from '../core/toast-service';
import { FontEntry, ThemeMeta, TreeNode } from '../core/types';
import { ModalService } from './modal-service';
import { CtxMenuEntry } from './context-menu-service';

/**
 * Acciones compartidas sobre nodos del árbol (saga / libro / sección / capítulo)
 * y sobre extras, fuentes y temas. Misma lógica que usaba `Tree`, pero sin
 * acoplarse a su UI state. Tree y Landing inyectan este service y reutilizan
 * tanto las acciones como los builders de menú contextual.
 */
@Injectable({ providedIn: 'root' })
export class NodeActionsService {
  private project = inject(ProjectService);
  private chapter = inject(ChapterService);
  private note = inject(NoteService);
  private settings = inject(SettingsService);
  private bookCfg = inject(BookConfigService);
  private sagaCfg = inject(SagaConfigService);
  private dictSvc = inject(DictionaryService);
  private extras = inject(ExtrasService);
  private fonts = inject(FontsService);
  private themesSvc = inject(ThemesService);
  private imageViewer = inject(ImageViewerService);
  private mdReader = inject(MarkdownReaderService);
  private raeAudit = inject(RaeAuditService);
  private quotesFix = inject(QuotesFixService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private dialogs = inject(NativeDialogsService);
  private splitSvc = inject(SplitChapterService);

  // ───── Builders ─────

  buildNodeMenu(node: TreeNode): CtxMenuEntry[] {
    if (node.kind === 'note') {
      return [
        {
          label: 'Abrir',
          icon: LucideEye,
          onClick: () => this.openMdInReader({ path: node.path, name: node.name }),
        },
        {
          label: 'Editar nota',
          icon: LucidePencil,
          onClick: () => this.openNote(node),
        },
        { label: 'Renombrar…', kbd: 'F2', onClick: () => this.renameNode(node) },
        { kind: 'separator' },
        {
          label: 'Borrar nota',
          danger: true,
          onClick: () => this.deleteNoteNode(node),
        },
      ];
    }
    if (node.kind === 'notes') {
      // La carpeta `notas/` directa de saga/book se detecta por nombre exacto en
      // el backend; renombrarla la convierte en `Folder` genérica al re-cargar
      // el tree (las .md adentro siguen viéndose). Para subcarpetas anidadas
      // (`notas/<sub>/`) el rename es totalmente seguro.
      const isRootNotesDir = node.name === 'notas';
      const entries: CtxMenuEntry[] = [
        {
          label: 'Nueva nota…',
          kbd: '.md',
          onClick: () => this.createNoteIn(node.path),
        },
        {
          label: 'Nueva carpeta…',
          icon: LucideNotebook,
          onClick: () => this.createFolderIn(node.path),
        },
        { kind: 'separator' },
      ];
      if (!isRootNotesDir) {
        entries.push({
          label: 'Renombrar…',
          kbd: 'F2',
          onClick: () => this.renameNode(node),
        });
      }
      entries.push(
        { kind: 'separator' },
        {
          label: isRootNotesDir ? 'Borrar carpeta notas' : 'Borrar carpeta',
          danger: true,
          onClick: () => this.deleteDir(node),
        },
      );
      return entries;
    }
    if (node.kind === 'folder') {
      return [
        {
          label: 'Nueva nota…',
          kbd: '.md',
          onClick: () => this.createNoteIn(node.path),
        },
        {
          label: 'Nueva carpeta…',
          icon: LucideFolder,
          onClick: () => this.createFolderIn(node.path),
        },
        { kind: 'separator' },
        { label: 'Renombrar…', kbd: 'F2', onClick: () => this.renameNode(node) },
        { kind: 'separator' },
        {
          label: 'Borrar carpeta',
          danger: true,
          onClick: () => this.deleteDir(node),
        },
      ];
    }
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
      if (this.isFlatSplittableChapter(node)) {
        if (entries.length > 0) entries.push({ kind: 'separator' });
        entries.push({
          label: 'Reestructurar en partes…',
          icon: LucideFolderOpen,
          onClick: () => this.splitChapter(node),
        });
      }
      if (this.isNumericedPart(node)) {
        if (entries.length > 0) entries.push({ kind: 'separator' });
        entries.push({
          label: 'Agregar parte nueva',
          kbd: '+1',
          onClick: () => this.insertPartAfter(node),
        });
      }
      if (moveable) {
        if (entries.length > 0) entries.push({ kind: 'separator' });
        entries.push(
          { label: 'Subir', icon: LucideArrowUp, onClick: () => this.moveUp(node) },
          { label: 'Bajar', icon: LucideArrowDown, onClick: () => this.moveDown(node) },
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
    const canCreateNote = !isExcluded && (node.kind === 'saga' || node.kind === 'book');
    const canCreateChapter = !isExcluded && (node.kind === 'book' || node.kind === 'section');
    const canCreateSection = !isExcluded && node.kind === 'book';
    const canCreateBook = !isExcluded && node.kind === 'saga';
    const canExport = !isExcluded && node.kind === 'book';
    const canConfigBook = !isExcluded && node.kind === 'book';
    const canConfigSaga = !isExcluded && node.kind === 'saga';
    const canMove = !isExcluded && this.isMoveable(node);
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
    if (canCreateNote) {
      entries.push({
        label: 'Nueva nota…',
        kbd: 'notas/',
        onClick: () => this.createNoteIn(`${node.path}/notas`),
      });
    }

    const hasImports = importable.length > 0 || cleanable.length > 0;
    const hasOps = canAddExtra || hasImports;
    if ((canCreateChapter || canCreateSection || canCreateBook || canCreateNote) && hasOps) {
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
    if (!isExcluded && node.kind === 'book') {
      const splittable = this.collectSplittable(node);
      if (splittable.length > 0) {
        entries.push({
          label: 'Reestructurar libro entero…',
          kbd: String(splittable.length),
          onClick: () => this.splitBookBulk(node),
        });
      }
    }

    if (canMove) {
      entries.push({ kind: 'separator' });
      entries.push(
        { label: 'Subir', icon: LucideArrowUp, onClick: () => this.moveUp(node) },
        { label: 'Bajar', icon: LucideArrowDown, onClick: () => this.moveDown(node) },
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
        label: 'Editar diccionario…',
        icon: LucideBookOpen,
        onClick: () => this.openDictionary(node),
      });
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

    const canAuditRae =
      !isExcluded &&
      (node.kind === 'saga' || node.kind === 'book' || node.kind === 'section');
    if (canAuditRae) {
      entries.push({ kind: 'separator' });
      entries.push({
        label: 'Revisar RAE',
        icon: LucideRuler,
        onClick: () => this.auditRae(node),
      });
      entries.push({
        label: 'Arreglar comillas',
        icon: LucideQuote,
        onClick: () => this.fixQuotesBulk(node),
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

  buildExtraMenu(scopePath: string, entry: ExtraEntry): CtxMenuEntry[] {
    const entries: CtxMenuEntry[] = [];
    if (isMarkdownExt(entry.ext)) {
      entries.push(
        {
          label: 'Abrir',
          icon: LucideEye,
          onClick: () => this.openMdInReader({ path: entry.path, name: entry.name }),
        },
        {
          label: 'Editar nota',
          icon: LucidePencil,
          onClick: () => this.openExtra(scopePath, entry),
        },
      );
    } else {
      entries.push({ label: 'Abrir', onClick: () => this.openExtra(scopePath, entry) });
    }
    entries.push(
      { label: 'Renombrar…', onClick: () => this.renameExtra(scopePath, entry) },
      { kind: 'separator' },
      { label: 'Borrar extra', danger: true, onClick: () => this.removeExtra(scopePath, entry) },
    );
    return entries;
  }

  buildEmptyMenu(): CtxMenuEntry[] {
    const root = this.settings.root();
    if (!root) return [];
    return [
      { label: 'Crear saga / novela', onClick: () => this.createSaga() },
      { kind: 'separator' },
      {
        label: 'Nueva carpeta…',
        icon: LucideFolder,
        onClick: () => this.createFolderIn(root),
      },
      {
        label: 'Nueva nota…',
        kbd: '.md',
        onClick: () => this.createNoteIn(root),
      },
    ];
  }

  buildThemeMenu(theme: ThemeMeta): CtxMenuEntry[] {
    return [
      { label: 'Editar tema…', onClick: () => this.openTheme(theme) },
      { label: 'Renombrar ID…', onClick: () => this.renameTheme(theme) },
      { label: 'Duplicar…', onClick: () => this.duplicateTheme(theme) },
      { kind: 'separator' },
      { label: 'Borrar tema', danger: true, onClick: () => this.deleteTheme(theme) },
    ];
  }

  buildFontMenu(scopePath: string, entry: FontEntry): CtxMenuEntry[] {
    return [
      { label: 'Abrir con sistema', onClick: () => this.openFontWithSystem(entry) },
      { label: 'Renombrar fuente…', onClick: () => this.renameFont(scopePath, entry) },
      { kind: 'separator' },
      { label: 'Borrar fuente', danger: true, onClick: () => this.removeFont(scopePath, entry) },
    ];
  }

  async openFontWithSystem(entry: FontEntry): Promise<void> {
    try {
      await openPath(entry.path);
    } catch (e) {
      this.toast.error(`No se pudo abrir: ${e}`);
    }
  }

  // ───── Node actions ─────

  async importThis(node: TreeNode): Promise<void> {
    await this.chapter.importChapter(node);
  }

  async deleteOriginal(node: TreeNode): Promise<void> {
    await this.chapter.deleteOriginal(node);
  }

  async importBulk(node: TreeNode): Promise<void> {
    const nodes = this.collectImportable(node);
    if (nodes.length === 0) return;
    await this.chapter.bulkImport(nodes);
  }

  async cleanupBulk(node: TreeNode): Promise<void> {
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

  async deleteFile(node: TreeNode): Promise<void> {
    const ok = await this.modal.confirm({
      title: 'Borrar capítulo',
      message: `Borrar ${node.name}.${node.ext}?\nSe borra el archivo y su .meta.json.`,
      danger: true,
    });
    if (!ok) return;
    await this.chapter.deleteChapterFile(node);
  }

  async deleteDir(node: TreeNode): Promise<void> {
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

  async createChapter(node: TreeNode): Promise<void> {
    await this.chapter.createChapter(node.path);
  }

  async createSection(node: TreeNode): Promise<void> {
    const name = await this.modal.prompt({
      title: 'Nuevo capítulo',
      message: 'Sin número, se prepende automático.',
      placeholder: 'Nombre',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    await this.chapter.createDirectory(node.path, name.trim(), true);
  }

  async createBook(node: TreeNode): Promise<void> {
    const name = await this.modal.prompt({
      title: 'Nuevo libro',
      message: 'Sin número, se prepende automático.',
      placeholder: 'Nombre',
      validate: (v) => (v.trim() ? null : 'Ingresá un nombre'),
    });
    if (!name?.trim()) return;
    await this.chapter.createBook(node.path, name.trim());
  }

  async createSaga(): Promise<void> {
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

  async moveUp(node: TreeNode): Promise<void> {
    await this.chapter.moveNode(node, 'up');
  }

  async moveDown(node: TreeNode): Promise<void> {
    await this.chapter.moveNode(node, 'down');
  }

  async exportEpub(node: TreeNode): Promise<void> {
    await this.chapter.exportEpub(node);
  }

  async auditRae(node: TreeNode): Promise<void> {
    await this.raeAudit.open({ path: node.path, name: node.name });
  }

  async fixQuotesBulk(node: TreeNode): Promise<void> {
    let count: number;
    try {
      count = await this.quotesFix.countEnglishChapters(node.path);
    } catch (e) {
      this.toast.error(`Comillas: ${e}`);
      return;
    }
    if (count === 0) {
      this.toast.info('No hay capítulos en inglés en esta selección.');
      return;
    }
    const ok = await this.modal.confirm({
      title: 'Arreglar comillas',
      message: `Convertir comillas rectas a tipográficas (“ ” ‘ ’) en ${count} capítulo${count === 1 ? '' : 's'} en inglés de "${node.name}"?\nSolo se modifican los capítulos con cambios.`,
    });
    if (!ok) return;
    await this.quotesFix.fixScope(node.path);
  }

  configBook(node: TreeNode): void {
    this.bookCfg.openFor(node);
  }

  configSaga(node: TreeNode): void {
    this.sagaCfg.openFor(node);
  }

  openDictionary(node: TreeNode): void {
    void this.dictSvc.openFor(node);
  }

  async renameNode(node: TreeNode): Promise<void> {
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
        const newNode = findNodeByPath(this.project.tree(), newPath);
        if (newNode) await this.chapter.open(newNode);
      }
      this.toast.success(`Renombrado a "${trimmed}"`);
    } catch (err) {
      this.toast.error(`Renombrar: ${err}`);
    }
  }

  async markAsEpilogo(node: TreeNode): Promise<void> {
    if (node.kind !== 'section') return;
    try {
      await invoke<string>('mark_as_epilogo', { sectionPath: node.path });
      await this.project.loadTree();
      this.toast.success(`"${node.name}" marcado como epílogo`);
    } catch (err) {
      this.toast.error(`Marcar epílogo: ${err}`);
    }
  }

  async excludeFolder(node: TreeNode): Promise<void> {
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

  async includeFolder(node: TreeNode): Promise<void> {
    try {
      await invoke('set_directory_excluded', { path: node.path, excluded: false });
      await this.project.loadTree();
    } catch (e) {
      this.toast.error(`No se pudo incluir: ${e}`);
    }
  }

  async addExtraFromMenu(node: TreeNode): Promise<void> {
    await this.pickAndAddExtras(node.path);
  }

  /** Abre file picker y agrega los archivos seleccionados al scope. Devuelve cantidad agregada. */
  async pickAndAddExtras(scopePath: string): Promise<number> {
    const paths = await this.dialogs.pickFile({
      title: 'Agregar extra(s)',
      multiple: true,
    });
    if (paths.length === 0) return 0;
    return this.addExtraFiles(scopePath, paths);
  }

  /** Copia archivos al `extras/` del scope. Devuelve cantidad agregada. */
  async addExtraFiles(scopePath: string, paths: string[]): Promise<number> {
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
      this.toast.info(`Agregado${added === 1 ? '' : 's'} ${added} extra${added === 1 ? '' : 's'}.`);
    }
    if (failed > 0 && added === 0) {
      this.toast.error(`No se pudo agregar ningún extra.`);
    }
    return added;
  }

  // ───── Extra actions ─────

  async openExtra(_scopePath: string, entry: ExtraEntry): Promise<void> {
    if (entry.kind === 'image') {
      void this.imageViewer.open(entry);
      return;
    }
    if (isMarkdownExt(entry.ext)) {
      await this.note.open({ path: entry.path, name: entry.name });
      return;
    }
    try {
      await openPath(entry.path);
    } catch (e) {
      this.toast.error(`No se pudo abrir: ${e}`);
    }
  }

  // ───── Note actions ─────

  async openNote(node: TreeNode): Promise<void> {
    if (node.kind !== 'note') return;
    await this.note.open({ path: node.path, name: node.name });
  }

  /** Abre el .md como render read-only en el panel derecho. No toca el centro. */
  async openMdInReader(target: NoteTarget): Promise<void> {
    await this.mdReader.open(target);
  }

  async deleteNoteNode(node: TreeNode): Promise<void> {
    if (node.kind !== 'note') return;
    const ok = await this.modal.confirm({
      title: 'Borrar nota',
      message: `Borrar ${node.name}.${node.ext || 'md'}?\nEl archivo se borra de disco.`,
      danger: true,
    });
    if (!ok) return;
    await this.note.deleteNote({ path: node.path, name: node.name });
  }

  async createNoteIn(parentDir: string): Promise<void> {
    const name = await this.modal.prompt({
      title: 'Nueva nota',
      message: 'Sin extensión, .md se prepende automático.',
      placeholder: 'nombre',
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Nombre vacío';
        if (t.includes('/') || t.includes('\\')) return 'Sin barras / o \\';
        return null;
      },
    });
    if (!name?.trim()) return;
    await this.note.createNote(parentDir, name.trim());
  }

  async createFolderIn(parentDir: string): Promise<void> {
    const name = await this.modal.prompt({
      title: 'Nueva carpeta',
      message: 'Carpeta libre para organizar notas. No afecta el EPUB.',
      placeholder: 'Worldbuilding',
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Nombre vacío';
        if (t.includes('/') || t.includes('\\')) return 'Sin barras / o \\';
        return null;
      },
    });
    if (!name?.trim()) return;
    try {
      await this.note.createFolder(parentDir, name.trim());
    } catch (e) {
      this.toast.error(`No se pudo crear: ${e}`);
    }
  }

  async renameExtra(scopePath: string, entry: ExtraEntry): Promise<void> {
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

  async removeExtra(scopePath: string, entry: ExtraEntry): Promise<void> {
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

  // ───── Font actions ─────

  async renameFont(scopePath: string, entry: FontEntry): Promise<void> {
    const newName = await this.modal.prompt({
      title: 'Renombrar fuente',
      defaultValue: entry.name,
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Nombre vacío';
        if (t === entry.name) return 'Mismo nombre';
        if (t.includes('/') || t.includes('\\')) return 'Sin barras / o \\';
        if (!/\.(ttf|otf|woff|woff2)$/i.test(t)) return 'Extensión inválida (ttf/otf/woff/woff2)';
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

  async removeFont(scopePath: string, entry: FontEntry): Promise<void> {
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

  // ───── Theme actions ─────

  openTheme(theme: ThemeMeta): void {
    this.themesSvc.openEditor(theme.id);
  }

  async renameTheme(theme: ThemeMeta): Promise<void> {
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

  async duplicateTheme(theme: ThemeMeta): Promise<void> {
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

  async deleteTheme(theme: ThemeMeta): Promise<void> {
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

  // ───── Helpers ─────

  isMoveable(node: TreeNode): boolean {
    // Cualquier nodo reordenable; el backend renumera/migra prefijos si falta.
    // Solo bloqueamos kinds estructurales puros.
    return (
      node.kind === 'saga' ||
      node.kind === 'book' ||
      node.kind === 'section' ||
      node.kind === 'chapter' ||
      node.kind === 'note'
    );
  }

  collectImportable(root: TreeNode): TreeNode[] {
    const out: TreeNode[] = [];
    walk(root, (n) => {
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

  collectCleanable(root: TreeNode): TreeNode[] {
    const out: TreeNode[] = [];
    walk(root, (n) => {
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

  isFlatSplittableChapter(node: TreeNode): boolean {
    if (node.kind !== 'chapter') return false;
    const ext = (node.ext ?? '').toLowerCase();
    if (ext !== 'docx' && ext !== 'odt' && ext !== 'html') return false;
    const tree = this.project.tree();
    if (!tree) return false;
    const parent = findParent(tree, node);
    return parent?.kind === 'book';
  }

  collectSplittable(book: TreeNode): TreeNode[] {
    if (book.kind !== 'book') return [];
    return book.children.filter((c) => {
      if (c.kind !== 'chapter') return false;
      const ext = (c.ext ?? '').toLowerCase();
      return ext === 'docx' || ext === 'odt' || ext === 'html';
    });
  }

  async splitChapter(node: TreeNode): Promise<void> {
    await this.splitSvc.startSingle(node.path);
  }

  async insertPartAfter(node: TreeNode): Promise<void> {
    await this.chapter.insertPartAfter(node.path);
  }

  isNumericedPart(node: TreeNode): boolean {
    if (node.kind !== 'chapter' || node.ext !== 'html') return false;
    if (!/^\d+$/.test(node.name)) return false;
    const tree = this.project.tree();
    if (!tree) return false;
    const parent = findParent(tree, node);
    return parent?.kind === 'section';
  }

  async splitBookBulk(book: TreeNode): Promise<void> {
    const splittable = this.collectSplittable(book);
    if (splittable.length === 0) return;
    await this.splitSvc.startBulk(splittable.map((c) => c.path));
  }

  hasHtmlSibling(node: TreeNode, scope: TreeNode | null = this.project.tree()): boolean {
    if (!scope) return false;
    const parent = findParent(scope, node);
    if (!parent) return false;
    const stem = node.name;
    return parent.children.some(
      (c) => c.kind === 'chapter' && c.ext === 'html' && c.name === stem,
    );
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

function findParent(node: TreeNode, target: TreeNode): TreeNode | null {
  for (const c of node.children) {
    if (c.path === target.path) return node;
    const found = findParent(c, target);
    if (found) return found;
  }
  return null;
}

function walk(node: TreeNode, fn: (n: TreeNode) => void): void {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

function isMarkdownExt(ext: string | null | undefined): boolean {
  if (!ext) return false;
  const e = ext.toLowerCase();
  return e === 'md' || e === 'markdown';
}

export function isEpilogoName(name: string): boolean {
  const stripped = name.replace(/^\d+\s*-\s*/, '').trim().toLowerCase();
  const flat = stripped.normalize('NFD').replace(/\p{M}/gu, '');
  return flat === 'epilogo' || flat === 'epilogue';
}
