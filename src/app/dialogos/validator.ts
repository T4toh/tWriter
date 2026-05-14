/**
 * Validador RAE para diálogos en español. Detecta violaciones de la regla DPD
 * de diálogos sobre texto YA escrito — tanto texto sin convertir como texto
 * convertido pero mal parseado por versiones anteriores del converter.
 *
 * Estrategia híbrida:
 *  1. Diff-based: corre `convert()` sobre cada párrafo; si el output difiere
 *     significativamente del input (más allá de la normalización de comillas),
 *     emite `pending-conversion` con autoFix = output del converter.
 *  2. Reglas dedicadas: pasada regex sobre cada párrafo para detectar guion
 *     incorrecto, raya huérfana, mezcla raya/comilla, párrafo colapsado,
 *     tipografía RAE.
 *
 * Trabaja sobre TEXTO PLANO. La extracción HTML→plain vive en el caller
 * (editor usa `extractPlainText` de ProseMirror, batch usa `htmlToPlain`).
 *
 * Ground truth: https://www.rae.es/dpd/raya
 */
import { convert } from './converter';
import { runDedicatedRules } from './rules-dedicated';
import { RaeCategory, RaeViolation } from '../core/types';

// Escapes Unicode explícitos: si el archivo se vuelve a guardar bajo un encoding
// raro, los smart quotes literales (« » " " ' ') pueden colarse como ASCII y
// dejar el normalizador sin efecto → falso positivo `pending-conversion` para
// cualquier párrafo narrativo con apóstrofe tipográfico (ej. "Anar's rest").
const QUOTE_NORM_RE = /[«»“”]/g;
const SINGLE_QUOTE_NORM_RE = /[‘’]/g;

function normalizeQuotesForCompare(text: string): string {
  return text.replace(QUOTE_NORM_RE, '"').replace(SINGLE_QUOTE_NORM_RE, "'");
}

function categoryFor(ruleId: string): RaeCategory {
  switch (ruleId) {
    case 'dash-short':
    case 'space-after-open':
    case 'space-before-verb':
      return 'char';
    case 'dash-orphan':
    case 'dash-quote-mix':
    case 'paragraph-collapsed':
      return 'structure';
    case 'verb-capitalized':
    case 'period-before-verb':
      return 'typo';
    default:
      return 'structure';
  }
}

export function validateRae(plain: string, lang: string | null): RaeViolation[] {
  if (lang !== 'es') return [];
  if (!plain.trim()) return [];

  const out: RaeViolation[] = [];
  const paragraphs = plain.split('\n\n');
  let offset = 0;

  for (const para of paragraphs) {
    if (para.trim()) {
      pushPendingConversion(para, offset, out);
      pushDedicated(para, offset, out);
    }
    offset += para.length + 2;
  }

  return out;
}

function pushPendingConversion(
  para: string,
  offset: number,
  out: RaeViolation[],
): void {
  const converted = convert(para).text;
  if (converted === para) return;
  const normalizedInput = normalizeQuotesForCompare(para);
  if (converted === normalizedInput) return;
  out.push({
    offset,
    length: para.length,
    category: 'pending-conversion',
    severity: 'warning',
    ruleId: 'pending-conversion',
    message:
      'Diálogo con comillas detectado. Aplicá las reglas RAE para convertir ' +
      'a raya (—).',
    shortMessage: 'Conversión pendiente',
    autoFix: { offset, length: para.length, replacement: converted },
    paragraphRange: { offset, length: para.length },
  });
}

function pushDedicated(para: string, offset: number, out: RaeViolation[]): void {
  for (const v of runDedicatedRules(para)) {
    out.push({
      offset: offset + v.offset,
      length: v.length,
      category: categoryFor(v.ruleId),
      severity: v.severity,
      ruleId: v.ruleId,
      message: v.message,
      shortMessage: v.shortMessage,
      autoFix: v.autoFix
        ? {
            offset: offset + v.autoFix.offset,
            length: v.autoFix.length,
            replacement: v.autoFix.replacement,
          }
        : undefined,
      paragraphRange: { offset, length: para.length },
    });
  }
}

const P_BLOCK_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
const BR_RE = /<br\s*\/?>/i;
const TAG_RE = /<[^>]+>/g;

const ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
};

export function htmlToPlain(html: string): string {
  const blocks: string[] = [];
  const matches = Array.from(html.matchAll(P_BLOCK_RE));
  if (matches.length === 0) {
    pushIfText(blocks, html);
    return blocks.join('\n\n');
  }
  let last = 0;
  for (const m of matches) {
    const start = m.index ?? 0;
    pushIfText(blocks, html.slice(last, start));
    pushIfText(blocks, m[1]);
    last = start + m[0].length;
  }
  pushIfText(blocks, html.slice(last));
  return blocks.join('\n\n');
}

function pushIfText(blocks: string[], chunk: string): void {
  if (!chunk) return;
  const parts = chunk.split(BR_RE);
  for (const p of parts) {
    const text = stripInline(p).trim();
    if (text) blocks.push(text);
  }
}

function stripInline(html: string): string {
  let text = html.replace(TAG_RE, '');
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    text = text.split(entity).join(char);
  }
  return text;
}
