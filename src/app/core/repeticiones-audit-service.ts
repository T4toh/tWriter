import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { htmlToPlain } from '../dialogos/validator';
import { detectRepeticiones, DEFAULTS as REP_DEFAULTS } from '../repeticiones/detector';
import { findCompoundRanges, isInsideCompound } from '../dictionary/compound-terms';
import { resolverIdiomaEfectivo } from '../revision/deteccion';
import { Repeticion } from './types';
import { auditTitleFromPath } from './audit-snippet';
import { BookConfigService } from './book-config-service';
import { DebugService } from './debug-service';
import { FontPreviewService } from './font-preview-service';
import { ImageViewerService } from './image-viewer-service';
import { MarkdownReaderService } from './markdown-reader-service';
import { RaeAuditService } from './rae-audit-service';
import { SearchService } from './search-service';
import { SettingsService } from './settings-service';

interface ChapterPayload {
  path: string;
  html: string;
  idioma?: string | null;
}

export interface ChapterRepeticiones {
  path: string;
  title: string;
  /** El plano contra el que se calcularon los offsets. Lo necesitan tanto el
   *  snippet de la lista como el ancla del salto. */
  plain: string;
  repeticiones: Repeticion[];
}

export interface RepeticionesScope {
  path: string;
  name: string;
}

/**
 * Auditoría de repeticiones sobre un alcance (saga, libro o sección).
 *
 * Hermano de `RaeAuditService`, con la misma forma a propósito: el modal de
 * revisión por libro sabía cuántas repeticiones había pero no cuáles ni dónde,
 * así que para arreglarlas había que abrir capítulo por capítulo a buscarlas de
 * nuevo a ojo. Acá se juntan las ocurrencias con `path` + `offset` + `length`,
 * que es lo que necesitan el snippet y el salto.
 *
 * El detector ya devolvía todo eso: `escanear` en `revision-libro-service` lo
 * tiraba al contar (`res.repeticiones.cambios += det.repeticiones`).
 */
@Injectable({ providedIn: 'root' })
export class RepeticionesAuditService {
  private search = inject(SearchService);
  private imageViewer = inject(ImageViewerService);
  private fontPreview = inject(FontPreviewService);
  private markdownReader = inject(MarkdownReaderService);
  private raeAudit = inject(RaeAuditService);
  private settings = inject(SettingsService);
  private bookConfig = inject(BookConfigService);
  private debug = inject(DebugService);

