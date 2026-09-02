/** Payload del evento `epub-export-progress` (ver `epub.rs::ExportProgress`). */
export interface ExportProgress {
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
