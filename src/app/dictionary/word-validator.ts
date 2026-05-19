export interface ValidationOk {
  ok: true;
  value: string;
  sanitized: boolean;
}

export interface ValidationFail {
  ok: false;
  reason: string;
}

export type ValidationResult = ValidationOk | ValidationFail;

const MIN_LENGTH = 2;
const MAX_LENGTH = 64;

// Puntuación / whitespace que se permite en los bordes y se descarta.
// (Caracteres internos como apóstrofe, guión, espacio quedan permitidos.)
const EDGE_PUNCT_CHARS = ` \\t.,;:!?¡¿"'\`´‘’“”«»()[\\]{}…—–\\-_*+~|<>/\\\\`;
const EDGE_PUNCT_RE = new RegExp(`^[${EDGE_PUNCT_CHARS}]+|[${EDGE_PUNCT_CHARS}]+$`, 'g');

// Caracteres que invalidan completamente la palabra (saltos de línea, tab interno).
const INVALID_CHARS_RE = /[\r\n\t]/;

const DIGITS_ONLY_RE = /^\d+$/;

export function validateWord(raw: string): ValidationResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'Entrada inválida' };
  }
  if (INVALID_CHARS_RE.test(raw)) {
    return { ok: false, reason: 'Contiene saltos de línea o tabs' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Vacía' };
  }
  const sanitized = trimmed.replace(EDGE_PUNCT_RE, '');
  if (!sanitized) {
    return { ok: false, reason: 'Solo contiene puntuación' };
  }
  if (sanitized.length < MIN_LENGTH) {
    return { ok: false, reason: `Muy corta (mínimo ${MIN_LENGTH} caracteres)` };
  }
  if (sanitized.length > MAX_LENGTH) {
    return { ok: false, reason: `Muy larga (máximo ${MAX_LENGTH} caracteres)` };
  }
  if (DIGITS_ONLY_RE.test(sanitized)) {
    return { ok: false, reason: 'No puede ser solo dígitos' };
  }
  return { ok: true, value: sanitized, sanitized: sanitized !== raw };
}

const COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function compareWords(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

export function existsCaseInsensitive(list: readonly string[], word: string): boolean {
  return list.some((w) => COLLATOR.compare(w, word) === 0);
}

export function sortWords(list: readonly string[]): string[] {
  return [...list].sort(compareWords);
}

export interface ProblematicEntry {
  word: string;
  reason: string;
  suggested: string | null;
}

export function detectProblematic(list: readonly string[]): ProblematicEntry[] {
  const seenLower = new Set<string>();
  const out: ProblematicEntry[] = [];
  for (const w of list) {
    const result = validateWord(w);
    if (!result.ok) {
      out.push({ word: w, reason: result.reason, suggested: null });
      continue;
    }
    if (result.value !== w) {
      const key = result.value.toLowerCase();
      if (seenLower.has(key)) {
        out.push({ word: w, reason: 'Duplicada tras sanitizar', suggested: null });
      } else {
        out.push({ word: w, reason: 'Tiene espacios o puntuación al borde', suggested: result.value });
        seenLower.add(key);
      }
      continue;
    }
    const key = w.toLowerCase();
    if (seenLower.has(key)) {
      out.push({ word: w, reason: 'Duplicada (variante de mayúsculas)', suggested: null });
    } else {
      seenLower.add(key);
    }
  }
  return out;
}

export function cleanList(list: readonly string[]): string[] {
  const seenLower = new Set<string>();
  const out: string[] = [];
  for (const w of list) {
    const result = validateWord(w);
    if (!result.ok) continue;
    const key = result.value.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    out.push(result.value);
  }
  return out.sort(compareWords);
}
