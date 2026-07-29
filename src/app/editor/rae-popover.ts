import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RaeViolation } from '../core/types';
import { AnchorBox, Placement, placePopover } from './popover-position';

@Component({
  selector: 'app-rae-popover',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (violation(); as v) {
      <div
        #root
        class="rae-pop"
        [class.rae-pop--pending]="v.category === 'pending-conversion'"
        [class.rae-pop--char]="v.category === 'char'"
        [class.rae-pop--structure]="v.category === 'structure'"
        [class.rae-pop--typo]="v.category === 'typo'"
        [class.rae-pop--measuring]="placed() === null"
        [style.top.px]="placed()?.y ?? 0"
        [style.left.px]="placed()?.x ?? 0"
        [style.max-height.px]="placed()?.maxHeight ?? null"
        (click)="$event.stopPropagation()"
      >
        <div class="rae-pop-head">
          <span class="rae-pop-tag">{{ tagLabel() }}</span>
          <span class="rae-pop-rule">{{ v.ruleId }}</span>
        </div>
        <div class="rae-pop-msg">{{ v.message }}</div>
        <footer class="rae-pop-footer">
          @if (canAutoFix()) {
            <button type="button" class="rae-pop-apply" (click)="apply.emit()">
              Aplicar
            </button>
          }
          @if (canApplyParagraph()) {
            <button
              type="button"
              class="rae-pop-apply"
              (click)="applyParagraph.emit()"
              title="Aplicar reglas RAE al párrafo entero (preview)"
            >
              Aplicar RAE al párrafo
            </button>
          }
          <button type="button" class="rae-pop-dismiss" (click)="dismiss.emit()">
            @if (canAutoFix() || canApplyParagraph()) {
              Ignorar
            } @else {
              OK
            }
          </button>
        </footer>
      </div>
    }
  `,
  styleUrl: './rae-popover.scss',
})
export class RaePopover {
  violation = input<RaeViolation | null>(null);
  anchor = input<AnchorBox | null>(null);
  apply = output<void>();
  applyParagraph = output<void>();
  dismiss = output<void>();

  canAutoFix = computed(() => {
    const v = this.violation();
    return v !== null && v.autoFix !== undefined && v.category !== 'pending-conversion';
  });

  canApplyParagraph = computed(() => {
    const v = this.violation();
    return v !== null && v.category === 'pending-conversion';
  });

  tagLabel = computed(() => {
    const v = this.violation();
    if (v === null) return '';
    switch (v.category) {
      case 'pending-conversion':
        return 'Conversión pendiente';
      case 'char':
        return 'Carácter';
      case 'structure':
        return 'Estructura';
      case 'typo':
        return 'Tipografía';
    }
  });

  private readonly root = viewChild<ElementRef<HTMLElement>>('root');
  /** null hasta que el popover se midió: se renderiza invisible para que no se
   *  vea el salto desde la posición inicial. */
  protected readonly placed = signal<Placement | null>(null);
  private readonly resizeTick = signal(0);

  constructor() {
    const onResize = (): void => this.resizeTick.update((n) => n + 1);
    window.addEventListener('resize', onResize);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('resize', onResize));

    // Medición real: el alto depende del mensaje y de qué botones aplican, así
    // que no se puede estimar desde el CSS. Se mide el elemento ya renderizado
    // y se recoloca en el mismo ciclo.
    afterRenderEffect(() => {
      this.resizeTick();
      const anchor = this.anchor();
      const el = this.root()?.nativeElement;
      if (!anchor || !el) {
        this.placed.set(null);
        return;
      }
      this.placed.set(
        placePopover(
          anchor,
          // scrollHeight excluye el border; max-height con box-sizing:border-box
          // lo incluye. Se suma (offsetHeight - clientHeight) = borders (+ scrollbar
          // horizontal), que no depende del recorte, así remedir converge igual.
          { width: el.offsetWidth, height: el.scrollHeight + el.offsetHeight - el.clientHeight },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    });
  }
}
