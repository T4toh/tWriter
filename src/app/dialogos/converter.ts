/**
 * Conversor de diálogos al formato RAE (rayas).
 * Port 1:1 de dialogos_a_esp/src/converter.py — mismas reglas D1-D5 + normalización.
 */
import { DIALOG_TAGS, TAGS_ALT, isDialogTag } from './tags';

const EM_DASH = '—';
const QUOTES_CHAR_CLASS = '["“”]';
const SINGLE_QUOTES_CHAR_CLASS = "['‘’]";

export interface ConvertResult {
  text: string;
  changes: number;
}

export function convert(text: string): ConvertResult {
  let result = normalizeQuotes(text);
  const before = result;
  result = normalizeSpacingBeforeTags(result);

  const lines = result.split('\n');
  const converted: string[] = [];
  for (const line of lines) {
    converted.push(convertLine(line));
  }
  const finalText = converted.join('\n');
  // Heurística cantidad de cambios: comparar caracteres distintos por línea.
  const changes = before === finalText ? 0 : 1;
  return { text: finalText, changes };
}

function normalizeQuotes(text: string): string {
  return text
    .replace(/«/g, '"')
    .replace(/»/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function normalizeSpacingBeforeTags(text: string): string {
  // "texto"Verbo → "texto" Verbo (sólo si Verbo es dialog tag)
  const pattern = /"([.,]?)"([A-ZÁÉÍÓÚÑ]\w+)/gu;
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
    `"([^"]+)\\.\\s*"\\s+(${TAGS_ALT})\\b([^"]*?)\\.\\s+"([^"]+)"`,
    'gi',
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
    `"([^"]+)",\\s+(${TAGS_ALT})\\b([^,]*),\\s+"([^"]+)"`,
    'gi',
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
    `"([^"]+)",\\s+(${TAGS_ALT})\\b([^"]*?)\\.\\s+"([^"]+)"`,
    'gi',
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

  return result;
}

/** D4: Narración intermedia sin verbo. */
function applyD4(line: string): string {
  const re = /"([^"]+)"\s+([A-ZÁÉÍÓÚÑ][^"]*?)\.\s+"([^"]+)"/gu;
  return line.replace(re, (full, t1: string, narration: string, t2: string) => {
    const words = narration.trim().split(/\s+/);
    for (const w of words) {
      if (isDialogTag(w)) return full;
    }
    const text1 = t1.trim().replace(/\.+$/, '');
    return `${EM_DASH}${text1} ${EM_DASH}${narration.trim()}${EM_DASH}. ${t2.trim()}`;
  });
}

/** D2: Etiqueta de diálogo. */
function applyD2(line: string): string {
  // Patrón 1: "texto" verbo
  const re1 = new RegExp(
    `${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}\\s+(${TAGS_ALT})\\b`,
    'gi',
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
    `${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS}([,.\\s]+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*)\\b`,
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
    `${SINGLE_QUOTES_CHAR_CLASS}([^'\\u2018\\u2019]+)${SINGLE_QUOTES_CHAR_CLASS}\\s+(${TAGS_ALT})\\b`,
    'gi',
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
        `${EM_DASH}${tag}\\b[^"]*?[\\.,]\\s*${QUOTES_CHAR_CLASS}`,
        'i',
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
