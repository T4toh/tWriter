import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { Acepcion } from './types';

/** Cuántas consultas se recuerdan. El popover de repeticiones pregunta por la
 *  misma palabra cada vez que se abre una marca del mismo grupo. */
const MAX_CACHE = 50;

/**
 * Consulta el tesauro embebido. Sin signals a propósito: es request/response,
 * no estado observable — el que lo llama guarda el resultado donde le sirve.
 */
@Injectable({ providedIn: 'root' })
export class TesauroService {
  private readonly cache = new Map<string, Acepcion[]>();

  async lookup(palabra: string, idioma: string): Promise<Acepcion[]> {
    const clave = `${idioma}:${palabra.toLowerCase()}`;
    const guardado = this.cache.get(clave);
    if (guardado) return guardado;
    let res: Acepcion[] = [];
    try {
      res = await invoke<Acepcion[]>('tesauro_lookup', { palabra, idioma });
    } catch {
      // Sin sinónimos no es una falla que valga interrumpir la escritura: el
      // popover ya sabe mostrar "sin sinónimos".
      res = [];
    }
    if (this.cache.size >= MAX_CACHE) {
      const primera = this.cache.keys().next().value;
      if (primera !== undefined) this.cache.delete(primera);
    }
    this.cache.set(clave, res);
    return res;
  }
}
