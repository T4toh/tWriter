import { Injectable, signal } from '@angular/core';

export type ModalKind = 'prompt' | 'confirm' | 'alert';
export type AlertVariant = 'info' | 'error' | 'success';

export interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Devuelve null si OK, string con error si inválido. */
  validate?: (value: string) => string | null;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface AlertOptions {
  title: string;
  message: string;
  variant?: AlertVariant;
  okLabel?: string;
}

interface PromptState extends PromptOptions {
  kind: 'prompt';
}
interface ConfirmState extends ConfirmOptions {
  kind: 'confirm';
}
interface AlertState extends AlertOptions {
  kind: 'alert';
}

export type ModalState = PromptState | ConfirmState | AlertState;

const CLOSE_ANIMATION_MS = 120;

@Injectable({ providedIn: 'root' })
export class ModalService {
  readonly current = signal<ModalState | null>(null);
  readonly closing = signal(false);

  private resolver: ((value: unknown) => void) | null = null;

  prompt(opts: PromptOptions): Promise<string | null> {
    return this.openModal<string | null>({ kind: 'prompt', ...opts }, null);
  }

  confirm(opts: ConfirmOptions): Promise<boolean> {
    return this.openModal<boolean>({ kind: 'confirm', ...opts }, false);
  }

  alert(opts: AlertOptions): Promise<void> {
    return this.openModal<void>({ kind: 'alert', ...opts }, undefined);
  }

  /** Llamado por ModalHost al confirmar. */
  resolve(value: unknown): void {
    if (!this.resolver) return;
    const r = this.resolver;
    this.resolver = null;
    this.closing.set(true);
    setTimeout(() => {
      this.current.set(null);
      this.closing.set(false);
      r(value);
    }, CLOSE_ANIMATION_MS);
  }

  /** Llamado por ModalHost al cancelar (Esc, backdrop, botón cancelar). */
  cancel(): void {
    const cur = this.current();
    if (!cur) return;
    if (cur.kind === 'prompt') this.resolve(null);
    else if (cur.kind === 'confirm') this.resolve(false);
    else this.resolve(undefined);
  }

  private openModal<T>(state: ModalState, rejectedValue: T): Promise<T> {
    if (this.current() !== null) {
      return Promise.resolve(rejectedValue);
    }
    return new Promise<T>((resolve) => {
      this.resolver = resolve as (value: unknown) => void;
      this.current.set(state);
    });
  }
}
