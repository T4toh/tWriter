import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class NavigationService {
  /** Path del nodo siendo browseado en el landing. null = root. */
  readonly browsingPath = signal<string | null>(null);

  setBrowsing(path: string | null): void {
    this.browsingPath.set(path);
  }

  goRoot(): void {
    this.browsingPath.set(null);
  }
}
