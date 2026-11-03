/**
 * Texto ↔ líneas del editor de guion. Puro, sin DOM.
 *
 * El archivo se guarda byte a byte como el autor lo escribió: lo único que
 * cambia es `\r\n` → `\n`. El `\n` final no viaja por acá —`partirLineas` saca
 * uno si lo hay y `write_note` (Rust) lo repone al guardar—, así una línea
 * vacía al final del editor no se multiplica en cada guardado.
 */

export function partirLineas(texto: string): string[] {
  const normalizado = texto.replace(/\r\n/g, '\n');
  const sinFinal = normalizado.endsWith('\n') ? normalizado.slice(0, -1) : normalizado;
  return sinFinal.split('\n');
}

export function unirLineas(lineas: string[]): string {
  return lineas.join('\n');
}
