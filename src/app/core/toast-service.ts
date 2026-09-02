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

  /** Toast sin auto-dismiss, para una operación en curso: el caller lo va
   *  actualizando con `update()` y lo cierra con `dismiss()` al terminar.
   *  Devuelve el id. Ojo: si el caller se olvida de cerrarlo queda pegado para
   *  siempre, así que va siempre con un `finally`. */
  progreso(message: string): number {
    const id = this.nextId++;
    this.toasts.update((ts) => [...ts, { id, level: 'info' as ToastLevel, message }]);
    return id;
  }

  /** Cambia el texto de un toast vivo. Si ya se cerró, no hace nada. */
  update(id: number, message: string): void {
    this.toasts.update((ts) => ts.map((t) => (t.id === id ? { ...t, message } : t)));
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
