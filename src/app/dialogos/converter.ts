/**
 * Conversor de diálogos al formato RAE (rayas). Nació como port de
 * dialogos_a_esp/src/converter.py (deprecado) y ya divergió: la norma es el
 * DPD «raya», y `scripts/run-raya-corpus-smoke.mjs` es la regresión.
 */
import { DIALOG_TAGS, TAGS_ALT, isDialogTag } from './tags';

const EM_DASH = '—';
const QUOTES_CHAR_CLASS = '["“”]';
const SINGLE_QUOTES_CHAR_CLASS = "['‘’]";
/** Word boundary unicode-safe: JS `\b` es ASCII-only y nunca matchea después de
 *  letras acentuadas (preguntó, exclamó, susurró…). Usamos negative lookahead
 *  Unicode-aware. Requiere flag `u` en el regex contenedor. */
const NOT_LETTER = '(?!\\p{L})';
/** Dónde puede abrir un parlamento: al principio de la línea o tras un cierre
 *  de oración. Captura lo que precede para devolverlo en el reemplazo. */
const DIALOG_START = '(^\\s*|[.?!…]\\s+)';

export interface ConvertResult {
  text: string;
  changes: number;
}

export function convert(text: string): ConvertResult {
  let result = text;

  // Si el input tiene <p>…</p> (caso normal del editor TipTap), convertir cada
  // párrafo de forma independiente. El converter original opera línea-por-línea
  // asumiendo que cada diálogo está separado por `\n`; en HTML, cada diálogo
  // está en su propio `<p>`. Sin esta normalización D1 sólo dispara para el
  // primer diálogo del chapter porque `</p><p>` no es `\s+`.
  if (/<p[\s>]/i.test(text) || /<br\s*\/?>/i.test(text)) {
    // Cada <p>…</p> se procesa independiente; dentro de un <p> los <br>
    // (Shift+Enter en TipTap) también son separadores de diálogo. Sin esto, una
    // línea con varios diálogos pegados por <br> sólo convierte el primero.
    // Un `<blockquote>` es verso (canción, poema, inscripción), no diálogo:
    // pasa entero sin tocar.
    result = result.replace(
      /(<blockquote\b[\s\S]*?<\/blockquote>)|<p\b([^>]*)>([\s\S]*?)<\/p>/gi,
      (_full, verso: string | undefined, attrs: string, inner: string) =>
        verso ?? `<p${attrs}>${convertBrSeparated(inner)}</p>`,
    );
    // Texto fuera de <p> (raro, pero por las dudas)
    if (!/<p[\s>]/i.test(text)) {
      result = convertBrSeparated(result);
    }
  } else {
    const lines = result.split('\n');
    const converted: string[] = [];
    for (const line of lines) {
      converted.push(convertLine(line));
    }
    result = converted.join('\n');
  }
  const changes = text === result ? 0 : 1;
  return { text: result, changes };
}

function convertBrSeparated(inner: string): string {
  if (!/<br\s*\/?>/i.test(inner)) return convertLine(inner);
  const parts = inner.split(/(<br\s*\/?>)/gi);
  return parts
    .map((p) => (/^<br\s*\/?>$/i.test(p) ? p : convertLine(p)))
    .join('');
}

