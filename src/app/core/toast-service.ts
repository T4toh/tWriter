import { Injectable, signal } from '@angular/core';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
}

const DEFAULT_DURATION_MS = 4000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 1;

  show(message: string, level: ToastLevel = 'info', durationMs = DEFAULT_DURATION_MS): void {
    const id = this.nextId++;
    const toast: Toast = { id, level, message };
    this.toasts.update((ts) => [...ts, toast]);
    setTimeout(() => this.dismiss(id), durationMs);
  }

  success(message: string, durationMs?: number): void {
    this.show(message, 'success', durationMs);
  }

  info(message: string, durationMs?: number): void {
    this.show(message, 'info', durationMs);
  }

  warn(message: string, durationMs?: number): void {
    this.show(message, 'warn', durationMs);
  }

  error(message: string, durationMs?: number): void {
    this.show(message, 'error', durationMs ?? 6000);
  }

  dismiss(id: number): void {
    this.toasts.update((ts) => ts.filter((t) => t.id !== id));
  }
}
