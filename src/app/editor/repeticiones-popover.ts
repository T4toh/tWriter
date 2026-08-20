import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Repeticion } from '../core/types';
import { AnchorBox, Placement, placePopover } from './popover-position';

/**
 * Popover de una repetición cercana. Dice DÓNDE está la repetición, no con qué
 * reemplazarla: los sinónimos son otro item del TODO (el tesauro de rla-es) y
 * otro PR.
 *
 * La mecánica de medición y colocación es la misma que `RaePopover` — ver el
 * comentario largo de ahí para por qué se mide el elemento real en vez de
 * estimar el alto desde el CSS.
 */
@Component({
  selector: 'app-repeticiones-popover',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (repeticion(); as r) {
      <div
        #root
        class="rep-pop"
        [class.rep-pop--measuring]="placed() === null"
        [style.top.px]="placed()?.y ?? 0"
        [style.left.px]="placed()?.x ?? 0"
        [style.max-height.px]="clippedMaxHeight()"
        (click)="$event.stopPropagation()"
      >
        <div class="rep-pop-head">
          <span class="rep-pop-tag">Repetición</span>
          <span class="rep-pop-count">{{ r.apariciones }} veces en el párrafo</span>
        </div>
        <div class="rep-pop-msg">
          <span class="rep-pop-word">{{ palabra() }}</span>
          ya apareció {{ r.distancia }}
          {{ r.distancia === 1 ? 'palabra' : 'palabras' }} antes.
        </div>
        <footer class="rep-pop-footer">
          <button type="button" class="rep-pop-goto" (click)="goToPrevious.emit()">
            Ir a la anterior
          </button>
          <button type="button" class="rep-pop-dismiss" (click)="dismiss.emit()">
            Ignorar
          </button>
        </footer>
      </div>
    }
  `,
  styleUrl: './repeticiones-popover.scss',
})
export class RepeticionesPopover {
  repeticion = input<Repeticion | null>(null);
  /** La palabra como está escrita en el documento. `Repeticion.palabra` viene
   *  normalizada (sin tildes, en minúscula) y mostrarla así se lee como un
   *  error de la app. */
  palabra = input<string>('');
  anchor = input<AnchorBox | null>(null);
  goToPrevious = output<void>();
  dismiss = output<void>();

  private readonly root = viewChild<ElementRef<HTMLElement>>('root');
  protected readonly placed = signal<Placement | null>(null);
  protected readonly clippedMaxHeight = signal<number | null>(null);
  private readonly resizeTick = signal(0);

  constructor() {
    const onResize = (): void => this.resizeTick.update((n) => n + 1);
    window.addEventListener('resize', onResize);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('resize', onResize));

    afterRenderEffect(() => {
      this.resizeTick();
      const anchor = this.anchor();
      const el = this.root()?.nativeElement;
      if (!anchor || !el) {
        this.placed.set(null);
        this.clippedMaxHeight.set(null);
        return;
      }
      const height = el.scrollHeight + el.offsetHeight - el.clientHeight;
      const result = placePopover(
        anchor,
        { width: el.offsetWidth, height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      this.placed.set(result);
      this.clippedMaxHeight.set(result.maxHeight < height ? result.maxHeight : null);
    });
  }
}
