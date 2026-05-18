import { Injectable } from '@angular/core';
import { convertFileSrc } from '@tauri-apps/api/core';

interface Entry {
  url: string;
  version: number;
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
 *  viejo y re-fetchea. */
@Injectable({ providedIn: 'root' })
export class CoverCache {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<string>>();

  async urlFor(path: string, version: number): Promise<string> {
    const existing = this.cache.get(path);
    if (existing && existing.version === version) return existing.url;
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
        this.cache.set(path, { url, version });
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
