/**
 * Educador de comillas tipográficas para textos en inglés.
 *
 * Convierte comillas rectas ASCII a su forma tipográfica ("smart quotes"):
 *   "…"  → “…”   (U+201C / U+201D)
 *   '…'  → ‘…’   (U+2018 / U+2019)
 *   It's → It’s  (apóstrofe / posesivo → U+2019)
 *
 * Es la contraparte en inglés del conversor a rayas RAE (`../dialogos/converter`),
 * que hace lo opuesto (normaliza curly→ASCII y produce rayas). Acá NO se tocan
 * las rayas ni el español: esto solo aplica cuando el capítulo es `idioma === 'en'`.
 *
 * Tag-aware: opera sobre el subset XHTML del editor tokenizando en tags vs texto
 * y educando SOLO los segmentos de texto. Así `<hr class="scene-break"/>` y demás
 * atributos con comillas rectas nunca se corrompen.
 *
 * Limitaciones conocidas (aceptables para el caso de uso):
 * - Comillas rectas usadas como pulgadas/prima (`6"` → `6”`, `5'` → `5’`).
 * - Elisiones iniciales fuera de la lista `LEADING_ELISIONS` se tratan como
 *   apertura de cita simple en vez de apóstrofe.
 */
import type { ConvertResult } from '../dialogos/converter';

const LDQUO = '“'; // “
const RDQUO = '”'; // ”
const LSQUO = '‘'; // ‘
const RSQUO = '’'; // ’

/** Chars tras los cuales una comilla abre (no cierra). */
const OPENERS = new Set(['', '(', '[', '{', '¿', '¡', '—', '–', LSQUO, LDQUO]);

/** Tags de bloque: resetean el contexto (arranque de línea ⇒ próxima comilla abre). */
const BLOCK_TAG = /^<\s*\/?\s*(p|br|hr|h1|h2|h3|blockquote|div|li)\b/i;

/** Elisiones iniciales que llevan apóstrofe (’), no apertura de cita simple. */
const LEADING_ELISIONS = ['em', 'tis', 'twas', 'cause', 'round', 'til', 'bout', 'n'];

function isAlnum(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

function isOpenContext(prev: string): boolean {
  return OPENERS.has(prev) || /\s/.test(prev);
}

/** ¿El apóstrofe en `text[i]` es una elisión inicial (’90s, 'em, 'tis…)? */
function isLeadingElision(text: string, i: number): boolean {
  const rest = text.slice(i + 1);
  if (/^\d0s\b/.test(rest)) return true; // décadas: '90s, '00s
  const m = /^(\p{L}+)/u.exec(rest);
  if (!m) return false;
  return LEADING_ELISIONS.includes(m[1].toLowerCase());
}

/** Educa un segmento de texto plano (sin tags). `prev` es el último char visible previo. */
function educateText(text: string, prev: string): { out: string; last: string } {
  let out = '';
  let prevChar = prev;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      out += isOpenContext(prevChar) ? LDQUO : RDQUO;
    } else if (ch === "'") {
      if (isAlnum(prevChar)) {
        out += RSQUO; // contracción / posesivo: It's, dogs', o'clock
      } else {
        const next = i + 1 < text.length ? text[i + 1] : '';
        if (isAlnum(next) && !isLeadingElision(text, i)) {
          out += LSQUO; // apertura de cita simple: 'tech'
        } else {
          out += RSQUO; // cierre / elisión: thief', 'em, '90s
        }
      }
    } else {
      out += ch;
    }
    prevChar = ch;
  }
  return { out, last: prevChar };
}

export function educateQuotes(html: string): ConvertResult {
  // Tokenizar en tags (<...>) y texto. Educar solo el texto.
  const tokens = html.split(/(<[^>]+>)/);
  let prev = '';
  let out = '';
  for (const tok of tokens) {
    if (tok === '') continue;
    if (tok[0] === '<') {
      out += tok;
      if (BLOCK_TAG.test(tok)) prev = ''; // bloque ⇒ reset contexto
      // tags inline (<i>, <em>, <strong>, <span>) son transparentes: mantienen prev
      continue;
    }
    const { out: educated, last } = educateText(tok, prev);
    out += educated;
    prev = last;
  }
  const changes = html === out ? 0 : 1;
  return { text: out, changes };
}
