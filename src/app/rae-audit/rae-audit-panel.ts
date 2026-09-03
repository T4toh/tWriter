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
import { RaeViolation, TreeNode } from '../core/types';
import { SearchService } from '../core/search-service';

/** Chars de contexto a cada lado de la violación para el ancla del salto. */
const ANCHOR_MARGIN = 40;

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
    const margin = 40;
    const start = Math.max(0, v.offset - margin);
    const end = Math.min(chapter.plain.length, v.offset + v.length + margin);
    const before = chapter.plain.slice(start, v.offset);
    const highlight = chapter.plain.slice(v.offset, v.offset + v.length);
    const after = chapter.plain.slice(v.offset + v.length, end);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < chapter.plain.length ? '…' : '';
    return `${prefix}${before}‹${highlight}›${after}${suffix}`;
  }

  protected async openChapterAt(chapter: ChapterViolations, v: RaeViolation): Promise<void> {
    const node = findNodeByPath(this.project.tree(), chapter.path);
    if (!node) return;
    const parent = chapter.path.replace(/\/[^/]+$/, '');
    this.nav.setBrowsing(parent);
    // Ancla de texto, NO el offset: la auditoría calcula sus offsets sobre
    // `dialogos/htmlToPlain`, que dropea los `<hr>`, mientras el editor vive en
    // el espacio de `extractPlainText`, que mete `* * *` por cada uno. Los dos
    // planos se desfasan 7 chars por corte de escena, así que pasar el offset
    // crudo cae al lado. El texto de alrededor, en cambio, es idéntico en los
    // dos: se recorta al bloque y el highlighter lo encuentra exacto.
    const anchor = anchorAround(chapter.plain, v.offset, v.length);
    if (anchor.length >= 2) {
      this.search.requestHighlight(chapter.path, anchor);
    }
    await this.chapter.open(node);
  }
}

/** Contexto alrededor de `[offset, offset+length)` sin cruzar el borde del
 *  bloque (`\n\n`): el highlighter compara contra el texto de un párrafo del
 *  DOM, y un literal que abarque dos párrafos no matchearía nunca. Devuelve
 *  hasta `ANCHOR_MARGIN` chars de cada lado — cuanto más largo, más único, y
 *  con la frase entera el bloque gana por cobertura de términos aunque el
 *  literal se parta en un `<em>`. */
function anchorAround(plain: string, offset: number, length: number): string {
  const blockStart = plain.lastIndexOf('\n\n', Math.max(0, offset - 1));
  const from = blockStart < 0 ? 0 : blockStart + 2;
  const blockEnd = plain.indexOf('\n\n', offset + length);
  const to = blockEnd < 0 ? plain.length : blockEnd;
  const start = Math.max(from, offset - ANCHOR_MARGIN);
  const end = Math.min(to, offset + length + ANCHOR_MARGIN);
  return plain.slice(start, end).trim();
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
