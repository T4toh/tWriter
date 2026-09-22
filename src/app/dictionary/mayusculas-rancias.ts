/**
 * Mayúsculas rancias: las que deja un Shift trabado en pleno flujo de escritura
 * y que nada marca porque la palabra, en minúsculas, es correcta. Dos formas:
 *
 *  - `mayuscula-mezclada`: `LLOra`, `AEdan`, `YIRIel`, `QUieres` — dos o más
 *    mayúsculas al arranque seguidas de minúscula. Es la huella del Shift que
 *    se soltó tarde. Quedan afuera el plural de sigla (`AVs`, `CPUs`), el
 *    CamelCase (`HoloDrive`, `LaMoza`, `McKay`) y la grafía exacta del
 *    diccionario.
 *  - `mayuscula-corta`: `ME`, `YA`, `EL` — una funcional de 2–3 letras en
 *    ALL-CAPS (lista cerrada `CORTAS`, es + en) rodeada de minúsculas. Un grito
 *    (`¡YA!`, `NOW!`, `—¡NO ME TOQUES!`) no se marca: va pegado a `!`/`?` o
 *    sus vecinas también están en mayúsculas. Tampoco la que cuelga de un
 *    guion (`G-VI`). Las siglas (`ARS`, `RC`) quedan afuera por no estar en la
 *    lista, sin mirar el diccionario.
 *
 * ALL-CAPS de una palabra de contenido (`—¡AEDAN!`) es un grito y no se toca.
 * Una sola letra nunca se marca (`A veces`, `I` en inglés).
 *
 * Medido sobre el corpus del autor el 2026-09-22 (597 capítulos): la regla
 * "minúscula en el texto, Capitalizada en el diccionario" (`aedan` vs `Aedan`)
 * daba 762 hits y todos falsos — el diccionario guarda `Ignician`, `Magus`,
 * `Hombrelobo` con mayúscula y el texto los usa en minúscula a propósito. La
 * grafía del diccionario no es canónica, así que esa regla no existe.
 *
 * Lleva `autoFix` con la sugerencia para que el popover del editor la aplique
 * con un click. Nunca en bulk: el modal «Revisar libro» no incluye estas
 * violaciones y el panel de auditoría solo lista y salta ("nunca nada
 * automático" = cada arreglo es una decisión del autor, no que no haya botón).
 *
 * Función pura; `scripts/run-mayusculas-smoke.mjs`.
 */
import { RaeViolation } from '../core/types';

const PALABRA_RE = /\p{L}+/gu;

/** Funcionales de 2–3 letras que un Shift trabado deja en mayúsculas. es + en. */
const CORTAS = new Set<string>([
  // es
  'el', 'la', 'lo', 'los', 'las', 'un', 'una', 'me', 'te', 'se', 'le', 'les',
  'nos', 'os', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'yo', 'tú', 'él', 'que',
  'qué', 'de', 'del', 'al', 'en', 'con', 'por', 'sin', 'no', 'ya', 'sí', 'si',
  'ni', 'es', 'fue', 'son', 'era', 'ser', 'hay', 'ha', 'he', 'has', 'muy',
  'más', 'así', 'tan', 'ay', 'eh', 'oh', 'ah', 'uy', 'vos', 'voy', 'va',
  'van', 'vas', 'ir', 'da', 'dan', 'das', 'ver', 'veo', 'ven', 'sé',
  'soy', 'sos', 'eso', 'esa', 'ese', 'aun', 'aún', 'hoy', 'mal',
  // en (sin `us`: `the US` es país; sin `vi`/`it` numeral romano y nombre)
  'the', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'but',
  'not', 'is', 'am', 'are', 'was', 'be', 'he', 'she', 'we', 'my',
  'you', 'his', 'her', 'its', 'our', 'do', 'did', 'had', 'so',
  'if', 'as', 'up', 'yes', 'yet', 'too', 'now', 'let', 'get', 'got',
]);

/** Run de 2+ mayúsculas al arranque y después minúscula: `LLOra`, `AEdan`. */
const ARRANQUE_RANCIO_RE = /^\p{Lu}{2,}\p{Ll}/u;
/** Plural de sigla: `AVs`, `CPUs`. */
const SIGLA_PLURAL_RE = /^\p{Lu}+s$/u;

/** Char no blanco que precede a un arranque de oración (o de diálogo). */
const CIERRE_RE = /[.!?…—«»"“”¡¿(]$/;

interface Token {
  raw: string;
  lower: string;
  offset: number;
  allCaps: boolean;
}

function tokenizar(plain: string): Token[] {
  const out: Token[] = [];
  for (const m of plain.matchAll(PALABRA_RE)) {
    const raw = m[0];
    out.push({
      raw,
      lower: raw.toLowerCase(),
      offset: m.index,
      allCaps: raw.length > 1 && raw === raw.toUpperCase() && raw !== raw.toLowerCase(),
    });
  }
  return out;
}

function arrancaOracion(plain: string, offset: number): boolean {
  const antes = plain.slice(0, offset).trimEnd();
  return antes.length === 0 || CIERRE_RE.test(antes);
}

function capitalizar(lower: string): string {
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function violacion(t: Token, ruleId: string, sugerencia: string): RaeViolation {
  return {
    offset: t.offset,
    length: t.raw.length,
    category: 'mayusculas',
    severity: 'warning',
    ruleId,
    message: `«${t.raw}» → «${sugerencia}»`,
    shortMessage: 'Mayúscula rancia',
    autoFix: { offset: t.offset, length: t.raw.length, replacement: sugerencia },
  };
}

export function detectMayusculasRancias(
  plain: string,
  dictWords: readonly string[],
): RaeViolation[] {
  const dict = new Map<string, string>();
  for (const w of dictWords) {
    const k = w.toLowerCase();
    if (!dict.has(k)) dict.set(k, w);
  }

  const tokens = tokenizar(plain);
  const out: RaeViolation[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.raw.length < 2) continue;
    const entry = dict.get(t.lower);
    if (entry === t.raw) continue;

    if (t.allCaps) {
      if (!CORTAS.has(t.lower)) continue; // grito de contenido o sigla
      const antes = plain[t.offset - 1] ?? '';
      const despues = plain.slice(t.offset + t.raw.length).trimStart()[0] ?? '';
      if (antes === '-' || despues === '-') continue; // `G-VI`
      if (despues === '!' || despues === '?') continue; // grito suelto: `¡YA!`, `NOW!`
      if (tokens[i - 1]?.allCaps || tokens[i + 1]?.allCaps) continue; // grito entero
      const sug = arrancaOracion(plain, t.offset) ? capitalizar(t.lower) : t.lower;
      out.push(violacion(t, 'mayuscula-corta', sug));
      continue;
    }

    if (ARRANQUE_RANCIO_RE.test(t.raw) && !SIGLA_PLURAL_RE.test(t.raw)) {
      out.push(violacion(t, 'mayuscula-mezclada', entry ?? capitalizar(t.lower)));
    }
  }

  return out;
}
