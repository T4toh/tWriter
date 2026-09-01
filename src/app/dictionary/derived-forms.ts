/** Reglas de flexión por idioma de saga. Nunca se mezclan entre idiomas. */
export type IdiomaFlexion = 'es' | 'en';

/** Reduce el idioma declarado por la saga (`es`, `es-AR`, `en-US`…) a la familia
 *  de reglas de flexión. Null si no lo declara: en ese caso no se pela ni se
 *  genera nada y el filtro se comporta como antes. */
export function idiomaFlexionDe(raw: string | null | undefined): IdiomaFlexion | null {
  const s = raw?.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('es')) return 'es';
  if (s.startsWith('en')) return 'en';
  return null;
}

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

export type Categoria = 'verbo' | 'adjetivo';

/** Formas a ofrecer para un lema. Solo español; en inglés devuelve [].
 *
 *  El generador NUNCA escribe un plural: de eso se encarga `stripInflection`.
 *  Por eso el núcleo verbal son 15 formas y no 17 (sin `bardeados`/`bardeadas`)
 *  y los adjetivos son 2 y no 4. */
export function generateForms(
  lema: string,
  categoria: Categoria,
  idioma: IdiomaFlexion,
): string[] {
  if (idioma !== 'es') return [];
  const l = lema.trim().toLowerCase();
  if (!l) return [];
  return categoria === 'verbo' ? conjugar(l) : generoAdjetivo(l);
}

/** Adjetivos en `-o`: masculino y femenino singular. Los invariables en género
 *  (`-e`, `-ista`, consonante) no generan nada — la entrada sola alcanza. */
function generoAdjetivo(lema: string): string[] {
  if (!lema.endsWith('o')) return [];
  return [lema, lema.slice(0, -1) + 'a'];
}

function conjugar(lema: string): string[] {
  const term = lema.slice(-2);
  const raiz = lema.slice(0, -2);
  if (raiz.length < 2) return [];

  if (term === 'ar') {
    return dedupe([
      lema,
      raiz + 'ando',
      raiz + 'ado',
      raiz + 'ada',
      raiz + 'o',
      raiz + 'ás',
      raiz + 'a',
      raiz + 'an',
      preteritoPrimeraAr(raiz),
      raiz + 'aste',
      raiz + 'ó',
      raiz + 'aron',
      raiz + 'aba',
      raiz + 'aban',
      raiz + 'á',
    ]);
  }

  if (term !== 'er' && term !== 'ir') return [];

  // Raíz terminada en vocal (`leer`, `oír`): la `i` átona entre vocales pasa a
  // `y`, pero la `i` tónica lleva tilde y NO pasa a `y`. Confundir los dos casos
  // escribe formas que no existen (`leyste`, `leido`) y esas sí silencian typos.
  const enVocal = VOCAL_FINAL.test(raiz);
  const gerundio = enVocal ? 'yendo' : 'iendo';
  const participio = enVocal ? 'ído' : 'ido';
  const participioF = enVocal ? 'ída' : 'ida';
  const preterito2 = enVocal ? 'íste' : 'iste';
  const preterito3 = enVocal ? 'yó' : 'ió';
  const preterito3pl = enVocal ? 'yeron' : 'ieron';
  const presenteVoseo = term === 'er' ? 'és' : 'ís';
  const imperativoVoseo = term === 'er' ? 'é' : 'í';

  return dedupe([
    lema,
    raiz + gerundio,
    raiz + participio,
    raiz + participioF,
    raiz + 'o',
    raiz + presenteVoseo,
    raiz + 'e',
    raiz + 'en',
    raiz + 'í',
    raiz + preterito2,
    raiz + preterito3,
    raiz + preterito3pl,
    raiz + 'ía',
    raiz + 'ían',
    raiz + imperativoVoseo,
  ]);
}

/** Ajuste ortográfico del pretérito 1ª sg: `trancar`→`tranqué`, `pagar`→`pagué`,
 *  `cazar`→`cacé`. No es modelar un irregular, es cómo se escribe el sonido. */
function preteritoPrimeraAr(raiz: string): string {
  if (raiz.endsWith('c')) return raiz.slice(0, -1) + 'qué';
  if (raiz.endsWith('g')) return raiz + 'ué';
  if (raiz.endsWith('z')) return raiz.slice(0, -1) + 'cé';
  return raiz + 'é';
}

function dedupe(formas: readonly string[]): string[] {
  return [...new Set(formas)];
}

export interface LemmaCandidate {
  lema: string;
  categoria: Categoria;
}

/** Sustantivos que terminan parecido a una forma verbal. Sin esta lista
 *  `teletransportación` — que está en el diccionario de Meridian — se ofrecería
 *  como verbo. */
const STOP_SUSTANTIVOS: readonly string[] = [
  'ciones', 'ción', 'siones', 'sión', 'mientos', 'miento', 'dades', 'dad',
];

interface ReglaSufijo {
  sufijo: string;
  terminaciones: readonly string[];
}

