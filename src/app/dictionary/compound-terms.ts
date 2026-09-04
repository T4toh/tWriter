/**
 * Términos compuestos del diccionario per-saga: las entradas que los
 * tokenizadores parten en dos y el diccionario token-level no puede expresar.
 * Son de dos formas, y el problema es el mismo:
 *   - **con espacio** — `Kun Lian` un reino, `Tres Torres` un vino,
 *     `Amalut de las Arenas` un apellido;
 *   - **con apóstrofe** — `Sarta’an`, `Sa’artan`. Para el autor son UNA palabra,
 *     pero LT parte ahí: medido contra el container, `Sarta’an cayó al mar.`
 *     marca `an` (`MORFOLOGIK_RULE_ES`, TYPOS) y `Escapó de Sa’artan` marca
 *     `Sa` y `artan` por separado. El `PALABRA_RE = /\p{L}+/gu` del detector de
 *     repeticiones parte igual.
 *
 * Existe porque el resto del diccionario es token-level y no tiene forma de
 * expresar ninguna de las dos: `isInDictionary` es un `Set.has` de una palabra
 * suelta y el detector compara token contra token. Guardar `Tres Torres` o
 * `Sarta’an` ya funcionaba —`validateWord` permite espacios y apóstrofes
 * internos— pero no servía para nada: el filtro compara la marca (`an`) contra
 * el diccionario, `an` no está, y la marca sobrevive. Y el workaround de cargar
 * los pedazos sueltos es peor que el bug: mete `Tres` —o peor, `an`— al
 * diccionario y apaga la corrección de la palabra común en toda la saga.
 *
 * La pasada corre UNA vez sobre el texto plano y devuelve rangos. Los
 * consumidores que ya trabajan con offsets sobre ese mismo plano (el filtro de
 * LanguageTool, el detector de repeticiones) descartan por CONTENCIÓN lo que
 * caiga adentro. Contención y no igualdad de string a propósito: LT marca
 * `las Arenas` con `AGREEMENT_DET_NOUN`, un span que no coincide con la entrada
 * (`Amalut de las Arenas`) sino que está adentro.
 *
 * Función pura: sin DOM, sin ProseMirror, sin `@tiptap/core`, para que entre en
 * un smoke runner de node (`scripts/run-compound-terms-smoke.mjs`).
 */

export interface CompoundRange {
  /** Offset del primer carácter, en el espacio de `extractPlainText`. */
  start: number;
  /** Offset del carácter siguiente al último (medio abierto, como slice). */
  end: number;
  /** El texto matcheado, tal cual aparece en el plano. Para debug y UI. */
  term: string;
}

/** Las variantes de apóstrofe que un autor puede llegar a tipear. La recta
 *  ASCII y la tipográfica son las dos que importan; el resto entran gratis
 *  porque un teclado o un autocorrector las mete sin avisar. */
const APOSTROFES = "'’‘ʼ´`";

/** Un separador que parte la entrada en tokens: whitespace o apóstrofe. */
const SEPARADOR_INTERNO = new RegExp(`[\\s${APOSTROFES}]`, 'u');

/** Una entrada del diccionario es compuesta si algún tokenizador la va a
 *  partir: tiene espacio o apóstrofe interno. Los bordes no cuentan —
 *  `validateWord` ya los recorta. */
export function isCompound(word: string): boolean {
  return SEPARADOR_INTERNO.test(word.trim());
}

/** Parte el diccionario en las dos poblaciones. Las simples siguen el camino
 *  token-level de siempre; las compuestas van a `findCompoundRanges`. */
export function splitDictionary(words: readonly string[]): {
  simples: string[];
  compuestas: string[];
} {
  const simples: string[] = [];
  const compuestas: string[] = [];
  for (const w of words) {
    (isCompound(w) ? compuestas : simples).push(w);
  }
  return { simples, compuestas };
}

