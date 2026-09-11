import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BookConfig, BookConfigService } from '../core/book-config-service';
import { ChapterService } from '../core/chapter-service';
import { ExportsService } from '../core/exports-service';
import { sinPrefijoNumerico } from '../core/nombre-carpeta';
import { TreeNode } from '../core/types';
import { Select, SelectOption } from '../shared/select';
import { capitulosPorDefecto } from './muestra';

/**
 * Qué exportar de un libro: el EPUB completo, la muestra, o los dos (default).
 * La muestra corta en fin de capítulo; el default son los capítulos que suman
 * ~10 % de las palabras, que es lo que el lector conoce de la vista previa de
 * Amazon. El estado de apertura vive en `ExportsService` para que lo abran la
 * tarjeta del libro y el menú contextual por igual.
 */
@Component({
  selector: 'app-export-modal',
  imports: [FormsModule, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './export-modal.html',
  styleUrl: './export-modal.scss',
})
export class ExportModal {
  protected exports = inject(ExportsService);
  private chapter = inject(ChapterService);
  private cfgService = inject(BookConfigService);

  protected readonly completo = signal(true);
  protected readonly muestra = signal(true);
  protected readonly n = signal(1);
  protected readonly cfg = signal<BookConfig | null>(null);

  protected readonly titulo = computed<string>(() => {
    const node = this.exports.pendiente();
    return this.cfg()?.titulo || (node ? sinPrefijoNumerico(node.name) : '');
  });

  /** Capítulos que entran al EPUB, en orden, con sus palabras. El epílogo
   *  queda afuera porque la muestra nunca lo lleva. */
  protected readonly capitulos = computed<{ palabras: number }[]>(() => {
    const node = this.exports.pendiente();
    if (!node) return [];
    const epilogo = this.cfg()?.epilogo?.trim() || null;
    return node.children
      .filter((c) => !c.excluded && (c.kind === 'section' || c.kind === 'chapter'))
      .filter((c) => c.name !== epilogo)
      .map((c) => ({ palabras: c.wordCount ?? 0 }));
  });

  protected readonly opcionesN = computed<SelectOption[]>(() => {
    const caps = this.capitulos();
    const total = caps.reduce((s, c) => s + c.palabras, 0);
    let acumulado = 0;
    return caps.map((c, i) => {
      acumulado += c.palabras;
      const pct = total > 0 ? Math.round((acumulado / total) * 100) : 0;
      const cantidad = i + 1;
      return {
        value: String(cantidad),
        label: `${cantidad} capítulo${cantidad === 1 ? '' : 's'} · ~${pct} % del libro`,
      };
    });
  });

  protected readonly nStr = computed<string>(() => String(this.n()));
  protected readonly sinLink = computed<boolean>(() => !this.cfg()?.link?.trim());

  constructor() {
    effect(() => {
      const node = this.exports.pendiente();
      if (!node) return;
      untracked(() => {
        this.completo.set(true);
        this.muestra.set(true);
        this.cfg.set(null);
        void this.cargar(node);
      });
    });
  }

  private async cargar(node: TreeNode): Promise<void> {
    try {
      this.cfg.set(await this.cfgService.load(node.path));
    } catch {
      this.cfg.set(null);
    }
    this.n.set(capitulosPorDefecto(this.capitulos().map((c) => c.palabras)));
  }

  protected setN(value: string): void {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 1) this.n.set(parsed);
  }

  protected cerrar(): void {
    this.exports.cerrar();
  }

  protected async exportar(): Promise<void> {
    const node = this.exports.pendiente();
    if (!node) return;
    const completo = this.completo();
    const muestra = this.muestra() ? this.n() : null;
    this.cerrar();
    // En serie, no en paralelo: los dos escriben en `Exportados/` y comparten
    // el evento de progreso; un toast a la vez se lee, dos se pisan.
    if (completo) await this.chapter.exportEpub(node);
    if (muestra !== null) await this.chapter.exportEpub(node, muestra);
  }
}
