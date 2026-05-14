/**
 * Reglas dedicadas del validador RAE — patrones para texto YA convertido pero
 * mal parseado. El converter por sí solo no detecta estos casos porque "ya hay
 * raya" y considera el párrafo hecho.
 *
 * Cada regla recibe el TEXTO PLANO de un único párrafo (sin tags HTML) y
 * devuelve cero, una o más violaciones con offset/length relativos al inicio
 * del párrafo. El validator orchestrator suma el offset del párrafo dentro
 * del documento.
 */
import { DIALOG_TAGS, TAGS_ALT } from './tags';

const EM_DASH = '—';

export interface DedicatedViolation {
  offset: number;
  length: number;
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
  shortMessage: string;
  autoFix?: { offset: number; length: number; replacement: string };
}

type Rule = (paragraph: string) => DedicatedViolation[];

const DASH_OR_DOUBLE_HYPHEN = /^(\s*)(--|-{1}|–)(\s*)(\S)/u;

const ruleDashShort: Rule = (p) => {
  const m = DASH_OR_DOUBLE_HYPHEN.exec(p);
  if (!m) return [];
  const indentLen = m[1].length;
  const dashLen = m[2].length;
  const spaceLen = m[3].length;
  const firstChar = m[4];
  if (!/[A-ZÁÉÍÓÚÑ¿¡]/.test(firstChar)) return [];
  return [
    {
      offset: indentLen,
      length: dashLen + spaceLen,
      ruleId: 'dash-short',
      severity: 'error',
      message: `Usá raya em (${EM_DASH}, U+2014) para abrir diálogo, no guion ni en-dash.`,
      shortMessage: 'Guion incorrecto',
      autoFix: {
        offset: indentLen,
        length: dashLen + spaceLen,
        replacement: EM_DASH,
      },
    },
  ];
};

const TAG_WORD_RE = new RegExp(`(?<!\\p{L})(${TAGS_ALT})(?!\\p{L})`, 'giu');

const SENTENCE_END_RE = /[.?!…]/;
// Subordinantes y conjunciones frecuentes en español que indican que la palabra
// previa es verbo de habla en el contenido del diálogo (NO dicendi-inciso).
// Ej. `Dicen que una mansión está encantada` → `dicen` no es dicendi-tag,
// es verbo reportativo del speaker.
const SUBORDINATORS = new Set([
  'que', 'si', 'como', 'cuando', 'donde', 'mientras', 'aunque', 'porque',
  'pues', 'para', 'sin', 'tras', 'hacia', 'desde', 'según', 'sobre', 'dónde',
  'cuándo', 'cómo', 'cuánto', 'cuánta', 'cuántos', 'cuántas', 'quién',
  'quiénes', 'qué', 'cuál', 'cuáles',
]);

const ruleDashOrphan: Rule = (p) => {
  if (!/^[\s]*—/.test(p)) return [];
  const out: DedicatedViolation[] = [];
  for (const m of p.matchAll(TAG_WORD_RE)) {
    const i = m.index ?? 0;
    if (i === 0) continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(p[j])) j--;
    if (j < 0) continue;
    // Legítimo: la raya de cierre del inciso ya está antes (—dijo).
    if (p[j] === EM_DASH) continue;
    // Anti-falso-positivo 1: si el verbo NO viene después de sentence boundary
    // (`.?!…`), es un verbo regular dentro del contenido del diálogo, no un
    // dicendi-tag. Ej. `—Así le dicen al oro.` — `dicen` precedido por `le`.
    if (!SENTENCE_END_RE.test(p[j])) continue;
    // Anti-falso-positivo 2: si la palabra siguiente al tag es subordinante
    // (que, si, cuando, porque…), el tag funciona como verbo reportativo del
    // hablante, no como dicendi. Ej. `Dicen que una mansión está encantada`
    // → speaker reporta lo que "dicen los otros", no es narrador-inciso.
    // Dicendi real lleva subject phrase: `Preguntó su hermana.`
    const after = p.slice(i + m[0].length).replace(/^\s+/, '');
    const nextWordMatch = after.match(/^([^\s.,;:!?]+)/);
    const nextWord = (nextWordMatch?.[1] ?? '').toLowerCase();
    if (SUBORDINATORS.has(nextWord)) continue;
    // Anti-falso-positivo 3: el dicendi-inciso es típicamente corto
    // (`<tag> <sujeto>.` con ≤4 palabras entre el tag y el `.`). Si entre el
    // tag y el próximo sentence-end hay más palabras, es contenido del
    // speech, no inciso. Ej. `—Bueno… dicen bastantes estupideces sobre los
    // magos en las barracas, así que me imagino lo que debe pasar.` — entre
    // `dicen` y el `.` hay 15+ palabras, no es inciso.
    const tail = p.slice(i + m[0].length);
    const endMatch = tail.match(/[.?!…]/);
    if (!endMatch || endMatch.index === undefined) continue;
    const segment = tail.slice(0, endMatch.index).trim();
    const wordCount = segment ? segment.split(/\s+/).length : 0;
    if (wordCount > 4) continue;
    out.push({
      offset: i,
      length: m[0].length,
      ruleId: 'dash-orphan',
      severity: 'warning',
      message:
        `Verbo dicendi «${m[0]}» sin raya de cierre del diálogo previa. ` +
        `Esperaba «${EM_DASH}${m[0].toLowerCase()}».`,
      shortMessage: 'Raya huérfana',
    });
  }
  return out;
};

