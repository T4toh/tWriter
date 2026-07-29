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
import { GrammarMatch } from '../core/types';
import { AnchorBox, Placement, placePopover } from './popover-position';

@Component({
  selector: 'app-grammar-popover',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (match(); as m) {
      <div
        #root
        class="grammar-pop"
        [class.grammar-pop--measuring]="placed() === null"
        [style.top.px]="placed()?.y ?? 0"
        [style.left.px]="placed()?.x ?? 0"
        [style.max-height.px]="placed()?.maxHeight ?? null"
        (click)="$event.stopPropagation()"
      >
        <div class="msg">{{ m.message }}</div>
        @if (hasAnySuggestion()) {
          <ul class="reps">
            @for (r of dictSuggestions(); track r) {
              <li>
                <button type="button" class="rep-btn rep-btn--dict" (click)="apply.emit(r)">
                  {{ r }}<span class="rep-chip">tu diccionario</span>
                </button>
              </li>
            }
            @for (r of suggestions(); track r) {
              <li>
                <button type="button" class="rep-btn" (click)="apply.emit(r)">{{ r }}</button>
              </li>
            }
          </ul>
        } @else {
          <div class="no-reps">Sin sugerencias automáticas</div>
        }
        <footer class="grammar-pop-footer">
          <div class="footer-actions">
            <button type="button" class="ignore-btn" (click)="dismiss.emit()">Ignorar</button>
            @if (canAddToDict()) {
              <button
                type="button"
                class="dict-btn"
                (click)="addToDict.emit()"
                title="Agregar al diccionario de esta novela"
              >
                + diccionario
              </button>
            }
          </div>
          <a
            class="lt-attrib"
            href="https://languagetool.org"
            target="_blank"
            title="Powered by LanguageTool"
          >
            <img src="assets/LT.svg" alt="LanguageTool" />
          </a>
        </footer>
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
  suggestions = computed(() => {
    const room = Math.max(0, 5 - this.dictSuggestions().length);
    return (this.match()?.replacements ?? []).slice(0, room);
  });
  hasAnySuggestion = computed(() => this.dictSuggestions().length > 0 || this.suggestions().length > 0);
  canAddToDict = computed(() => this.match()?.category === 'TYPOS');

  private readonly root = viewChild<ElementRef<HTMLElement>>('root');
  /** null hasta que el popover se midió: se renderiza invisible para que no se
   *  vea el salto desde la posición inicial. */
  protected readonly placed = signal<Placement | null>(null);
  private readonly resizeTick = signal(0);

  constructor() {
    const onResize = (): void => this.resizeTick.update((n) => n + 1);
    window.addEventListener('resize', onResize);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('resize', onResize));

    // Medición real: el alto depende de cuántas sugerencias haya, así que no
    // se puede estimar desde el CSS. Se mide el elemento ya renderizado y se
    // recoloca en el mismo ciclo.
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