function normalizeQuotes(text: string): string {
  // Con comillas inglesas en la línea, las «» son una cita interna
  // (`"Me dijo «vete»", dijo.`): aplanarlas rompe el par de afuera.
  const conInglesas = /["“”]/.test(text);
  return (conInglesas ? text : text.replace(/[«»]/g, '"'))
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function normalizeSpacingBeforeTags(text: string): string {
  // "texto"Verbo → "texto" Verbo (sólo si Verbo es dialog tag).
  // `\w+` es ASCII-only en JS y se corta antes de acentos: `Preguntó` →
  // `Pregunt` → `isDialogTag('Pregunt')` false → normalize no aplica.
  // `\p{L}+` con flag `u` matchea letras Unicode (incluye acentos).
  const pattern = /"([.,]?)"(\p{Lu}\p{L}+)/gu;
  return text.replace(pattern, (full, punct: string, word: string) => {
    if (isDialogTag(word)) {
      return `"${punct}" ${word}`;
    }
    return full;
  });
}

/** Volver a poner las comillas que la normalización aplanó y que la
 *  conversión no consumió (una cita interna, un apóstrofo). Solo cuando la
 *  línea original usaba una sola familia: con comillas mezcladas no hay forma
 *  de saber cuál era cuál y quedan rectas. */
function restoreQuotes(original: string, converted: string): string {
  let out = converted;
  if (!/["“”]/.test(original) && /[«»]/.test(original)) {
    let open = true;
    out = out.replace(/"/g, () => ((open = !open) ? '»' : '«'));
  } else if (!/["«»]/.test(original) && /[“”]/.test(original)) {
    let open = true;
    out = out.replace(/"/g, () => ((open = !open) ? '”' : '“'));
  }
  if (!original.includes("'") && /[‘’]/.test(original)) {
    out = out.replace(/(\p{L})?'/gu, (_, letra: string | undefined) =>
      letra ? `${letra}’` : '‘',
    );
  }
  return out;
}

/** Pensamiento (`«¿Y si no vuelve?», pensó`) o cita con comentario del
 *  transcriptor (`«Es imprescindible —señaló el ministro— que…».`, DPD 2.4):
 *  van entre comillas a propósito, no son diálogo. */
function isThoughtOrQuote(line: string): boolean {
  return (
    /^\s*"[^"]+"[,.]?\s+pens\p{L}*/iu.test(line) ||
    /^\s*"[^"]*—[^"]*"\.?\s*$/u.test(line)
  );
}

function convertLine(line: string): string {
  if (!line.trim()) return line;

  // Normalizar por línea y no el documento entero: si no, un solo párrafo
  // convertido aplana las «» y los ’ de todo el capítulo.
  const normalized = normalizeSpacingBeforeTags(normalizeQuotes(line));
  if (isThoughtOrQuote(normalized)) return line;

  let current = fixPunctuationBeforeTag(normalized);

  for (let i = 0; i < 10; i++) {
    const prev = current;
    current = applyD4(current);
    current = applyD3(current);
    current = applyD2(current);
    current = applyD1(current);
    current = applyD5(current);
    if (current === prev) break;
  }
  if (current === normalized) return line;
  return restoreQuotes(line, current);
}

function fixPunctuationBeforeTag(line: string): string {
  const re = new RegExp(
    `"([^"]+)\\.\\s*"\\s+(${TAGS_ALT})${NOT_LETTER}([^"]*?)\\.\\s+"([^"]+)"`,
    'giu',
  );
  return line.replace(re, (_, c1: string, verb: string, rest: string, c2: string) => {
    const content1 = c1.trim();
    const verbRest = rest.trim();
    const content2 = c2.trim();
    // `c1` es greedy: con `"Yo..." dijo` se queda con `Yo..` y el punto
    // que dejó afuera era el tercero de los suspensivos.
    if (/[?!….]$/.test(content1)) return _;
    return verbRest
      ? `"${content1}", ${verb} ${verbRest}. "${content2}"`
      : `"${content1}", ${verb}. "${content2}"`;
  });
}

/** D3: Inciso del narrador con verbo. */
function applyD3(line: string): string {
  // "texto1", verbo[ resto], "texto2"
  const re1 = new RegExp(
    `"([^"]+)",\\s+(${TAGS_ALT})${NOT_LETTER}([^,]*),\\s+"([^"]+)"`,
    'giu',
  );
  let result = line.replace(re1, (_, t1: string, verb: string, rest: string, t2: string) => {
    const text1 = stripClosing(t1);
    const v = verb.toLowerCase();
    const verbRest = rest.trim();
    const text2 = t2.trim();
    return verbRest
      ? `${EM_DASH}${text1} ${EM_DASH}${v} ${verbRest}${EM_DASH}, ${text2}`
      : `${EM_DASH}${text1} ${EM_DASH}${v}${EM_DASH}, ${text2}`;
  });

  // "texto1", verbo resto. "texto2"
  const re2 = new RegExp(
    `"([^"]+)",\\s+(${TAGS_ALT})${NOT_LETTER}([^"]*?)\\.\\s+"([^"]+)"`,
    'giu',
  );
  result = result.replace(re2, (_, t1: string, verb: string, rest: string, t2: string) => {
    const text1 = stripClosing(t1);
    const v = verb.toLowerCase();
    const verbRest = rest.trim();
    const text2 = t2.trim();
    return verbRest
      ? `${EM_DASH}${text1} ${EM_DASH}${v} ${verbRest}${EM_DASH}. ${text2}`
      : `${EM_DASH}${text1} ${EM_DASH}${v}${EM_DASH}. ${text2}`;
  });

  // NUEVO — pattern 3: "texto1" verbo[ resto], "texto2"
  // (sin coma entre comilla y verbo: caso típico cuando texto1 termina en
  // ?, !, … o cuando el usuario simplemente no separó con coma)
  const re3 = new RegExp(
    `"([^"]+)"\\s+(${TAGS_ALT})${NOT_LETTER}([^,"]*),\\s+"([^"]+)"`,
    'giu',
  );
  result = result.replace(re3, (_, t1: string, verb: string, rest: string, t2: string) => {
    const text1 = stripClosing(t1);
    const v = verb.toLowerCase();
    const verbRest = rest.trim();
    const text2 = t2.trim();
    return verbRest
      ? `${EM_DASH}${text1} ${EM_DASH}${v} ${verbRest}${EM_DASH}, ${text2}`
      : `${EM_DASH}${text1} ${EM_DASH}${v}${EM_DASH}, ${text2}`;
  });

  // NUEVO — pattern 4: "texto1" verbo[ resto]. "texto2"
  // (cierre con punto + continuación, sin coma entre comilla y verbo)
  const re4 = new RegExp(
    `"([^"]+)"\\s+(${TAGS_ALT})${NOT_LETTER}([^"]*?)\\.\\s+"([^"]+)"`,
    'giu',
  );
  result = result.replace(re4, (_, t1: string, verb: string, rest: string, t2: string) => {
    const text1 = stripClosing(t1);
    const v = verb.toLowerCase();
    const verbRest = rest.trim();
    const text2 = t2.trim();
    return verbRest
      ? `${EM_DASH}${text1} ${EM_DASH}${v} ${verbRest}${EM_DASH}. ${text2}`
      : `${EM_DASH}${text1} ${EM_DASH}${v}${EM_DASH}. ${text2}`;
  });

  return result;
}

/** El parlamento antes de un inciso con verbo de lengua pierde el punto o la
 *  coma final (DPD 2.3c); ?, ! y los suspensivos (`…` o `...`) se quedan. */
function stripClosing(raw: string): string {
  const t = raw.trim();
  if (/(?:[?!…]|\.\.)$/.test(t)) return t;
  return t.replace(/[.,]$/, '').trim();
}

/** D4: Narración intermedia sin verbo. */
function applyD4(line: string): string {
  const re = /"([^"]+)"\s+([A-ZÁÉÍÓÚÑ][^"]*?)\.\s+"([^"]+)"/gu;
  return line.replace(re, (full, t1: string, narration: string, t2: string) => {
    const words = narration.trim().split(/\s+/);
    for (const w of words) {
      if (isDialogTag(w)) return full;
    }
    // RAE: cuando NO hay verbo dicendi, la puntuación final del diálogo
    // se preserva. Ej: "Hola." Cerró la puerta. "Adiós." → —Hola. —Cerró la
    // puerta—. Adiós. (el punto del "Hola" queda adentro de la raya).
    const text1 = t1.trim();
    return `${EM_DASH}${text1} ${EM_DASH}${narration.trim()}${EM_DASH}. ${t2.trim()}`;
  });
}

