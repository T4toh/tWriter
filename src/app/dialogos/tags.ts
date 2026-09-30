/**
 * Verbos dicendi reconocidos. La base vino de dialogos_a_esp/src/rules.py
 * (deprecado); lo que sigue a `aportó` se sumó con el corpus de borradores
 * (`scripts/run-raya-corpus-smoke.mjs`).
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
  'masculló', 'masculla', 'mascullaron', 'mascullan',
  'advirtió', 'advierte', 'advirtieron', 'advierten',
  'espetó', 'espeta', 'espetaron', 'espetan',
  'musitó', 'musita', 'musitaron', 'musitan',
  'confesó', 'confiesa', 'confesaron', 'confiesan',
  'inquirió', 'inquiere', 'inquirieron', 'inquieren',
  'farfulló', 'farfulla', 'farfullaron', 'farfullan',
  'siseó', 'sisea', 'sisearon', 'sisean',
  'rezongó', 'rezonga', 'rezongaron', 'rezongan',
  'gruñó', 'gruñe', 'gruñeron', 'gruñen',
  'admitió', 'admite', 'admitieron', 'admiten',
  'reconoció', 'reconoce', 'reconocieron', 'reconocen',
  'prometió', 'promete', 'prometieron', 'prometen',
  'anunció', 'anuncia', 'anunciaron', 'anuncian',
  'avisó', 'avisa', 'avisaron', 'avisan',
  'aclaró', 'aclara', 'aclararon', 'aclaran',
  'concluyó', 'concluye', 'concluyeron', 'concluyen',
  'interrumpió', 'interrumpe', 'interrumpieron', 'interrumpen',
  'objetó', 'objeta', 'objetaron', 'objetan',
  'bromeó', 'bromea', 'bromearon', 'bromean',
  'repitió', 'repite', 'repitieron', 'repiten',
  // Sin presente: `protesta` es sustantivo.
  'protestó', 'protestaron',
  // Primera persona (narrador protagonista).
  'dije', 'pregunté', 'respondí', 'contesté', 'murmuré', 'susurré', 'grité',
  'exclamé', 'añadí', 'agregué', 'repuse', 'repliqué', 'insistí', 'expliqué',
  'mascullé', 'advertí', 'confesé', 'repetí',
  // Imperfecto.
  'decía', 'decían', 'preguntaba', 'preguntaban', 'respondía', 'respondían',
  'contestaba', 'contestaban', 'murmuraba', 'murmuraban', 'susurraba',
  'susurraban', 'gritaba', 'gritaban', 'exclamaba', 'añadía', 'agregaba',
  'insistía', 'explicaba', 'repetía', 'mascullaba',
  // Enclíticos (registro arcaizante).
  'díjole', 'preguntóle', 'respondióle',
];

const TAGS_SET = new Set(DIALOG_TAGS.map((t) => t.toLowerCase()));

/** Verbos de la lista que también son de acción: `—No se moleste. —Negó con
 *  la cabeza.` es la acción del DPD 2.3d (punto y mayúscula), no un dicendi mal
 *  puntuado. En mayúscula no se pueden corregir solos. */
export const AMBIGUOUS_TAGS: ReadonlySet<string> = new Set([
  'negó', 'niega', 'negaron', 'niegan',
  'señaló', 'señala', 'señalaron', 'señalan',
  'indicó', 'indica', 'indicaron', 'indican',
  'pidió', 'pide', 'pidieron', 'piden',
  'ordenó', 'ordena', 'ordenaron', 'ordenan',
  'continuó', 'continúa', 'continuaron', 'continúan',
  'aportó', 'aporta', 'aportaron', 'aportan',
  'sollozó', 'solloza', 'sollozaron', 'sollozan',
  'gimió', 'gime', 'gimieron', 'gimen',
]);

export function isDialogTag(word: string): boolean {
  return TAGS_SET.has(word.toLowerCase());
}

export const TAGS_ALT = DIALOG_TAGS.join('|');

/** Dicendi con un clítico adelante opcional (`le dijo`, `me preguntó`) o en
 *  perífrasis (`volvió a decir`). Sin grupo de captura propio: va adentro del
 *  grupo del que lo usa. */
export const TAG_PHRASE =
  `(?:(?:me|te|le|les|nos|os|se|lo|la|los|las)\\s+)?` +
  `(?:(?:volvió|volvía|vuelve|volví)\\s+a\\s+(?:decir|preguntar|repetir|gritar|insistir)|${TAGS_ALT})`;
