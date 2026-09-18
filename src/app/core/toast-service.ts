import { Injectable, signal } from '@angular/core';
import { MAX_HISTORIAL, pushHistorial } from '../notificaciones/historial';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

/** Lo que se abre al clickear el toast. Existe porque un toast tiene lugar
 *  para una línea: el veredicto entra, las 20 líneas de epubcheck no. */
export interface ToastDetalle {
  titulo: string;
  texto: string;
}

/** Vuelta atrás de la acción que disparó el toast. Existe porque hay acciones
 *  destructivas que se hacen con un solo click y sin confirmación —desactivar
 *  una regla de LT en toda la novela, agregar una palabra al diccionario— y el
 *  aviso de 4 segundos era todo el rastro que quedaba. */
export interface ToastAccion {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
  detalle?: ToastDetalle;
  accion?: ToastAccion;
}

/** Un toast que ya se fue, guardado para la campana. `ts` es cuándo pasó: el
 *  toast vivo no lo necesita —está en pantalla— pero en el historial es la
 *  mitad del dato. */
export interface ToastHistorico extends Toast {
  ts: number;
}

const DEFAULT_DURATION_MS = 4000;

/** Un "Deshacer" que se va en 4 segundos no es una red. */
export const DESHACER_DURATION_MS = 10000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  /** Lo que pasó, más nuevo primero. Sobrevive al auto-dismiss: el caso que
   *  lo motivó es el aviso que se fue en 4 segundos mientras el autor miraba
   *  para otro lado. Solo en memoria — se vacía al cerrar la app. */
  readonly historial = signal<ToastHistorico[]>([]);
  private nextId = 1;

  show(
    message: string,
    level: ToastLevel = 'info',
    durationMs = DEFAULT_DURATION_MS,
    detalle?: ToastDetalle,
    accion?: ToastAccion,
  ): void {
    const id = this.nextId++;
    const toast: Toast = { id, level, message, detalle, accion };
    this.toasts.update((ts) => [...ts, toast]);
    this.historial.update((h) => pushHistorial(h, { ...toast, ts: Date.now() }, MAX_HISTORIAL));
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

  success(
    message: string,
    durationMs?: number,
    detalle?: ToastDetalle,
    accion?: ToastAccion,
  ): void {
    this.show(message, 'success', durationMs, detalle, accion);
  }

  info(message: string, durationMs?: number, detalle?: ToastDetalle, accion?: ToastAccion): void {
    this.show(message, 'info', durationMs, detalle, accion);
  }

  warn(message: string, durationMs?: number, detalle?: ToastDetalle, accion?: ToastAccion): void {
    this.show(message, 'warn', durationMs, detalle, accion);
  }

  error(message: string, durationMs?: number, detalle?: ToastDetalle, accion?: ToastAccion): void {
    this.show(message, 'error', durationMs ?? 6000, detalle, accion);
  }

  dismiss(id: number): void {
    this.toasts.update((ts) => ts.filter((t) => t.id !== id));
  }

  /** Borra una entrada del historial. No toca el toast vivo, si sigue en
   *  pantalla: son dos listas distintas a propósito. */
  olvidar(id: number): void {
    this.historial.update((h) => h.filter((t) => t.id !== id));
  }

  limpiarHistorial(): void {
    this.historial.set([]);
  }
}
