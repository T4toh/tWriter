import { Injectable, Signal, WritableSignal, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { detectLang } from '../dialogos/detect';
import { DebugService } from './debug-service';
import { ExportsService } from './exports-service';
import { GitService } from './git-service';
import { ProjectService } from './project-service';
import { ToastService } from './toast-service';
import { ChapterMeta, EMPTY_META, TreeNode } from './types';

const AUTOSAVE_MS = 1500;

export type PaneId = 0 | 1;
const PANE_IDS: readonly PaneId[] = [0, 1] as const;

export interface ChapterPane {
  active: WritableSignal<TreeNode | null>;
  content: WritableSignal<string>;
  meta: WritableSignal<ChapterMeta>;
  dirty: WritableSignal<boolean>;
  saving: WritableSignal<boolean>;
  lastSavedAt: WritableSignal<number | null>;
  error: WritableSignal<string | null>;
  loadedAt: WritableSignal<number>;
  wordCount: Signal<number>;
  canEdit: Signal<boolean>;
  autosaveTimer: ReturnType<typeof setTimeout> | null;
}

function makeChapterPane(): ChapterPane {
  const active = signal<TreeNode | null>(null);
  const content = signal<string>('');
  const meta = signal<ChapterMeta>(EMPTY_META);
  return {
    active,
    content,
    meta,
    dirty: signal<boolean>(false),
    saving: signal<boolean>(false),
    lastSavedAt: signal<number | null>(null),
    error: signal<string | null>(null),
    loadedAt: signal<number>(0),
    wordCount: computed(() => countWords(content())),
    canEdit: computed(() => !!active()?.editable),
    autosaveTimer: null,
  };
}

@Injectable({ providedIn: 'root' })
export class ChapterService {
  private project = inject(ProjectService);
  private debug = inject(DebugService);
  private git = inject(GitService);
  private toast = inject(ToastService);
  private exports = inject(ExportsService);

  /** Dos panes. pane 0 = principal (siempre activo). pane 1 = secundario (split). */
  readonly panes: readonly [ChapterPane, ChapterPane] = [makeChapterPane(), makeChapterPane()];

  // Backward-compat aliases a pane 0.
  readonly active = this.panes[0].active;
  readonly content = this.panes[0].content;
  readonly meta = this.panes[0].meta;
  readonly dirty = this.panes[0].dirty;
  readonly saving = this.panes[0].saving;
  readonly lastSavedAt = this.panes[0].lastSavedAt;
  readonly error = this.panes[0].error;
  readonly loadedAt = this.panes[0].loadedAt;
  readonly wordCount = this.panes[0].wordCount;
  readonly canEdit = this.panes[0].canEdit;

  // Globales (no per-pane).
  readonly importing = signal<boolean>(false);
  readonly bulkProgress = signal<{ done: number; total: number; current: string } | null>(null);

  // ──────── API legacy (pane 0) ────────

  async open(node: TreeNode): Promise<void> {
    return this.openInPane(node, 0);
  }

  close(): void {
    this.closeInPane(0);
  }

  updateContent(html: string): void {
    this.updateContentInPane(html, 0);
  }

  async save(): Promise<void> {
    return this.saveInPane(0);
  }

  async setLanguage(lang: 'es' | 'en'): Promise<void> {
    return this.setLanguageInPane(lang, 0);
  }

  // ──────── API pane-aware ────────

  async openInPane(node: TreeNode, paneId: PaneId): Promise<void> {
    if (node.kind !== 'chapter') return;
    const pane = this.panes[paneId];
    await this.flushPendingInPane(paneId);
    pane.error.set(null);

    if (!node.editable) {
      pane.content.set('');
      pane.meta.set(EMPTY_META);
      pane.dirty.set(false);
      pane.active.set(node);
      pane.loadedAt.set(Date.now());
      return;
    }

    try {
      const [html, metaRaw] = await Promise.all([
        invoke<string>('read_chapter', { path: node.path }),
        invoke<ChapterMeta>('read_meta', { chapterPath: node.path }),
      ]);
      let meta = metaRaw ?? EMPTY_META;
      if (!meta.idioma && html.trim()) {
        meta = { ...meta, idioma: detectLang(html) };
        try {
          await invoke('write_meta', { chapterPath: node.path, meta });
        } catch {
          // logged via meta error signal si falla
        }
      }
      pane.content.set(html);
      pane.meta.set(meta);
      pane.dirty.set(false);
      pane.active.set(node);
      pane.loadedAt.set(Date.now());
    } catch (err) {
      pane.error.set(String(err));
      pane.active.set(node);
      pane.loadedAt.set(Date.now());
    }
  }

  closeInPane(paneId: PaneId): void {
    const pane = this.panes[paneId];
    this.cancelAutosaveInPane(paneId);
    pane.active.set(null);
    pane.content.set('');
    pane.meta.set(EMPTY_META);
    pane.dirty.set(false);
    pane.error.set(null);
    pane.loadedAt.set(Date.now());
  }

  updateContentInPane(html: string, paneId: PaneId): void {
    const pane = this.panes[paneId];
    if (!pane.canEdit()) return;
    if (pane.content() === html) return;
    pane.content.set(html);
    pane.dirty.set(true);
    this.scheduleAutosaveInPane(paneId);
  }

  async saveInPane(paneId: PaneId): Promise<void> {
    const pane = this.panes[paneId];
    const node = pane.active();
    if (!node || !node.editable || !pane.dirty()) return;
    this.cancelAutosaveInPane(paneId);
    pane.saving.set(true);
    try {
      await invoke('write_chapter', { path: node.path, html: pane.content() });
      const root = this.project.root();
      if (root) {
        // Persistimos palabras + ultima_edicion en `.twriter/stats.json` (no
        // tocamos `meta.json` en cada save — antes generaba 1 commit ruidoso
        // por cada autosave). meta.json solo se reescribe al cambiar idioma,
        // titulo, status u orden.
        await invoke('write_chapter_stats', {
          root,
          chapterPath: node.path,
          palabras: countWords(pane.content()),
          ultimaEdicion: new Date().toISOString(),
        });
      }
      pane.dirty.set(false);
      pane.lastSavedAt.set(Date.now());
    } catch (err) {
      pane.error.set(String(err));
    } finally {
      pane.saving.set(false);
    }
  }

  async setLanguageInPane(lang: 'es' | 'en', paneId: PaneId): Promise<void> {
    const pane = this.panes[paneId];
    const node = pane.active();
    if (!node || !node.editable) return;
    const updated: ChapterMeta = { ...pane.meta(), idioma: lang };
    pane.meta.set(updated);
    try {
      await invoke('write_meta', { chapterPath: node.path, meta: updated });
    } catch (err) {
      pane.error.set(String(err));
    }
  }

  /** Devuelve el primer paneId que tiene ese path activo, o null. */
  findPaneByPath(path: string): PaneId | null {
    for (const i of PANE_IDS) {
      if (this.panes[i].active()?.path === path) return i;
    }
    return null;
  }

  // ──────── Operaciones globales (sin pane) ────────

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
      for (const i of PANE_IDS) {
        if (this.panes[i].active()?.path === node.path) this.closeInPane(i);
      }
      await this.project.loadTree();
      void this.git.refreshStatus();
      return true;
    } catch (err) {
      this.debug.error('cleanup', `${node.name}: ${err}`);
      this.panes[0].error.set(String(err));
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
      for (const i of PANE_IDS) {
        if (this.panes[i].active()?.path.startsWith(node.path)) this.closeInPane(i);
      }
      await this.project.loadTree();
      void this.git.refreshStatus();
      return true;
    } catch (err) {
      this.debug.error('cleanup', `${node.name}: ${err}`);
      this.panes[0].error.set(String(err));
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
      // Abrir el capítulo nuevo en pane 0 (default).
      const newNode = this.findNode(this.project.tree(), result.path);
      if (newNode) {
        await this.open(newNode);
      }
      return result.path;
    } catch (err) {
      this.debug.error('create', String(err));
      this.panes[0].error.set(String(err));
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
      this.panes[0].error.set(String(err));
      return null;
    }
  }

  /** Sube o baja un nodo entre sus siblings. Delegado a relocateNode. */
  async moveNode(node: TreeNode, direction: 'up' | 'down'): Promise<boolean> {
    const tree = this.project.tree();
    if (!tree) return false;
    const parent = findParentNode(tree, node.path);
    if (!parent) {
      this.panes[0].error.set('Nodo sin padre — no se puede reordenar.');
      return false;
    }
    const siblings = sameKindSiblings(parent, node.kind);
    const idx = siblings.findIndex((s) => s.path === node.path);
    if (idx < 0) return false;
    const destIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (destIdx < 0 || destIdx >= siblings.length) return false;
    return this.relocateNode(node.path, parent.path, destIdx);
  }

  /**
   * Mueve un nodo a un padre (mismo o distinto) y lo inserta en `destIndex`.
   * Renumera siblings de origen y destino para mantener prefijos `1..N` gap-free.
   * Re-mapea panes abiertos que tocaban paths renombrados.
   */
  async relocateNode(
    srcPath: string,
    destParentPath: string,
    destIndex: number,
  ): Promise<boolean> {
    const root = this.project.root();
    if (!root) {
      this.panes[0].error.set('Sin root configurado.');
      return false;
    }
    // Flush autosave de panes con descendientes del src.
    for (const i of PANE_IDS) {
      const active = this.panes[i].active();
      if (!active) continue;
      if (active.path === srcPath || active.path.startsWith(srcPath + '/')) {
        await this.flushPendingInPane(i);
      }
    }
    try {
      const result = await invoke<{
        from: string;
        to: string;
        renamed: [string, string][];
      }>('relocate_node', {
        args: { srcPath, destParentPath, destIndex, root },
      });

      const remap = new Map<string, string>(result.renamed);
      const beforeByPane: Array<string | null> = PANE_IDS.map(
        (i) => this.panes[i].active()?.path ?? null,
      );

      await this.project.loadTree();
      void this.git.refreshStatus();

      for (const i of PANE_IDS) {
        const before = beforeByPane[i];
        if (!before) continue;
        let newPath: string | null = remap.get(before) ?? null;
        if (!newPath) {
          for (const [oldP, newP] of remap) {
            if (before.startsWith(oldP + '/')) {
              newPath = newP + before.slice(oldP.length);
              break;
            }
          }
        }
        if (newPath && newPath !== before) {
          const node = this.findNode(this.project.tree(), newPath);
          if (node) await this.openInPane(node, i);
          else this.closeInPane(i);
        }
      }
      this.debug.info('reorder', `relocate ${result.from} → ${result.to}`);
      return true;
    } catch (err) {
      this.debug.error('reorder', String(err));
      this.toast.error(`No se pudo mover: ${err}`);
      this.panes[0].error.set(String(err));
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
      this.panes[0].error.set(String(err));
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
      this.panes[0].error.set(String(err));
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
    this.panes[0].error.set(null);
    try {
      const result = await invoke<{ html_path: string }>('import_chapter', {
        path: node.path,
      });
      await this.project.loadTree();
      // Reabrir como el nuevo .html en pane 0.
      const newNode = this.findNode(this.project.tree(), result.html_path);
      if (newNode) {
        await this.open(newNode);
      }
    } catch (err) {
      this.panes[0].error.set(String(err));
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

  // ──────── Autosave per-pane ────────

  private scheduleAutosaveInPane(paneId: PaneId): void {
    this.cancelAutosaveInPane(paneId);
    this.panes[paneId].autosaveTimer = setTimeout(
      () => void this.saveInPane(paneId),
      AUTOSAVE_MS,
    );
  }

  private cancelAutosaveInPane(paneId: PaneId): void {
    const pane = this.panes[paneId];
    if (pane.autosaveTimer != null) {
      clearTimeout(pane.autosaveTimer);
      pane.autosaveTimer = null;
    }
  }

  private async flushPendingInPane(paneId: PaneId): Promise<void> {
    if (this.panes[paneId].dirty()) {
      await this.saveInPane(paneId);
    } else {
      this.cancelAutosaveInPane(paneId);
    }
  }
}

function countWords(html: string): number {
  if (!html) return 0;
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

function findParentNode(tree: TreeNode, childPath: string): TreeNode | null {
  for (const c of tree.children) {
    if (c.path === childPath) return tree;
    const found = findParentNode(c, childPath);
    if (found) return found;
  }
  return null;
}

function sameKindSiblings(parent: TreeNode, kind: TreeNode['kind']): TreeNode[] {
  return parent.children.filter((c) => c.kind === kind);
}
