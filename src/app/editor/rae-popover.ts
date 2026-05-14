import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RaeViolation } from '../core/types';

@Component({
  selector: 'app-rae-popover',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (violation(); as v) {
      <div
        class="rae-pop"
        [class.rae-pop--pending]="v.category === 'pending-conversion'"
        [class.rae-pop--char]="v.category === 'char'"
        [class.rae-pop--structure]="v.category === 'structure'"
        [class.rae-pop--typo]="v.category === 'typo'"
        [style.top.px]="y()"
        [style.left.px]="x()"
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
  x = input<number>(0);
  y = input<number>(0);
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
}
