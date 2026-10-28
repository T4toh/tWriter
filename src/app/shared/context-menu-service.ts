import { Injectable, signal } from '@angular/core';
import type { LucideIcon } from '@lucide/angular';
import { atajo } from './atajo';

export interface CtxMenuItem {
  kind?: 'item';
  label: string;
  /** Texto opcional a la derecha (atajo, hint o badge). */
  kbd?: string;
  /** Ícono Lucide opcional a la derecha (alternativa decorativa a `kbd`). */
  icon?: LucideIcon;
  /** Pinta el item en rojo. */
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
}

export interface CtxMenuSeparator {
  kind: 'separator';
}

/** Rótulo no clickeable que encabeza un grupo de items. */
export interface CtxMenuHeader {
  kind: 'header';
  label: string;
}

export type CtxMenuEntry = CtxMenuItem | CtxMenuSeparator | CtxMenuHeader;

export interface CtxMenuState {
  x: number;
  y: number;
  entries: CtxMenuEntry[];
}

@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  readonly current = signal<CtxMenuState | null>(null);

  /**
   * Abre un menú custom para `event`. Suprime el menú nativo y detiene la propagación
   * (para que el listener global en App no abra encima el menú default).
   */
  open(event: MouseEvent, entries: CtxMenuEntry[]): void {
    event.preventDefault();
    event.stopPropagation();
    this.show(event.clientX, event.clientY, entries);
  }

  /** Desplegable de un botón: el menú abre pegado abajo del botón, no donde cayó el click. */
  openBelow(event: MouseEvent, entries: CtxMenuEntry[]): void {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.show(rect.left, rect.bottom + 2, entries);
  }

  private show(x: number, y: number, entries: CtxMenuEntry[]): void {
    if (!entries.some((e) => !e.kind || e.kind === 'item')) return;
    this.current.set({ x, y, entries });
  }

  /**
   * Llamado por el handler global de App cuando ningún componente capturó el evento.
   * Suprime SIEMPRE el menú nativo. Si hay selección de texto, muestra acciones
   * default (Copiar / Seleccionar todo). Si no, no abre nada.
   */
  openDefault(event: MouseEvent): void {
    event.preventDefault();
    const sel = window.getSelection()?.toString() ?? '';
    if (!sel.trim()) return;
    const entries: CtxMenuEntry[] = [
      {
        label: 'Copiar',
        kbd: atajo('C'),
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(sel);
          } catch {
            // sin permiso de clipboard; silenciamos
          }
        },
      },
      {
        label: 'Seleccionar todo',
        kbd: atajo('A'),
        onClick: () => {
          const target = event.target as HTMLElement | null;
          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement
          ) {
            target.select();
          } else {
            document.execCommand?.('selectAll');
          }
        },
      },
    ];
    this.current.set({ x: event.clientX, y: event.clientY, entries });
  }

  close(): void {
    this.current.set(null);
  }
}
