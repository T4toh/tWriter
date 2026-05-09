import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { detectLang } from '../dialogos/detect';
import { DebugService } from './debug-service';
import { ExportsService } from './exports-service';
import { GitService } from './git-service';
import { ProjectService } from './project-service';
import { ToastService } from './toast-service';
import { ChapterMeta, EMPTY_META, TreeNode } from './types';

const AUTOSAVE_MS = 1500;

@Injectable({ providedIn: 'root' })
export class ChapterService {
  private project = inject(ProjectService);
  private debug = inject(DebugService);
  private git = inject(GitService);
  private toast = inject(ToastService);
  private exports = inject(ExportsService);

  readonly active = signal<TreeNode | null>(null);
  readonly importing = signal<boolean>(false);
  readonly bulkProgress = signal<{ done: number; total: number; current: string } | null>(null);
  readonly content = signal<string>('');
  readonly meta = signal<ChapterMeta>(EMPTY_META);
  readonly dirty = signal<boolean>(false);
  readonly saving = signal<boolean>(false);
  readonly lastSavedAt = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  /** Bumpea cada vez que se abre o cierra un capítulo. El editor lo observa para resincronizar. */
  readonly loadedAt = signal<number>(0);

  readonly wordCount = computed(() => countWords(this.content()));
  readonly canEdit = computed(() => !!this.active()?.editable);

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  async open(node: TreeNode): Promise<void> {
    if (node.kind !== 'chapter') {
      return;
    }
    await this.flushPending();
    this.error.set(null);

    if (!node.editable) {
      this.content.set('');
      this.meta.set(EMPTY_META);
      this.dirty.set(false);
      this.active.set(node);
      this.loadedAt.set(Date.now());
      return;
    }

    try {
      const [html, metaRaw] = await Promise.all([
        invoke<string>('read_chapter', { path: node.path }),
        invoke<ChapterMeta>('read_meta', { chapterPath: node.path }),
      ]);
      let meta = metaRaw ?? EMPTY_META;
      // Auto-detect idioma si está vacío
      if (!meta.idioma && html.trim()) {
        meta = { ...meta, idioma: detectLang(html) };
        try {
          await invoke('write_meta', { chapterPath: node.path, meta });
        } catch {
          // logged via meta error signal si falla
        }
      }
      this.content.set(html);
      this.meta.set(meta);
      this.dirty.set(false);
      this.active.set(node);
      this.loadedAt.set(Date.now());
    } catch (err) {
      this.error.set(String(err));
      this.active.set(node);
      this.loadedAt.set(Date.now());
    }
  }

  close(): void {
    this.cancelAutosave();
    this.active.set(null);
    this.content.set('');
    this.meta.set(EMPTY_META);
    this.dirty.set(false);
    this.error.set(null);
    this.loadedAt.set(Date.now());
  }

  updateContent(html: string): void {
    if (!this.canEdit()) {
      return;
    }
    if (this.content() === html) {
      return;
    }
    this.content.set(html);
    this.dirty.set(true);
    this.scheduleAutosave();
  }

  async save(): Promise<void> {
    const node = this.active();
    if (!node || !node.editable || !this.dirty()) {
      return;
    }
    this.cancelAutosave();
    this.saving.set(true);
    try {
      await invoke('write_chapter', { path: node.path, html: this.content() });
      const updated: ChapterMeta = {
        ...this.meta(),
        palabras: countWords(this.content()),
        ultima_edicion: new Date().toISOString(),
      };
      await invoke('write_meta', { chapterPath: node.path, meta: updated });
      this.meta.set(updated);
      this.dirty.set(false);
      this.lastSavedAt.set(Date.now());
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.saving.set(false);
    }
  }

  async setLanguage(lang: 'es' | 'en'): Promise<void> {
    const node = this.active();
    if (!node || !node.editable) return;
    const updated: ChapterMeta = { ...this.meta(), idioma: lang };
    this.meta.set(updated);
    try {
      await invoke('write_meta', { chapterPath: node.path, meta: updated });
    } catch (err) {
      this.error.set(String(err));
    }
  }

