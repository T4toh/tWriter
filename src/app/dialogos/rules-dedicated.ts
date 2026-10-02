/**
 * Reglas dedicadas del validador de raya — patrones para texto YA convertido pero
 * mal parseado. El converter por sí solo no detecta estos casos porque "ya hay
 * raya" y considera el párrafo hecho.
 *
 * Cada regla recibe el TEXTO PLANO de un único párrafo (sin tags HTML) y
 * devuelve cero, una o más violaciones con offset/length relativos al inicio
 * del párrafo. El validator orchestrator suma el offset del párrafo dentro
 * del documento.
 */
import type { RayaHelp } from '../core/types';
import {
  ACTION_VERBS,
  AMBIGUOUS_TAGS,
  CLITICS,
  DIALOG_TAGS,
  NON_VERB_STARTS,
  TAG_PHRASE,
  TAGS_ALT,
} from './tags';

const EM_DASH = '—';

/** Ayuda de cada regla: sección del DPD y un par ✗/✓, casi siempre con los
 *  ejemplos del propio DPD. Ver `docs/raya.md`, la chuleta completa. */
const raya = (section: string, wrong?: string, right?: string): RayaHelp => ({
  entry: 'raya',
  section,
  wrong,
  right,
});
const HELP = {
  open: raya('3.1', '-Hola -dijo Juan.', '—Hola —dijo Juan.'),
  spaceOpen: raya('3.1', '— ¿Cuándo volverás?', '—¿Cuándo volverás?'),
  spaces: raya('§2', '—No sé— dijo Pedro.', '—No sé —dijo Pedro.'),
  lengua: raya('2.3c', '—¡Qué le vamos a hacer! —Exclamó doña Patro.', '—¡Qué le vamos a hacer! —exclamó doña Patro.'),
  periodLengua: raya('2.3c', '—Tranquilo, che. —advirtió el comisario.', '—Tranquilo, che —advirtió el comisario.'),
  narration: raya('2.3d', '—No se moleste. —cerró la puerta.', '—No se moleste. —Cerró la puerta.'),
  narrationPeriod: raya('2.3d', '—Hola, Roberto —sus manos temblaban.', '—Hola, Roberto. —Sus manos temblaban.'),
  resume: raya('2.3d', '—Me voy ya. —Se puso en pie. —No hace falta.', '—Me voy ya. —Se puso en pie—. No hace falta.'),
  mid: raya('2.3e', '—Solo nos queda esto —Le enseñó unos billetes— para el viaje.', '—Solo nos queda esto —le enseñó unos billetes— para el viaje.'),
  noClose: raya('2.3a', '—Espero que todo salga bien —dijo Azucena—.', '—Espero que todo salga bien —dijo Azucena.'),
  punctAfter: raya('2.3c', '—Está bien —dijo Carlos;— lo haré.', '—Está bien —dijo Carlos—; lo haré.'),
  colonAfter: raya('2.3f', '—me confesó, y añadió: —Conocí gente.', '—me confesó, y añadió—: Conocí gente.'),
  aside: raya('2.1', 'Esperaba a Emilio —un gran amigo. No vino.', 'Esperaba a Emilio —un gran amigo—. No vino.'),
  quoteMix: raya('2.3e', '—Esto que has hecho —gritó "es una locura."', '—Esto que has hecho —gritó— es una locura.'),
  collapsed: raya('3.1'),
  orphan: raya('2.3c', '—Hola. dijo Juan.', '—Hola —dijo Juan.'),
  glued: raya('§2', '—Hola—dijo Juan.', '—Hola —dijo Juan.'),
  spacesClose: raya('§2', '—Hola —dijo Juan —. ¿Venís?', '—Hola —dijo Juan—. ¿Venís?'),
  midPeriod: raya('2.3e', '—Solo nos queda esto. —le enseñó unos billetes— para el viaje.', '—Solo nos queda esto —le enseñó unos billetes— para el viaje.'),
  ellipsis: {
    entry: 'puntos suspensivos',
    section: '§1',
    wrong: '—Ya voy.. —dijo Ana.',
    right: '—Ya voy… —dijo Ana.',
  },
} satisfies Record<string, RayaHelp>;

