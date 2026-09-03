import { convertFragmentHtml } from '../editor/rae-convert';
import { detectLang } from '../dialogos/detect';
import { htmlToPlain, validateRae } from '../dialogos/validator';
import { aplicarFixesHtml } from '../dialogos/aplicar-fixes';
import { educateQuotes } from '../quotes/educate';
import {
  DEFAULTS as REP_DEFAULTS,
  detectRepeticiones,
  ExcepcionesDeliberadas,
} from '../repeticiones/detector';
import { RaeAutoFix } from '../core/types';

/** Qué transformaciones aplicar. Repeticiones no está: no se auto-aplican,
 *  solo se listan para que el autor las revise a mano. */
export interface SeleccionRevision {
  rayas: boolean;
  comillas: boolean;
  arreglosRae: boolean;
}

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
  /** Idioma EFECTIVO (con fallback a `detectLang`) que se usó para gatear
   *  rayas/comillas/arreglosRae acá adentro. Lo expone el servicio de
   *  escaneo para contar capítulos por idioma sin re-derivarlo — el gateo
   *  vive en un solo lugar a propósito. */
  esIngles: boolean;
}

/**
 * Resuelve el idioma EFECTIVO de un capítulo. Cadena de tres niveles, en
 * este orden de prioridad:
 *
 *   1. `idiomaLibro` — el campo `idioma` de `book.json`. Si el libro lo
 *      declara, MANDA para todos sus capítulos, sin excepción, incluso si
 *      alguno trae un `idioma` distinto (o ninguno) en su `.meta.json`.
 *   2. `idiomaCapitulo` — el campo `idioma` del `.meta.json` del capítulo,
 *      cuando el libro no declaró nada.
 *   3. `detectLang(html)` — último recurso, solo cuando ni el libro ni el
 *      capítulo declararon idioma.
 *
 * Por qué el libro le gana al capítulo, y no al revés: las novelas de este
 * autor están escritas en UN idioma, a lo sumo con alguna cita, epígrafe o
 * diálogo suelto en otro. Un capítulo importado de `.docx` (que no trae
 * `idioma` en su `.meta.json`) con una cita larga en inglés adentro hacía
 * que `detectLang` lo clasificara 'en' entero — y ahí rayas se salteaba
 * (correcto para inglés) pero comillas tipográficas SÍ se le aplicaba,
 * metiéndole comillas inglesas a un capítulo que en realidad es español:
 * una escritura equivocada sobre el trabajo real del autor. Declarar el
 * idioma una sola vez en `book.json` resuelve la ambigüedad de raíz — si el
 * autor ya dijo "esta novela es en español", ninguna cita suelta en otro
 * idioma puede contradecirlo capítulo por capítulo. Por esto la detección
 * por contenido pasa a ser el ÚLTIMO recurso, no el segundo: no la "arregles"
 * subiéndola de prioridad, es la fuente menos confiable de las tres.
 *
 * Un `idioma` en blanco (`''` o solo espacios) no es una declaración, es un
 * campo sin llenar: `??` no lo filtra porque no es `null`/`undefined`, así
 * que cada nivel se normaliza a `undefined` antes de la cadena.
 */
export function resolverIdiomaEfectivo(
  idiomaLibro: string | null | undefined,
  idiomaCapitulo: string | null | undefined,
  html: string,
): string {
  const normalizar = (idioma: string | null | undefined): string | undefined =>
    idioma?.trim() || undefined;
  return normalizar(idiomaLibro) ?? normalizar(idiomaCapitulo) ?? detectLang(html);
}

/**
 * Corre los cuatro detectores sobre UN capítulo. Pura: sin DOM, sin
 * `@tiptap/core`, sin Tauri — la comparten el escaneo (`revision-libro-service`)
 * y, en la Tarea 4, el apply; así el gateo de idioma vive en un solo lugar y no
 * se puede olvidar en una de las dos copias.
 *
 * `idiomaLibro` es el campo `idioma` de `book.json` (manda si está, ver
 * `resolverIdiomaEfectivo`). `idiomaCapitulo` es el campo crudo persistido en
 * el `.meta.json` del capítulo (puede ser `null`/`undefined` si no está
 * seteado) — NO el resultado de `detectLang`.
 */
