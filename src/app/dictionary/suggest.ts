/**
 * Candidatos del diccionario de la saga para una palabra marcada como typo.
 *
 * El diccionario per-saga (`<saga>/diccionario.txt`) hoy solo SILENCIA falsos
 * positivos de LanguageTool. Acá se usa como fuente de sugerencias: si escribís
 * `Kallay`, LT ofrece palabras del español y nunca `Kallai`, que es la que hace
 * falta. Función pura, sin Angular ni DOM: la lista tiene decenas o cientos de
 * palabras, así que la distancia se calcula en TS sin Rust ni red.
 */

/** Pliega acentos (copia de src/app/core/search-highlight.ts línea 27).
 * Length-preserving: cada acento mapea a base (1:1). */
function foldAccents(s: string): string {
  const ACCENT_MAP: Record<string, string> = {
    á: 'a', à: 'a', ä: 'a', â: 'a', ã: 'a',
    é: 'e', è: 'e', ë: 'e', ê: 'e',
    í: 'i', ì: 'i', ï: 'i', î: 'i',
    ó: 'o', ò: 'o', ö: 'o', ô: 'o', õ: 'o',
    ú: 'u', ù: 'u', ü: 'u', û: 'u',
    Á: 'A', À: 'A', Ä: 'A', Â: 'A', Ã: 'A',
    É: 'E', È: 'E', Ë: 'E', Ê: 'E',
    Í: 'I', Ì: 'I', Ï: 'I', Î: 'I',
    Ó: 'O', Ò: 'O', Ö: 'O', Ô: 'O', Õ: 'O',
    Ú: 'U', Ù: 'U', Ü: 'U', Û: 'U',
  };
  let out = '';
  for (const ch of s) out += ACCENT_MAP[ch] ?? ch;
  return out;
}

/** Máximo de ediciones tolerado según el largo de la palabra tipeada. Mismo
 *  criterio que la búsqueda fuzzy: cortas exigen precisión, largas toleran más. */
function maxDistanceFor(length: number): number {
  if (length <= 3) return 1;
  if (length <= 6) return 1;
  return 2;
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
 * Excluye coincidencias exactas: si la palabra ya está bien escrita no hay nada
 * que sugerir.
 */
export function suggestFromDictionary(word: string, words: string[], max = 3): string[] {
  if (word.length === 0 || words.length === 0) return [];
  const needle = foldAccents(word.toLowerCase());
  const limit = maxDistanceFor(needle.length);
  const scored: { word: string; distance: number }[] = [];
  for (const candidate of words) {
    if (word === candidate) continue;
    const folded = foldAccents(candidate.toLowerCase());
    const distance = levenshtein(needle, folded, limit);
    if (distance <= limit) scored.push({ word: candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.word.localeCompare(b.word, 'es'));
  return scored.slice(0, max).map((s) => s.word);
}