  /** Importa varios capítulos secuencialmente. Reporta progreso al debug panel. */
  async bulkImport(nodes: TreeNode[]): Promise<{ ok: number; failed: number }> {
    const total = nodes.length;
    let ok = 0;
    let failed = 0;
    this.debug.info('bulk-import', `Importando ${total} archivos…`);
    for (let i = 0; i < total; i++) {
      const n = nodes[i];
      this.bulkProgress.set({ done: i, total, current: n.name });
      try {
        await invoke<{ html_path: string }>('import_chapter', { path: n.path });
        this.debug.info('bulk-import', `${n.name}.${n.ext} → HTML`);
        ok++;
      } catch (err) {
        this.debug.error('bulk-import', `${n.name}: ${err}`);
        failed++;
      }
    }
    this.bulkProgress.set(null);
    this.debug.info('bulk-import', `Listo: ${ok} ok, ${failed} fallaron.`);
    await this.project.loadTree();
    void this.git.refreshStatus();
    return { ok, failed };
  }

  /** Borra un capítulo (.html/.odt/.docx) y su .meta.json sibling. */
  async deleteChapterFile(node: TreeNode): Promise<boolean> {
    if (node.kind !== 'chapter') return false;
    try {
      const result = await invoke<{ deleted: string[] }>('delete_chapter_file', {
        path: node.path,
      });
      this.debug.info('cleanup', `Borré ${result.deleted.length} archivo(s) de ${node.name}.${node.ext}`);
      if (this.active()?.path === node.path) {
        this.close();
      }
      await this.project.loadTree();
      void this.git.refreshStatus();
      return true;
    } catch (err) {
      this.debug.error('cleanup', `${node.name}: ${err}`);
      this.error.set(String(err));
      return false;
    }
  }

  /** Alias semántico: usado cuando ya hay .html sibling y querés limpiar el original. */
  async deleteOriginal(node: TreeNode): Promise<boolean> {
    return this.deleteChapterFile(node);
  }

  /** Borra una carpeta (saga/libro/sección). target debe estar dentro de root. */
  async deleteDirectory(node: TreeNode, root: string): Promise<boolean> {
    if (node.kind === 'chapter') return false;
    try {
      await invoke('delete_directory', { root, target: node.path });
      this.debug.info('cleanup', `Borré carpeta ${node.name}`);
      if (this.active()?.path.startsWith(node.path)) {
        this.close();
      }
      await this.project.loadTree();
      void this.git.refreshStatus();
      return true;
    } catch (err) {
      this.debug.error('cleanup', `${node.name}: ${err}`);
      this.error.set(String(err));
      return false;
    }
  }

  /** Crea un capítulo .html vacío + .meta.json en parentDir. */
  async createChapter(
    parentDir: string,
    idioma: 'es' | 'en' = 'es',
    opts?: { titulo?: string },
  ): Promise<string | null> {
    try {
      const result = await invoke<{ path: string }>('create_chapter', {
        parentDir,
        idioma,
        titulo: opts?.titulo ?? null,
      });
      this.debug.info('create', `Capítulo creado: ${result.path}`);
      await this.project.loadTree();
      void this.git.refreshStatus();
      // Abrir el capítulo nuevo
      const newNode = this.findNode(this.project.tree(), result.path);
      if (newNode) {
        await this.open(newNode);
      }
      return result.path;
    } catch (err) {
      this.debug.error('create', String(err));
      this.error.set(String(err));
      return null;
    }
  }

  /** Exporta una novela a EPUB. Path debe ser un dir tipo book. */
  async exportEpub(node: TreeNode): Promise<string | null> {
    if (node.kind !== 'book') return null;
    try {
      const result = await invoke<{ epub_path: string; chapters: number }>(
        'export_book',
        { bookPath: node.path },
      );
      const filename = result.epub_path.split('/').pop() ?? 'epub';
      this.debug.info(
        'epub',
        `${node.name} → ${result.epub_path} (${result.chapters} parte${result.chapters === 1 ? '' : 's'})`,
      );
      this.toast.success(
        `EPUB generado: ${filename} (${result.chapters} parte${result.chapters === 1 ? '' : 's'})`,
      );
      await this.project.loadTree();
      void this.exports.refresh(node.path);
      return result.epub_path;
    } catch (err) {
      this.debug.error('epub', `${node.name}: ${err}`);
      this.toast.error(`Export falló: ${err}`);
      this.error.set(String(err));
      return null;
    }
  }

