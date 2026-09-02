import { RaeAutoFix } from '../core/types';
import { planoConMapa } from './plano-con-mapa';

/**
 * Aplica fixes de RAE sobre el HTML del capítulo. Los fixes traen offsets en el
 * espacio del texto plano; el mapa de `planoConMapa` los traduce a posiciones
 * exactas del HTML, así el markup inline (`<em>`, `<strong>`) queda intacto.
 *
 * Un fix cuyo rango en el HTML contiene un tag NO se aplica: cruzaría el borde
 * de una cursiva y se comería un `</em>`. En una operación masiva que el autor
 * no va a revisar archivo por archivo, saltear es la única opción defendible.
 */
export function aplicarFixesHtml(
  html: string,
  fixes: RaeAutoFix[],
): { html: string; aplicados: number; salteados: number } {
  if (fixes.length === 0) return { html, aplicados: 0, salteados: 0 };
  const { plain, mapa } = planoConMapa(html);
  let out = html;
  let aplicados = 0;
  let salteados = 0;
  // Descendente: aplicar de menor a mayor correría las posiciones de los
  // fixes que faltan procesar. Como `mapa` es monótono, el reemplazo de un
  // fix nunca toca posiciones anteriores a las de los fixes que siguen.
  const ordenados = [...fixes].sort((a, b) => b.offset - a.offset);
  for (const fix of ordenados) {
    // length 0 es una inserción válida (ver `space-before-verb` en
    // rules-dedicated.ts, que inserta un espacio faltante): offset puede
    // entonces llegar hasta `plain.length` (insertar después del último
    // carácter). Con length > 0 el rango tiene que caer adentro del plano.
    if (fix.offset < 0 || fix.length < 0 || fix.offset + fix.length > plain.length) {
      salteados += 1;
      continue;
    }
    // Sin carácter de plano en `plain.length` (insertar al final de todo):
    // no hay nada que mirar en el mapa para ese índice, pero `html.length` a
    // secas cae DESPUÉS del `</p>` de cierre. `finDeUltimoCaracter` sobre el
    // último carácter real da el punto justo antes de ese cierre. Con
    // `plain` vacío no hay carácter que mirar — ahí sí no queda otra que
    // `html.length`.
    const desde = fix.offset < plain.length
      ? mapa[fix.offset]
      : plain.length > 0
        ? finDeUltimoCaracter(html, mapa, plain, plain.length - 1)
        : html.length;
    // Rango vacío (inserción): nunca puede cruzar un tag.
    const hasta = fix.length === 0
      ? desde
      : finDeUltimoCaracter(html, mapa, plain, fix.offset + fix.length - 1);
    if (out.slice(desde, hasta).includes('<')) {
      salteados += 1;
      continue;
    }
    out = out.slice(0, desde) + fix.replacement + out.slice(hasta);
    aplicados += 1;
  }
  return { html: out, aplicados, salteados };
}

/**
 * Dónde termina en el HTML el carácter de plano `i` (el ÚLTIMO del rango de
 * un fix). No alcanza con `mapa[i] + 1`: una entidad (`&amp;`) ocupa varios
 * caracteres de HTML por uno de plano, y con el doble-decode de
 * `planoConMapa` (`&amp;lt;` → un solo `<` de plano) puede ocupar bastantes
 * más de lo que una regex ingenua buscando el primer `;` adivinaría.
 * Tampoco alcanza con `mapa[i + 1]` a secas: si el siguiente carácter de
 * plano quedó del otro lado de un tag (el espacio después de `</em>`), ese
 * tag no es parte del carácter `i` y no se puede pisar.
 *
 * La solución no adivina el largo de la entidad: el carácter `i` llega hasta
 * lo que venga antes entre el inicio del próximo carácter de plano y el
 * primer `<` que aparezca — lo que primero corte.
 */
function finDeUltimoCaracter(
  html: string,
  mapa: Int32Array,
  plain: string,
  i: number,
): number {
  const limite = i + 1 < plain.length ? mapa[i + 1] : html.length;
  const tag = html.indexOf('<', mapa[i]);
  return tag !== -1 && tag < limite ? tag : limite;
}