  readonly scope = signal<RepeticionesScope | null>(null);
  readonly chapters = signal<ChapterRepeticiones[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly progress = signal<{ done: number; total: number } | null>(null);

  readonly total = computed(() =>
    this.chapters().reduce((sum, c) => sum + c.repeticiones.length, 0),
  );

  /** Pedido de "abrime el popover sobre ESTA aparición", que el editor consume
   *  al terminar de detectar. Mismo patrón que el `PendingHighlight` de
   *  `SearchService`: el panel no puede abrir el popover por su cuenta porque
   *  necesita posiciones de ProseMirror, que solo existen después de que el
   *  capítulo abrió y el detector corrió.
   *
   *  La aparición se identifica por `palabra` normalizada + `anchor`, el mismo
   *  texto que se usa para el salto. El offset NO sirve: el panel lo calcula
   *  sobre `htmlToPlain` y el editor vive en `extractPlainText`, y los dos
   *  planos se desfasan. El ancla, en cambio, es idéntica en los dos — de eso
   *  se trata. */
  readonly pendingPopover = signal<{
    path: string;
    palabra: string;
    anchor: string;
  } | null>(null);

  pedirPopover(path: string, palabra: string, anchor: string): void {
    this.pendingPopover.set({ path, palabra, anchor });
  }

  limpiarPopoverPendiente(): void {
    this.pendingPopover.set(null);
  }

  constructor() {
    // La exclusión mutua con la auditoría RAE es de ida y vuelta, pero la
    // inyección no puede serlo: este servicio ya inyecta `RaeAuditService`
    // para cerrarlo al abrir, y hacer que el otro inyecte a este cerraría un
    // ciclo de DI. Así que la vuelta va por acá — si la RAE abre, este se
    // cierra solo. Sin esto quedaría abierto pero tapado (la cadena
    // `@else if` de `app.html` prioriza la RAE) y reaparecería viejo al
    // cerrar la de arriba.
    effect(() => {
      if (this.raeAudit.scope() !== null && this.scope() !== null) this.close();
    });
  }

  isOpen(): boolean {
    return this.scope() !== null;
  }

  /** Diccionario de la saga que contiene al alcance. Mismo camino que
   *  `RevisionLibroService.palabrasDeLaSaga`: `find_saga_dir` resuelve por
   *  filesystem, así que no hace falta caminar el árbol en TS. */
  private async palabrasDeLaSaga(path: string): Promise<string[]> {
    try {
      const sagaPath = await invoke<string | null>('find_saga_dir', { path });
      if (!sagaPath) return [];
      return await invoke<string[]>('get_saga_dictionary', { sagaPath });
    } catch {
      return [];
    }
  }

  /** Idioma declarado en `book.json`, si el alcance está adentro de un libro.
   *  Un fallo acá no es un error del escaneo: se cae al idioma del capítulo y
   *  después a `detectLang`, que es la cadena normal de `resolverIdiomaEfectivo`. */
  private async idiomaDelLibro(path: string): Promise<string | null> {
    try {
      const cfg = await this.bookConfig.load(path);
      return cfg.idioma ?? null;
    } catch {
      return null;
    }
  }

  async open(scope: RepeticionesScope): Promise<void> {
    // El slot del panel derecho es único (cadena `@else if` en `app.html`), así
    // que abrir este tiene que cerrar los otros — incluida la auditoría RAE,
    // que es la que más probablemente esté abierta al lado.
    this.search.hide();
    this.imageViewer.close();
    this.fontPreview.close();
    this.markdownReader.close();
    this.raeAudit.close();

    this.scope.set(scope);
    this.chapters.set([]);
    this.loading.set(true);
    this.error.set(null);
    this.progress.set(null);

    try {
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath: scope.path,
      });
      if (this.scope() !== scope) return;
      this.progress.set({ done: 0, total: payloads.length });

      // Una sola vez para todo el alcance, igual que en `escanear`.
      const idiomaLibro = await this.idiomaDelLibro(scope.path);
      const diccionario = await this.palabrasDeLaSaga(scope.path);
      if (this.scope() !== scope) return;
      const excepciones = this.settings.repeticionesExcepciones();

      const accumulated: ChapterRepeticiones[] = [];
      let processed = 0;
      for (const payload of payloads) {
        const plain = htmlToPlain(payload.html);
        const idioma = resolverIdiomaEfectivo(idiomaLibro, payload.idioma, payload.html);
        // Las compuestas del diccionario no se pueden filtrar por `ignorar`,
        // que es token-level. Mismo descarte por rango que el editor.
        const compuestas = findCompoundRanges(plain, diccionario);
        const reps = detectRepeticiones(plain, idioma === 'en' ? 'en' : 'es', {
          ...REP_DEFAULTS,
          excepciones,
          ignorar: diccionario,
        }).filter((r) => !isInsideCompound(compuestas, r.offset, r.offset + r.length));

        if (reps.length > 0) {
          accumulated.push({
            path: payload.path,
            title: auditTitleFromPath(payload.path),
            plain,
            repeticiones: reps,
          });
          // Se publica capítulo a capítulo, como la auditoría RAE: la lista se
          // va llenando mientras escanea en vez de aparecer entera al final.
          this.chapters.set([...accumulated]);
        }
        processed += 1;
        this.progress.set({ done: processed, total: payloads.length });
        if (processed % 5 === 0) {
          await yieldToEventLoop();
          if (this.scope() !== scope) return;
        }
      }

      this.debug.info(
        'repeticiones-audit',
        'audit completado',
        JSON.stringify({
          scope: scope.path,
          chapters: payloads.length,
          withHits: accumulated.length,
          total: this.total(),
        }),
      );
    } catch (err) {
      if (this.scope() !== scope) return;
      this.error.set(String(err));
      this.debug.error('repeticiones-audit', 'audit falló', String(err));
    } finally {
      this.loading.set(false);
      this.progress.set(null);
    }
  }

  close(): void {
    this.scope.set(null);
    this.chapters.set([]);
    this.loading.set(false);
    this.error.set(null);
    this.progress.set(null);
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