export interface DedicatedViolation {
  offset: number;
  length: number;
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
  shortMessage: string;
  autoFix?: { offset: number; length: number; replacement: string; manual?: boolean };
  help?: RayaHelp;
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
      help: HELP.open,
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
const IMPERATIVE_OBJECTS = new Set(['tu', 'tus', 'eso', 'esto', 'aquello']);
// Posesivos de primera y segunda del plural: el narrador casi nunca cuenta en
// «nosotros», así que lo que arrancan es un objeto del que habla, no el sujeto
// de un inciso. Ej. `—Buenos días, Jony. Interrumpieron nuestros planes.`
// `mi`/`mis` NO van: «Preguntó mi hermana» es el narrador protagonista.
const PLURAL_POSSESSIVES = new Set([
  'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'vuestro', 'vuestra', 'vuestros', 'vuestras',
]);
// Lo que puede abrir el sujeto pospuesto de `dicen`. Si lo que sigue no es
// nada de esto (ni un nombre propio), `dicen` es el impersonal «la gente
// dice», y su complemento es lo dicho. Ej. `—…los duendes… Dicen pelotudeces
// en el pueblo.`
const SUBJECT_STARTS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'su', 'sus', 'mi', 'mis', 'tu', 'tus',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'aquel', 'aquella', 'aquellos', 'aquellas',
  'ellos', 'ellas', 'ustedes', 'todos', 'todas', 'ambos', 'ambas',
  'varios', 'varias', 'algunos', 'algunas', 'muchos', 'muchas', 'otros', 'otras',
  'dos', 'tres', 'cuatro', 'cinco',
]);

/** Los puntos suspensivos que terminan justo en `j`, como `…` o como `...`. */
function terminaEnSuspensivos(p: string, j: number): boolean {
  return p[j] === '…' || (p[j] === '.' && p[j - 1] === '.' && p[j - 2] === '.');
}

/** `true` si `i` cae adentro de una cita «…» o “…” sin cerrar todavía. Lo que
 *  está citado es texto de otro (una carta, un cartel, lo que dijo alguien), y
 *  ahí un `Dijo` después de punto no es un inciso del narrador (DPD comillas
 *  2a). Las rectas `"` no cuentan: en un párrafo con raya son conversión a
 *  medio hacer y ya las marca `dash-quote-mix`. */
function dentroDeCita(p: string, i: number): boolean {
  let angulares = 0;
  let inglesas = 0;
  for (let k = 0; k < i; k++) {
    const c = p[k];
    if (c === '«') angulares++;
    else if (c === '»') angulares = Math.max(0, angulares - 1);
    else if (c === '“') inglesas++;
    else if (c === '”') inglesas = Math.max(0, inglesas - 1);
  }
  return angulares > 0 || inglesas > 0;
}

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
    // Anti-falso-positivo 1c: después de los suspensivos, la minúscula dice
    // que el enunciado sigue (DPD puntos suspensivos §1): `solo… decía.` es
    // una oración, no un inciso. Después de `?`/`!` no vale: `—¿Nervioso?
    // preguntó su hermana.` es justamente la raya que falta.
    if (terminaEnSuspensivos(p, j) && m[0][0] === m[0][0].toLowerCase()) continue;
    // Anti-falso-positivo 1b: adentro de una cita, el punto y el verbo son del
    // texto citado. Ej. `—Me escribió: «No vengas. Dijo mamá que no.»`
    if (dentroDeCita(p, i)) continue;
    // Anti-falso-positivo 2: si la palabra siguiente al tag es subordinante
    // (que, si, cuando, porque…), el tag funciona como verbo reportativo del
    // hablante, no como dicendi. Ej. `Dicen que una mansión está encantada`
    // → speaker reporta lo que "dicen los otros", no es narrador-inciso.
    // Dicendi real lleva subject phrase: `Preguntó su hermana.`
    const after = p.slice(i + m[0].length).replace(/^\s+/, '');
    const nextWordMatch = after.match(/^([^\s.,;:!?]+)/);
    const nextWord = (nextWordMatch?.[1] ?? '').toLowerCase();
    if (SUBORDINATORS.has(nextWord)) continue;
    // Anti-falso-positivo 2b: el presente (`repite`, `pregunta`, `cuenta`) es
    // igual al imperativo de tú. Si lo que sigue es un posesivo de segunda
    // persona o un demostrativo neutro, ninguno puede ser el sujeto que habla:
    // es el personaje dando una orden. Ej. `—Se nota, mago. Repite tu
    // historia, viajera.`
    if (IMPERATIVE_OBJECTS.has(nextWord)) continue;
    if (PLURAL_POSSESSIVES.has(nextWord)) continue;
    // Anti-falso-positivo 2c: `dicen` impersonal. El nombre propio del sujeto
    // (`Dicen Ana y Luis`) se reconoce por la mayúscula.
    const nextIsProper = /^\p{Lu}/u.test(nextWordMatch?.[1] ?? '');
    if (m[0].toLowerCase() === 'dicen' && nextWord && !nextIsProper && !SUBJECT_STARTS.has(nextWord)) {
      continue;
    }
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
      help: HELP.orphan,
      severity: 'warning',
      message:
        `Verbo dicendi «${m[0]}» sin raya de cierre del diálogo previa. ` +
        `Esperaba «${EM_DASH}${m[0].toLowerCase()}».`,
      shortMessage: 'Raya huérfana',
    });
  }
  return out;
};

