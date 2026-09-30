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

  /** Del `CHANGELOG.md` del repo: la última versión, y aparte las
   *  anteriores. Se corta en el primer `## v…`, así quedan afuera la intro
   *  para quien contribuye y «Sin publicar». */
  protected readonly novedades: string;
  protected readonly anteriores: string;

  constructor() {
    const desde = changelog.indexOf('\n## v');
    const versiones = desde === -1 ? '' : changelog.slice(desde + 1);
    const corte = versiones.indexOf('\n## ');
    this.novedades = corte === -1 ? versiones : versiones.slice(0, corte);
    this.anteriores = corte === -1 ? '' : versiones.slice(corte + 1);
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
