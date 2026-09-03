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
  /** Paths efectivamente escritos por el apply que generó este snapshot.
   *  El undo refresca ESTOS paths (no `groups()`: para cuando el undo corre,
   *  el needle ya no matchea nada y el preview quedó vacío — usar `groups()`
   *  ahí deja el editor mostrando el reemplazo con `dirty=false`). */
  paths: string[];
  /** Paths que el undo se negó a pisar. Por default es "se editaron después
   *  del reemplazo"; si `suspect` está en true, es "el registro quedó
   *  incompleto y no sé si es seguro". La copy tiene que distinguirlos. */
  blocked: string[];
  suspect: boolean;
}

/** Sella un preview con los parámetros que lo produjeron. `apply()` lo
 *  compara contra los valores actuales antes de escribir: si no coinciden
 *  (un preview viejo llegó tarde y repobló `groups` durante la ventana del
 *  debounce), se niega — mejor que un flag `pendiente`, porque cubre
 *  cualquier desincronización entre lo que se ve y lo que se va a escribir,
 *  no solo la del debounce. */
interface PreviewSeal {
  needle: string;
  scopePath: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Por qué el reemplazo no se puede correr con la configuración actual. */
export type MotivoBloqueo =
  | 'sinQuery'
  | 'sinCambio'
  | 'scopeNotas'
  /** Scope "Archivo actual" sin capítulo abierto (o abierto algo no-.html), o
   *  scope Saga/Libro sin ningún capítulo abierto — en los dos casos el
   *  remedio es el mismo: abrir un capítulo. */
  | 'sinCapitulo'
  /** Scope Saga/Libro con un capítulo abierto que no cuelga de ese ancestro
   *  (vive en una carpeta suelta). Distinto de `sinCapitulo`: acá SÍ hay un
   *  capítulo, pero el scope elegido no lo puede usar. */
  | 'sinAncestro'
  /** Hay un preview en camino (debounce todavía corriendo, o el invoke ya en
   *  vuelo) y `groups`/`counts` todavía no reflejan la config actual. Sin
   *  este caso, la ventana de 250ms del debounce dejaba el botón habilitado
   *  con `counts().selected === 0` (preview viejo o vacío) y el sello interno
   *  de `apply()` cortaba en silencio al click. */
  | 'sinPreview'
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
  /** True entre `schedulePreview()` y que `previewing()` se prenda: cubre la
   *  ventana del debounce donde todavía no se disparó el invoke. Se apaga al
   *  arrancar `runPreview()`, ya sea que siga al invoke o corte antes por
   *  needle vacío / scope sin resolver. */
  readonly pending = signal<boolean>(false);
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
    const s = this.settings.searchScope();
    if (s === 'notes') return 'scopeNotas';
    if (s === 'current' && this.scopeBloqueado()) return 'sinCapitulo';
    if (s === 'saga' || s === 'book') {
      const activo = this.chapter.panes[0].active();
      if (activo == null) return 'sinCapitulo';
      // Consultamos resolveScopePath() en vez de deducirlo: es la misma
      // función que arma el path real que se manda a `replace_preview`, así
      // que no hay forma de que este chequeo y el que realmente corre diverjan.
      if (this.resolveScopePath() === null) return 'sinAncestro';
    }
    if (this.pending() || this.previewing()) return 'sinPreview';
    if (this.counts().selected === 0) return 'sinSeleccion';
    return null;
  });

  readonly puedeAplicar = computed<boolean>(
    () => this.motivoBloqueo() === null && !this.applying() && !this.previewing(),
  );

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 0;
  /** Sello del último preview que sí se aplicó a `groups`. Null mientras
   *  `groups` está vacío o desactualizado respecto de la config actual. */
  private previewSeal: PreviewSeal | null = null;

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
    // Invalida cualquier preview en vuelo: su `id` capturado ya no va a
    // matchear `requestId`, así que su respuesta tardía se descarta.
    this.requestId++;
    this.previewSeal = null;
    this.groups.set([]);
    this.deselected.set(new Set());
    this.error.set(null);
    this.truncated.set(false);
    this.totalSkipped.set(0);
    this.previewing.set(false);
    this.pending.set(false);
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
    this.pending.set(true);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runPreview();
    }, DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    // La ventana de "pending" termina acá, corra o no el invoke: si el
    // needle o el scope cortan antes (ver early returns de abajo), no hay
    // preview en camino y el guard de `motivoBloqueo` no tiene por qué seguir
    // mostrando "Buscando ocurrencias…".
    this.pending.set(false);
    // `id` se toma ACÁ, antes de cualquier early return: así, aunque este
    // llamado corte por needle vacío o scope sin resolver, invalida a
    // cualquier preview anterior en vuelo (su `id` capturado deja de
    // matchear `requestId`) y su respuesta tardía no puede repoblar `groups`
    // con el scope/needle viejo.
    const id = ++this.requestId;
    const needle = this.search.query().trim();
    if (!needle || this.scopeBloqueado()) {
      this.groups.set([]);
      this.previewSeal = null;
      this.totalSkipped.set(0);
      this.truncated.set(false);
      return;
    }
    const scopePath = this.resolveScopePath();
    if (!scopePath) {
      this.groups.set([]);
      this.previewSeal = null;
      return;
    }
    const caseSensitive = this.settings.replaceCaseSensitive();
    const wholeWord = this.settings.replaceWholeWord();
    this.previewing.set(true);
    this.error.set(null);
    try {
      // El disco tiene que estar al día antes de escanearlo: el capítulo
      // abierto puede tener ediciones sin guardar.
      await this.chapter.flushAllDirty();
      const pv = await invoke<ReplacePreview>('replace_preview', {
        scopePath,
        needle,
        caseSensitive,
        wholeWord,
      });
      if (id !== this.requestId) return;
      this.groups.set(pv.groups);
      this.previewSeal = { needle, scopePath, caseSensitive, wholeWord };
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
      this.previewSeal = null;
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
    const scopePath = this.resolveScopePath();
    const caseSensitive = this.settings.replaceCaseSensitive();
    const wholeWord = this.settings.replaceWholeWord();
    // `groups` puede venir de un preview viejo que ganó la carrera del
    // requestId antes de sellarse (o que el debounce todavía no reemplazó).
    // Si lo que ve el autor no coincide con la config actual, no escribimos:
    // mejor un click que no hace nada que escribir fuera del scope elegido.
    const seal = this.previewSeal;
    if (
      !seal ||
      seal.needle !== needle ||
      seal.scopePath !== scopePath ||
      seal.caseSensitive !== caseSensitive ||
      seal.wholeWord !== wholeWord
    ) {
      this.debug.warn('replace', 'apply: preview desactualizado respecto de la config actual, no escribo');
      return;
    }
    const edits: FileEdit[] = editsDesdeSeleccion(this.groups(), this.deselected());
    if (edits.length === 0) return;
    this.applying.set(true);
    try {
      await this.chapter.flushAllDirty();
      const out = await invoke<ReplaceOutcome>('replace_apply', {
        root,
        needle,
        caseSensitive,
        wholeWord,
        edits,
        replacement,
        // Rust no tiene crate de fechas; el formato lo fija el frontend, igual
        // que en cada save de capítulo (`chapter-service.ts:199`).
        ultimaEdicion: new Date().toISOString(),
      });
      const paths = edits.map((e) => e.path);
      await this.afterWrite(paths);
      // Apagar ACÁ, no en el `finally`: lo que sigue es `loadTree()` (ya hecho
      // por `afterWrite`) más el `runPreview()` de abajo, un rescan de disco
      // de todo el scope. Si `applying` sigue en true durante ese rescan, el
      // editor recién recargado por `afterWrite` queda editable de nuevo pero
      // todavía tapado por el overlay — el autor tipearía a ciegas. El
      // `finally` de más abajo lo vuelve a poner en false por las dudas (rutas
      // de error antes de este punto), sin efecto visible si ya está en false.
      this.applying.set(false);
      if (out.snapshotId) {
        this.lastUndo.set({
          snapshotId: out.snapshotId,
          needle,
          replacement,
          files: out.files,
          occurrences: out.occurrences,
          paths,
          blocked: [],
          suspect: false,
        });
      }
      if (out.files > 0) {
        const verbo = replacement ? 'Reemplacé' : 'Borré';
        this.toast.success(
          `${verbo} ${out.occurrences} en ${out.files} capítulo${out.files === 1 ? '' : 's'}.`,
        );
      }
      if (out.skippedFiles.length > 0) {
        this.toast.warn(
          `${out.skippedFiles.length} capítulo${out.skippedFiles.length === 1 ? '' : 's'} cambiaron desde el preview: no los toqué.`,
        );
      }
      if (out.failedFiles.length > 0) {
        // Se escribieron algunos y otros no. El autor tiene que saberlo Y saber
        // que Deshacer cubre los que sí se escribieron. `failedFiles` no son
        // todos capítulos —acá también cae `stats.json` o el manifest del
        // snapshot— así que la copy dice "archivo", como la rama del undo.
        this.toast.error(
          `No pude escribir ${out.failedFiles.length} archivo${out.failedFiles.length === 1 ? '' : 's'}. ` +
            `Los ${out.files} capítulo${out.files === 1 ? '' : 's'} que sí se escribieron se pueden deshacer.`,
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
      // `info.paths`, no `groups()`: para cuando el undo corre, el needle ya
      // no matchea nada y el preview está vacío. Refrescar por `groups()`
      // dejaba el editor mostrando el reemplazo con `dirty=false` — el
      // próximo autosave lo reescribía y el undo se revertía solo.
      await this.afterWrite(info.paths);
      // Mismo motivo que en `apply()`: apagar acá, antes del `runPreview()` de
      // abajo, para no dejar el editor recién recargado editable-y-tapado
      // durante el rescan.
      this.applying.set(false);
      // `failed` y `blocked` pueden venir poblados los DOS. Son avisos
      // distintos y hay que dar los dos: si solo se muestra el error de
      // escritura, el autor nunca se entera de que hay capítulos esperando
      // su confirmación. Un solo `set` cubre las dos ramas — antes se pisaba
      // dos veces con el mismo valor cuando venían juntos.
      if (out.failed.length > 0 || out.blocked.length > 0) {
        // El snapshot sobrevive, así que reintentar es posible: no limpiar
        // `lastUndo` ni decirle al autor que terminó. `failed` no son todos
        // capítulos (puede traer `stats.json`), así que no se cuentan como
        // tales. `suspect` viaja acá porque es lo que lee el botón "Pisarlos
        // igual" — el toast dura 6s, esto persiste.
        this.lastUndo.set({ ...info, blocked: out.blocked, suspect: out.suspect });
      }
      if (out.failed.length > 0) {
        this.toast.error(
          `Deshice ${out.restored}. Fallaron ${out.failed.length} archivo${out.failed.length === 1 ? '' : 's'}; el snapshot sigue disponible para reintentar.`,
        );
        this.debug.error('replace', 'fallos al deshacer', out.failed.join('\n'));
      }
      if (out.blocked.length > 0) {
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
      // Si el snapshot ya no existe (carpeta borrada a mano, o cambio de
      // root — `UndoInfo` no recuerda el root y acá arriba usamos el actual),
      // no dejar el botón "Deshacer" ofrecido para siempre sobre algo
      // inexistente.
      if (String(err).toLowerCase().includes('no encontré el snapshot')) {
        this.lastUndo.set(null);
      }
      this.toast.error(`Deshacer: ${err}`);
      this.debug.error('replace', `undo falló: ${err}`);
    } finally {
      this.applying.set(false);
    }
  }

  /** Refresca lo que quedó viejo tras escribir en disco: el buffer del
   *  editor si alguno de estos paths está abierto, el árbol (palabras /
   *  `ultima_edicion` cambiaron) y el status de git. NO toca el índice de
   *  búsqueda: `fs::write_chapter` ya reindexa cada path que escribe del lado
   *  Rust, así que un segundo camino acá sería trabajo redundante — y
   *  serializaría un invoke por archivo adentro de `applying`. */
  private async afterWrite(paths: string[]): Promise<void> {
    await this.chapter.reloadIfChanged(paths.map((path) => ({ path, kind: 'modified' as const })));
    await this.project.loadTree();
    void this.git.refreshStatus();
  }
}
