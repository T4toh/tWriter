/**
 * Conversor de diálogos a raya. Nació como port de
 * dialogos_a_esp/src/converter.py (deprecado) y ya divergió: la norma es el
 * DPD «raya», y `scripts/run-raya-corpus-smoke.mjs` es la regresión.
 */
import { DIALOG_TAGS, TAG_PHRASE, isDialogTag } from './tags';

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
  // "texto"Verbo → "texto" Verbo (sólo si Verbo es dialog tag). La comilla
  // tiene que venir pegada a algo: es la de cierre.
  // `\w+` es ASCII-only en JS y se corta antes de acentos: `Preguntó` →
  // `Pregunt` → `isDialogTag('Pregunt')` false → normalize no aplica.
  // `\p{L}+` con flag `u` matchea letras Unicode (incluye acentos).
  return text.replace(/(?<=\S)"(\p{Lu}\p{L}+)/gu, (full, word: string) =>
    isDialogTag(word) ? `" ${word}` : full,
  );
}

/** Sustitutos de raya en un párrafo de diálogo: `--`, `―` (barra horizontal,
 *  la que muestra la web de la RAE), `–` (semirraya) y `−` (menos) pasan a
 *  raya; los dos últimos, salvo entre o antes de números (`1990–2000`, `−5`).
 *  El guion simple solo donde no puede ser de palabra: al abrir, abriendo un
 *  inciso (` -dijo`) o cerrándolo (`Juan-.`). Fuera de un diálogo no se toca
 *  nada. */
