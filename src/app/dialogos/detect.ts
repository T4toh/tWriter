/**
 * Heurística simple para detectar idioma de un capítulo.
 * Cuenta stop-words frecuentes de cada idioma y devuelve el ganador.
 */
const ES_STOPWORDS = new Set([
  'que', 'de', 'la', 'el', 'en', 'y', 'a', 'los', 'las', 'un', 'una',
  'es', 'se', 'no', 'por', 'con', 'su', 'para', 'al', 'lo', 'como',
  'más', 'pero', 'sus', 'le', 'ya', 'o', 'fue', 'este', 'ha', 'sí',
  'porque', 'esta', 'son', 'entre', 'cuando', 'muy', 'sin', 'sobre',
  'también', 'me', 'hasta', 'hay', 'dónde', 'quien', 'desde', 'todo',
  'nos', 'durante', 'estado', 'dijo', 'él', 'ella', 'ellos', 'nosotros',
  'tú', 'vos', 'usted', 'soy', 'eres', 'somos', 'están',
]);

const EN_STOPWORDS = new Set([
  'the', 'and', 'of', 'to', 'a', 'in', 'is', 'was', 'with', 'for',
  'on', 'as', 'by', 'that', 'be', 'this', 'are', 'from', 'or', 'an',
  'at', 'it', 'not', 'but', 'have', 'had', 'has', 'were', 'been',
  'their', 'they', 'them', 'his', 'her', 'she', 'he', 'we', 'you',
  'your', 'my', 'me', 'i', 'said', 'would', 'could', 'should',
  'about', 'which', 'when', 'where', 'who', 'what', 'why', 'how',
]);

export type Lang = 'es' | 'en';

export function detectLang(html: string): Lang {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ');
  const words = text.split(/\s+/).filter(Boolean).slice(0, 500);
  let es = 0;
  let en = 0;
  for (const w of words) {
    if (ES_STOPWORDS.has(w)) es++;
    if (EN_STOPWORDS.has(w)) en++;
  }
  return es >= en ? 'es' : 'en';
}
