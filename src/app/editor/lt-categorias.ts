/**
 * Título del popover de gramática según la categoría de LanguageTool. Sin
 * esto el título era el id de la regla (`MORFOLOGIK_RULE_ES`), que se lee como
 * una variable de entorno.
 *
 * Los ids salen de los `grammar.xml` de es y en de LT 6.8, más el enum
 * `Categories` del core que usan las reglas en Java. Los títulos van siempre en
 * español: la UI es en español aunque el capítulo esté en inglés. Lo que no
 * está acá (una categoría nueva de LT, `MISC`, `WIKIPEDIA`) cae en el genérico.
 */
const TITULOS: Readonly<Record<string, string>> = {
  TYPOS: 'Ortografía',
  MISSPELLING: 'Ortografía',
  MULTITOKEN_SPELLING: 'Ortografía',
  DIACRITICS: 'Tildes',
  DIACRITICS_EXPERIMENTAL: 'Tildes',
  GRAMMAR: 'Gramática',
  AGREEMENT_VERBS: 'Concordancia',
  AGREEMENT_NOUNS: 'Concordancia',
  PREPOSITIONS: 'Preposiciones',
  PUNCTUATION: 'Puntuación',
  TYPOGRAPHY: 'Tipografía',
  ACCURATE_TYPOGRAPHY: 'Tipografía',
  CASING: 'Mayúsculas',
  STYLE: 'Estilo',
  CREATIVE_WRITING: 'Estilo',
  TON_ACADEMIC: 'Estilo',
  PLAIN_ENGLISH: 'Estilo',
  REDUNDANCY: 'Redundancia',
  REDUNDANCIES: 'Redundancia',
  REPETITIONS: 'Repetición',
  REPETITIONS_STYLE: 'Repetición',
  CONFUSED_WORDS: 'Palabra confundida',
  CONFUSIONS: 'Palabra confundida',
  CONFUSIONS2: 'Palabra confundida',
  CONTEXT: 'Palabra confundida',
  SEMANTICS: 'Sentido',
  COLLOCATIONS: 'Combinación de palabras',
  COMPOUNDING: 'Palabras compuestas',
  INCORRECT_EXPRESSIONS: 'Expresión incorrecta',
  NONSTANDARD_PHRASES: 'Expresión incorrecta',
  PREFERABLE_EXPRESSIONS: 'Expresión preferible',
  PROPER_NOUNS: 'Nombre propio',
  LANGUAGE_VARIANTS: 'Variante regional',
  AMERICAN_ENGLISH: 'Variante regional',
  AMERICAN_ENGLISH_STYLE: 'Variante regional',
  BRITISH_ENGLISH: 'Variante regional',
  BRE_STYLE_OXFORD_SPELLING: 'Variante regional',
  REGIONALISMS: 'Variante regional',
  CAMBIOS_NORMA: 'Norma actualizada',
  FALSE_FRIENDS: 'Falso amigo',
  GENDER_NEUTRALITY: 'Lenguaje inclusivo',
};

export function tituloCategoria(categoria: string): string {
  return TITULOS[categoria] ?? 'Sugerencia';
}
