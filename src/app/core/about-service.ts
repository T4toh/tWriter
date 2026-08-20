import { Injectable, signal } from '@angular/core';

/** Un paquete de terceros. `texto` es el índice en `Licencias.textos`, o `null`
 *  si el paquete no trae su texto de licencia. */
export interface PaqueteLicencia {
  nombre: string;
  version: string;
  origen: 'npm' | 'cargo';
  licencia: string;
  texto: number | null;
}

/** Un dato de terceros que la app shipea (los tesauros), con su texto completo:
 *  son los que estamos obligados a reproducir. */
export interface DatoLicencia {
  nombre: string;
  descripcion: string;
  licencia: string;
  texto: string;
}

export interface Licencias {
  app: {
    nombre: string;
    version: string;
    licencia: string;
    texto: string;
    repo: string;
  };
  datos: DatoLicencia[];
  grupos: { licencia: string; paquetes: PaqueteLicencia[] }[];
  /** Textos deduplicados: el de Apache-2.0 son 11 KB y lo repiten diecisiete
   *  crates. Los paquetes guardan el índice. */
  textos: string[];
}

/**
 * Estado del modal "Acerca de". El JSON lo genera
 * `scripts/generar-licencias.mjs` en el `prebuild` y se carga la primera vez que
 * se abre el modal — son 117 KB que no tienen por qué estar en el arranque.
 */
@Injectable({ providedIn: 'root' })
export class AboutService {
  readonly open = signal<boolean>(false);
  readonly licencias = signal<Licencias | null>(null);
  readonly error = signal<string | null>(null);

  async openAbout(): Promise<void> {
    this.open.set(true);
    if (this.licencias() !== null) return;
    try {
      const res = await fetch('assets/licencias.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.licencias.set((await res.json()) as Licencias);
      this.error.set(null);
    } catch {
      // El JSON es un asset del build: si falta, el bundle está mal armado. Se
      // dice qué pasó en vez de mostrar una pantalla vacía.
      this.error.set(
        'No se pudo cargar la lista de licencias. Falta el asset del build ' +
          '(assets/licencias.json), que genera scripts/generar-licencias.mjs.',
      );
    }
  }

  close(): void {
    this.open.set(false);
  }
}
