import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RayaHelp, RayaViolation } from '../core/types';
import { RayaChuletaService } from '../core/raya-chuleta-service';
import { AnchorBox, Placement, placePopover } from './popover-position';

@Component({
  selector: 'app-raya-popover',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (violation(); as v) {
      <div
        #root
        class="editor-pop raya-pop"
        [class.raya-pop--pending]="v.category === 'pending-conversion'"
        [class.raya-pop--char]="v.category === 'char'"
        [class.raya-pop--structure]="v.category === 'structure'"
        [class.raya-pop--typo]="v.category === 'typo'"
        [class.editor-pop--measuring]="placed() === null"
        [style.top.px]="placed()?.y ?? 0"
        [style.left.px]="placed()?.x ?? 0"
        [style.max-height.px]="clippedMaxHeight()"
        (click)="$event.stopPropagation()"
      >
        <div class="raya-pop-head">
          <span class="raya-pop-tag">{{ tagLabel() }}</span>
          <span class="raya-pop-rule">{{ v.ruleId }}</span>
        </div>
        <div class="raya-pop-msg">{{ v.message }}</div>
        @if (v.help; as h) {
          @if (h.wrong && h.right) {
            <div class="raya-pop-ej">
              <span class="raya-pop-ej-no" aria-label="Mal">✗</span>
              <span>{{ h.wrong }}</span>
              <span class="raya-pop-ej-si" aria-label="Bien">✓</span>
              <span>{{ h.right }}</span>
            </div>
          }
          <div class="raya-pop-fuente">
            <a [href]="dpdUrl(h)" target="_blank" rel="noopener">DPD {{ h.entry }} {{ h.section }}</a>
            ·
            <button type="button" class="raya-pop-link" (click)="chuleta.show(); dismiss.emit()">
              Ver todas las reglas
            </button>
          </div>
        }
        <footer class="pop-footer">
          @if (canAutoFix()) {
            <button type="button" class="pop-btn pop-btn--primary" (click)="apply.emit()">
              Aplicar
            </button>
          }
          @if (canApplyParagraph()) {
            <button
              type="button"
              class="pop-btn pop-btn--primary"
              (click)="applyParagraph.emit()"
              title="Aplicar reglas de raya al párrafo entero (preview)"
            >
              Aplicar raya al párrafo
            </button>
          }
          <button type="button" class="pop-btn pop-btn--quiet" (click)="dismiss.emit()">
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
  styleUrl: './raya-popover.scss',
})
export class RayaPopover {
  violation = input<RayaViolation | null>(null);
  anchor = input<AnchorBox | null>(null);
  apply = output<void>();
  applyParagraph = output<void>();
  dismiss = output<void>();
  protected readonly chuleta = inject(RayaChuletaService);

  protected dpdUrl(h: RayaHelp): string {
    return `https://www.rae.es/dpd/${encodeURIComponent(h.entry)}`;
  }

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
      case 'mayusculas':
        return 'Mayúsculas';
    }
  });

  private readonly root = viewChild<ElementRef<HTMLElement>>('root');
  /** null hasta que el popover se midió: se renderiza invisible para que no se
   *  vea el salto desde la posición inicial. */
  protected readonly placed = signal<Placement | null>(null);
  /** `max-height` a bindear, o `null` cuando el popover entró completo. Si se
   *  bindeara siempre, `scrollHeight`/`offsetHeight`/`clientHeight` (enteros
   *  redondeados) pueden dejar un `max-height` un pixel más corto que el alto
   *  real (200.4px medido → 200px de tope) y, con `overflow-y: auto` siempre
   *  activo, aparece un scrollbar espurio con lugar de sobra adentro. */
  protected readonly clippedMaxHeight = signal<number | null>(null);

  constructor() {
    // Medición real: el alto depende del mensaje y de qué botones aplican, así
    // que no se puede estimar desde el CSS. Se mide el elemento ya renderizado
    // y se recoloca en el mismo ciclo. La remedición depende de que cambie la
    // identidad de `anchor()` (el efecto no lee `violation()` directamente):
    // hoy alcanza porque el editor siempre cierra el popover (pasa el signal
    // a `null`) antes de abrir el siguiente. Si en algún momento se reusa un
    // popover ya abierto (ej. un "saltar al próximo error" que solo cambia
    // `violation`), hay que sumar esa señal de contenido a las que lee este
    // efecto.
    afterRenderEffect(() => {
      const anchor = this.anchor();
      const el = this.root()?.nativeElement;
      if (!anchor || !el) {
        this.placed.set(null);
        this.clippedMaxHeight.set(null);
        return;
      }
      // scrollHeight excluye el border; max-height con box-sizing:border-box
      // lo incluye. Se suma (offsetHeight - clientHeight) = borders (+ scrollbar
      // horizontal), que no depende del recorte, así remedir converge igual.
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
