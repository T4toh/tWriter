import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import changelog from '../../../CHANGELOG.md';
import { AboutService, PaqueteLicencia } from '../core/about-service';
import { MarkdownView } from '../shared/markdown-view';

/**
 * Modal "Acerca de": qué es tWriter, bajo qué licencia, y los avisos de
 * terceros. Mismo patrón que `StorageHelpModal` — el estado de apertura vive en
 * el servicio, así lo puede abrir cualquier botón del header.
 *
 * Los datos salen de `assets/licencias.json`, que genera el `prebuild`: acá no
 * hay ninguna lista escrita a mano que pueda quedar vieja.
 */
@Component({
  selector: 'app-about-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownView],
  templateUrl: './about-modal.html',
  styleUrl: './about-modal.scss',
})
export class AboutModal {
  protected about = inject(AboutService);

  /** Qué texto de licencia está desplegado. Uno a la vez: son de 1 a 11 KB y
   *  dos abiertos vuelven el modal ilegible. */
  protected readonly abierto = signal<string | null>(null);
  /** Abre siempre en Novedades: `close()` la vuelve ahí. */
  protected readonly pestana = signal<'novedades' | 'licencias'>('novedades');

  /** Del `CHANGELOG.md` del repo (Keep a Changelog): la última versión
   *  publicada, y aparte las anteriores. Arranca en el primer `## [X.Y.Z]`,
   *  así quedan afuera la intro y `[Unreleased]`. Los links de comparación del
   *  final van con cada tramo: con ellos, `## [0.22.0]` es un link al diff. */
  protected readonly novedades: string;
  protected readonly anteriores: string;

  constructor() {
    const inicio = changelog.search(/^## \[\d/m);
    const finLinks = changelog.search(/^\[unreleased\]: /im);
    const links = finLinks === -1 ? '' : `\n\n${changelog.slice(finLinks)}`;
    const cuerpo =
      inicio === -1 ? '' : changelog.slice(inicio, finLinks === -1 ? undefined : finLinks);
    const corte = cuerpo.indexOf('\n## [');
    this.novedades = cuerpo ? (corte === -1 ? cuerpo : cuerpo.slice(0, corte)) + links : '';
    this.anteriores = corte === -1 ? '' : cuerpo.slice(corte + 1) + links;
  }

  protected readonly totalPaquetes = computed(() =>
    (this.about.licencias()?.grupos ?? []).reduce((n, g) => n + g.paquetes.length, 0),
  );

  protected alternar(clave: string): void {
    this.abierto.update((actual) => (actual === clave ? null : clave));
  }

  /** El texto de un paquete, resuelto contra la tabla deduplicada. */
  protected textoDe(p: PaqueteLicencia): string | null {
    const lic = this.about.licencias();
    return p.texto === null || !lic ? null : (lic.textos[p.texto] ?? null);
  }

  protected close(): void {
    this.abierto.set(null);
    this.pestana.set('novedades');
    this.about.close();
  }
}
