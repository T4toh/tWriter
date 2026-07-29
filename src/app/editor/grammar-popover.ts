import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { GrammarMatch } from '../core/types';

@Component({
  selector: 'app-grammar-popover',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (match(); as m) {
      <div
        class="grammar-pop"
        [style.top.px]="y()"
        [style.left.px]="x()"
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
  x = input<number>(0);
  y = input<number>(0);
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
}