/** Letra o dígito Unicode. NO se usa `\b`, que es ASCII-only y no ve los
 *  acentos: el mismo bug que se arrastró del `dialogos_a_esp` de Python. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Separador tolerado ENTRE las palabras de un término con espacio. Espacios y
 *  tabs, nunca `\n`: el plano de `extractPlainText` separa bloques con `\n\n`, y
 *  un `\s+` dejaría que `Tres Torres` matcheara un `Tres` que cierra un párrafo
 *  con el `Torres` que abre el siguiente. */
const SEP_ESPACIO = '[ \\t\\u00a0]+';

/** Separador de un término con apóstrofe. Las variantes son intercambiables al
 *  matchear: el autor guardó `Sarta’an` con la tipográfica y el texto puede
 *  tener la recta (o al revés, según de dónde vino pegado). */
const SEP_APOSTROFE = `[${APOSTROFES}]`;

/** Corta el término en tokens CONSERVANDO los separadores: el `split` con grupo
 *  de captura deja el texto en los índices pares y los separadores en los
 *  impares. */
const CORTE = new RegExp(`([\\s${APOSTROFES}]+)`, 'u');

/** El patrón de un término, con CADA hueco traducido al separador que ese hueco
 *  realmente tiene. Un `[ \\t'’]+` genérico sería más corto y estaría mal:
 *  dejaría que `Sarta’an` matcheara `Sarta an` y que `Tres Torres` matcheara
 *  `Tres’Torres`. */
function patronDe(term: string): string {
  return term
    .split(CORTE)
    .map((parte, i) => {
      if (i % 2 === 0) return escapeRe(parte);
      return /\s/.test(parte) ? SEP_ESPACIO : SEP_APOSTROFE;
    })
    .join('');
}

/**
 * Compila los términos compuestos en un solo regex, o null si no hay ninguno.
 *
 * **Case-sensitive a propósito**, y es la única parte del diccionario que lo es
 * (`isInDictionary` hace `toLowerCase`). `Tres Torres` el vino contra `tres
 * torres` de piedra es exactamente la distinción que este feature existe para
 * poder marcar; con match insensible, cargar el vino apagaría la corrección
 * sobre la frase común.
 */
export function compileCompounds(terms: readonly string[]): RegExp | null {
  const utiles = terms.map((t) => t.trim()).filter((t) => t && isCompound(t));
  if (utiles.length === 0) return null;
  // Más largo primero: si están cargados `Amalut de las Arenas` y `de las
  // Arenas`, tiene que ganar el largo. La alternación de JS es
  // leftmost-first-alternative, no leftmost-longest, así que el orden ES la
  // regla — con el corto adelante el rango queda recortado y el match de LT
  // que cubre el nombre entero deja de estar contenido.
  const ordenados = [...new Set(utiles)].sort((a, b) => b.length - a.length);
  return new RegExp(`(?:${ordenados.map(patronDe).join('|')})`, 'gu');
}

/**
 * Rangos del plano cubiertos por algún término compuesto, en orden de aparición.
 *
 * Los bordes se chequean a mano en vez de con lookbehind: WebKitGTK viejo (la
 * webview de Tauri en Linux) no siempre lo trae, y un regex que tira
 * `SyntaxError` al compilar se lleva puesto el chequeo entero.
 */
export function findCompoundRanges(
  plain: string,
  terms: readonly string[],
): CompoundRange[] {
  const re = compileCompounds(terms);
  if (!re) return [];
  const out: CompoundRange[] = [];
  for (const m of plain.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (start > 0 && WORD_CHAR.test(plain[start - 1])) continue;
    if (end < plain.length && WORD_CHAR.test(plain[end])) continue;
    out.push({ start, end, term: m[0] });
  }
  return out;
}

/**
 * ¿El span `[start, end)` cae ENTERO adentro de algún rango compuesto?
 *
 * ponytail: scan lineal sobre `ranges`. Son las apariciones de los nombres del
 * mundo en un capítulo contra las marcas de ese mismo capítulo — decenas por
 * decenas. Si algún día un capítulo tira miles de las dos, ordenar los rangos
 * (ya vienen ordenados) y buscar por bisección.
 */
export function isInsideCompound(
  ranges: readonly CompoundRange[],
  start: number,
  end: number,
): boolean {
  return ranges.some((r) => start >= r.start && end <= r.end);
}
