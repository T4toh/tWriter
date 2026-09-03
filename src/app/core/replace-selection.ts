/**
 * Selección del reemplazo en lote: contadores, tri-estado y el armado de los
 * `FileEdit` que se mandan a escribir.
 *
 * Puro a propósito, sin nada de Angular: es la parte que se rompe callado —un
 * off-by-one acá escribe en un archivo que el autor destildó— y el frontend no
 * tiene runner de tests. Se valida con `scripts/run-replace-selection-smoke.mjs`.
 *
 * `deselected` guarda los ids APAGADOS, no los prendidos, así un preview nuevo
 * arranca con todo seleccionado sin código extra.
 */

/** Espejo de `MotivoSkip` en `src-tauri/src/replace.rs`. */
export type MotivoSkip = 'cruzaTag' | 'cruzaEntidad' | 'cruzaBloque';

export interface ReplaceOccurrence {
  /** `<path>#<htmlStart>`, generado en Rust. */
  id: string;
  snippet: string;
  htmlStart: number;
  htmlEnd: number;
}

export interface ReplaceSkipped {
  snippet: string;
  reason: MotivoSkip;
}

export interface ReplaceGroup {
  path: string;
  title: string;
  occurrences: ReplaceOccurrence[];
  skipped: ReplaceSkipped[];
}

export interface ReplacePreview {
  groups: ReplaceGroup[];
  total: number;
  totalSkipped: number;
  truncated: boolean;
}

/** Lo que consume `replace_apply`. */
export interface FileEdit {
  path: string;
  ranges: Array<[number, number]>;
}

export interface SelectionCounts {
  total: number;
  selected: number;
  chapters: number;
  /** Capítulos con al menos una ocurrencia seleccionada. */
  chaptersSelected: number;
}

export type TriState = 'all' | 'none' | 'some';

export function contar(groups: ReplaceGroup[], deselected: Set<string>): SelectionCounts {
  let total = 0;
  let selected = 0;
  let chaptersSelected = 0;
  for (const g of groups) {
    total += g.occurrences.length;
    const enGrupo = g.occurrences.filter((o) => !deselected.has(o.id)).length;
    selected += enGrupo;
    if (enGrupo > 0) chaptersSelected += 1;
  }
  return { total, selected, chapters: groups.length, chaptersSelected };
}

export function estadoGrupo(group: ReplaceGroup, deselected: Set<string>): TriState {
  const n = group.occurrences.length;
  if (n === 0) return 'none';
  const apagadas = group.occurrences.filter((o) => deselected.has(o.id)).length;
  if (apagadas === 0) return 'all';
  if (apagadas === n) return 'none';
  return 'some';
}

/** Devuelve un Set NUEVO: los signals comparan por referencia. */
export function toggleOcurrencia(id: string, deselected: Set<string>): Set<string> {
  const out = new Set(deselected);
  if (out.has(id)) out.delete(id);
  else out.add(id);
  return out;
}

/** `all` → apaga todas. `none` y `some` → prende todas. */
export function toggleGrupo(group: ReplaceGroup, deselected: Set<string>): Set<string> {
  const out = new Set(deselected);
  if (estadoGrupo(group, deselected) === 'all') {
    for (const o of group.occurrences) out.add(o.id);
  } else {
    for (const o of group.occurrences) out.delete(o.id);
  }
  return out;
}

/** Un `FileEdit` por archivo con al menos una ocurrencia seleccionada. */
export function editsDesdeSeleccion(
  groups: ReplaceGroup[],
  deselected: Set<string>,
): FileEdit[] {
  const out: FileEdit[] = [];
  for (const g of groups) {
    const ranges = g.occurrences
      .filter((o) => !deselected.has(o.id))
      .map((o): [number, number] => [o.htmlStart, o.htmlEnd]);
    if (ranges.length > 0) out.push({ path: g.path, ranges });
  }
  return out;
}