  /** Sube o baja un nodo (capítulo o directorio numerado) entre sus siblings. */
  async moveNode(node: TreeNode, direction: 'up' | 'down'): Promise<boolean> {
    try {
      const result = await invoke<{ from: string; to: string }>('move_node', {
        path: node.path,
        direction,
      });
      this.debug.info('reorder', `${node.name} → ${direction}`);
      const activePath = this.active()?.path ?? null;
      const wasActive = activePath === node.path;
      const wasInsideMoved =
        activePath !== null && activePath.startsWith(result.from + '/');
      await this.project.loadTree();
      void this.git.refreshStatus();
      // Re-foco: si era el archivo movido, abrirlo en su nueva ubicación.
      // Si era un capítulo dentro de un dir movido, mapear el path y reabrir.
      if (wasActive) {
        const newNode = this.findNode(this.project.tree(), result.to);
        if (newNode) await this.open(newNode);
        else this.close();
      } else if (wasInsideMoved && activePath) {
        const remapped = result.to + activePath.slice(result.from.length);
        const newNode = this.findNode(this.project.tree(), remapped);
        if (newNode) await this.open(newNode);
        else this.close();
      }
      return true;
    } catch (err) {
      this.debug.error('reorder', `${node.name}: ${err}`);
      this.error.set(String(err));
      return false;
    }
  }

  /** Crea una carpeta (saga/libro/sección). numbered=true prepende próximo "N -". */
  async createDirectory(
    parentDir: string,
    name: string,
    numbered: boolean,
  ): Promise<string | null> {
    try {
      const result = await invoke<{ path: string }>('create_directory', {
        parentDir,
        name,
        numbered,
      });
      this.debug.info('create', `Carpeta creada: ${result.path}`);
      await this.project.loadTree();
      void this.git.refreshStatus();
      return result.path;
    } catch (err) {
      this.debug.error('create', String(err));
      this.error.set(String(err));
      return null;
    }
  }

  /** Crea un libro dentro de una saga, escribiendo book.json con autor/idioma heredados + defaults. */
  async createBook(parentDir: string, name: string): Promise<string | null> {
    try {
      const result = await invoke<{ path: string }>('create_book', {
        parentDir,
        name,
      });
      this.debug.info('create', `Libro creado: ${result.path}`);
      await this.project.loadTree();
      void this.git.refreshStatus();
      return result.path;
    } catch (err) {
      this.debug.error('create', String(err));
      this.error.set(String(err));
      return null;
    }
  }

  /** Borra todos los .odt/.docx que ya tienen .html sibling. */
  async bulkCleanup(nodes: TreeNode[]): Promise<{ ok: number; failed: number }> {
    const total = nodes.length;
    let ok = 0;
    let failed = 0;
    this.debug.info('bulk-cleanup', `Borrando ${total} originales…`);
    for (let i = 0; i < total; i++) {
      const n = nodes[i];
      this.bulkProgress.set({ done: i, total, current: n.name });
      try {
        await invoke('delete_chapter_file', { path: n.path });
        ok++;
      } catch (err) {
        this.debug.error('bulk-cleanup', `${n.name}: ${err}`);
        failed++;
      }
    }
    this.bulkProgress.set(null);
    this.debug.info('bulk-cleanup', `Listo: ${ok} ok, ${failed} fallaron.`);
    await this.project.loadTree();
    void this.git.refreshStatus();
    return { ok, failed };
  }

  /** Importa un .docx/.odt a HTML usando pandoc. Recarga árbol al terminar. */
  async importChapter(node: TreeNode): Promise<void> {
    if (node.kind !== 'chapter' || node.editable) return;
    if (node.ext !== 'docx' && node.ext !== 'odt') return;
    this.importing.set(true);
    this.error.set(null);
    try {
      const result = await invoke<{ html_path: string }>('import_chapter', {
        path: node.path,
      });
      await this.project.loadTree();
      // Reabrir como el nuevo .html
      const newNode = this.findNode(this.project.tree(), result.html_path);
      if (newNode) {
        await this.open(newNode);
      }
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.importing.set(false);
    }
  }

  private findNode(node: TreeNode | null, path: string): TreeNode | null {
    if (!node) return null;
    if (node.path === path) return node;
    for (const child of node.children) {
      const found = this.findNode(child, path);
      if (found) return found;
    }
    return null;
  }

  private scheduleAutosave(): void {
    this.cancelAutosave();
    this.autosaveTimer = setTimeout(() => void this.save(), AUTOSAVE_MS);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer != null) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  private async flushPending(): Promise<void> {
    if (this.dirty()) {
      await this.save();
    } else {
      this.cancelAutosave();
    }
  }
}

function countWords(html: string): number {
  if (!html) return 0;
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}
