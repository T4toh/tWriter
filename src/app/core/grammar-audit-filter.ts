import { findCompoundRanges, isInsideCompound } from '../dictionary/compound-terms';
import {
  IdiomaFlexion,
  makeDictLookup,
  stripInflection,
} from '../dictionary/derived-forms';
import { GrammarMatch } from './types';

/**
 * Filtro del diccionario de la saga sobre los matches de LT, para la
 * auditoría por alcance. Es el mismo criterio que `editor.ts::checkGrammar`
 * aplica al capítulo abierto, pero sobre una lista de palabras suelta en vez
 * de `SagaContextService`: el alcance auditado puede ser de otra saga que la
 * activa, así que el diccionario se resuelve por path y llega como array.
 *
 * - Adentro de un término compuesto no hay nada que corregir, sea la
 *   categoría que sea («Amalut de las Arenas» dispara `AGREEMENT_DET_NOUN`).
 * - Los `TYPOS` se descartan si la palabra está en el diccionario, con
 *   flexión pelada cuando se conoce el idioma (`kallais` con `Kallai`).
 */
export function filtrarMatchesAuditoria(
  plain: string,
  matches: readonly GrammarMatch[],
  diccionario: readonly string[],
  idioma: IdiomaFlexion | null,
): GrammarMatch[] {
  if (diccionario.length === 0) return [...matches];
  const compuestas = findCompoundRanges(plain, diccionario);
  const exactas = new Set(diccionario.map((w) => w.toLowerCase()));
  const lookup = makeDictLookup(diccionario);
  const enDiccionario = (word: string): boolean =>
    exactas.has(word.toLowerCase()) ||
    (idioma !== null && stripInflection(word, idioma, lookup) !== null);

  return matches.filter((m) => {
    if (isInsideCompound(compuestas, m.offset, m.offset + m.length)) return false;
    if (m.category !== 'TYPOS') return true;
    return !enDiccionario(plain.slice(m.offset, m.offset + m.length));
  });
}
