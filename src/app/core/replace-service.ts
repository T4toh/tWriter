import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ChapterService } from './chapter-service';
import { DebugService } from './debug-service';
import { GitService } from './git-service';
import { ProjectService } from './project-service';
import {
  FileEdit,
  ReplaceGroup,
  ReplacePreview,
  contar,
  editsDesdeSeleccion,
  estadoGrupo,
  toggleGrupo as toggleGrupoPuro,
  toggleOcurrencia as toggleOcurrenciaPuro,
} from './replace-selection';
import { SearchService } from './search-service';
import { SettingsService } from './settings-service';
import { ToastService } from './toast-service';

const DEBOUNCE_MS = 250;

interface ReplaceOutcome {
  files: number;
  occurrences: number;
  /** Cambiaron entre el preview y el apply: no se tocaron. */
  skippedFiles: string[];
  /** Se intentaron escribir y falló (disco lleno, permisos, archivo tomado por
   *  el servicio de sync). Cada entrada es `"<path>: <error>"`. Los que sí se
   *  escribieron antes del fallo están en el snapshot, así que Deshacer los
   *  cubre — hay que decírselo al autor, no tragarse el error. */
  failedFiles: string[];
  snapshotId: string;
}

interface UndoOutcome {
  restored: number;
  /** Se editaron después del reemplazo: no se pisaron. El panel ofrece
   *  "Pisarlos igual" con estos paths. */
  blocked: string[];
  /** Falló la restauración (permisos, disco, `rel` inválido en el manifest).
   *  Cada entrada es `"<path>: <error>"`. El snapshot NO se borra si hay
   *  alguno, para poder reintentar.
   *  OJO al renderizar: **no son todos capítulos** — acá también cae
   *  `.twriter/stats.json`. No los cuentes como "capítulos". */
  failed: string[];
  /** True si el registro del snapshot quedó incompleto (`replace_apply` no
   *  pudo reescribir el manifest final). En ese caso `blocked` NO significa
   *  "se editó después": significa "no sé si es seguro restaurarlo". La copy
   *  tiene que decir eso, o el autor confirma "Pisarlos igual" creyendo que
   *  pisa sus propias ediciones recientes. */
  suspect: boolean;
}

export interface UndoInfo {
  snapshotId: string;
  needle: string;
  replacement: string;
  files: number;
  occurrences: number;
  /** Paths que el undo se negó a pisar. Por default es "se editaron después
   *  del reemplazo"; si `suspect` está en true, es "el registro quedó
   *  incompleto y no sé si es seguro". La copy tiene que distinguirlos. */
  blocked: string[];
  suspect: boolean;
}

/** Por qué el reemplazo no se puede correr con la configuración actual. */
export type MotivoBloqueo =
  | 'sinQuery'
  | 'sinCambio'
  | 'scopeNotas'
  | 'sinContexto'
  | 'sinSeleccion'
  | null;

@Injectable({ providedIn: 'root' })
export class ReplaceService {
  private search = inject(SearchService);
  private settings = inject(SettingsService);
  private chapter = inject(ChapterService);
  private project = inject(ProjectService);
  private git = inject(GitService);
  private toast = inject(ToastService);
  private debug = inject(DebugService);

  readonly replacement = signal<string>('');
  readonly groups = signal<ReplaceGroup[]>([]);
  readonly deselected = signal<Set<string>>(new Set());
  readonly previewing = signal<boolean>(false);
  readonly applying = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly truncated = signal<boolean>(false);
  readonly totalSkipped = signal<number>(0);
  readonly lastUndo = signal<UndoInfo | null>(null);

  readonly counts = computed(() => contar(this.groups(), this.deselected()));

  /** True si el scope elegido no puede alimentar un reemplazo. */
  readonly scopeBloqueado = computed<boolean>(() => {
    const s = this.settings.searchScope();
    if (s === 'notes') return true;
    if (s === 'current') {
      const activo = this.chapter.panes[0].active();
      return activo == null || !activo.path.toLowerCase().endsWith('.html');
    }
    return false;
  });

  readonly motivoBloqueo = computed<MotivoBloqueo>(() => {
    if (!this.search.query().trim()) return 'sinQuery';
    if (this.search.query().trim() === this.replacement()) return 'sinCambio';
    if (this.scopeBloqueado()) return 'scopeNotas';
    if (this.search.scopeNeedsContext()) return 'sinContexto';
    if (this.counts().selected === 0) return 'sinSeleccion';
    return null;
  });

  readonly puedeAplicar = computed<boolean>(
    () => this.motivoBloqueo() === null && !this.applying() && !this.previewing(),
  );

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 0;