/** Ordenadas de sufijo más largo a más corto: la primera que matchea gana.
 *  `-a` y `-o` no están acá — caen al fallback de adjetivo, que además
 *  reconstruye el verbo como segundo candidato.
 *
 *  Todo sufijo de esta tabla tiene que ser una forma que `generateForms` emita:
 *  si no, el autor pide las formas, se agregan las 15, y la palabra que apretó
 *  sigue subrayada. Por eso NO están `-amos` ni `-ábamos` (1ª plural presente e
 *  imperfecto): el núcleo verbal son 15 formas por decisión del spec y ninguna
 *  de las dos está ahí. `casteamos` no infiere lema y se agrega sola con
 *  `+ diccionario`, que es el costo de un click que el spec ya acepta. */
const REGLAS: readonly ReglaSufijo[] = [
  { sufijo: 'ieron', terminaciones: ['er', 'ir'] },
  { sufijo: 'iendo', terminaciones: ['er', 'ir'] },
  { sufijo: 'ando', terminaciones: ['ar'] },
  { sufijo: 'aban', terminaciones: ['ar'] },
  { sufijo: 'aste', terminaciones: ['ar'] },
  { sufijo: 'aron', terminaciones: ['ar'] },
  { sufijo: 'iste', terminaciones: ['er', 'ir'] },
  { sufijo: 'ado', terminaciones: ['ar'] },
  { sufijo: 'ada', terminaciones: ['ar'] },
  { sufijo: 'ido', terminaciones: ['er', 'ir'] },
  { sufijo: 'ida', terminaciones: ['er', 'ir'] },
  { sufijo: 'aba', terminaciones: ['ar'] },
  { sufijo: 'ían', terminaciones: ['er', 'ir'] },
  { sufijo: 'ía', terminaciones: ['er', 'ir'] },
  { sufijo: 'ás', terminaciones: ['ar'] },
  { sufijo: 'és', terminaciones: ['er'] },
  { sufijo: 'ís', terminaciones: ['ir'] },
  { sufijo: 'ió', terminaciones: ['er', 'ir'] },
  { sufijo: 'an', terminaciones: ['ar'] },
  { sufijo: 'en', terminaciones: ['er', 'ir'] },
  { sufijo: 'ó', terminaciones: ['ar'] },
  { sufijo: 'é', terminaciones: ['ar'] },
  { sufijo: 'á', terminaciones: ['ar'] },
  { sufijo: 'í', terminaciones: ['ir'] },
];

/** Terminaciones de infinitivo: si la palabra ya termina así, es su propio lema. */
const INFINITIVOS: readonly string[] = ['ar', 'er', 'ir'];

const MIN_RAIZ = 3;
/** Los sufijos de una o dos letras (`-an`, `-en`, `-ó`) matchean cualquier cosa,
 *  incluidos nombres propios, así que piden una raíz más larga para aceptarse. */
const MIN_RAIZ_SUFIJO_CORTO = 4;

/** Candidatos de lema + categoría inferidos desde una forma marcada. */
export function inferLemma(word: string, idioma: IdiomaFlexion): LemmaCandidate[] {
  if (idioma !== 'es') return [];
  const w = word.trim().toLowerCase();
  if (w.length < MIN_RAIZ + 1) return [];
  if (STOP_SUSTANTIVOS.some((s) => w.endsWith(s))) return [];

  // La palabra YA es el infinitivo: es su propio lema. Sin este caso el botón
  // «+ formas…» no aparece justo sobre la entrada más obvia — `bardear`,
  // `castear`, `Moniquear` — porque ninguna regla de sufijo matchea un
  // infinitivo y el fallback de `-a`/`-o` tampoco (terminan en `r`).
  // Un sustantivo en `-ar`/`-er` (`altar`, `Brámar`) también cae acá y propone
  // un verbo que no existe: misma limitación aceptada que `Bastien`, y el mismo
  // remedio, que es cancelar el preview.
  if (INFINITIVOS.some((t) => w.endsWith(t))) {
    return [{ lema: w, categoria: 'verbo' }];
  }

  for (const regla of REGLAS) {
    if (!w.endsWith(regla.sufijo)) continue;
    const raiz = w.slice(0, -regla.sufijo.length);
    // Sin el piso más alto para sufijos cortos, `Aedan` matchea `-an` con raíz
    // `aed` y propone el verbo `aedar`. Los sufijos largos (`-iendo`, `-aste`)
    // ya discriminan solos y se conforman con una raíz de 3 (`comiendo`→`comer`).
    if (raiz.length < (regla.sufijo.length <= 2 ? MIN_RAIZ_SUFIJO_CORTO : MIN_RAIZ)) continue;
    return regla.terminaciones.map((t) => ({ lema: raiz + t, categoria: 'verbo' as const }));
  }

  // `-a` y `-o` son ambiguos: `telequinético` es adjetivo, `teletransporta` y
  // `teletransporto` son verbo. Se devuelven los dos, adjetivo primero porque
  // es lo más frecuente con esa terminación en el corpus.
  if (w.endsWith('a')) {
    return [
      { lema: w, categoria: 'adjetivo' },
      { lema: w + 'r', categoria: 'verbo' },
    ];
  }
  if (w.endsWith('o')) {
    return [
      { lema: w, categoria: 'adjetivo' },
      { lema: w.slice(0, -1) + 'ar', categoria: 'verbo' },
    ];
  }
  return [];
}
