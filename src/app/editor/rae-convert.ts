/**
 * Mitad SIN DOM del apply de RAE: HTML de entrada → HTML convertido.
 *
 * Vive separado de `rae-apply.ts` a propósito. Ese importa `@tiptap/core`, que
 * no carga en node, y el smoke runner (`scripts/run-rae-apply-smoke.mjs`)
 * necesita poder importar esto sin arrastrarlo.
 */
import { convert } from '../dialogos/converter';

/**
 * Aplica las reglas RAE sobre un fragmento HTML. Devuelve `null` cuando no hay
 * nada que cambiar — el caller no dispara transacción.
 *
 * El converter ya acepta HTML con markup inline: es exactamente lo que recibe
 * del botón "RAE" del toolbar, que convierte el capítulo entero. Acá se le da
 * la misma clase de input sobre un rango más chico.
 */
export function convertFragmentHtml(html: string): string | null {
  const out = convert(html).text;
  return out === html ? null : out;
}
