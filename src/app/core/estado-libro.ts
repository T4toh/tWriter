/** Ciclo de vida de una novela y su historial de revisiones.
 *
 *  Reemplaza al `finalizada: bool` viejo, que solo sabía decir "no le agrego
 *  más capítulos" y dejaba afuera las dos preguntas que el autor sí se hace:
 *  si el libro ya salió y cuántas veces lo revisó.
 *
 *  **Las revisiones no son un estado, son un historial** — el proofreading
 *  nunca termina. Por eso «revisada» no existe acá: lo que hay es una lista de
 *  sellos y un «necesita revisar» que se deriva (ver `necesitaRevisar`), nunca
 *  se guarda. Un estado guardado que hay que recordar mantener al día es un
 *  estado que queda mintiendo.
 *
 *  Módulo puro a propósito: lo prueba `scripts/run-estados-smoke.mjs`. */

export type EstadoLibro = 'en_curso' | 'terminada' | 'publicada';

export const ESTADOS_LIBRO: ReadonlyArray<EstadoLibro> = [
  'en_curso',
  'terminada',
  'publicada',
];

export const ESTADO_LIBRO_DEFAULT: EstadoLibro = 'en_curso';

export const ESTADO_LIBRO_LABEL: Record<EstadoLibro, string> = {
  en_curso: 'En curso',
  terminada: 'Terminada',
  publicada: 'Publicada',
};

/** Qué implica cada estado, para el select del modal. */
export const ESTADO_LIBRO_DETALLE: Record<EstadoLibro, string> = {
  en_curso: 'Se le siguen agregando capítulos',
  terminada: 'Terminada de escribir (oculta el creador de capítulos)',
  publicada: 'Ya salió',
};

export function esEstadoLibro(value: unknown): value is EstadoLibro {
  return ESTADOS_LIBRO.includes(value as EstadoLibro);
}

/** El estado de un `book.json`, con el default para los que no lo tienen.
 *  Rust ya migra `finalizada` al leer; esto cubre el JSON escrito a mano. */
export function estadoLibro(value: unknown): EstadoLibro {
  return esEstadoLibro(value) ? value : ESTADO_LIBRO_DEFAULT;
}

/** Desde `terminada` en adelante no se crean capítulos, partes ni epílogo:
 *  es exactamente lo que hacía `finalizada`. */
export function admiteCapitulosNuevos(estado: EstadoLibro): boolean {
  return estado === 'en_curso';
}

/** Sello de revisión: `YYYY-MM-DDTHH:MM` en **hora local**.
 *
 *  Se calcula acá y no en Rust porque del lado nativo solo hay epoch UTC, y el
 *  nombre del EPUB saldría corrido las horas del huso. Sin `Z` ni offset
 *  justamente para que `new Date(sello)` lo vuelva a leer como hora local. */
export function selloRevision(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** Valida un sello tipeado a mano.
 *
 *  El patrón solo no alcanza y `Date` tampoco. `new Date('2026')` parsea
 *  contento y dejaría pasar un sello de un solo campo, y al revés
 *  `new Date('2026-02-31T00:00')` **no** es `Invalid Date`: rueda al 3 de
 *  marzo, así que un 31 de febrero entraría convertido en otra fecha, en
 *  silencio. Por eso son los tres pasos: el patrón, que la fecha parsee, y el
 *  round-trip por `selloRevision`, que es lo único que descarta el rodeo. */
export function esSelloRevision(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return false;
  return selloRevision(d) === value;
}

/** Milisegundos de la última revisión, o `null` si todavía no hay ninguna.
 *  No asume que la lista esté ordenada ni que todos los sellos sean válidos:
 *  el `book.json` se edita a mano. */
export function ultimaRevisionMs(revisiones: readonly string[] | null | undefined): number | null {
  let max: number | null = null;
  for (const sello of revisiones ?? []) {
    const ms = new Date(sello).getTime();
    if (Number.isFinite(ms) && (max === null || ms > max)) max = ms;
  }
  return max;
}

/** Deriva el «necesita revisar» que el autor pidió sin guardarlo en ningún
 *  lado: un libro terminado o publicado que nunca se revisó, o que se editó
 *  después de la última revisión.
 *
 *  `ultimaEdicionMs` es el `modifiedMs` del nodo del libro, que Rust ya manda
 *  como el máximo mtime de sus hijos. Un libro en curso nunca lo necesita —
 *  todavía se está escribiendo. */
export function necesitaRevisar(
  estado: EstadoLibro,
  revisiones: readonly string[] | null | undefined,
  ultimaEdicionMs: number | null | undefined,
): boolean {
  if (estado === 'en_curso') return false;
  const ultima = ultimaRevisionMs(revisiones);
  if (ultima === null) return true;
  return !!ultimaEdicionMs && ultimaEdicionMs > ultima;
}
