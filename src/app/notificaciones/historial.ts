/** Parte pura del historial de notificaciones. Vive aparte de `ToastService`
 *  —y sin importar nada de Angular— para que la pueda correr el smoke runner
 *  de `scripts/run-historial-smoke.mjs` (ver CLAUDE.md: los runners solo
 *  cargan funciones puras).
 *
 *  Genérico sobre `{ id }` a propósito: acá no se sabe nada de niveles,
 *  detalles ni acciones, solo del orden y del tope. */

/** Tope duro de entradas. NO es el mecanismo de limpieza —las borra el autor,
 *  una por una o con "Limpiar todo"— sino la red contra una sesión de escritura
 *  de doce horas que acumule miles. */
export const MAX_HISTORIAL = 200;

/** Mete una entrada al historial. **Más nueva primero**: es el orden en que se
 *  muestran, y así el recorte por el tope tira siempre las más viejas.
 *
 *  Hacerlo al revés (agregar al final y cortar con `slice(0, max)`) compila
 *  igual y descarta justo las que el autor está buscando — las que acaban de
 *  pasar. De ahí que esto tenga test propio y no sea un `update()` inline. */
export function pushHistorial<T extends { id: number }>(
  lista: readonly T[],
  entrada: T,
  max: number = MAX_HISTORIAL,
): T[] {
  if (max <= 0) return [];
  return [entrada, ...lista].slice(0, max);
}
