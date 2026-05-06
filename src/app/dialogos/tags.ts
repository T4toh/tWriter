/**
 * Verbos dicendi reconocidos. Ported 1:1 desde dialogos_a_esp/src/rules.py.
 */
export const DIALOG_TAGS: readonly string[] = [
  'dijo', 'dice', 'dijeron', 'dicen',
  'preguntó', 'pregunta', 'preguntaron', 'preguntan',
  'respondió', 'responde', 'respondieron', 'responden',
  'contestó', 'contesta', 'contestaron', 'contestan',
  'murmuró', 'murmura', 'murmuraron', 'murmuran',
  'susurró', 'susurra', 'susurraron', 'susurran',
  'gritó', 'grita', 'gritaron', 'gritan',
  'exclamó', 'exclama', 'exclamaron', 'exclaman',
  'añadió', 'añade', 'añadieron', 'añaden',
  'agregó', 'agrega', 'agregaron', 'agregan',
  'continuó', 'continúa', 'continuaron', 'continúan',
  'repuso', 'repone', 'repusieron', 'reponen',
  'replicó', 'replica', 'replicaron', 'replican',
  'insistió', 'insiste', 'insistieron', 'insisten',
  'afirmó', 'afirma', 'afirmaron', 'afirman',
  'negó', 'niega', 'negaron', 'niegan',
  'comentó', 'comenta', 'comentaron', 'comentan',
  'explicó', 'explica', 'explicaron', 'explican',
  'señaló', 'señala', 'señalaron', 'señalan',
  'indicó', 'indica', 'indicaron', 'indican',
  'mencionó', 'menciona', 'mencionaron', 'mencionan',
  'expresó', 'expresa', 'expresaron', 'expresan',
  'aseguró', 'asegura', 'aseguraron', 'aseguran',
  'declaró', 'declara', 'declararon', 'declaran',
  'manifestó', 'manifiesta', 'manifestaron', 'manifiestan',
  'sugirió', 'sugiere', 'sugirieron', 'sugieren',
  'propuso', 'propone', 'propusieron', 'proponen',
  'ordenó', 'ordena', 'ordenaron', 'ordenan',
  'pidió', 'pide', 'pidieron', 'piden',
  'rogó', 'ruega', 'rogaron', 'ruegan',
  'suplicó', 'suplica', 'suplicaron', 'suplican',
  'bramó', 'brama', 'bramaron', 'braman',
  'gimió', 'gime', 'gimieron', 'gimen',
  'sollozó', 'solloza', 'sollozaron', 'sollozan',
  'balbuceó', 'balbucea', 'balbucearon', 'balbucean',
  'tartamudeó', 'tartamudea', 'tartamudearon', 'tartamudean',
  'aportó', 'aporta', 'aportaron', 'aportan',
];

const TAGS_SET = new Set(DIALOG_TAGS.map((t) => t.toLowerCase()));

export function isDialogTag(word: string): boolean {
  return TAGS_SET.has(word.toLowerCase());
}

export const TAGS_ALT = DIALOG_TAGS.join('|');