export function detectarEnCapitulo(
  html: string,
  idiomaLibro: string | null | undefined,
  idiomaCapitulo: string | null | undefined,
  opts: OpcionesDeteccion,
): ResultadoDeteccionCapitulo {
  const idiomaEfectivo = resolverIdiomaEfectivo(idiomaLibro, idiomaCapitulo, html);
  const esIngles = idiomaEfectivo === 'en';
  const plain = htmlToPlain(html);

  // Rayas: gatea con el idioma EFECTIVO (con fallback a `detectLang`), no
  // con el campo crudo. Esto diverge a propósito de `canApplyRae` en
  // editor.ts, que sí usa el campo crudo (null/undefined = habilitado): ahí
  // hay un autor mirando un modal de diff antes de que se escriba nada, así
  // que puede darse el lujo de permitir de más ante la duda. Acá no — esto
  // corre desatendido sobre un libro entero y escribe sin mostrar nada, así
  // que la duda tiene que resolverse para el lado de NO tocar. Si un capítulo
  // sin idioma seteado tiene contenido en inglés, `detectLang` lo va a marcar
  // 'en' igual que hace `comillas` dos líneas más abajo — los dos detectores
  // tienen que coincidir en si el capítulo es inglés o no, si no la misma
  // función lo clasifica distinto para cada uno y vuelve a colarse el bug de
  // rayas españolas sobre diálogo inglés. El converter no discrimina por su
  // cuenta: la regla D1 convierte cualquier párrafo que arranca con comilla a
  // raya sin exigir verbo dicendi español, y de paso `normalizeQuotes()`
  // aplana las comillas tipográficas a rectas — sin este gate, un capítulo en
  // inglés con diálogo entre comillas sale con rayas españolas y comillas
  // rectas, corrupción real.
  // NO "arreglar" esto para que calce con `canApplyRae` — es la divergencia
  // correcta, ver arriba.
  //
  // `convertFragmentHtml` (no `convert()` crudo) es el mismo guard "solo se
  // normalizaron comillas" que usa el editor (`rae-convert.ts`) y que
  // `validator.ts::pushPendingConversion` aplica por párrafo. Sin él, un
  // capítulo español que solo tiene «» / “” / ‘’ sin diálogo de verdad cuenta
  // como "1 cambio" y aplicar le aplana la tipografía de comillas a ASCII sin
  // convertir nada a raya — peor que no tocarlo. Los tres guards tienen que
  // mantenerse juntos.
  const rayas = !esIngles && convertFragmentHtml(html) !== null ? 1 : 0;

  // Comillas: solo capítulos en inglés (efectivo, con fallback a detectLang si
  // no hay idioma seteado), igual que `quotes-fix-service`.
  const comillas = esIngles ? educateQuotes(html).changes : 0;

  // arreglosRae: `validateRae` ya se auto-gatea a `lang === 'es'` exacto, así
  // que capítulos en inglés o sin idioma detectado como 'es' quedan en 0 sin
  // gate adicional acá. `pending-conversion` se excluye a propósito: su
  // autoFix ES la salida de `convert()` (ver `validator.ts`), la misma
  // transformación que ya cuenta `rayas` arriba. Sin este filtro el mismo
  // cambio aparecía duplicado en dos filas del modal, y "arreglos RAE" dejaba
  // de ser independiente de "rayas" — tildar solo arreglosRae convertía el
  // diálogo igual.
  const violaciones = validateRae(plain, idiomaEfectivo);
  const arreglosRae = violaciones.filter(
    (v) => v.autoFix !== undefined && v.category !== 'pending-conversion',
  ).length;

  const reps = detectRepeticiones(plain, esIngles ? 'en' : 'es', {
    ...REP_DEFAULTS,
    excepciones: opts.excepciones,
    ignorar: opts.diccionario,
  });

  return { rayas, comillas, arreglosRae, repeticiones: reps.length, esIngles };
}

/**
 * Aplica sobre UN capítulo las transformaciones tildadas en `seleccion`,
 * encadenadas sobre el mismo HTML. Comparte `esIngles` con `detectarEnCapitulo`
 * — es la misma función la que decide si un capítulo es inglés para las dos,
 * a propósito: el bug que esto previene ya pasó dos veces en este plan (rayas
 * españolas aplicadas sobre diálogo en inglés porque el gate se derivó a mano
 * en un segundo lugar y no coincidía con el de detectar).
 *
 * `rayas` y `comillas` son mutuamente excluyentes por idioma, así que el orden
 * entre ellas no importa. `arreglosRae` va después y sobre el HTML que resulte
 * de las anteriores, para que un capítulo con las tres tildadas sea una sola
 * pasada consistente. Los fixes de `arreglosRae` excluyen la categoría
 * `pending-conversion` — esa violación es la conversión de diálogo, que ya es
 * responsabilidad exclusiva de `rayas` (mismo motivo que en
 * `detectarEnCapitulo`, ver ahí).
 */
export function aplicarEnCapitulo(
  html: string,
  idiomaLibro: string | null | undefined,
  idiomaCapitulo: string | null | undefined,
  seleccion: SeleccionRevision,
): { html: string; salteados: number } {
  const idiomaEfectivo = resolverIdiomaEfectivo(idiomaLibro, idiomaCapitulo, html);
  const esIngles = idiomaEfectivo === 'en';
  let out = html;
  let salteados = 0;

  if (seleccion.rayas && !esIngles) out = convertFragmentHtml(out) ?? out;
  if (seleccion.comillas && esIngles) out = educateQuotes(out).text;
  if (seleccion.arreglosRae) {
    const fixes = validateRae(htmlToPlain(out), idiomaEfectivo)
      .filter((v) => v.category !== 'pending-conversion')
      .map((v) => v.autoFix)
      .filter((f): f is RaeAutoFix => f !== undefined);
    const r = aplicarFixesHtml(out, fixes);
    out = r.html;
    salteados = r.salteados;
  }

  return { html: out, salteados };
}
