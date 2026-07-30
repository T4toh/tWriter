/**
 * Mitad SIN DOM del apply de RAE: HTML de entrada → HTML convertido.
 *
 * Vive separado de `rae-apply.ts` a propósito. Ese importa `@tiptap/core`, que
 * no carga en node, y el smoke runner (`scripts/run-rae-apply-smoke.mjs`)
 * necesita poder importar esto sin arrastrarlo.
 */
import { convert } from '../dialogos/converter';
import { normalizeQuotesForCompare } from '../dialogos/validator';

/**
 * Aplica las reglas RAE sobre un fragmento HTML. Devuelve `null` cuando no hay
 * nada que cambiar — el caller no dispara transacción.
 *
 * El converter ya acepta HTML con markup inline: es exactamente lo que recibe
 * del botón "RAE" del toolbar, que convierte el capítulo entero. Acá se le da
 * la misma clase de input sobre un rango más chico.
 *
 * El segundo guard es el mismo que usa `pushPendingConversion` en el validador:
 * `convert()` normaliza «» “” ‘’ a comillas rectas ANTES de aplicar las reglas,
 * así que un párrafo donde ninguna regla mordió igual sale distinto del input.
 * Pasa siempre que el markup inline arranca antes del diálogo
 * (`<em>“Vení”</em>, dijo ella.`): el ancla `^(\s*)"` de D1 no ve la comilla
 * porque el tag la corrió de la posición 0. Sin el guard, el caller reemplazaba
 * el párrafo por una versión con las comillas tipográficas degradadas a rectas
 * y sin convertir a raya — peor que no hacer nada.
 */
export function convertFragmentHtml(html: string): string | null {
  const out = convert(html).text;
  if (out === html) return null;
  if (out === normalizeQuotesForCompare(html)) return null;
  return out;
}
