import { Component, computed, effect, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Categoria,
  IdiomaFlexion,
  LemmaCandidate,
  generateForms,
  inferLemma,
} from './derived-forms';
import { existsCaseInsensitive } from './word-validator';

interface FormaItem {
  forma: string;
  yaEsta: boolean;
}

@Component({
  selector: 'app-derived-forms-panel',
  imports: [FormsModule],
  template: `
    <div class="formas-backdrop" (click)="cerrar.emit()"></div>
    <div class="formas-panel" (click)="$event.stopPropagation()">
      <header>
        <h3>Formas de «{{ palabra() }}»</h3>
        <button type="button" class="cerrar" (click)="cerrar.emit()" title="Cancelar">×</button>
      </header>

      <div class="config">
        <label class="campo">
          <span>Lema</span>
          <input
            type="text"
            [ngModel]="lema()"
            (ngModelChange)="cambiarLema($event)"
            placeholder="ej: bardear"
          />
        </label>
        <div class="campo">
          <span>Categoría</span>
          <div class="radios">
            <label>
              <input
                type="radio"
                name="categoria"
                value="verbo"
                [checked]="categoria() === 'verbo'"
                (change)="cambiarCategoria('verbo')"
              />
              verbo
            </label>
            <label>
              <input
                type="radio"
                name="categoria"
                value="adjetivo"
                [checked]="categoria() === 'adjetivo'"
                (change)="cambiarCategoria('adjetivo')"
              />
              adjetivo
            </label>
          </div>
        </div>
      </div>

      @if (formas().length === 0) {
        <p class="vacio">
          @if (categoria() === 'verbo') {
            El lema tiene que ser un infinitivo terminado en -ar, -er o -ir.
          } @else {
            Los adjetivos que no terminan en -o son invariables en género y no
            necesitan formas extra. Si «{{ palabra() }}» es una forma verbal,
            elegí «verbo».
          }
        </p>
      } @else {
        <ul class="formas">
          @for (f of formas(); track f.forma) {
            <li [class.ya-esta]="f.yaEsta">
              <label>
                <input
                  type="checkbox"
                  [checked]="f.yaEsta || !excluidas().has(f.forma)"
                  [disabled]="f.yaEsta"
                  (change)="alternar(f.forma)"
                />
                <span class="forma">{{ f.forma }}</span>
                @if (f.yaEsta) {
                  <span class="nota">ya está</span>
                }
              </label>
            </li>
          }
        </ul>
        @if (seleccionadas().length === 0) {
          <p class="nota-plural">Todas las formas ya están en el diccionario.</p>
        } @else {
          <p class="nota-plural">
            Los plurales no hacen falta: el diccionario ya los reconoce solo.
          </p>
        }
      }

      <footer>
        <button type="button" class="btn-cancelar" (click)="cerrar.emit()">Cancelar</button>
        <button
          type="button"
          class="btn-agregar"
          [disabled]="seleccionadas().length === 0"
          (click)="agregar.emit(seleccionadas())"
        >
          Agregar {{ seleccionadas().length }}
        </button>
      </footer>
    </div>
  `,
  styleUrl: './derived-forms-panel.scss',
})
export class DerivedFormsPanel {
  palabra = input.required<string>();
  idioma = input.required<IdiomaFlexion>();
  existentes = input<readonly string[]>([]);
  agregar = output<string[]>();
  cerrar = output<void>();

  protected readonly lema = signal<string>('');
  protected readonly categoria = signal<Categoria>('verbo');
  /** Los dos candidatos que devuelve `inferLemma` para las formas en `-a`/`-o`:
   *  el radio elige entre ellos, y elegir cambia el lema además de la categoría. */
  private readonly candidatos = signal<readonly LemmaCandidate[]>([]);
  private readonly excluidasSet = signal<ReadonlySet<string>>(new Set<string>());

  protected readonly formas = computed<FormaItem[]>(() => {
    const existentes = this.existentes();
    return generateForms(this.lema(), this.categoria(), this.idioma()).map((forma) => ({
      forma,
      yaEsta: existsCaseInsensitive(existentes, forma),
    }));
  });

  protected readonly seleccionadas = computed<string[]>(() =>
    this.formas()
      .filter((f) => !f.yaEsta && !this.excluidasSet().has(f.forma))
      .map((f) => f.forma),
  );

  constructor() {
    // Cuando cambia la palabra de entrada, se resiembra lema y categoría desde
    // el primer candidato inferido y se limpian las exclusiones de la anterior.
    effect(() => {
      const candidatos = inferLemma(this.palabra(), this.idioma());
      this.candidatos.set(candidatos);
      const primero = candidatos[0];
      this.lema.set(primero?.lema ?? this.palabra().trim().toLowerCase());
      this.categoria.set(primero?.categoria ?? 'verbo');
      this.excluidasSet.set(new Set<string>());
    });
  }

  protected excluidas(): ReadonlySet<string> {
    return this.excluidasSet();
  }

  protected cambiarLema(valor: string): void {
    this.lema.set(valor);
    this.excluidasSet.set(new Set<string>());
  }

  protected cambiarCategoria(valor: Categoria): void {
    this.categoria.set(valor);
    // `bardea` infiere `bardea`/adjetivo y `bardear`/verbo: sin mover el lema,
    // pasar el radio a «verbo» sigue generando cero formas y el caso más
    // frecuente del corpus (3ª persona en -a) queda muerto.
    const candidato = this.candidatos().find((c) => c.categoria === valor);
    if (candidato) this.lema.set(candidato.lema);
    this.excluidasSet.set(new Set<string>());
  }

  protected alternar(forma: string): void {
    const next = new Set(this.excluidasSet());
    if (next.has(forma)) next.delete(forma);
    else next.add(forma);
    this.excluidasSet.set(next);
  }
}
