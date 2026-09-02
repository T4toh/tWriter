import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import {
  ConteoCapitulos,
  ConteoDetector,
  RevisionLibroService,
  SeleccionRevision,
} from '../core/revision-libro-service';
import { Spinner } from '../shared/spinner';

@Component({
  selector: 'app-revision-libro-modal',
  imports: [Spinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './revision-libro-modal.html',
  styleUrl: './revision-libro-modal.scss',
})
export class RevisionLibroModal {
  protected readonly svc = inject(RevisionLibroService);

  protected readonly rayas = signal<boolean>(false);
  protected readonly comillas = signal<boolean>(false);
  protected readonly arreglosRae = signal<boolean>(false);

  // El modal se monta una sola vez en app.html y solo se oculta con el @if
  // interno (`svc.libro()`), así que las casillas nunca pasan por el
  // constructor de nuevo al cambiar de libro. Sin este reset, tildar «Rayas»
  // en el libro A y después abrir el libro B deja la casilla tildada para B
  // sin que el autor la haya marcado — y "Aplicar" reescribe capítulos de B
  // con una selección que quedó pegada de A. Lee SOLO `svc.libro()`: si acá
  // adentro se lee `resultado()` también, el effect se re-dispara al
  // terminar cada escaneo y destilda las casillas en la cara del autor.
  constructor() {
    effect(() => {
      this.svc.libro();
      this.rayas.set(false);
      this.comillas.set(false);
      this.arreglosRae.set(false);
    });
  }

  protected readonly puedeAplicar = computed<boolean>(() => {
    const r = this.svc.resultado();
    if (!r || this.svc.aplicando()) return false;
    return (
      (this.rayas() && r.rayas.capitulos > 0)
      || (this.comillas() && r.comillas.capitulos > 0)
      || (this.arreglosRae() && r.arreglosRae.cambios > 0)
    );
  });

  /** Idioma del libro derivado del conteo real de capítulos que dejó el
   *  escaneo (`capitulosEs`/`capitulosEn` en `ResumenRevision`) — no de
   *  `book.json`, que puede estar desactualizado o vacío, y no de una
   *  segunda llamada a `detectLang`: es el mismo dato con el que
   *  `detectarEnCapitulo` decidió si cada detector aplica, así que el header
   *  y las filas de abajo no se pueden contradecir. `null` antes de escanear
   *  — ahí no se conoce el idioma de ningún capítulo todavía. */
  protected readonly idiomaLibro = computed<string | null>(() => {
    const r = this.svc.resultado();
    if (!r) return null;
    const { capitulosEs: es, capitulosEn: en } = r;
    if (es > 0 && en > 0) return `español e inglés (${es} y ${en} capítulos)`;
    if (en > 0) return 'inglés';
    return 'español';
  });

  protected async aplicar(): Promise<void> {
    const seleccion: SeleccionRevision = {
      rayas: this.rayas(),
      comillas: this.comillas(),
      arreglosRae: this.arreglosRae(),
    };
    await this.svc.aplicar(seleccion);
  }

  /** Rayas/comillas: no hay conteo real de cambios (ver `ConteoCapitulos`),
   *  así que la fila dice solo en cuántos capítulos hay algo para tocar. */
  protected resumenCapitulos(c: ConteoCapitulos): string {
    if (c.capitulos === 0) return 'sin cambios';
    return `${c.capitulos} capítulo${c.capitulos === 1 ? '' : 's'}`;
  }

  protected resumen(c: ConteoDetector): string {
    if (c.cambios === 0) return 'sin cambios';
    const caps = `${c.capitulos} capítulo${c.capitulos === 1 ? '' : 's'}`;
    return `${c.cambios} en ${caps}`;
  }
}
