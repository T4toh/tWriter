import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  LucideBookOpen,
  LucideCircleAlert,
  LucideCircleX,
  LucideDynamicIcon,
  LucideRuler,
  LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { ChapterService } from '../core/chapter-service';
import { NavigationService } from '../core/navigation-service';
import { ProjectService } from '../core/project-service';
import { ChapterViolations, RayaAuditService } from '../core/raya-audit-service';
import { RayaViolation } from '../core/types';
import { SearchService } from '../core/search-service';
import { RayaChuletaService } from '../core/raya-chuleta-service';
import { auditAnchor, auditSnippet } from '../core/audit-snippet';
import { findNodeByPath } from '../core/tree-utils';

@Component({
  selector: 'app-raya-audit-panel',
  standalone: true,
  imports: [LucideBookOpen, LucideDynamicIcon, LucideRuler, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './raya-audit-panel.html',
  styleUrl: './raya-audit-panel.scss',
})
export class RayaAuditPanel {
  private svc = inject(RayaAuditService);
  private chapter = inject(ChapterService);
  private project = inject(ProjectService);
  private nav = inject(NavigationService);
  private search = inject(SearchService);
  protected readonly chuleta = inject(RayaChuletaService);

  protected readonly scope = this.svc.scope;
  protected readonly chapters = this.svc.chapters;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;
  protected readonly progress = this.svc.progress;
  protected readonly total = this.svc.totalViolations;
  protected readonly autoFixable = this.svc.autoFixableCount;
  protected readonly emptyAfterLoad = computed(
    () => !this.loading() && this.chapters().length === 0 && this.error() === null,
  );

  protected close(): void {
    this.svc.close();
  }

  protected categoryLabel(c: RayaViolation['category']): string {
    switch (c) {
      case 'pending-conversion':
        return 'Conv. pendiente';
      case 'char':
        return 'Carácter';
      case 'structure':
        return 'Estructura';
      case 'typo':
        return 'Tipografía';
      case 'mayusculas':
        return 'Mayúsculas';
    }
  }

  protected severityIcon(s: RayaViolation['severity']): LucideIcon {
    return s === 'error' ? LucideCircleX : LucideCircleAlert;
  }

  protected snippet(chapter: ChapterViolations, v: RayaViolation): string {
    return auditSnippet(chapter.plain, v.offset, v.length);
  }

  protected async openChapterAt(chapter: ChapterViolations, v: RayaViolation): Promise<void> {
    const node = findNodeByPath(this.project.tree(), chapter.path);
    if (!node) return;
    const parent = chapter.path.replace(/\/[^/]+$/, '');
    this.nav.setBrowsing(parent);
    // Ancla de texto, NO el offset — el porqué está en `audit-snippet.ts`.
    const anchor = auditAnchor(chapter.plain, v.offset, v.length);
    if (anchor.length >= 2) {
      // `fold: false` a propósito: el ancla es texto exacto del capítulo, así que
      // plegar acentos sólo abre la puerta a que una variante sin tilde de un
      // párrafo anterior le gane al bloque de la violación.
      this.search.requestHighlight(chapter.path, anchor, undefined, false);
      // Y el popover sobre la violación: ahí están la regla, el ejemplo y el
      // arreglo, que es lo que el autor vino a ver.
      this.svc.pedirPopover(chapter.path, v.ruleId, anchor);
    }
    // Si el capítulo ya está abierto, NO recargarlo: `chapter.open` vuelve a
    // hacer `setContent`, y el resaltado que el editor ya consumió sobre el DOM
    // viejo se pierde con el reset de scroll — el salto no se mueve del
    // anterior. Mismo guard que el panel de búsqueda.
    if (this.chapter.panes[0].active()?.path === chapter.path) return;
    await this.chapter.open(node);
  }
}
