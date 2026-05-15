import { Injectable, signal } from '@angular/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

/** Espejo del struct Rust `system_fonts::SystemFont` (serializado camelCase). */
export interface SystemFont {
  family: string;
  path: string;
  hasBold: boolean;
  hasItalic: boolean;
}

/** Servicio singleton que mantiene el listado de fuentes instaladas en el OS
 *  y carga FontFaces on-demand para el preview del dropdown del editor.
 *
 *  Load lazy: `ensureLoaded()` invoca `list_system_fonts` la primera vez (~400ms
 *  en sistemas con muchas fuentes), las siguientes invocaciones son
 *  instantáneas. El cache vive en el backend Rust; este servicio solo replica
 *  el snapshot en un signal Angular. */
@Injectable({ providedIn: 'root' })
export class SystemFontsService {
  readonly fonts = signal<SystemFont[]>([]);
  readonly loading = signal<boolean>(false);

  private loaded = false;
  private inflight: Promise<void> | null = null;
  private readonly loadedFaces = new Set<string>();

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.loading.set(true);
    this.inflight = (async () => {
      try {
        const list = await invoke<SystemFont[]>('list_system_fonts');
        this.fonts.set(list);
        this.loaded = true;
      } finally {
        this.loading.set(false);
        this.inflight = null;
      }
    })();
    await this.inflight;
  }

  /** Fuerza re-scan del OS (re-invoca la enumeración fontdb). Útil si el
   *  usuario instaló fuentes con la app abierta. */
  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await invoke<SystemFont[]>('refresh_system_fonts');
      this.fonts.set(list);
      this.loaded = true;
    } finally {
      this.loading.set(false);
    }
  }

  /** True si la familia (case-sensitive) está en la lista del OS. */
  has(family: string): boolean {
    return this.fonts().some((f) => f.family === family);
  }

  /** Devuelve la entry si existe, sino undefined. */
  find(family: string): SystemFont | undefined {
    return this.fonts().find((f) => f.family === family);
  }

  /** Carga una face vía FontFace API y la agrega a `document.fonts` para que
   *  CSS pueda resolver `font-family: '<family>'`. Idempotente — guarda el
   *  set de familias ya cargadas. Útil para mostrar el preview de fuentes
   *  del pool del repo (que no están instaladas en el OS) y como garantía
   *  de render para OS fonts si WebKit no las pickea via fontconfig. */
  async loadFace(family: string, path: string): Promise<void> {
    if (this.loadedFaces.has(family)) return;
    this.loadedFaces.add(family);
    try {
      const url = convertFileSrc(path);
      const ff = new FontFace(family, `url("${url}")`);
      await ff.load();
      document.fonts.add(ff);
    } catch {
      this.loadedFaces.delete(family);
    }
  }
}
