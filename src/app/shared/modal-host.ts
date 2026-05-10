import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalService, ModalState } from './modal-service';

@Component({
  selector: 'app-modal-host',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './modal-host.html',
  styleUrl: './modal-host.scss',
})
export class ModalHost {
  private svc = inject(ModalService);

  protected readonly state = this.svc.current;
  protected readonly closing = this.svc.closing;

  protected readonly value = signal('');
  protected readonly errorMsg = signal<string | null>(null);

  protected readonly promptState = computed(() => {
    const s = this.state();
    return s?.kind === 'prompt' ? s : null;
  });
  protected readonly confirmState = computed(() => {
    const s = this.state();
    return s?.kind === 'confirm' ? s : null;
  });
  protected readonly alertState = computed(() => {
    const s = this.state();
    return s?.kind === 'alert' ? s : null;
  });

  private readonly promptInput = viewChild<ElementRef<HTMLInputElement>>('promptInput');
  private readonly okButton = viewChild<ElementRef<HTMLButtonElement>>('okButton');

  constructor() {
    effect(() => {
      const s = this.state();
      if (s?.kind === 'prompt') {
        this.value.set(s.defaultValue ?? '');
        this.errorMsg.set(null);
        queueMicrotask(() => {
          const el = this.promptInput()?.nativeElement;
          if (el) {
            el.focus();
            el.select();
          }
        });
      } else if (s) {
        this.errorMsg.set(null);
        queueMicrotask(() => this.okButton()?.nativeElement.focus());
      }
    });
  }

  protected onValueChange(v: string): void {
    this.value.set(v);
    if (this.errorMsg()) this.errorMsg.set(null);
  }

  protected confirmPrompt(): void {
    const s = this.promptState();
    if (!s) return;
    const v = this.value();
    if (s.validate) {
      const err = s.validate(v);
      if (err) {
        this.errorMsg.set(err);
        return;
      }
    }
    this.svc.resolve(v);
  }

  protected confirmConfirm(): void {
    this.svc.resolve(true);
  }

  protected confirmAlert(): void {
    this.svc.resolve(undefined);
  }

  protected cancel(): void {
    this.svc.cancel();
  }

  protected onBackdropClick(): void {
    this.cancel();
  }

  protected onCardClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  @HostListener('document:keydown.escape', ['$event'])
  protected onEsc(event: Event): void {
    if (!this.state()) return;
    event.stopPropagation();
    event.preventDefault();
    this.cancel();
  }

  protected onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.confirmPrompt();
    }
  }

  protected getOkLabel(s: ModalState): string {
    if (s.kind === 'prompt') return s.okLabel ?? 'OK';
    if (s.kind === 'confirm') return s.okLabel ?? 'OK';
    return s.okLabel ?? 'OK';
  }
}
