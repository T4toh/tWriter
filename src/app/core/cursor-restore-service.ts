import { Injectable, signal } from '@angular/core';

/** Pedido pendiente de restaurar el cursor en un cap/nota al cargarlo. El
 *  bootstrap encola uno cuando hay `lastSession` válida; el Editor / NotesEditor
 *  lo consume después del primer render del doc. */
export interface PendingCursorRestore {
  path: string;
  pmPos: number;
  /** Contador monotónico para evitar doble-consumo. */
  requestId: number;
}

/** Cola de un solo slot para restaurar la posición del cursor al abrir un
 *  cap/nota. Mismo patrón que `SearchService.pendingHighlight` — el productor
 *  encola con `request`, el consumidor llama `consume(path)` y obtiene el
 *  pmPos a aplicar (o null si no era para este path / ya se consumió). */
@Injectable({ providedIn: 'root' })
export class CursorRestoreService {
  private readonly pending = signal<PendingCursorRestore | null>(null);
  private counter = 0;

  request(path: string, pmPos: number): void {
    this.pending.set({ path, pmPos, requestId: ++this.counter });
  }

  /** Si hay un pedido pendiente para `path`, lo devuelve y lo limpia.
   *  Idempotente — una sola toma. */
  consume(path: string): PendingCursorRestore | null {
    const p = this.pending();
    if (!p || p.path !== path) return null;
    this.pending.set(null);
    return p;
  }
}
