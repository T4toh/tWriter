import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class NavigationService {
  /** Path del nodo siendo browseado en el landing. null = root. */
  readonly browsingPath = signal<string | null>(null);
  /** Último capítulo abierto en el pane principal. Sobrevive al cierre del
   *  capítulo (abrir una nota en el centro lo cierra), y es lo que fija el
   *  "libro que estoy escribiendo" para el panel de notas. */
  readonly ultimoCapitulo = signal<string | null>(null);

  setUltimoCapitulo(path: string): void {
    this.ultimoCapitulo.set(path);
  }

  setBrowsing(path: string | null): void {
    this.browsingPath.set(path);
  }

  goRoot(): void {
    this.browsingPath.set(null);
  }
}
