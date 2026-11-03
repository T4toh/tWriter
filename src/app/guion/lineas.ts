/**
 * Texto ↔ líneas del editor de guion. Puro, sin DOM.
 *
 * El archivo se guarda byte a byte como el autor lo escribió: lo único que
 * cambia es `\r\n` → `\n` y que un archivo sin `\n` final lo gana. Para eso
 * `partirLineas` saca **un** `\n` final y `unirLineas` lo repone: así
 * `unirLineas(partirLineas(x)) === x` para cualquier `x` que termine en `\n`,
 * incluidos los que terminan en líneas en blanco (si `unirLineas` no lo
 * pusiera y lo agregara `write_note` solo cuando falta, `"a\n\n"` perdía un
 * `\n` en cada guardado).
 */

export function partirLineas(texto: string): string[] {
  const normalizado = texto.replace(/\r\n/g, '\n');
  const sinFinal = normalizado.endsWith('\n') ? normalizado.slice(0, -1) : normalizado;
  return sinFinal.split('\n');
}

export function unirLineas(lineas: string[]): string {
  return lineas.join('\n') + '\n';
}

/** Lo pegado se parte sin tocar el `\n` final: copiar líneas enteras (del
 *  principio de una al principio de otra) trae ese `\n`, y es la línea vacía
 *  que hace que lo pegado no se pegue a la línea del cursor. */
export function partirPegado(texto: string): string[] {
  return texto.replace(/\r\n/g, '\n').split('\n');
}

/** Cuántos caracteres saca Shift+Tab al principio de una línea: hasta dos
 *  espacios, o un tab. */
export function cuantoDesindentar(linea: string): number {
  return /^( {1,2}|\t)/.exec(linea)?.[0].length ?? 0;
}
