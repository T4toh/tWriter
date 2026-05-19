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
    const term = chapter.plain.slice(v.offset, v.offset + v.length).trim();
    if (term.length >= 2) {
      this.search.requestHighlight(chapter.path, term);
    }
    await this.chapter.open(node);
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
