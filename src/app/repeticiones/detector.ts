/**
 * Detector de repeticiones cercanas. Función pura: sin DOM, sin ProseMirror,
 * sin `@tiptap/core`, para que entre en un smoke runner de node.
 *
 * LanguageTool solo marca duplicados literales pegados (`la nave nave`), y eso
 * en los dos idiomas. La repetición que molesta al leer una novela es la que
 * pasa a unas palabras de distancia, y ese agujero se tapa acá.
 *
 * Spec: docs/superpowers/specs/2026-08-20-detector-repeticiones-design.md
 */
import { DIALOG_TAGS } from '../dialogos/tags';
import { Repeticion } from '../core/types';

export interface OpcionesRepeticion {
  /** Distancia máxima en palabras entre apariciones para que cuenten juntas. */
  ventana: number;
  /** Apariciones dentro de la ventana necesarias para marcar. */
  minApariciones: number;
  /** Distancia bajo la cual 2 apariciones ya alcanzan (repetición pegada). */
  ventanaCorta: number;
  /** Largo mínimo de palabra a considerar. */
  largoMinimo: number;
  /** Nombres propios del mundo, del diccionario per-saga. Se normalizan acá. */
  ignorar: Iterable<string>;
}

export const DEFAULTS: Omit<OpcionesRepeticion, 'ignorar'> = {
  ventana: 40,
  minApariciones: 3,
  ventanaCorta: 5,
  // 4 y no 5: con 5 se caen `nave`, `dark`, `mano`, `casa` — justo los
  // sustantivos repetidos que se quieren ver. El ruido funcional lo cortan las
  // stopword lists, que es su trabajo; el largo mínimo solo saca el resto.
  largoMinimo: 4,
};

/** Minúsculas + sin diacríticos. El diccionario per-saga llega en minúscula
 *  pero CON diacríticos (`sagaCtx.isInDictionary` solo hace `toLowerCase`),
 *  así que se normaliza acá adentro en vez de confiar en quien llama. */