  constructor() {
    // El preview depende del needle, los toggles y el scope. NO del
    // replacement: cambiar el texto de reemplazo solo cambia la etiqueta del
    // botón, no lo que se encontró.
    effect(() => {
      const activo = this.search.replaceMode();
      this.search.query();
      this.settings.searchScope();
      this.settings.replaceCaseSensitive();
      this.settings.replaceWholeWord();
      this.chapter.panes[0].active();
      if (!activo) {
        this.reset();
        return;
      }
      this.schedulePreview();
    });
  }

  reset(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.groups.set([]);
    this.deselected.set(new Set());
    this.error.set(null);
    this.truncated.set(false);
    this.totalSkipped.set(0);
    this.previewing.set(false);
  }

  setReplacement(value: string): void {
    this.replacement.set(value);
  }

  toggleOcurrencia(id: string): void {
    this.deselected.set(toggleOcurrenciaPuro(id, this.deselected()));
  }

  toggleGrupo(group: ReplaceGroup): void {
    this.deselected.set(toggleGrupoPuro(group, this.deselected()));
  }

  estadoGrupo(group: ReplaceGroup): 'all' | 'none' | 'some' {
    return estadoGrupo(group, this.deselected());
  }

  private schedulePreview(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runPreview();
    }, DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    const needle = this.search.query().trim();
    if (!needle || this.scopeBloqueado()) {
      this.groups.set([]);
      this.totalSkipped.set(0);
      this.truncated.set(false);
      return;
    }
    const scopePath = this.resolveScopePath();
    if (!scopePath) {
      this.groups.set([]);
      return;
    }
    const id = ++this.requestId;
    this.previewing.set(true);
    this.error.set(null);
    try {
      // El disco tiene que estar al día antes de escanearlo: el capítulo
      // abierto puede tener ediciones sin guardar.
      await this.chapter.flushAllDirty();
      const pv = await invoke<ReplacePreview>('replace_preview', {
        scopePath,
        needle,
        caseSensitive: this.settings.replaceCaseSensitive(),
        wholeWord: this.settings.replaceWholeWord(),
      });
      if (id !== this.requestId) return;
      this.groups.set(pv.groups);
      this.totalSkipped.set(pv.totalSkipped);
      this.truncated.set(pv.truncated);
      // Las ocurrencias que ya no existen se van del set de apagadas, así el
      // contador no queda mintiendo tras editar la query.
      const vivos = new Set(pv.groups.flatMap((g) => g.occurrences.map((o) => o.id)));
      this.deselected.update((prev) => new Set([...prev].filter((id) => vivos.has(id))));
    } catch (err) {
      if (id !== this.requestId) return;
      this.error.set(String(err));
      this.groups.set([]);
      this.debug.error('replace', `preview falló: ${err}`);
    } finally {
      if (id === this.requestId) this.previewing.set(false);
    }
  }

  /**
   * Mapea el scope del panel a un PATH de disco. `replace_preview` camina un
   * directorio (o un archivo suelto), no filtra por nombre de saga como hace
   * tantivy, así que hay que resolver el ancestro a su path.
   */
  private resolveScopePath(): string | null {
    const s = this.settings.searchScope();
    const root = this.settings.root();
    if (s === 'all' || s === 'chapters') return root ?? null;
    const activo = this.chapter.panes[0].active();
    if (s === 'current') return activo?.path ?? null;
    if (!activo) return null;
    if (s === 'saga') return this.project.findAncestorByKind(activo.path, 'saga')?.path ?? null;
    if (s === 'book') return this.project.findAncestorByKind(activo.path, 'book')?.path ?? null;
    return null;
  }

  async apply(): Promise<void> {
    if (!this.puedeAplicar()) return;
    const root = this.settings.root();
    if (!root) return;
    const needle = this.search.query().trim();
    const replacement = this.replacement();
    const edits: FileEdit[] = editsDesdeSeleccion(this.groups(), this.deselected());
    if (edits.length === 0) return;
    this.applying.set(true);
    try {
      await this.chapter.flushAllDirty();
      const out = await invoke<ReplaceOutcome>('replace_apply', {
        root,
        needle,
        caseSensitive: this.settings.replaceCaseSensitive(),
        wholeWord: this.settings.replaceWholeWord(),
        edits,
        replacement,
        // Rust no tiene crate de fechas; el formato lo fija el frontend, igual
        // que en cada save de capítulo (`chapter-service.ts:199`).
        ultimaEdicion: new Date().toISOString(),
      });
      await this.afterWrite(edits.map((e) => e.path));
      if (out.snapshotId) {
        this.lastUndo.set({
          snapshotId: out.snapshotId,
          needle,
          replacement,
          files: out.files,
          occurrences: out.occurrences,
          blocked: [],
          suspect: false,
        });
      }
      const verbo = replacement ? 'Reemplacé' : 'Borré';
      this.toast.success(
        `${verbo} ${out.occurrences} en ${out.files} capítulo${out.files === 1 ? '' : 's'}.`,
      );
      if (out.skippedFiles.length > 0) {
        this.toast.warn(
          `${out.skippedFiles.length} capítulo${out.skippedFiles.length === 1 ? '' : 's'} cambiaron desde el preview: no los toqué.`,
        );
      }
      if (out.failedFiles.length > 0) {
        // Se escribieron algunos y otros no. El autor tiene que saberlo Y saber
        // que Deshacer cubre los que sí se escribieron.
        this.toast.error(
          `No pude escribir ${out.failedFiles.length} capítulo${out.failedFiles.length === 1 ? '' : 's'}. ` +
            `Los que sí cambiaron se pueden deshacer.`,
        );
        this.debug.error('replace', 'fallos de escritura', out.failedFiles.join('\n'));
      }
      this.debug.info('replace', 'apply', JSON.stringify(out));
      await this.runPreview();
    } catch (err) {
      this.error.set(String(err));
      this.toast.error(`Reemplazo: ${err}`);
      this.debug.error('replace', `apply falló: ${err}`);
    } finally {
      this.applying.set(false);
    }
  }

  async undo(forcePaths: string[] = []): Promise<void> {
    const info = this.lastUndo();
    const root = this.settings.root();
    if (!info || !root) return;
    this.applying.set(true);
    try {
      await this.chapter.flushAllDirty();
      const out = await invoke<UndoOutcome>('replace_undo', {
        root,
        snapshotId: info.snapshotId,
        forcePaths,
        ultimaEdicion: new Date().toISOString(),
      });
      await this.afterWrite(this.groups().map((g) => g.path));
      // `failed` y `blocked` pueden venir poblados los DOS. Son avisos
      // distintos y hay que dar los dos: si solo se muestra el error de
      // escritura, el autor nunca se entera de que hay capítulos esperando
      // su confirmación.
      if (out.failed.length > 0) {
        // El snapshot sobrevive, así que reintentar es posible: no limpiar
        // `lastUndo` ni decirle al autor que terminó. `failed` no son todos
        // capítulos (puede traer `stats.json`), así que no se cuentan como
        // tales.
        this.lastUndo.set({ ...info, blocked: out.blocked });
        this.toast.error(
          `Deshice ${out.restored}. Fallaron ${out.failed.length} archivo${out.failed.length === 1 ? '' : 's'}; el snapshot sigue disponible para reintentar.`,
        );
        this.debug.error('replace', 'fallos al deshacer', out.failed.join('\n'));
      }
      if (out.blocked.length > 0) {
        this.lastUndo.set({ ...info, blocked: out.blocked });
        this.toast.warn(
          out.suspect
            ? `Deshice ${out.restored}. El registro de este reemplazo quedó incompleto, así que no toqué ${out.blocked.length} capítulo${out.blocked.length === 1 ? '' : 's'}: no puedo saber si es seguro restaurarlos.`
            : `Deshice ${out.restored}. ${out.blocked.length} capítulo${out.blocked.length === 1 ? '' : 's'} se editaron después del reemplazo y no los pisé.`,
        );
      }
      if (out.failed.length === 0 && out.blocked.length === 0) {
        this.lastUndo.set(null);
        this.toast.success(`Deshecho: ${out.restored} capítulo${out.restored === 1 ? '' : 's'}.`);
      }
      this.debug.info('replace', 'undo', JSON.stringify(out));
      await this.runPreview();
    } catch (err) {
      this.toast.error(`Deshacer: ${err}`);
      this.debug.error('replace', `undo falló: ${err}`);
    } finally {
      this.applying.set(false);
    }
  }

  /** Refresca todo lo que quedó viejo tras escribir en disco. Mismo orden que
   *  usa `QuotesFixService` después de un fix en lote. */
  private async afterWrite(paths: string[]): Promise<void> {
    await this.chapter.reloadIfChanged(paths.map((path) => ({ path, kind: 'modified' as const })));
    await this.project.loadTree();
    void this.git.refreshStatus();
    await this.search.applyPathChanges(paths.map((path) => ({ path, kind: 'modified' as const })));
  }
}
