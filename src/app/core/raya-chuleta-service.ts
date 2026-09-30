import { Injectable, signal } from '@angular/core';

/** Abre y cierra la chuleta de diálogos con raya (`docs/raya.md`). */
@Injectable({ providedIn: 'root' })
export class RayaChuletaService {
  readonly open = signal<boolean>(false);

  show(): void {
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }
}
