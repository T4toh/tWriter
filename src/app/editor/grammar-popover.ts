import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { GrammarMatch } from '../core/types';
import { tituloCategoria } from './lt-categorias';
import { AnchorBox, Placement, placePopover } from './popover-position';
import { ReviewNav } from './review-nav';

@Component({
  selector: 'app-grammar-popover',
  standalone: true,
  imports: [ReviewNav],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (match(); as m) {
      <div
        #root
        class="editor-pop grammar-pop"
        [class.editor-pop--measuring]="placed() === null"
        [style.top.px]="placed()?.y ?? 0"
        [style.left.px]="placed()?.x ?? 0"
        [style.max-height.px]="clippedMaxHeight()"
        (click)="$event.stopPropagation()"
      >
        <div class="pop-head">
          <a
            class="lt-attrib"
            href="https://languagetool.org"
            target="_blank"
            rel="noopener"
            title="Powered by LanguageTool"
          >
            <img src="assets/LT.svg" alt="LanguageTool" />
          </a>
          <span class="pop-title">{{ titulo() }}</span>
          @if (review(); as r) {
            <app-review-nav [review]="r" (next)="next.emit()" (end)="endReview.emit()" />
          }
        </div>
        <!-- En ortografía la explicación de LT no dice nada que el título no diga. -->
        @if (m.category !== 'TYPOS') {
          <div class="pop-sub">{{ m.message }}</div>
        }
        <ul class="pop-list">
          @for (r of dictSuggestions(); track r) {
            <li>
              <button type="button" class="pop-item pop-item--sugerencia" (click)="apply.emit(r)">
                {{ r }}<span class="pop-item-nota">tu diccionario</span>
              </button>
            </li>
          }
          @for (r of suggestions(); track r) {
            <li>
              <button type="button" class="pop-item pop-item--sugerencia" (click)="apply.emit(r)">
                {{ r }}
              </button>
            </li>
          }
          @if (!hasAnySuggestion()) {
            <li class="pop-vacio">Sin sugerencias</li>
          }
        </ul>
        <ul class="pop-list">
          @if (canAddToDict()) {
            <li>
              <button
                type="button"
                class="pop-item"
                (click)="addToDict.emit()"
                title="Agregar al diccionario de esta novela"
              >
                Agregar al diccionario
              </button>
            </li>
          }
          <li>
            <button type="button" class="pop-item" (click)="dismiss.emit()">Ignorar</button>
          </li>
          @if (!masOpciones()) {
            <li>
              <button type="button" class="pop-item pop-item--tenue" (click)="masOpciones.set(true)">
                Más opciones…
              </button>
            </li>
          } @else {
            @if (canAddToDict() && canDeriveForms()) {
              <li>
                <button type="button" class="pop-item" (click)="addToDictWithForms.emit()">
                  Agregar con sus formas…
                </button>
              </li>
            }
            <li>
              <button type="button" class="pop-item pop-item--peligro" (click)="disableRule.emit()">
                No marcar más esta regla<span class="pop-item-nota">en toda la novela</span>
              </button>
            </li>
            <li class="pop-nota">Regla {{ m.ruleId }}</li>
          }
        </ul>
      </div>
    }
  `,
  styleUrl: './grammar-popover.scss',
})
export class GrammarPopover {
  match = input<GrammarMatch | null>(null);
  anchor = input<AnchorBox | null>(null);
  dictSuggestions = input<string[]>([]);
  apply = output<string>();
  dismiss = output<void>();
  addToDict = output<void>();
  disableRule = output<void>();
  canDeriveForms = input<boolean>(false);
  addToDictWithForms = output<void>();
  /** «3 de 12» del recorrido de «Revisar»; `null` fuera de él (popover por click). */
  review = input<{ n: number; total: number } | null>(null);
  next = output<void>();
  endReview = output<void>();
  titulo = computed(() => tituloCategoria(this.match()?.category ?? ''));
  /** Lo raro (formas derivadas, desactivar la regla) se despliega a pedido, y
   *  se vuelve a plegar con cada match nuevo del recorrido. */
  protected readonly masOpciones = linkedSignal({ source: this.match, computation: () => false });
  suggestions = computed(() => {
    const room = Math.max(0, 3 - this.dictSuggestions().length);
    return (this.match()?.replacements ?? []).slice(0, room);
  });
  hasAnySuggestion = computed(() => this.dictSuggestions().length > 0 || this.suggestions().length > 0);
  canAddToDict = computed(() => this.match()?.category === 'TYPOS');

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
    // Medición real: el alto depende de cuántas sugerencias haya, así que no
    // se puede estimar desde el CSS. Se mide el elemento ya renderizado y se
    // recoloca en el mismo ciclo. La remedición depende de que cambie la
    // identidad de `anchor()` (el efecto no lee `match()`/`dictSuggestions()`
    // directamente): hoy alcanza porque el editor siempre cierra el popover
    // (pasa el signal a `null`) antes de abrir el siguiente. El «Siguiente ›»
    // de «Revisar» también pasa por ahí (`abrirPopoverGramaticaEn` arma un
    // `anchorAt` nuevo en cada paso), así que la identidad cambia igual. Si en
    // algún momento se reusa un popover ya abierto cambiando solo `match`, hay
    // que sumar esas señales de contenido a las que lee este efecto.
    afterRenderEffect(() => {
      const anchor = this.anchor();
      // Desplegar «Más opciones…» cambia el alto sin cambiar el ancla.
      this.masOpciones();
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
