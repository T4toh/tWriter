/**
 * Cuántos capítulos entran en la muestra por defecto: los primeros que suman
 * al menos el 10 % de las palabras del libro, mínimo uno. Es la proporción
 * que Amazon usa para su vista previa, así que es lo que el lector espera.
 * Sin conteos (todo en cero) cae a un capítulo.
 */
export const PORCENTAJE_MUESTRA = 0.1;

export function capitulosPorDefecto(palabras: readonly number[]): number {
  if (palabras.length === 0) return 1;
  const total = palabras.reduce((s, p) => s + p, 0);
  if (total <= 0) return 1;
  const objetivo = total * PORCENTAJE_MUESTRA;
  let acumulado = 0;
  for (let i = 0; i < palabras.length; i++) {
    acumulado += palabras[i];
    if (acumulado >= objetivo) return i + 1;
  }
  return palabras.length;
}