// Una comilla que abre un parlamento dentro de un párrafo con raya: al
// principio, tras un signo de puntuación o justo tras el verbo del inciso
// (`—gritó "es una locura."`). Una cita en medio del parlamento (`—Leí
// "Rayuela" anoche.`) es válida (DPD raya §4, comillas 2a).
const QUOTE_OPENS_SPEECH_RE = new RegExp(
  `(?:^|[.?!…;:,]|—(?:${TAG_PHRASE})(?:\\s+\\p{L}+){0,3})\\s*$`,
  'iu',
);

const ruleDashQuoteMix: Rule = (p) => {
  if (!p.includes(EM_DASH)) return [];
  const quoteMatch = [...p.matchAll(/["“”]/g)].find((q) =>
    QUOTE_OPENS_SPEECH_RE.test(p.slice(0, q.index)),
  );
  if (!quoteMatch) return [];
  return [
    {
      offset: quoteMatch.index,
      length: 1,
      ruleId: 'dash-quote-mix',
      help: HELP.quoteMix,
      severity: 'error',
      message:
        'Párrafo mezcla raya (—) y comilla doble ("). Indica conversión incompleta — ' +
        'corregí manualmente o aplicá las reglas de raya al párrafo.',
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
      help: HELP.collapsed,
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

// Una intervención arranca en mayúscula, signo de apertura, comilla o
// suspensivos. Raya + espacio + minúscula es un ítem de lista (DPD 3.2:
// `— expresiva,`), donde el espacio va.
const SPACE_AFTER_OPEN_RE = /^([\s]*)—([ \t]+)[\p{Lu}¿¡«"“…]/u;

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
      help: HELP.spaceOpen,
      severity: 'warning',
      message:
        'Sobra espacio entre la raya de apertura y el texto. La RAE pide raya ' +
        'pegada al primer carácter del diálogo.',
      shortMessage: 'Espacio sobrante',
      autoFix: { offset: spaceOffset, length: spaceLen, replacement: '' },
    },
  ];
};

const SPACE_BEFORE_VERB_RE = new RegExp(`(\\S)—(${TAG_PHRASE})(?!\\p{L})`, 'giu');

const ruleSpaceBeforeVerb: Rule = (p) => {
  const out: DedicatedViolation[] = [];
  for (const m of p.matchAll(SPACE_BEFORE_VERB_RE)) {
    const i = m.index ?? 0;
    out.push({
      offset: i + 1,
      length: 1,
      ruleId: 'space-before-verb',
      help: HELP.glued,
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
const VERB_CAPITAL_RE = /—\s?(\p{Lu}\p{L}*)(?:\s+(\p{L}+))?/gu;
const TAGS_LOWER_SET = new Set(DIALOG_TAGS.map((t) => t.toLowerCase()));

const ruleVerbCapitalized: Rule = (p) => {
  const out: DedicatedViolation[] = [];
  for (const m of p.matchAll(VERB_CAPITAL_RE)) {
    const word = m[1];
    // `—Le contestó`: el que va en mayúscula es el clítico, pero el que dice
    // si es verbo de lengua es el siguiente.
    // `La`/`Lo` en mayúscula son casi siempre artículo (`—La pregunta lo tomó
    // por sorpresa`), no clítico.
    const clitic = CLITICS.has(word.toLowerCase()) && !/^l[oa]s?$/i.test(word);
    const verb = (clitic ? m[2] ?? '' : word).toLowerCase();
    if (!TAGS_LOWER_SET.has(verb)) continue;
    // `—Hola —Pidió un café.` es una acción (le falta el punto, DPD 2.3d),
    // no un dicendi a bajar de caja.
    if (AMBIGUOUS_TAGS.has(verb)) continue;
    const dashOffset = m.index ?? 0;
    // Anti-falso-positivo 1: raya de APERTURA del párrafo (`—Dicen eso...`)
    // — la palabra es contenido del diálogo, no dicendi-tag post-close. Va
    // con mayúscula como cualquier inicio de oración.
    if (p.slice(0, dashOffset).trim() === '') continue;
    // Tras un punto simple (`. —Dijo`) sobran las dos cosas y
    // period-before-verb marca primero el punto. Tras `?`, `!` o suspensivos
    // el verbo de lengua va igual en minúscula (DPD 2.3c: `—¡Qué le vamos a
    // hacer! —exclamó`), así que ahí sí se marca.
    let j = dashOffset - 1;
    while (j >= 0 && /\s/.test(p[j])) j--;
    if (j >= 0 && p[j] === '.' && p[j - 1] !== '.') continue;
    const wordOffset = dashOffset + m[0].indexOf(word);
    out.push({
      offset: wordOffset,
      length: 1,
      ruleId: 'verb-capitalized',
      help: HELP.lengua,
      severity: 'warning',
      message:
        `«${word}» va en minúscula: el comentario del narrador que introduce un ` +
        'verbo de habla arranca en minúscula, aunque antes haya ? o !.',
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

// Solo el punto simple: los suspensivos (`—Bueno... —dijo`) se quedan antes
// del inciso, y un punto doble (`—Ya voy.. —dijo`) lo marca double-period.
// La coma (`—Hola, —dijo`) sobra igual.
const PERIOD_BEFORE_VERB_RE = new RegExp(
  `(?<!\\.)([.,])(\\s+)—(${TAG_PHRASE})(?!\\p{L})`,
  'giu',
);

const rulePeriodBeforeVerb: Rule = (p) => {
  const out: DedicatedViolation[] = [];
  for (const m of p.matchAll(PERIOD_BEFORE_VERB_RE)) {
    // `—No se moleste. —Negó con la cabeza.`: tras punto y en mayúscula, un
    // verbo que también es de acción es la acción del DPD 2.3d y está bien.
    const phrase = m[3];
    const words = phrase.toLowerCase().split(/\s+/);
    const verb = words[words.length - 1];
    if (phrase[0] !== phrase[0].toLowerCase()) {
      if (AMBIGUOUS_TAGS.has(verb)) continue;
      // En mayúscula tras punto, `—Te dije.`, `—Me dijo que la regañaste.` o
      // `—La pregunta…` son el personaje que retoma: primera o segunda
      // persona, artículo, o un «que» detrás. `—Le contestó` sí es inciso.
      if (words.length > 1 && !['le', 'les', 'se'].includes(words[0])) continue;
      const next = /^\s*(\p{L}+)/u.exec(p.slice((m.index ?? 0) + m[0].length))?.[1];
      if (next && /^(?:que|si)$/i.test(next)) continue;
    }
    const i = m.index ?? 0;
    const signo = m[1] === '.' ? 'Punto' : 'Coma';
    out.push({
      offset: i,
      length: 1,
      ruleId: 'period-before-verb',
      help: HELP.periodLengua,
      severity: 'warning',
      message:
        `${signo} antes de la raya del verbo de habla. Antes de un inciso con ` +
        'verbo de lengua no va punto ni coma.',
      shortMessage: `${signo} sobrante`,
      autoFix: { offset: i, length: 1, replacement: '' },
    });
  }
  return out;
};

// DPD «puntos suspensivos»: son tres «y solo tres» (§1) y tras ellos no va
// punto de cierre (§3.1). Dos puntos, o cuatro o más, son un error, y cuál de
// los dos quiso el autor (suspensivos o punto) no se puede saber: sin autoFix.
// Única excepción: detrás de una abreviatura se suma su punto y van cuatro
// (`pág....`, §3.1).
const DOUBLE_PERIOD_RE = /(?<!\.)(?:\.{2}|\.{4,})(?!\.)/g;
const ABBR_BEFORE_RE =
  /(?<!\p{L})(?:etc|págs?|Sra?|Srta|Dra?|Ud|Uds|núm|aprox|admón|cód|tel|ej)$/iu;

const ruleDoublePeriod: Rule = (p) =>
  [...p.matchAll(DOUBLE_PERIOD_RE)]
    .filter((m) => !(m[0].length === 4 && ABBR_BEFORE_RE.test(p.slice(0, m.index))))
    .map((m) => ({
      offset: m.index ?? 0,
      length: m[0].length,
      ruleId: 'double-period',
      help: HELP.ellipsis,
      severity: 'warning',
      message:
        `${m[0].length} puntos seguidos. Los suspensivos son tres y solo tres, ` +
        'sin punto después; si no, va uno, o ninguno antes de un verbo de habla.',
      shortMessage: 'Puntos de más',
    }));

/** Las rayas de un párrafo de diálogo después de la de apertura, con su papel
 *  por paridad: la primera abre un inciso, la segunda lo cierra, y así. */
function incisoDashes(p: string): { at: number; opens: boolean }[] {
  const open = /^\s*—/.exec(p);
  if (!open) return [];
  const out: { at: number; opens: boolean }[] = [];
  let opens = true;
  for (let i = p.indexOf(EM_DASH, open[0].length); i !== -1; i = p.indexOf(EM_DASH, i + 1)) {
    out.push({ at: i, opens });
    opens = !opens;
  }
  return out;
}

const PUNCT_AROUND_CLOSE = /[.,;:]/;

/** La raya que cierra un inciso: pegada a lo último del comentario, con la
 *  puntuación del enunciado interrumpido después (DPD raya 2.3c, 2.3f) y sin
 *  raya si el párrafo termina ahí (2.3a). */
const ruleClosingDash: Rule = (p) => {
  const out: DedicatedViolation[] = [];
  const push = (
    offset: number,
    length: number,
    message: string,
    replacement: string,
    help: RayaHelp,
    manual = false,
  ): void => {
    out.push({
      offset,
      length,
      ruleId: 'closing-dash',
      help,
      severity: 'warning',
      message,
      shortMessage: 'Raya de cierre',
      autoFix: { offset, length, replacement, ...(manual ? { manual } : {}) },
    });
  };
  for (const { at, opens } of incisoDashes(p)) {
    if (opens) continue;
    const before = p[at - 1] ?? '';
    const after = p[at + 1] ?? '';
    if (after === '.' && p.slice(at + 2).trim() === '') {
      push(at, 1, 'Si el personaje no sigue hablando, el inciso no lleva raya de cierre.', '', HELP.noClose);
    } else if (before === ' ' && PUNCT_AROUND_CLOSE.test(p[at - 2] ?? '') && /\S/.test(after)) {
      // `—dijo Pedro, —capaz` / `—añadió: —Conocí`: la puntuación quedó antes
      // y la raya pegada a lo que sigue.
      const signo = p[at - 2];
      const msg =
        `El «${signo}» va después de la raya de cierre: ` +
        `«—${signo}».`;
      // Tras un punto puede ser también otro hablante pegado en el mismo
      // párrafo, y ahí el arreglo es otro. Un párrafo es un hablante (DPD
      // 3.1), así que va en bloque salvo que el párrafo parezca colapsado:
      // ahí es dudoso y se ofrece de a uno (decisión del autor, 2026-10-02;
      // hasta entonces era siempre de a uno, y La Ciudad de las Luces tenía
      // 98 escritos así a mano).
      push(
        at - 2,
        3,
        signo === '.'
          ? `${msg} Si el que habla es otro personaje, va en párrafo aparte.`
          : msg,
        `${EM_DASH}${signo} `,
        signo === '.' ? HELP.resume : signo === ':' ? HELP.colonAfter : HELP.punctAfter,
        signo === '.' && ruleParagraphCollapsed(p).length > 0,
      );
    } else if (PUNCT_AROUND_CLOSE.test(before) && !(before === '.' && p[at - 2] === '.')) {
      push(
        at - 1,
        2,
        `El «${before}» va después de la raya de cierre: «—${before}».`,
        `${EM_DASH}${before}`,
        HELP.punctAfter,
      );
    } else if (before === ' ' && (PUNCT_AROUND_CLOSE.test(after) || after === ' ')) {
      push(at - 1, 1, 'La raya de cierre va pegada a la última palabra del inciso.', '', HELP.spacesClose);
    } else if (after === ' ' && PUNCT_AROUND_CLOSE.test(p[at + 2] ?? '')) {
      push(at + 1, 1, 'Entre la raya de cierre y la puntuación no va espacio.', '', HELP.spacesClose);
    } else if (/\p{Ll}/u.test(after)) {
      push(at + 1, 0, 'Después de la raya de cierre va un espacio antes de seguir.', ' ', HELP.spacesClose);
    }
  }
  return out;
};

/** La raya que abre un inciso: separada de lo anterior, pegada al comentario. */
const ruleOpeningDash: Rule = (p) => {
  const out: DedicatedViolation[] = [];
  for (const { at, opens } of incisoDashes(p)) {
    if (!opens) continue;
    const before = p[at - 1] ?? '';
    const spaces = /^[ \t]+/.exec(p.slice(at + 1))?.[0].length ?? 0;
    if (spaces === 0) continue;
    // `—No sé— dijo`: pegada a lo anterior y separada del comentario.
    const glued = /\S/.test(before);
    out.push({
      offset: glued ? at : at + 1,
      length: glued ? 1 + spaces : spaces,
      ruleId: 'opening-dash',
      help: HELP.spaces,
      severity: 'warning',
      message:
        'La raya que abre el comentario del narrador va separada de lo anterior ' +
        'y pegada a lo que sigue: «hola —dijo».',
      shortMessage: 'Raya de inciso',
      autoFix: glued
        ? { offset: at, length: 1 + spaces, replacement: ` ${EM_DASH}` }
        : { offset: at + 1, length: spaces, replacement: '' },
    });
  }
  return out;
};

const LENGUA_AT_RE = new RegExp(`^(?:${TAG_PHRASE})(?!\\p{L})`, 'iu');
const WORDS_RE = /^(\p{L}+)(?:\s+(\p{L}+))?/u;

/** Qué es el comentario que arranca en `i`: de lengua (`dijo`, `le dijo`,
 *  `Juan dijo`), narración segura (`sus manos`, `se levantó`, `golpeó`) o
 *  algo que no se puede saber (un verbo que no está en ninguna lista). */
function incisoKind(p: string, i: number): 'lengua' | 'narracion' | null {
  const rest = p.slice(i);
  const w = WORDS_RE.exec(rest);
  if (!w) return null;
  const w1 = w[1].toLowerCase();
  const w2 = (w[2] ?? '').toLowerCase();
  if (LENGUA_AT_RE.test(rest)) return 'lengua';
  if (w2 && LENGUA_AT_RE.test(rest.slice(w[1].length).trimStart())) return 'lengua';
  if (NON_VERB_STARTS.has(w1) || ACTION_VERBS.has(w1)) return 'narracion';
  if (CLITICS.has(w1) && ACTION_VERBS.has(w2)) return 'narracion';
  return null;
}

/** Caja del comentario del narrador que no lleva verbo de lengua (los de
 *  lengua los ven verb-capitalized y period-before-verb). A mitad del
 *  enunciado va en minúscula (DPD raya 2.3e); si no, el parlamento cierra con
 *  punto y el comentario arranca en mayúscula (2.3d). */
const ruleIncisoCase: Rule = (p) => {
  const out: DedicatedViolation[] = [];
  const dashes = incisoDashes(p);
  dashes.forEach(({ at, opens }, k) => {
    if (!opens || !/\p{L}/u.test(p[at + 1] ?? '')) return;
    if (incisoKind(p, at + 1) !== 'narracion') return;
    const first = p[at + 1];
    const close = dashes[k + 1];
    const mid = close !== undefined && /^(?:[,;:]|\s+\p{Ll})/u.test(p.slice(close.at + 1));
    let j = at - 1;
    while (j >= 0 && /\s/.test(p[j])) j--;
    const prev = p[j] ?? '';
    const push = (
      offset: number,
      length: number,
      replacement: string,
      message: string,
      help: RayaHelp,
    ): void => {
      out.push({
        offset,
        length,
        ruleId: 'inciso-case',
        help,
        severity: 'warning',
        message,
        shortMessage: 'Caja del inciso',
        autoFix: { offset, length, replacement },
      });
    };
    if (mid) {
      if (prev === '.' && p[j - 1] !== '.') {
        push(j, 1, '', 'El comentario queda a mitad del enunciado: sobra el punto.', HELP.midPeriod);
      } else if (first !== first.toLowerCase()) {
        push(at + 1, 1, first.toLowerCase(),
          'A mitad del enunciado el comentario del narrador va en minúscula.', HELP.mid);
      }
    } else if (/[.?!…]/.test(prev)) {
      if (first === first.toLowerCase()) {
        push(at + 1, 1, first.toUpperCase(),
          'Tras un enunciado completo, el comentario del narrador que no introduce ' +
          'palabras va en mayúscula.', HELP.narration);
      }
    } else {
      // `—Hola —sus manos…`: falta cerrar el parlamento con punto.
      const from = prev === ',' ? j : j + 1;
      push(from, at + 2 - from, `. ${EM_DASH}${first.toUpperCase()}`,
        'Cuando el narrador no introduce las palabras, el parlamento cierra con punto ' +
        'y el comentario arranca en mayúscula.', HELP.narrationPeriod);
    }
  });
  return out;
};

/** Espacio doble entre palabras o signos. */
const ruleDoubleSpace: Rule = (p) =>
  [...p.matchAll(/(?<=\S)[ \t]{2,}(?=\S)/g)].map((m) => ({
    offset: m.index ?? 0,
    length: m[0].length,
    ruleId: 'double-space',
    severity: 'warning',
    message: 'Espacio doble.',
    shortMessage: 'Espacio doble',
    autoFix: { offset: m.index ?? 0, length: m[0].length, replacement: ' ' },
  }));

/** Inciso entre rayas en la narración (no diálogo) al que le falta la de
 *  cierre: va aunque detrás siga un punto (DPD raya 2.1). No se sabe dónde
 *  termina el inciso, así que no hay arreglo. Las rayas tras dos puntos
 *  (`dijo: —Vení.`) o punto (teatro, `María.— ¿Dónde vas?`, 3.4) no cuentan. */
const ruleUnclosedAside: Rule = (p) => {
  if (/^\s*—/.test(p)) return [];
  const dashes = [...p.matchAll(/(?<![:.]\s*)—/g)];
  if (dashes.length % 2 === 0) return [];
  const last = dashes[dashes.length - 1];
  return [
    {
      offset: last.index ?? 0,
      length: 1,
      ruleId: 'unclosed-aside',
      help: HELP.aside,
      severity: 'warning',
      message:
        'Inciso entre rayas sin raya de cierre. Va aunque detrás siga un punto: ' +
        '«Esperaba a Emilio —un gran amigo—. No vino.».',
      shortMessage: 'Inciso sin cerrar',
    },
  ];
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
  ruleDoublePeriod,
  ruleClosingDash,
  ruleOpeningDash,
  ruleIncisoCase,
  ruleDoubleSpace,
  ruleUnclosedAside,
];

export function runDedicatedRules(paragraph: string): DedicatedViolation[] {
  const out: DedicatedViolation[] = [];
  for (const rule of RULES) {
    out.push(...rule(paragraph));
  }
  return out;
}
