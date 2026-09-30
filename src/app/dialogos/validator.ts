/**
 * Validador de raya para diálogos en español. Detecta violaciones de la regla DPD
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
import { RayaCategory, RayaViolation } from '../core/types';

// Escapes Unicode explícitos: si el archivo se vuelve a guardar bajo un encoding
// raro, los smart quotes literales (« » " " ' ') pueden colarse como ASCII y
// dejar el normalizador sin efecto → falso positivo `pending-conversion` para
// cualquier párrafo narrativo con apóstrofe tipográfico (ej. "Anar's rest").
const QUOTE_NORM_RE = /[«»“”]/g;
const SINGLE_QUOTE_NORM_RE = /[‘’]/g;

export function normalizeQuotesForCompare(text: string): string {
  return text.replace(QUOTE_NORM_RE, '"').replace(SINGLE_QUOTE_NORM_RE, "'");
}

function categoryFor(ruleId: string): RayaCategory {
  switch (ruleId) {
    case 'dash-short':
    case 'space-after-open':
    case 'space-before-verb':
    case 'double-space':
    case 'opening-dash':
    case 'closing-dash':
      return 'char';
    case 'dash-orphan':
    case 'dash-quote-mix':
    case 'paragraph-collapsed':
      return 'structure';
    case 'verb-capitalized':
    case 'period-before-verb':
    case 'double-period':
    case 'inciso-case':
      return 'typo';
    default:
      return 'structure';
  }
}

/** Qué párrafos del plano no son prosa (verso, títulos), por su offset de
 *  inicio: `validateRaya` no los mira. Un verso entre comillas o un título
 *  `«Uno»` no son diálogos a convertir. */
export type SkipParagraph = (offset: number) => boolean;

export function validateRaya(
  plain: string,
  lang: string | null,
  skip?: SkipParagraph,
): RayaViolation[] {
  if (lang !== 'es') return [];
  if (!plain.trim()) return [];

  const out: RayaViolation[] = [];
  const paragraphs = plain.split('\n\n');
  let offset = 0;

  for (const para of paragraphs) {
    if (para.trim() && !skip?.(offset)) {
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
  out: RayaViolation[],
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
      'Diálogo con comillas o guiones en vez de raya. Aplicá las reglas de raya ' +
      'para convertirlo a raya (—).',
    shortMessage: 'Conversión pendiente',
    help: { entry: 'raya', section: '3.1', wrong: '"Hola", dijo Juan.', right: '—Hola —dijo Juan.' },
    autoFix: { offset, length: para.length, replacement: converted },
    paragraphRange: { offset, length: para.length },
  });
}

function pushDedicated(para: string, offset: number, out: RayaViolation[]): void {
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
            ...(v.autoFix.manual ? { manual: true } : {}),
          }
        : undefined,
      paragraphRange: { offset, length: para.length },
      ...(v.help ? { help: v.help } : {}),
    });
  }
}

export const P_BLOCK_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
const BR_RE = /<br\s*\/?>/i;
const TAG_RE = /<[^>]+>/g;

export const ENTITY_MAP: Record<string, string> = {
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

// `src/app/dialogos/plano-con-mapa.ts` replica esta función carácter por
// carácter, incluido el orden de las pasadas de entidades, para poder devolver
// además el mapa de posiciones al HTML. Si tocás algo acá — el recorrido de
// bloques, el trim, el orden de `ENTITY_MAP` — corré
// `node scripts/run-plano-con-mapa-smoke.mjs` (además de este archivo): si las
// dos se desalinean, los arreglos de raya se aplican en el lugar equivocado del
// HTML y en silencio.
export function htmlToPlain(html: string): string {
  return plainBlocks(html)
    .map((b) => b.text)
    .join('\n\n');
}

/** El `SkipParagraph` de un capítulo en HTML: los `<p>` adentro de un
 *  `<blockquote>` (verso) y el texto de los títulos. Mismo recorrido que
 *  `htmlToPlain`, así que los offsets son los de su plano. */
export function nonProseSkip(html: string): SkipParagraph {
  const skip = new Set<number>();
  let offset = 0;
  for (const b of plainBlocks(html)) {
    if (!b.prose) skip.add(offset);
    offset += b.text.length + 2;
  }
  return (o) => skip.has(o);
}

interface PlainBlock {
  text: string;
  prose: boolean;
}

const HEADING_RE = /<h[1-6]\b/i;
const BLOCKQUOTE_RE = /<blockquote\b[\s\S]*?<\/blockquote>/gi;

function plainBlocks(html: string): PlainBlock[] {
  const blocks: PlainBlock[] = [];
  const matches = Array.from(html.matchAll(P_BLOCK_RE));
  if (matches.length === 0) {
    pushIfText(blocks, html, !HEADING_RE.test(html));
    return blocks;
  }
  const verses = Array.from(html.matchAll(BLOCKQUOTE_RE), (m) => [
    m.index ?? 0,
    (m.index ?? 0) + m[0].length,
  ]);
  const inVerse = (at: number): boolean => verses.some(([from, to]) => at > from && at < to);
  let last = 0;
  for (const m of matches) {
    const start = m.index ?? 0;
    const between = html.slice(last, start);
    pushIfText(blocks, between, !HEADING_RE.test(between));
    pushIfText(blocks, m[1], !inVerse(start));
    last = start + m[0].length;
  }
  const tail = html.slice(last);
  pushIfText(blocks, tail, !HEADING_RE.test(tail));
  return blocks;
}

function pushIfText(blocks: PlainBlock[], chunk: string, prose: boolean): void {
  if (!chunk) return;
  const parts = chunk.split(BR_RE);
  for (const p of parts) {
    const text = stripInline(p).trim();
    if (text) blocks.push({ text, prose });
  }
}

function stripInline(html: string): string {
  let text = html.replace(TAG_RE, '');
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    text = text.split(entity).join(char);
  }
  return text;
}
