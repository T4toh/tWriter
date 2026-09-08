/** Payload del evento `epub-export-progress` (ver `epub.rs::ExportProgress`). */
export interface ExportProgress {
  /** Path del libro que se está exportando. El listener filtra por acá: el
   *  evento es global, así que exportar dos novelas a la vez cruzaría las
   *  fases de una en el toast de la otra. */
  libro: string;
  fase: string;
  hecho: number;
  total: number;
}

/**
 * Texto que ve el autor mientras se genera el EPUB.
 *
 * `hecho`/`total` solo vienen en la fase de capítulos; en las demás son 0 y
 * alcanza con el nombre de la fase. El `+1` es a propósito: el backend avisa
 * **antes** de escribir cada capítulo (`hecho` es un índice 0-based), y decir
 * "0 de 12" mientras se trabaja en el primero se lee como que no arrancó.
 */
export function textoDeFase(p: ExportProgress): string {
  return p.total > 0 ? `${p.fase} (${p.hecho + 1} de ${p.total})` : `${p.fase}…`;
}

/** Largo del toast antes de que el texto pase al detalle. Un toast mide 380px
 *  y entran ~2 líneas: más que esto se lee cortado. */
const MAX_AVISO = 110;

/**
 * Recorta un aviso del export para el toast, sin partir palabras.
 *
 * Los avisos del backend son frases enteras —qué pasó, en qué capítulo y qué
 * conviene hacer—, así que en el toast entra la cabeza y el resto se lee al
 * clickearlo. Devuelve el aviso tal cual si ya entra: el caller compara con el
 * original para saber si hace falta detalle.
 */
export function resumenDeAviso(aviso: string): string {
  const texto = aviso.trim();
  if (texto.length <= MAX_AVISO) return texto;
  const corte = texto.slice(0, MAX_AVISO);
  const espacio = corte.lastIndexOf(' ');
  // El umbral evita que un aviso sin espacios (un path largo) quede en tres
  // palabras: ahí es mejor cortar duro que no decir nada.
  const base = espacio > 40 ? corte.slice(0, espacio) : corte;
  return `${base.trimEnd()}…`;
}
