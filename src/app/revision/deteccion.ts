import { convert } from '../dialogos/converter';
import { detectLang } from '../dialogos/detect';
import { htmlToPlain, validateRae } from '../dialogos/validator';
import { educateQuotes } from '../quotes/educate';
import {
  DEFAULTS as REP_DEFAULTS,
  detectRepeticiones,
  ExcepcionesDeliberadas,
} from '../repeticiones/detector';

export interface OpcionesDeteccion {
  /** Formas de repetición deliberada a filtrar (ver `repeticiones/detector.ts`). */
  excepciones: ExcepcionesDeliberadas;
  /** Nombres propios del diccionario de la saga, para que `repeticiones` no
   *  cuente contra el autor un nombre inventado que aparece varias veces. */
  diccionario: Iterable<string>;
}

export interface ResultadoDeteccionCapitulo {
  rayas: number;
  comillas: number;
  arreglosRae: number;
  repeticiones: number;
}

/**
 * Corre los cuatro detectores sobre UN capítulo. Pura: sin DOM, sin
 * `@tiptap/core`, sin Tauri — la comparten el escaneo (`revision-libro-service`)
 * y, en la Tarea 4, el apply; así el gateo de idioma vive en un solo lugar y no
 * se puede olvidar en una de las dos copias.
 *
 * `idioma` es el campo crudo persistido en el `.meta.json` del capítulo (puede
 * ser `null`/`undefined` si no está seteado) — NO el resultado de `detectLang`.
 */
export function detectarEnCapitulo(
  html: string,
  idioma: string | null | undefined,
  opts: OpcionesDeteccion,
): ResultadoDeteccionCapitulo {
  const idiomaEfectivo = idioma ?? detectLang(html);
  const esIngles = idiomaEfectivo === 'en';
  const plain = htmlToPlain(html);

  // Rayas: mismo gate que `canApplyRae` en editor.ts (`idioma !== 'en'`, sobre
  // el campo CRUDO — null/undefined siguen habilitados, igual que en el
  // editor). El converter no discrimina por su cuenta: la regla D1 convierte
  // cualquier párrafo que arranca con comilla a raya sin exigir verbo dicendi
  // español, y de paso `normalizeQuotes()` aplana las comillas tipográficas a
  // rectas — sin este gate, un capítulo en inglés con diálogo entre comillas
  // sale con rayas españolas y comillas rectas, corrupción real.
  const rayas = idioma !== 'en' ? convert(html).changes : 0;

  // Comillas: solo capítulos en inglés (efectivo, con fallback a detectLang si
  // no hay idioma seteado), igual que `quotes-fix-service`.
  const comillas = esIngles ? educateQuotes(html).changes : 0;

  // arreglosRae: `validateRae` ya se auto-gatea a `lang === 'es'` exacto, así
  // que capítulos en inglés o sin idioma detectado como 'es' quedan en 0 sin
  // gate adicional acá.
  const violaciones = validateRae(plain, idiomaEfectivo);
  const arreglosRae = violaciones.filter((v) => v.autoFix !== undefined).length;

  const reps = detectRepeticiones(plain, esIngles ? 'en' : 'es', {
    ...REP_DEFAULTS,
    excepciones: opts.excepciones,
    ignorar: opts.diccionario,
  });

  return { rayas, comillas, arreglosRae, repeticiones: reps.length };
}
