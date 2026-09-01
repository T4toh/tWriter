/** Reglas de flexión por idioma de saga. Nunca se mezclan entre idiomas. */
export type IdiomaFlexion = 'es' | 'en';

export interface DictLookup {
  /** Canónica si la grafía coincide exacto, comparando en minúsculas. */
  exactGet(word: string): string | null;
  /** Canónica ignorando diacríticos. Solo se consulta después de pelar algo. */
  foldedGet(word: string): string | null;
}

/** Minúsculas y sin diacríticos. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function makeDictLookup(words: readonly string[]): DictLookup {
  const exacto = new Map<string, string>();
  const plegado = new Map<string, string>();
  for (const w of words) {
    const lower = w.toLowerCase();
    if (!exacto.has(lower)) exacto.set(lower, w);
    const f = fold(w);
    if (!plegado.has(f)) plegado.set(f, w);
  }
  return {
    exactGet: (word) => exacto.get(word.toLowerCase()) ?? null,
    foldedGet: (word) => plegado.get(fold(word)) ?? null,
  };
}

/** Rioplatense: sin `os` de vosotros. Los dobles (`-melo`) salen de pelar dos veces. */
const ENCLITICOS: readonly string[] = ['me', 'te', 'se', 'lo', 'la', 'le', 'nos', 'los', 'las', 'les'];

const VOCAL_FINAL = /[aeiouáéíóú]$/;
const MIN_RESTO = 4;
const MAX_PELADOS = 2;

/** Devuelve la entrada del diccionario que cubre `word` vía flexión, o null. */
export function stripInflection(
  word: string,
  idioma: IdiomaFlexion,
  lookup: DictLookup,
): string | null {
  const w = word.toLowerCase();

  // Resuelve un resto YA pelado: exacto primero, y recién ahí sin diacríticos.
  // El índice plegado nunca se consulta sobre la palabra cruda — si lo hiciera,
  // el diccionario pasaría a ignorar los acentos y `mirmidon` mal escrita
  // dejaría de marcarse.
  const resolver = (resto: string): string | null => {
    if (resto.length < MIN_RESTO) return null;
    return lookup.exactGet(resto) ?? lookup.foldedGet(resto);
  };

  const plural = pelarPlural(w, idioma, resolver);
  if (plural) return plural;

  if (idioma !== 'es') return null;
  return pelarEncliticos(w, resolver);
}

function pelarPlural(
  w: string,
  idioma: IdiomaFlexion,
  resolver: (resto: string) => string | null,
): string | null {
  if (!w.endsWith('s')) return null;
  const candidatos: string[] = [];
  if (idioma === 'es') {
    if (w.endsWith('ces')) candidatos.push(w.slice(0, -3) + 'z');
    if (VOCAL_FINAL.test(w.slice(0, -1))) candidatos.push(w.slice(0, -1));
    if (w.endsWith('es')) candidatos.push(w.slice(0, -2));
  } else {
    // Inglés: solo `-s`. `-es` y `-ies` no se implementan — cero casos en las
    // 265 entradas del diccionario de Milky Way.
    candidatos.push(w.slice(0, -1));
  }
  for (const c of candidatos) {
    const hit = resolver(c);
    if (hit) return hit;
  }
  return null;
}

function pelarEncliticos(w: string, resolver: (resto: string) => string | null): string | null {
  let nivel: string[] = [w];
  for (let profundidad = 0; profundidad < MAX_PELADOS; profundidad += 1) {
    const siguiente: string[] = [];
    for (const actual of nivel) {
      for (const enclitico of ENCLITICOS) {
        if (!actual.endsWith(enclitico)) continue;
        const resto = actual.slice(0, -enclitico.length);
        if (resto.length < MIN_RESTO) continue;
        // El resto tiene que tener forma de infinitivo, gerundio o imperativo.
        // Corta pelados espurios sobre sustantivos (`hermanos` → `herma`).
        if (!(resto.endsWith('r') || resto.endsWith('ndo') || VOCAL_FINAL.test(resto))) continue;
        const hit = resolver(resto);
        if (hit) return hit;
        siguiente.push(resto);
      }
    }
    nivel = siguiente;
  }
  return null;
}