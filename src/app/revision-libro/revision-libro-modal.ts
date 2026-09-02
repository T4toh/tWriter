import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
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

  protected readonly puedeAplicar = computed<boolean>(() => {
    const r = this.svc.resultado();
    if (!r || this.svc.aplicando()) return false;
    return (
      (this.rayas() && r.rayas.cambios > 0)
      || (this.comillas() && r.comillas.cambios > 0)
      || (this.arreglosRae() && r.arreglosRae.cambios > 0)
    );
  });

  protected async aplicar(): Promise<void> {
    const seleccion: SeleccionRevision = {
      rayas: this.rayas(),
      comillas: this.comillas(),
      arreglosRae: this.arreglosRae(),
    };
    await this.svc.aplicar(seleccion);
  }

  protected resumen(c: ConteoDetector): string {
    if (c.cambios === 0) return 'sin cambios';
    const caps = `${c.capitulos} capítulo${c.capitulos === 1 ? '' : 's'}`;
    return `${c.cambios} en ${caps}`;
  }
}
