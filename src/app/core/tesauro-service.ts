import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { RespuestaTesauro } from './types';

/** Cuántas consultas se recuerdan. El popover de repeticiones pregunta por la
 *  misma palabra cada vez que se abre una marca del mismo grupo. */
const MAX_CACHE = 50;

/**
 * Consulta el tesauro embebido. Sin signals a propósito: es request/response,
 * no estado observable — el que lo llama guarda el resultado donde le sirve.
 */
@Injectable({ providedIn: 'root' })
export class TesauroService {
  private readonly cache = new Map<string, RespuestaTesauro>();

  async lookup(palabra: string, idioma: string): Promise<RespuestaTesauro> {
    const clave = `${idioma}:${palabra.toLowerCase()}`;
    const guardado = this.cache.get(clave);
    if (guardado) return guardado;
    let res: RespuestaTesauro;
    try {
      res = await invoke<RespuestaTesauro>('tesauro_lookup', { palabra, idioma });
    } catch {
      // El invoke falló, así que del tesauro no sabemos nada: `disponible:
      // false` para que el popover diga eso y no "sin sinónimos para «x»", que
      // sería echarle la culpa a la palabra. Sigue sin interrumpir la escritura.
      res = { disponible: false, acepciones: [] };
    }
    if (this.cache.size >= MAX_CACHE) {
      const primera = this.cache.keys().next().value;
      if (primera !== undefined) this.cache.delete(primera);
    }
    this.cache.set(clave, res);
    return res;
  }
}
