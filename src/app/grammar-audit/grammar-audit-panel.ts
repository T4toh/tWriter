import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LucideSpellCheck, LucideX } from '@lucide/angular';
import { auditAnchor, auditSnippet } from '../core/audit-snippet';
import { ChapterService } from '../core/chapter-service';
import { ChapterGrammar, GrammarAuditService } from '../core/grammar-audit-service';
import { NavigationService } from '../core/navigation-service';
import { ProjectService } from '../core/project-service';
import { SearchService } from '../core/search-service';
import { findNodeByPath } from '../core/tree-utils';
import { GrammarMatch } from '../core/types';

/** Hasta cuántos matches se muestra el capítulo abierto de entrada. Mismo
 *  criterio que el panel de repeticiones. */
const AUTO_ABRIR_HASTA = 10;

@Component({
  selector: 'app-grammar-audit-panel',
  standalone: true,
  imports: [LucideSpellCheck, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './grammar-audit-panel.html',
  styleUrl: './grammar-audit-panel.scss',
})
export class GrammarAuditPanel {
  protected svc = inject(GrammarAuditService);
  private chapter = inject(ChapterService);
  private project = inject(ProjectService);
  private nav = inject(NavigationService);
  private search = inject(SearchService);

  protected readonly scope = this.svc.scope;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;
  protected readonly progress = this.svc.progress;
  protected readonly total = this.svc.total;
  protected readonly fallidos = this.svc.fallidos;

  protected readonly grupos = computed(() =>
    this.svc.chapters().map((c) => ({
      chapter: c,
      abierto: c.matches.length <= AUTO_ABRIR_HASTA,
    })),
  );

  protected readonly emptyAfterLoad = computed(
    () => !this.loading() && this.svc.chapters().length === 0 && this.error() === null,
  );

  protected close(): void {
    this.svc.close();
  }

  protected snippet(chapter: ChapterGrammar, m: GrammarMatch): string {
    return auditSnippet(chapter.plain, m.offset, m.length);
  }

  /** El texto marcado tal cual está escrito. Es lo que decide de un vistazo
   *  si es un error o un nombre propio / palabra en otro idioma que no vale
   *  la pena meter al diccionario. */
  protected texto(chapter: ChapterGrammar, m: GrammarMatch): string {
    return chapter.plain.slice(m.offset, m.offset + m.length);
  }

  protected mensaje(m: GrammarMatch): string {
    return m.shortMessage || m.message;
  }

  protected async openChapterAt(chapter: ChapterGrammar, m: GrammarMatch): Promise<void> {
    const node = findNodeByPath(this.project.tree(), chapter.path);
    if (!node) return;
    const parent = chapter.path.replace(/\/[^/]+$/, '');
    this.nav.setBrowsing(parent);
    // Ancla de texto, NO el offset — el porqué está en `audit-snippet.ts`.
    const anchor = auditAnchor(chapter.plain, m.offset, m.length);
    if (anchor.length >= 2) {
      this.search.requestHighlight(chapter.path, anchor, undefined, false);
      // Y el popover sobre el match: ahí están las sugerencias, «ignorar» y
      // «+ diccionario», que es lo que el autor vino a hacer.
      this.svc.pedirPopover(chapter.path, m.ruleId, anchor);
    }
    // Si el capítulo ya está abierto, NO recargarlo: `chapter.open` vuelve a
    // hacer `setContent`, y el resaltado que el editor ya consumió sobre el DOM
    // viejo se pierde con el reset de scroll — el salto no se mueve del
    // anterior. Mismo guard que el panel de búsqueda.
    if (this.chapter.panes[0].active()?.path === chapter.path) return;
    await this.chapter.open(node);
  }
}
