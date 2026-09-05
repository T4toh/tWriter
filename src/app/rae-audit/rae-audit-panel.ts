import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
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
import { ChapterViolations, RaeAuditService } from '../core/rae-audit-service';
import { RaeViolation } from '../core/types';
import { SearchService } from '../core/search-service';
import { auditAnchor, auditSnippet } from '../core/audit-snippet';
import { findNodeByPath } from '../core/tree-utils';

@Component({
  selector: 'app-rae-audit-panel',
  standalone: true,
  imports: [LucideDynamicIcon, LucideRuler, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rae-audit-panel.html',
  styleUrl: './rae-audit-panel.scss',
})
export class RaeAuditPanel {
  private svc = inject(RaeAuditService);
  private chapter = inject(ChapterService);
  private project = inject(ProjectService);
  private nav = inject(NavigationService);
  private search = inject(SearchService);

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

  protected categoryLabel(c: RaeViolation['category']): string {
    switch (c) {
      case 'pending-conversion':
        return 'Conv. pendiente';
      case 'char':
        return 'Carácter';
      case 'structure':
        return 'Estructura';
      case 'typo':
        return 'Tipografía';
    }
  }

  protected severityIcon(s: RaeViolation['severity']): LucideIcon {
    return s === 'error' ? LucideCircleX : LucideCircleAlert;
  }

  protected snippet(chapter: ChapterViolations, v: RaeViolation): string {
    return auditSnippet(chapter.plain, v.offset, v.length);
  }

  protected async openChapterAt(chapter: ChapterViolations, v: RaeViolation): Promise<void> {
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
    }
    await this.chapter.open(node);
  }
}
