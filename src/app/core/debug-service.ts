import { Injectable, signal } from '@angular/core';

export type DebugLevel = 'info' | 'warn' | 'error';

export interface DebugEntry {
  ts: number;
  level: DebugLevel;
  source: string;
  message: string;
  details?: string;
}

const MAX_ENTRIES = 200;

/**
 * Sink puro para eventos de debug. Sin inyecciones — se evita ciclo DI con
 * los servicios que la consumen (chapter, etc). Las suscripciones a errores
 * de servicios se cablean en el App component.
 */
@Injectable({ providedIn: 'root' })
export class DebugService {
  readonly entries = signal<DebugEntry[]>([]);
  readonly visible = signal<boolean>(false);

  log(level: DebugLevel, source: string, message: string, details?: string): void {
    const entry: DebugEntry = {
      ts: Date.now(),
      level,
      source,
      message,
      details,
    };
    this.entries.update((es) => [entry, ...es].slice(0, MAX_ENTRIES));
  }

  info(source: string, message: string, details?: string): void {
    this.log('info', source, message, details);
  }

  warn(source: string, message: string, details?: string): void {
    this.log('warn', source, message, details);
  }

  error(source: string, message: string, details?: string): void {
    this.log('error', source, message, details);
  }

  clear(): void {
    this.entries.set([]);
  }

  toggle(): void {
    this.visible.update((v) => !v);
  }
}
