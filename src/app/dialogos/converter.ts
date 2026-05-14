/**
 * Conversor de diálogos al formato RAE (rayas).
 * Port 1:1 de dialogos_a_esp/src/converter.py — mismas reglas D1-D5 + normalización.
 */
import { DIALOG_TAGS, TAGS_ALT, isDialogTag } from './tags';

const EM_DASH = '—';
const QUOTES_CHAR_CLASS = '["“”]';
const SINGLE_QUOTES_CHAR_CLASS = "['‘’]";
/** Word boundary unicode-safe: JS `\b` es ASCII-only y nunca matchea después de
 *  letras acentuadas (preguntó, exclamó, susurró…). Usamos negative lookahead
 *  Unicode-aware. Requiere flag `u` en el regex contenedor. */
const NOT_LETTER = '(?!\\p{L})';

export interface ConvertResult {
  text: string;
  changes: number;
}

export function convert(text: string): ConvertResult {
  let result = normalizeQuotes(text);
  result = normalizeSpacingBeforeTags(result);

  // Si el input tiene <p>…</p> (caso normal del editor TipTap), convertir cada
  // párrafo de forma independiente. El converter original opera línea-por-línea
  // asumiendo que cada diálogo está separado por `\n`; en HTML, cada diálogo
  // está en su propio `<p>`. Sin esta normalización D1 sólo dispara para el
  // primer diálogo del chapter porque `</p><p>` no es `\s+`.
  if (/<p[\s>]/i.test(text) || /<br\s*\/?>/i.test(text)) {
    // Cada <p>…</p> se procesa independiente; dentro de un <p> los <br>
    // (Shift+Enter en TipTap) también son separadores de diálogo. Sin esto, una
    // línea con varios diálogos pegados por <br> sólo convierte el primero.
    result = result.replace(
      /<p\b([^>]*)>([\s\S]*?)<\/p>/gi,
      (_full, attrs: string, inner: string) => {
        return `<p${attrs}>${convertBrSeparated(inner)}</p>`;
      },
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
  return text
    .replace(/«/g, '"')
    .replace(/»/g, '"')
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

function convertLine(line: string): string {
  if (!line.trim()) return line;

  let current = fixPunctuationBeforeTag(line);

  for (let i = 0; i < 10; i++) {
    const prev = current;
    current = applyD4(current);
    current = applyD3(current);
    current = applyD2(current);
    current = applyD1(current);
    current = applyD5(current);
    if (current === prev) break;
  }
  return current;
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
    if (/[?!…]$/.test(content1)) return _;
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
    const text1 = t1.trim();
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
    const text1 = t1.trim();
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
    const text1 = cleanText1(t1);
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
    const text1 = cleanText1(t1);
    const v = verb.toLowerCase();
    const verbRest = rest.trim();
    const text2 = t2.trim();
    return verbRest
      ? `${EM_DASH}${text1} ${EM_DASH}${v} ${verbRest}${EM_DASH}. ${text2}`
      : `${EM_DASH}${text1} ${EM_DASH}${v}${EM_DASH}. ${text2}`;
  });

  return result;
}

/** Strip trailing periods (RAE: el punto antes del verbo dicendi desaparece);
 *  preserva ?, !, … porque esos sí van adentro del diálogo. */
function cleanText1(raw: string): string {
  let t = raw.trim();
  if (/[?!…]$/.test(t)) return t;
  return t.replace(/\.+$/, '').trim();
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

/** D2: Etiqueta de diálogo. */
function applyD2(line: string): string {
  // Patrón 1: "texto" verbo
  const re1 = new RegExp(
    `${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}\\s+(${TAGS_ALT})${NOT_LETTER}`,
    'giu',
  );
  let result = line.replace(re1, (_, content: string, tag: string) => {
    const c = content;
    const t = tag.toLowerCase();
    if (c.endsWith('.')) return `${EM_DASH}${c.replace(/\.+$/, '').trim()} ${EM_DASH}${t}`;
    if (/[?!]$/.test(c)) return `${EM_DASH}${c} ${EM_DASH}${t}`;
    if (c.endsWith(',')) return `${EM_DASH}${c.replace(/,+$/, '').trim()} ${EM_DASH}${t}`;
    return `${EM_DASH}${c} ${EM_DASH}${t}`;
  });

  // Patrón 2: "texto"[,. ]palabra → si palabra es dialog tag o nueva narración
  const re2 = new RegExp(
    `${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}([,.\\s]+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*)${NOT_LETTER}`,
    'gu',
  );
  if (result === line) {
    result = result.replace(re2, (_, content: string, _sep: string, word: string) => {
      const c = content;
      if (isDialogTag(word)) {
        const t = word.toLowerCase();
        if (c.endsWith('.')) return `${EM_DASH}${c.replace(/\.+$/, '').trim()} ${EM_DASH}${t}`;
        if (/[?!]$/.test(c)) return `${EM_DASH}${c} ${EM_DASH}${t}`;
        if (c.endsWith(',')) return `${EM_DASH}${c.replace(/,+$/, '').trim()} ${EM_DASH}${t}`;
        return `${EM_DASH}${c} ${EM_DASH}${t}`;
      }
      // Narración nueva con mayúscula
      if (/[.?!…]$/.test(c)) return `${EM_DASH}${c} ${EM_DASH}${word}`;
      return `${EM_DASH}${c}. ${EM_DASH}${word}`;
    });
  }

  // Patrón 3: comillas simples con verbo
  const re3 = new RegExp(
    `${SINGLE_QUOTES_CHAR_CLASS}([^'\\u2018\\u2019]+)${SINGLE_QUOTES_CHAR_CLASS}\\s+(${TAGS_ALT})${NOT_LETTER}`,
    'giu',
  );
  result = result.replace(re3, (_, content: string, tag: string) => {
    const c = content;
    const t = tag.toLowerCase();
    if (c.endsWith('.')) return `${EM_DASH}${c.replace(/\.+$/, '').trim()} ${EM_DASH}${t}`;
    if (/[?!]$/.test(c)) return `${EM_DASH}${c} ${EM_DASH}${t}`;
    if (c.endsWith(',')) return `${EM_DASH}${c.replace(/,+$/, '').trim()} ${EM_DASH}${t}`;
    return `${EM_DASH}${c} ${EM_DASH}${t}`;
  });

  return result;
}

/** D1: Sustitución directa de delimitadores. */
function applyD1(line: string): string {
  // Inicio de línea
  const re1 = new RegExp(
    `^(\\s*)${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}`,
    'gu',
  );
  let result = line.replace(re1, (_, indent: string, content: string) => {
    return `${indent}${EM_DASH}${content}`;
  });

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

  // Diálogos adicionales en la misma línea (sólo si ya hay raya)
  if (result.includes(EM_DASH)) {
    const reAdd = new RegExp(
      `(\\s+)${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}`,
      'gu',
    );
    result = result.replace(reAdd, (full, space: string, content: string) => {
      const c = content.trim();
      if (c && (/^[A-ZÁÉÍÓÚÑ]/.test(c) || c.startsWith('¿') || c.startsWith('¡'))) {
        return `${space}${EM_DASH}${content}`;
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

  const re = new RegExp(
    `${SINGLE_QUOTES_CHAR_CLASS}([^'\\u2018\\u2019]+)${SINGLE_QUOTES_CHAR_CLASS}`,
    'gu',
  );
  return line.replace(re, (_, content: string) => `«${content}»`);
}
