import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** «3 de 12 · Siguiente › · ✕» del recorrido de «Revisar». Va en la cabecera
 *  de los tres popovers del editor (gramática, raya, repeticiones), que el
 *  recorrido abre uno tras otro. */
@Component({
  selector: 'app-review-nav',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="review-nav-count">{{ review().n }} de {{ review().total }}</span>
    <button type="button" class="btn btn-sm btn-secondary" (click)="next.emit()">
      Siguiente ›
    </button>
    <button
      type="button"
      class="btn btn-sm btn-secondary"
      (click)="end.emit()"
      title="Terminar la revisión"
      aria-label="Terminar la revisión"
    >
      ✕
    </button>
  `,
  styles: `
    :host {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .review-nav-count {
      font-size: 11px;
      color: var(--fg-muted);
      white-space: nowrap;
    }
  `,
})
export class ReviewNav {
  review = input.required<{ n: number; total: number }>();
  next = output<void>();
  end = output<void>();
}
