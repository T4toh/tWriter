/**
 * Límites de la palabra que toca el offset dado. Función pura, sin DOM: la
 * cubre `scripts/run-tesauro-smoke.mjs`.
 *
 * `fin` es exclusivo. Un cursor pegado al final de una palabra cuenta como
 * adentro — es el caso normal al terminar de escribirla. Decisión explícita:
 * un cursor con una letra a la izquierda y un espacio (u otro no-letra) a la
 * derecha resuelve SIEMPRE a la palabra de la izquierda, sin importar si esa
 * palabra es la primera del texto o cualquier otra — no hay "demasiado cerca
 * del espacio" que lo invalide. Para que dé `null` hace falta que no haya
 * letra a ninguno de los dos lados del offset (ej. dos espacios seguidos,
 * o el texto vacío).
 */
const LETRA = /[a-záéíóúüñA-ZÁÉÍÓÚÜÑ']/;

export function palabraEn(
  texto: string,
  offset: number,
): { inicio: number; fin: number } | null {
  if (texto.length === 0) return null;
  let i = Math.max(0, Math.min(offset, texto.length));
  // Cursor pegado al final de una palabra: mirar el carácter de atrás.
  if (i === texto.length || !LETRA.test(texto[i])) {
    if (i === 0 || !LETRA.test(texto[i - 1])) return null;
    i -= 1;
  }
  let inicio = i;
  while (inicio > 0 && LETRA.test(texto[inicio - 1])) inicio -= 1;
  let fin = i + 1;
  while (fin < texto.length && LETRA.test(texto[fin])) fin += 1;
  return { inicio, fin };
}
