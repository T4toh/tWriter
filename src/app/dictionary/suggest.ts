/**
 * Candidatos del diccionario de la saga para una palabra marcada como typo.
 *
 * El diccionario per-saga (`<saga>/diccionario.txt`) hoy solo SILENCIA falsos
 * positivos de LanguageTool. Acá se usa como fuente de sugerencias: si escribís
 * `Kallay`, LT ofrece palabras del español y nunca `Kallai`, que es la que hace
 * falta. Función pura, sin Angular ni DOM: la lista tiene decenas o cientos de
 * palabras, así que la distancia se calcula en TS sin Rust ni red.
 */
import { foldAccents } from '../core/search-highlight';

/** Máximo de ediciones tolerado según el largo de la palabra tipeada: 1 hasta
 *  6 caracteres, 2 desde 7. Difiere a propósito de `fuzzy_distance_for` de
 *  `search.rs` (0/1/2 en ≤3/4..=7/≥8): ese umbral es para BUSCAR en el índice,
 *  este es para SUGERIR una corrección. Tolerancia 0 en palabras de 3 letras
 *  no ofrecería nada útil — para sugerir conviene arrancar en 1 incluso en
 *  las cortas. */
function maxDistanceFor(length: number): number {
  return length <= 6 ? 1 : 2;
}

/** Levenshtein clásico con dos filas (O(n) memoria). Corta temprano si la
 *  diferencia de largos ya excede el umbral. */
function levenshtein(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (a === b) return 0;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > limit) return limit + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/**
 * Devuelve hasta `max` palabras del diccionario cercanas a `word`, tal cual
 * están escritas en el diccionario. Comparación case-insensitive y con acentos
 * plegados; orden por distancia ascendente y después alfabético (estable).
 * Excluye coincidencias exactas (verbatim): si la palabra ya está bien escrita
 * no hay nada que sugerir.
 *
 * Nota: si el diccionario tiene dos entradas que pliegan al mismo valor con
 * acentos distintos (ej. `Kallia` y `Kállia`), tipear una de ellas exactamente
 * igual sugiere la otra — es la intersección de "acento distinto ⇒ sugerir" y
 * "idéntica ⇒ excluir". Esto es por diseño. En el flujo real del editor este
 * caso es inalcanzable: `SagaContextService.isInDictionary` filtra el match
 * de LanguageTool antes de que el popover pueda abrirse, así que esta función
 * nunca se llama con una palabra que ya esté verbatim en el diccionario.
 */
export function suggestFromDictionary(word: string, words: string[], max = 3): string[] {
  if (word.length === 0 || words.length === 0) return [];
  const needle = foldAccents(word.toLowerCase());
  const limit = maxDistanceFor(needle.length);
  const scored: { word: string; distance: number }[] = [];
  for (const candidate of words) {
    if (word === candidate) continue; // Excluye coincidencia verbatim exacta.
    const folded = foldAccents(candidate.toLowerCase());
    const distance = levenshtein(needle, folded, limit);
    if (distance <= limit) scored.push({ word: candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.word.localeCompare(b.word, 'es'));
  return scored.slice(0, max).map((s) => s.word);
}
