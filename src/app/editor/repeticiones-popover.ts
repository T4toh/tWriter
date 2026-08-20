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
import { Repeticion, RespuestaTesauro } from '../core/types';
import { AnchorBox, Placement, placePopover } from './popover-position';

/**
 * Popover de una repetición cercana. Dice DÓNDE está la repetición y, con los
 * chips de sinónimos del tesauro embebido, ofrece con qué reemplazarla.
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
    @if (anchor()) {
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
          <span class="rep-pop-tag">{{ repeticion() ? 'Repetición' : 'Sinónimos' }}</span>
          @if (repeticion(); as r) {
            <span class="rep-pop-count">{{ r.apariciones }} veces acá cerca</span>
          }
        </div>
        @if (repeticion(); as r) {
          <div class="rep-pop-msg">
            <span class="rep-pop-word">{{ palabra() }}</span>
            ya apareció {{ r.distancia }}
            {{ r.distancia === 1 ? 'palabra' : 'palabras' }} más arriba.
          </div>
        } @else {
          <div class="rep-pop-msg"><span class="rep-pop-word">{{ palabra() }}</span></div>
        }
        @if (resultado(); as r) {
          @if (!r.disponible) {
            <div class="rep-pop-sin">El tesauro no se pudo cargar</div>
          } @else if (r.acepciones.length === 0) {
            <div class="rep-pop-sin">Sin sinónimos para «{{ palabra() }}»</div>
          } @else {
            @for (a of r.acepciones; track $index) {
              <div class="rep-pop-acepcion">
                @if (a.categoria) {
                  <span class="rep-pop-cat">{{ categoriaEs(a.categoria) }}</span>
                }
                <div class="rep-pop-chips">
                  @for (s of a.sinonimos; track s) {
                    <button
                      type="button"
                      class="rep-pop-chip"
                      (click)="reemplazar.emit(s)"
                    >
                      {{ s }}
                    </button>
                  }
                </div>
              </div>
            }
          }
        } @else {
          <div class="rep-pop-sin">Buscando sinónimos…</div>
        }
        <footer class="rep-pop-footer">
          @if (repeticion()) {
            <button type="button" class="rep-pop-goto" (click)="goToPrevious.emit()">
              Ir a la anterior
            </button>
          }
          <button type="button" class="rep-pop-dismiss" (click)="dismiss.emit()">
            {{ repeticion() ? 'Ignorar' : 'Cerrar' }}
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
  /** `null` mientras la consulta está en vuelo. Después distingue los tres
   *  estados que puede tener la respuesta: tesauro que no cargó
   *  (`disponible: false`), palabra sin entrada (`acepciones` vacío) y
   *  sinónimos para mostrar. */
  resultado = input<RespuestaTesauro | null>(null);
  goToPrevious = output<void>();
  dismiss = output<void>();
  reemplazar = output<string>();

  /** Las categorías vienen del dato y la UI es en español. El inglés las trae
   *  como `noun`/`verb`/…; el español, en ~810 acepciones, con las
   *  abreviaturas de la RAE. Las variantes figuradas (`m. fig.`, `f. fig.`) se
   *  muestran con su categoría base: el matiz no cambia con qué palabra se
   *  reemplaza, y `fig.` a secas es la única sin base. Lo que no está en la
   *  tabla se muestra tal cual en vez de tragarse la etiqueta — pero cae en
   *  versalitas, así que conviene que no falte ninguna. */
  protected categoriaEs(cat: string): string {
    const tabla: Record<string, string> = {
      // Inglés (WordNet).
      noun: 'sustantivo',
      verb: 'verbo',
      adj: 'adjetivo',
      adv: 'adverbio',
      // Español (rla-es).
      'm.': 'sustantivo',
      'f.': 'sustantivo',
      'm. fig.': 'sustantivo',
      'f. fig.': 'sustantivo',
      'adj.': 'adjetivo',
      'adv.': 'adverbio',
      'tr.': 'verbo',
      'intr.': 'verbo',
      'prnl.': 'verbo',
      'intr.-prnl.': 'verbo',
      'interj.': 'interjección',
      'fig.': 'figurado',
    };
    return tabla[cat] ?? cat;
  }

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
      // Se lee acá aunque no se use: el alto del popover cambia cuando aterriza
      // la consulta (de "Buscando sinónimos…" a los chips), y sin esta lectura
      // el effect no se reejecuta — `placed` y `clippedMaxHeight` quedarían
      // calculados con los ~60 px del estado de carga y el popover se desborda
      // del viewport sin scroll.
      this.resultado();
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