/** D2: Etiqueta de diálogo. Las comillas tienen que abrir la línea o venir
 *  tras un cierre de oración: una comilla en medio de la narración
 *  (`La palabra "fin" dice mucho.`) no es un parlamento. */
function applyD2(line: string): string {
  // Patrón 1: "texto" verbo
  const re1 = new RegExp(
    `${DIALOG_START}${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}\\s+(${TAGS_ALT})${NOT_LETTER}`,
    'giu',
  );
  let result = line.replace(re1, (_, pre: string, content: string, tag: string) =>
    `${pre}${EM_DASH}${stripClosing(content)} ${EM_DASH}${tag.toLowerCase()}`,
  );

  // Patrón 2: "texto"[,. ]palabra → si palabra es dialog tag o nueva narración
  const re2 = new RegExp(
    `${DIALOG_START}${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}([,.\\s]+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*)${NOT_LETTER}`,
    'gu',
  );
  if (result === line) {
    result = result.replace(re2, (_, pre: string, content: string, _sep: string, word: string) => {
      const c = content.trim();
      if (isDialogTag(word)) {
        return `${pre}${EM_DASH}${stripClosing(c)} ${EM_DASH}${word.toLowerCase()}`;
      }
      // Narración nueva con mayúscula
      if (/[.?!…]$/.test(c)) return `${pre}${EM_DASH}${c} ${EM_DASH}${word}`;
      return `${pre}${EM_DASH}${c.replace(/,+$/, '')}. ${EM_DASH}${word}`;
    });
  }

  // Patrón 3: comillas simples con verbo. El ancla de DIALOG_START también
  // deja afuera los apóstrofos (`Bob's`).
  const re3 = new RegExp(
    `${DIALOG_START}${SINGLE_QUOTES_CHAR_CLASS}([^'\\u2018\\u2019]+)${SINGLE_QUOTES_CHAR_CLASS}\\s+(${TAGS_ALT})${NOT_LETTER}`,
    'giu',
  );
  result = result.replace(re3, (_, pre: string, content: string, tag: string) =>
    `${pre}${EM_DASH}${stripClosing(content)} ${EM_DASH}${tag.toLowerCase()}`,
  );

  return result;
}

