import { Injectable } from '@angular/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

interface Entry {
  url: string;
  version: number;
  mtime: number;
}

/** Cache de blob URLs para covers de saga/libro.
 *
 *  Por qué no usar `convertFileSrc` directo en el `<img>`: WebKitGTK no
 *  cachea de forma estable las respuestas del custom protocol
 *  `asset://`, y cualquier re-paint del `<img>` (hover, focus, transform)
 *  re-fetchea el archivo del disco. Generamos un blob URL una sola vez
 *  por (path, version) — el browser nunca lo refetchea porque los bytes
 *  viven en el heap JS.
 *
 *  El parámetro `version` se usa para invalidar cuando el usuario edita
 *  la tapa via modal — al cambiar el `savedAt()` del config service,
 *  pasamos el nuevo valor como version y este servicio revoca el blob
 *  viejo y re-fetchea.
 *
 *  `version` solo se entera de lo que se guarda desde la app. Lo que pasa
 *  afuera (renombrar la tapa en Finder, un pull que trae otra con el mismo
 *  nombre) se ve por la fecha de modificación: cada pedido hace un `stat` del
 *  archivo, que no lee los bytes. Si el archivo no está, el blob se descarta
 *  y `urlFor` tira, igual que si fallara el fetch. */
@Injectable({ providedIn: 'root' })
export class CoverCache {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<string>>();

  async urlFor(path: string, version: number): Promise<string> {
    const mtime = await invoke<number | null>('image_mtime', { path });
    if (mtime === null) {
      this.invalidate(path);
      throw new Error(`no existe: ${path}`);
    }
    const existing = this.cache.get(path);
    if (existing && existing.version === version && existing.mtime === mtime) return existing.url;
    if (existing) {
      URL.revokeObjectURL(existing.url);
      this.cache.delete(path);
    }
    const pending = this.inflight.get(path);
    if (pending) return pending;
    const p = (async () => {
      try {
        const res = await fetch(convertFileSrc(path));
        if (!res.ok) throw new Error(`fetch ${path} → ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        this.cache.set(path, { url, version, mtime });
        return url;
      } finally {
        this.inflight.delete(path);
      }
    })();
    this.inflight.set(path, p);
    return p;
  }

  invalidate(path: string): void {
    const entry = this.cache.get(path);
    if (entry) {
      URL.revokeObjectURL(entry.url);
      this.cache.delete(path);
    }
  }
}
