import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LucideRepeat, LucideX } from '@lucide/angular';
import { auditAnchor, auditSnippet } from '../core/audit-snippet';
import { ChapterService } from '../core/chapter-service';
import { NavigationService } from '../core/navigation-service';
import { ProjectService } from '../core/project-service';
import {
  ChapterRepeticiones,
  RepeticionesAuditService,
} from '../core/repeticiones-audit-service';
import { SearchService } from '../core/search-service';
import { findNodeByPath } from '../core/tree-utils';
import { Repeticion } from '../core/types';

/** Hasta cuántas repeticiones se muestra el capítulo abierto de entrada. Mismo
 *  criterio que los grupos del panel de búsqueda: un libro entero puede dar
 *  cientos, y con todo desplegado la lista es imposible de recorrer. */
const AUTO_ABRIR_HASTA = 10;

@Component({
  selector: 'app-repeticiones-audit-panel',
  standalone: true,
  imports: [LucideRepeat, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './repeticiones-audit-panel.html',
  styleUrl: './repeticiones-audit-panel.scss',
})
export class RepeticionesAuditPanel {
  protected svc = inject(RepeticionesAuditService);
  private chapter = inject(ChapterService);
  private project = inject(ProjectService);
  private nav = inject(NavigationService);
  private search = inject(SearchService);

  protected readonly scope = this.svc.scope;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;
  protected readonly progress = this.svc.progress;
  protected readonly total = this.svc.total;

  /** Los capítulos con su flag de auto-abrir ya resuelto, para no meter la
   *  comparación en el template. */
  protected readonly grupos = computed(() =>
    this.svc.chapters().map((c) => ({
      chapter: c,
      abierto: c.repeticiones.length <= AUTO_ABRIR_HASTA,
    })),
  );

  protected readonly emptyAfterLoad = computed(
    () => !this.loading() && this.svc.chapters().length === 0 && this.error() === null,
  );

  protected close(): void {
    this.svc.close();
  }

  protected snippet(chapter: ChapterRepeticiones, r: Repeticion): string {
    return auditSnippet(chapter.plain, r.offset, r.length);
  }

  /** «3 veces · a 6 palabras». Las dos cifras que el popover inline ya muestra
   *  y que deciden si la repetición molesta: cuántas van en la ventana y cuán
   *  cerca quedó de la anterior. */
  protected detalle(r: Repeticion): string {
    const veces = `${r.apariciones} vece${r.apariciones === 1 ? '' : 's'}`;
    const dist = `a ${r.distancia} palabra${r.distancia === 1 ? '' : 's'}`;
    return `${veces} · ${dist}`;
  }

  protected async openChapterAt(chapter: ChapterRepeticiones, r: Repeticion): Promise<void> {
    const node = findNodeByPath(this.project.tree(), chapter.path);
    if (!node) return;
    const parent = chapter.path.replace(/\/[^/]+$/, '');
    this.nav.setBrowsing(parent);
    // Ancla de texto, NO el offset — el porqué está en `audit-snippet.ts`.
    const anchor = auditAnchor(chapter.plain, r.offset, r.length);
    if (anchor.length >= 2) {
      // `fold: false`: el ancla es texto exacto del capítulo. Plegar acentos
      // solo abre la puerta a que una variante sin tilde de un párrafo anterior
      // le gane al bloque de la repetición.
      this.search.requestHighlight(chapter.path, anchor, undefined, false);
      // Y además el popover sobre la aparición: el resaltado deja seleccionada
      // el ancla ENTERA (±40 chars), que sirve para encontrar el párrafo y no
      // para arreglar nada. Lo que el autor vino a buscar son los sinónimos.
      this.svc.pedirPopover(chapter.path, r.palabra, anchor);
    }
    await this.chapter.open(node);
  }
}