/** D1: Sustitución directa de delimitadores. */
function applyD1(line: string): string {
  // Parlamento cerrado (`.`, `?`, `!`, `…`) y narración en minúscula detrás:
  // la narración lleva su raya, si no se pega al diálogo. La caja la
  // resuelve el validador (DPD 2.3c/d).
  const reNarrator = new RegExp(
    `^(\\s*)${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]*[.?!…])${QUOTES_CHAR_CLASS}\\s+(?=\\p{L})`,
    'u',
  );
  let result = line.replace(reNarrator, (_, indent: string, content: string) =>
    `${indent}${EM_DASH}${content} ${EM_DASH}`,
  );

  // Inicio de línea
  const re1 = new RegExp(
    `^(\\s*)${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}`,
    'gu',
  );
  if (result === line) {
    result = line.replace(re1, (_, indent: string, content: string) => {
      return `${indent}${EM_DASH}${content}`;
    });
  }

  // Comillas simples al inicio
  const re2 = new RegExp(
    `^(\\s*)${SINGLE_QUOTES_CHAR_CLASS}([^'\\u2018\\u2019]+)${SINGLE_QUOTES_CHAR_CLASS}`,
    'gu',
  );
  if (result === line) {
    result = result.replace(re2, (_, indent: string, content: string) => {
      return `${indent}${EM_DASH}${content}`;
    });
  }

  // Diálogos adicionales en la misma línea (sólo si ya hay raya). Tras un
  // cierre de oración: una comilla con mayúscula en medio del parlamento
  // (`—Me dijo «Vete» y se fue.`) es una cita interna, no otro diálogo.
  if (result.includes(EM_DASH)) {
    const reAdd = new RegExp(
      `([.?!…]\\s+)${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}`,
      'gu',
    );
    result = result.replace(reAdd, (full, pre: string, content: string) => {
      const c = content.trim();
      if (c && (/^[A-ZÁÉÍÓÚÑ]/.test(c) || c.startsWith('¿') || c.startsWith('¡'))) {
        return `${pre}${EM_DASH}${content}`;
      }
      return full;
    });
  }

  return result;
}

/** D5: Citas internas con comillas latinas (sólo simples). */
function applyD5(line: string): string {
  if (!line.includes(EM_DASH)) return line;
  if (new RegExp(`^\\s*${QUOTES_CHAR_CLASS}`).test(line)) return line;

  for (const tag of DIALOG_TAGS) {
    if (
      new RegExp(
        `${EM_DASH}${tag}${NOT_LETTER}[^"]*?[\\.,]\\s*${QUOTES_CHAR_CLASS}`,
        'iu',
      ).test(line)
    ) {
      return line;
    }
  }

  if (new RegExp(`\\.\\s+[A-ZÁÉÍÓÚÑ][^.]*\\s*${QUOTES_CHAR_CLASS}`).test(line)) {
    return line;
  }

  const quoteCount = (line.match(new RegExp(QUOTES_CHAR_CLASS, 'g')) ?? []).length;
  if (quoteCount >= 4) return line;

  // Sin letra pegada a ninguna de las dos comillas: `rock'n'roll` y `Bob's`
  // son apóstrofos.
  const re = new RegExp(
    `(?<!\\p{L})${SINGLE_QUOTES_CHAR_CLASS}([^'\\u2018\\u2019]+)${SINGLE_QUOTES_CHAR_CLASS}(?!\\p{L})`,
    'gu',
  );
  return line.replace(re, (_, content: string) => `«${content}»`);
}
