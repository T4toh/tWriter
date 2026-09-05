import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { LucideArrowRight } from '@lucide/angular';
import { RaeAuditService } from '../core/rae-audit-service';
import { RepeticionesAuditService } from '../core/repeticiones-audit-service';
import {
  ConteoCapitulos,
  ConteoDetector,
  RevisionLibroService,
  SeleccionRevision,
} from '../core/revision-libro-service';
import { Spinner } from '../shared/spinner';

@Component({
  selector: 'app-revision-libro-modal',
  imports: [Spinner, LucideArrowRight],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './revision-libro-modal.html',
  styleUrl: './revision-libro-modal.scss',
})
export class RevisionLibroModal {
  protected readonly svc = inject(RevisionLibroService);
  private raeAudit = inject(RaeAuditService);
  private repeticionesAudit = inject(RepeticionesAuditService);

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
    if (!r || this.svc.aplicando() || this.svc.escaneando()) return false;
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

  /** Nota discreta de dónde sale el idioma de `idiomaLibro()`: si `book.json`
   *  lo declara, es información ("esto lo declaré yo"); si no, es un aviso
   *  suave de que la app lo adivinó por capítulo/contenido — el autor tiene
   *  que poder distinguir las dos cosas (ver `resolverIdiomaEfectivo` en
   *  `deteccion.ts`). `null` antes de escanear. */
  protected readonly notaIdioma = computed<string | null>(() => {
    const r = this.svc.resultado();
    if (!r) return null;
    return r.idiomaLibroDeclarado
      ? 'declarado en la configuración de la novela'
      : 'detectado automáticamente: no está declarado en la configuración de la novela';
  });

  protected async aplicar(): Promise<void> {
    const seleccion: SeleccionRevision = {
      rayas: this.rayas(),
      comillas: this.comillas(),
      arreglosRae: this.arreglosRae(),
    };
    await this.svc.aplicar(seleccion);
  }

  /** Los conteos de este modal son un número y nada más: no dicen cuáles ni
   *  dónde, así que para arreglar algo había que abrir capítulo por capítulo a
   *  buscarlo de nuevo a ojo. Estos dos abren la lista por ocurrencia, con
   *  snippet y salto al lugar.
   *
   *  Cierran el modal a propósito: los dos paneles viven en el slot derecho,
   *  al lado del editor, y la gracia es poder arreglar mientras se recorre la
   *  lista — con el modal encima no se puede tocar nada. */
  protected verRae(ev: Event): void {
    // Las dos filas de RAE son `<label>` con checkbox adentro, así que
    // clickear el botón tildaría la casilla de paso.
    ev.preventDefault();
    ev.stopPropagation();
    const node = this.svc.libro();
    if (!node) return;
    this.svc.cerrar();
    void this.raeAudit.open({ path: node.path, name: node.name });
  }

  protected verRepeticiones(): void {
    const node = this.svc.libro();
    if (!node) return;
    this.svc.cerrar();
    void this.repeticionesAudit.open({ path: node.path, name: node.name });
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