const ruleDashQuoteMix: Rule = (p) => {
  if (!p.includes(EM_DASH)) return [];
  const quoteMatch = /["“”]/.exec(p);
  if (!quoteMatch) return [];
  return [
    {
      offset: quoteMatch.index,
      length: 1,
      ruleId: 'dash-quote-mix',
      severity: 'error',
      message:
        'Párrafo mezcla raya (—) y comilla doble ("). Indica conversión incompleta — ' +
        'corregí manualmente o aplicá las reglas RAE al párrafo.',
      shortMessage: 'Mezcla raya/comilla',
    },
  ];
};

const TRANSITION_RE = /[.?!…]\s+—/gu;

const ruleParagraphCollapsed: Rule = (p) => {
  if (!p.includes(EM_DASH)) return [];
  let transitions = 0;
  for (const _m of p.matchAll(TRANSITION_RE)) transitions += 1;
  if (transitions < 3) return [];
  // Salvaguarda anti-falso-positivo: un único hablante con incisos múltiples
  // produce `.\s+—` transitions también (el `—verbo` post-inciso cuenta).
  // Un párrafo REALMENTE colapsado (varios turns pegados, caso Meridian 2.0)
  // tiene 3+ verbos dicendi distintos. Sin esta salvaguarda flagea monólogos
  // legítimos con 2 incisos como ej. `—¡Duendes! —gritó. —Todo apestaba
  // —agregó. —Resulta que...`.
  let verbCount = 0;
  for (const _m of p.matchAll(TAG_WORD_RE)) verbCount += 1;
  if (verbCount < 3) return [];
  return [
    {
      offset: 0,
      length: p.length,
      ruleId: 'paragraph-collapsed',
      severity: 'error',
      message:
        `Párrafo con ${verbCount} verbos dicendi y ${transitions + 1} segmentos ` +
        'de diálogo. La RAE pide un párrafo por cambio de hablante. Si es un ' +
        'solo hablante con varios incisos podés ignorar; si hay varios turns ' +
        'pegados, separá manualmente.',
      shortMessage: 'Posible párrafo colapsado',
    },
  ];
};

const SPACE_AFTER_OPEN_RE = /^([\s]*)—([ \t]+)\S/u;

const ruleSpaceAfterOpen: Rule = (p) => {
  const m = SPACE_AFTER_OPEN_RE.exec(p);
  if (!m) return [];
  const indentLen = m[1].length;
  const spaceLen = m[2].length;
  const spaceOffset = indentLen + 1;
  return [
    {
      offset: spaceOffset,
      length: spaceLen,
      ruleId: 'space-after-open',
      severity: 'warning',
      message:
        'Sobra espacio entre la raya de apertura y el texto. La RAE pide raya ' +
        'pegada al primer carácter del diálogo.',
      shortMessage: 'Espacio sobrante',
      autoFix: { offset: spaceOffset, length: spaceLen, replacement: '' },
    },
  ];
};

const SPACE_BEFORE_VERB_RE = new RegExp(`(\\S)—(${TAGS_ALT})(?!\\p{L})`, 'giu');

const ruleSpaceBeforeVerb: Rule = (p) => {
  const out: DedicatedViolation[] = [];
  for (const m of p.matchAll(SPACE_BEFORE_VERB_RE)) {
    const i = m.index ?? 0;
    out.push({
      offset: i + 1,
      length: 1,
      ruleId: 'space-before-verb',
      severity: 'warning',
      message: 'Falta espacio antes de la raya del verbo dicendi.',
      shortMessage: 'Espacio faltante',
      autoFix: { offset: i + 1, length: 0, replacement: ' ' },
    });
  }
  return out;
};

// `\w+` en JS es ASCII-only y NO matchea letras acentuadas (`Preguntó`,
// `Murmuró` se cortan en `Pregunt`/`Murmur` y nunca matchean DIALOG_TAGS).
// `\p{L}+` con flag `u` matchea letras Unicode.
const VERB_CAPITAL_RE = /—\s?(\p{Lu}\p{L}+)/gu;
const TAGS_LOWER_SET = new Set(DIALOG_TAGS.map((t) => t.toLowerCase()));

const ruleVerbCapitalized: Rule = (p) => {
  const out: DedicatedViolation[] = [];
  for (const m of p.matchAll(VERB_CAPITAL_RE)) {
    const word = m[1];
    if (!TAGS_LOWER_SET.has(word.toLowerCase())) continue;
    const dashOffset = m.index ?? 0;
    // Anti-falso-positivo 1: raya de APERTURA del párrafo (`—Dicen eso...`)
    // — la palabra es contenido del diálogo, no dicendi-tag post-close. Va
    // con mayúscula como cualquier inicio de oración.
    if (p.slice(0, dashOffset).trim() === '') continue;
    // Anti-falso-positivo 2: raya precedida por sentence-end (`. —Dicen`)
    // es apertura de nuevo segmento de speech, no cierre de inciso. La
    // palabra es contenido. (Si el `.` antes sobra, lo flaggea
    // period-before-verb separadamente.)
    let j = dashOffset - 1;
    while (j >= 0 && /\s/.test(p[j])) j--;
    if (j >= 0 && SENTENCE_END_RE.test(p[j])) continue;
    const wordOffset = dashOffset + m[0].length - word.length;
    out.push({
      offset: wordOffset,
      length: 1,
      ruleId: 'verb-capitalized',
      severity: 'warning',
      message:
        `Verbo dicendi «${word}» con mayúscula. La RAE pide minúscula tras la raya.`,
      shortMessage: 'Verbo capitalizado',
      autoFix: {
        offset: wordOffset,
        length: 1,
        replacement: word[0].toLowerCase(),
      },
    });
  }
  return out;
};

const PERIOD_BEFORE_VERB_RE = new RegExp(
  `(\\.)(\\s+)—(${TAGS_ALT})(?!\\p{L})`,
  'giu',
);

const rulePeriodBeforeVerb: Rule = (p) => {
  const out: DedicatedViolation[] = [];
  for (const m of p.matchAll(PERIOD_BEFORE_VERB_RE)) {
    const i = m.index ?? 0;
    out.push({
      offset: i,
      length: 1,
      ruleId: 'period-before-verb',
      severity: 'warning',
      message:
        'Punto antes de la raya del verbo dicendi. La RAE elimina el punto ' +
        'cuando hay verbo dicendi tras la raya de cierre.',
      shortMessage: 'Punto sobrante',
      autoFix: { offset: i, length: 1, replacement: '' },
    });
  }
  return out;
};

const RULES: readonly Rule[] = [
  ruleDashShort,
  ruleDashOrphan,
  ruleDashQuoteMix,
  ruleParagraphCollapsed,
  ruleSpaceAfterOpen,
  ruleSpaceBeforeVerb,
  ruleVerbCapitalized,
  rulePeriodBeforeVerb,
];

export function runDedicatedRules(paragraph: string): DedicatedViolation[] {
  const out: DedicatedViolation[] = [];
  for (const rule of RULES) {
    out.push(...rule(paragraph));
  }
  return out;
}