function normalizeDashes(line: string): string {
  // Apertura con sustituto y mayúscula detrás: con minúscula es un ítem de
  // lista (`- harina,`, DPD raya 3.2) y el espacio sí va.
  const opener = /^(\s*)(?:--|[-–―−])[ \t]*(?=[\p{Lu}¿¡«"“…])/u.exec(line);
  if (!opener && !/^\s*—/.test(line)) return line;
  const head = opener ? `${opener[1]}${EM_DASH}` : '';
  const rest = (opener ? line.slice(opener[0].length) : line)
    // Raya de inciso con verbo de lengua detrás: va pegada al verbo
    // (`-- dijo` → `—dijo`).
    .replace(new RegExp(`(?<=\\s)(?:--|[-–―−])[ \\t]+(?=${TAG_PHRASE}${NOT_LETTER})`, 'giu'), EM_DASH)
    .replace(/--|―|(?<!\d)–(?!\d)|−(?!\d)/g, EM_DASH)
    // Guion con espacio a los dos lados: nunca es de palabra.
    .replace(/(?<=\s)-(?=\s)/g, EM_DASH)
    .replace(/(?<=\s)-(?=\p{L})/gu, EM_DASH)
    .replace(/(?<=[\p{L}.,;:?!…])-(?=[\s.,;:?!…]|$)/gu, EM_DASH);
  return head + rest;
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
    // Comillas de seguir: la intervención que ocupa más de un párrafo abre
    // cada párrafo siguiente con `»` (DPD comillas 2c). Se mira sobre la
    // línea original: normalizada, ese `»` es una comilla más.
    /^\s*»/.test(line) ||
    /^\s*["“«][^"“”«»]+["”»][,.]?\s+pens\p{L}*/iu.test(line) ||
    /^\s*["“«][^"“”«»]*—[^"“”«»]*["”»]\.?\s*$/u.test(line)
  );
}

function convertLine(html: string): string {
  if (!html.trim()) return html;
  // `&nbsp;` es una entidad en el HTML del editor y ninguna regex la ve como
  // espacio: se pasa al carácter (que `\s` sí matchea) y se vuelve después.
  // Si la conversión consumió ese espacio, no vuelve, y está bien.
  if (!html.includes('&nbsp;')) return convertPlainLine(html);
  return convertPlainLine(html.replaceAll('&nbsp;', '\u00a0')).replaceAll('\u00a0', '&nbsp;');
}

function convertPlainLine(line: string): string {
  if (!line.trim()) return line;

  // Normalizar por línea y no el documento entero: si no, un solo párrafo
  // convertido aplana las «» y los ’ de todo el capítulo.
  if (isThoughtOrQuote(line)) return line;
  const dashed = normalizeDashes(line);
  const normalized = normalizeSpacingBeforeTags(normalizeQuotes(dashed));

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
  if (current === normalized) return dashed;
  return restoreQuotes(line, current);
}

function fixPunctuationBeforeTag(line: string): string {
  const re = new RegExp(
    `"([^"]+)\\.\\s*"\\s+(${TAG_PHRASE})${NOT_LETTER}([^"]*?)\\.\\s+"([^"]+)"`,
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

/** D3: Inciso del narrador con verbo entre dos parlamentos. Cuatro formas:
 *  con o sin coma entre la comilla y el verbo, y el segundo parlamento tras
 *  coma (sigue el enunciado) o tras punto (enunciado nuevo). Si el segundo
 *  parlamento lleva su propio verbo detrás (`"…", agregó.`), va con él. */
function applyD3(line: string): string {
  let result = line;
  for (const sep of [',\\s+', '\\s+']) {
    for (const [middle, join] of [['([^,"]*),', ','], ['([^"]*?)\\.', '.']]) {
      const re = new RegExp(
        `"([^"]+)"${sep}(${TAG_PHRASE})${NOT_LETTER}${middle}\\s+"([^"]+)"` +
          `(?:,?\\s+(${TAG_PHRASE})${NOT_LETTER})?`,
        'giu',
      );
      result = result.replace(
        re,
        (_, t1: string, verb: string, rest: string, t2: string, verb2?: string) => {
          const inciso = rest.trim() ? `${verb.toLowerCase()} ${rest.trim()}` : verb.toLowerCase();
          const text2 = verb2
            ? `${stripClosing(t2)} ${EM_DASH}${verb2.toLowerCase()}`
            : t2.trim();
          return `${EM_DASH}${stripClosing(t1)} ${EM_DASH}${inciso}${EM_DASH}${join} ${text2}`;
        },
      );
    }
  }
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
  // Patrón 1: "texto" verbo, con la coma afuera o sin coma. Afuera es la
  // puntuación española (DPD comillas 3a/3b: `«¿Qué es esto?», preguntaron`).
  const re1 = new RegExp(
    `${DIALOG_START}${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS},?\\s+(${TAG_PHRASE})${NOT_LETTER}`,
    'giu',
  );
  let result = line.replace(re1, (_, pre: string, content: string, tag: string) =>
    `${pre}${EM_DASH}${stripClosing(content)} ${EM_DASH}${tag.toLowerCase()}`,
  );

  // Sujeto antes del verbo: `"No sé", Juan dijo.` es un inciso de verbo de
  // lengua (DPD 2.3c), no narración nueva.
  if (result === line) {
    const reSubject = new RegExp(
      `${DIALOG_START}${QUOTES_CHAR_CLASS}([^"\\u201C\\u201D]+)${QUOTES_CHAR_CLASS},?\\s+(\\p{Lu}\\p{L}+\\s+(?:${TAG_PHRASE}))${NOT_LETTER}`,
      'gu',
    );
    // Con el parlamento cerrado en punto, lo que sigue es narración nueva
    // (`"Vení." María dice que no.`): eso lo resuelve el patrón 2.
    result = result.replace(reSubject, (full, pre: string, content: string, inciso: string) =>
      /(?<!\.)\.\s*$/.test(content)
        ? full
        : `${pre}${EM_DASH}${stripClosing(content)} ${EM_DASH}${inciso}`,
    );
  }

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
    `${DIALOG_START}${SINGLE_QUOTES_CHAR_CLASS}([^'\\u2018\\u2019]+)${SINGLE_QUOTES_CHAR_CLASS},?\\s+(${TAG_PHRASE})${NOT_LETTER}`,
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