export function normalizar(palabra: string): string {
  return palabra
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function setNormalizado(palabras: Iterable<string>): Set<string> {
  const s = new Set<string>();
  for (const p of palabras) s.add(normalizar(p));
  return s;
}

// Funcionales largas: las cortas ya las tapa `largoMinimo`, así que acá solo
// van las que sobreviven a ese filtro y aun así no son palabras de contenido.
const STOPWORDS_ES = setNormalizado([
  'pues', 'ante', 'cada', 'algo', 'nada', 'todo', 'toda', 'ella', 'ellos',
  'ellas', 'esto', 'esos', 'esas', 'este', 'esta', 'muy', 'más', 'bien',
  'porque', 'cuando', 'aunque', 'entonces', 'también', 'tampoco', 'después',
  'antes', 'mientras', 'todavía', 'siempre', 'nunca', 'donde', 'sobre',
  'desde', 'hasta', 'entre', 'contra', 'durante', 'según', 'aquel', 'aquella',
  'aquello', 'aquellos', 'aquellas', 'estos', 'estas', 'esos', 'esas', 'este',
  'esta', 'eso', 'esto', 'algo', 'nada', 'todo', 'toda', 'todos', 'todas',
  'alguien', 'nadie', 'alguna', 'algunas', 'alguno', 'algunos', 'otra',
  'otras', 'otro', 'otros', 'mismo', 'misma', 'mismos', 'mismas', 'tanto',
  'tanta', 'tantos', 'tantas', 'menos', 'nuestro', 'nuestra', 'suyo', 'suya',
  'quien', 'quienes', 'cual', 'cuales', 'como', 'para', 'pero', 'sino',
  'estaba', 'estaban', 'había', 'habían', 'tenía', 'tenían', 'hacia',
  'haber', 'ser', 'era', 'eran', 'fue', 'fueron',
  // Auxiliares y modales de alta frecuencia. Sobreviven a `largoMinimo` y son
  // el grueso del ruido medido contra prosa real: `tengo`, `pudo`, `podía`.
  'tengo', 'tiene', 'tienes', 'tenés', 'tienen', 'tuvo', 'puede', 'puedo',
  'pudo', 'podía', 'podían', 'podés', 'quiero', 'quiere', 'quería', 'sabía',
  'sabe', 'sabés', 'está', 'están', 'estás', 'estoy', 'sido', 'siendo',
  'hacer', 'hacía', 'hizo', 'hace', 'decir', 'vamos', 'iba', 'iban',
  'debía', 'debe', 'parecía', 'parece',
]);

const STOPWORDS_EN = setNormalizado([
  'they', 'them', 'then', 'than', 'that', 'this', 'with', 'from', 'were',
  'been', 'have', 'what', 'when', 'just', 'only', 'such', 'some', 'more',
  'very', 'much', 'into', 'over', 'back', 'down', 'like', 'well', 'once',
  'because', 'through', 'though', 'although', 'should', 'would', 'could',
  'there', 'their', 'these', 'those', 'which', 'where', 'while', 'about',
  'after', 'before', 'again', 'still', 'other', 'another', 'something',
  'someone', 'anything', 'nothing', 'everything', 'everyone', 'really',
  'almost', 'maybe', 'never', 'always', 'until', 'without', 'between',
  'against', 'during', 'around', 'behind', 'himself', 'herself', 'itself',
  'themselves', 'myself', 'yourself', 'having', 'being', 'doing', 'going',
  'would', 'might', 'must', 'even', 'than', 'that', 'this',
  // Los equivalentes ingleses del mismo ruido: alta frecuencia, 4+ chars.
  'your', 'yours', 'will', 'know', 'knew', 'want', 'need', 'think',
  'thought', 'thing', 'things', 'look', 'looked', 'come', 'came', 'take',
  'took', 'make', 'made', 'right', 'okay', 'yeah', 'gonna', 'kind', 'sort',
  'time', 'good', 'here', 'seem', 'seemed', 'felt', 'feel',
]);

const DICENDI_ES = setNormalizado(DIALOG_TAGS);

/** El equivalente inglés no existe en el repo: `dialogos/tags.ts` es del
 *  validador RAE y es español-only por diseño. Lista mínima propia. */
const DICENDI_EN = setNormalizado([
  'said', 'says', 'asked', 'asks', 'replied', 'replies', 'answered',
  'answers', 'whispered', 'whispers', 'shouted', 'shouts', 'muttered',
  'mutters', 'murmured', 'murmurs', 'added', 'adds', 'yelled', 'screamed',
  'growled', 'sighed', 'repeated', 'continued', 'explained',
]);

/** Nexos que delatan una construcción hecha, no un descuido: `cuerpo a
 *  cuerpo`, `cara a cara`, `poco a poco`, `side by side`, `day after day`.
 *  Se miran solo cuando las dos apariciones están pegadísimas. */
const NEXO_CONSTRUCCION = new Set([
  'a', 'de', 'por', 'con', 'en', 'tras', 'y', 'o', 'ni',
  'to', 'by', 'and', 'or', 'after', 'on', 'for',
]);

/** Fin de oración: si entre dos palabras hay uno de estos, la que sigue
 *  arranca oración y su mayúscula no prueba nada. La raya cuenta porque un
 *  turno de diálogo también arranca oración. */
const CORTE_ORACION = /[.?!…:;—\n]/;

interface Token {
  /** Forma normalizada. */
  norm: string;
  /** Offset global en el texto plano del capítulo. */
  offset: number;
  length: number;
  /** Índice en la secuencia de palabras del párrafo (todas, sin filtrar). */
  idx: number;
  /** Arranca oración: descarta la heurística de nombre propio. */
  inicioOracion: boolean;
  /** Primera letra en mayúscula. */
  capitalizado: boolean;
}

const PALABRA_RE = /\p{L}+/gu;

function tokenizar(parrafo: string, base: number): Token[] {
  const tokens: Token[] = [];
  let idx = 0;
  let finPrevio = 0;
  for (const m of parrafo.matchAll(PALABRA_RE)) {
    const raw = m[0];
    const start = m.index;
    const separador = parrafo.slice(finPrevio, start);
    tokens.push({
      norm: normalizar(raw),
      offset: base + start,
      length: raw.length,
      idx,
      inicioOracion: idx === 0 || CORTE_ORACION.test(separador),
      capitalizado: raw[0] !== raw[0].toLowerCase(),
    });
    finPrevio = start + raw.length;
    idx += 1;
  }
  return tokens;
}

/**
 * Devuelve las repeticiones del texto plano, ordenadas por offset.
 *
 * La ventana NO cruza párrafo: el plano viene de `extractPlainText`, que separa
 * bloques con `\n\n`, y cada bloque se analiza solo. Es el recorte de densidad
 * más grande que sale gratis, y es el caso que molesta al leer.
 *
 * ponytail: match exacto sobre la forma normalizada — `oscura` no matchea con
 * `oscuro` ni `corrió` con `correr`. El upgrade path es un stemmer liviano de
 * español, si la calibración muestra que los casos perdidos importan. No se
 * suma FreeLing ni spaCy para esto.
 */
export function detectRepeticiones(
  plain: string,
  lang: 'es' | 'en',
  opts: OpcionesRepeticion,
): Repeticion[] {
  const stopwords = lang === 'es' ? STOPWORDS_ES : STOPWORDS_EN;
  const dicendi = lang === 'es' ? DICENDI_ES : DICENDI_EN;
  const ignorar = setNormalizado(opts.ignorar);
  const hits: Repeticion[] = [];

  let base = 0;
  for (const parrafo of plain.split('\n\n')) {
    const tokens = tokenizar(parrafo, base);
    base += parrafo.length + 2; // el separador `\n\n` que se comió el split

    // Las cinco capas de exclusión. Sin esto el detector marca todo: el
    // prototipo crudo tiró 6.095 hits en 59 KB.
    const candidatos = tokens.filter(
      (t) =>
        t.norm.length >= opts.largoMinimo &&
        !stopwords.has(t.norm) &&
        !dicendi.has(t.norm) &&
        !ignorar.has(t.norm) &&
        // Capitalizado mid-oración = nombre propio del mundo, esté o no en el
        // diccionario per-saga. Que `Kallai` se repita es normal.
        !(t.capitalizado && !t.inicioOracion),
    );

    const porForma = new Map<string, Token[]>();
    for (const t of candidatos) {
      const previas = porForma.get(t.norm);
      if (previas === undefined) {
        porForma.set(t.norm, [t]);
        continue;
      }
      previas.push(t);
      const i = previas.length - 1;
      const previa = previas[i - 1];
      const distancia = t.idx - previa.idx;
      if (distancia > opts.ventana) continue;

      // `cuerpo a cuerpo` no es un descuido. Con las dos apariciones separadas
      // por un solo nexo, la repetición es la construcción misma.
      if (distancia === 2) {
        const medio = tokens[previa.idx + 1];
        if (medio !== undefined && NEXO_CONSTRUCCION.has(medio.norm)) continue;
      }

      // Cuántas apariciones caen en la ventana que termina en esta.
      let apariciones = 1;
      for (let j = i - 1; j >= 0 && t.idx - previas[j].idx <= opts.ventana; j -= 1) {
        apariciones += 1;
      }
      // Umbral: `minApariciones` en la ventana, o dos pegadas. La excepción por
      // distancia corta es la que cubre `oscura, oscura como el vacío`, que son
      // dos nomás.
      if (apariciones < opts.minApariciones && distancia > opts.ventanaCorta) continue;

      hits.push({
        offset: t.offset,
        length: t.length,
        palabra: t.norm,
        offsetPrevio: previa.offset,
        distancia,
        apariciones,
      });
    }
  }

  return hits.sort((a, b) => a.offset - b.offset);
}
