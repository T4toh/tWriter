import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';

export type CreateKind = 'chapter' | 'book';

@Component({
  selector: 'app-create-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="create-card"
      [attr.data-kind]="kind()"
      [disabled]="busy()"
      (click)="onClick()"
    >
      <span class="plus">＋</span>
      <span class="label">{{ label() }}</span>
    </button>
  `,
  styles: [`
    :host {
      display: block;
    }
    .create-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      min-height: 120px;
      padding: 24px 16px;
      background: transparent;
      border: 1.5px dashed var(--border);
      border-radius: 6px;
      color: var(--fg-muted);
      font: inherit;
      cursor: pointer;
      transition: border-color 0.1s, color 0.1s, background 0.1s;
    }
    .create-card[data-kind='book'] {
      min-height: 100%;
      aspect-ratio: auto;
    }
    .create-card:hover:not(:disabled) {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(200, 168, 120, 0.05);
    }
    .create-card:disabled {
      opacity: 0.5;
      cursor: wait;
    }
    .plus {
      font-size: 28px;
      line-height: 1;
      font-weight: 300;
    }
    .label {
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 600;
    }
  `],
})
export class CreateCard {
  readonly kind = input.required<CreateKind>();
  readonly label = input.required<string>();
  readonly busy = input<boolean>(false);
  readonly create = output<void>();

  protected onClick(): void {
    if (this.busy()) return;
    this.create.emit();
  }
}
