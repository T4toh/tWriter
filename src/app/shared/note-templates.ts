/** Plantillas de notas. Las secciones salen de las notas que el autor ya
 *  escribe a mano en `Novelas/Notas/` — no son un modelo inventado:
 *
 *  - `personaje`: forma de `Notas/Meridian/<libro>/Aedan.md`
 *  - `mundo`: forma de `Notas/Meridian/<libro>/Mundo.md` (estado del mundo
 *    al momento de ese libro)
 *
 *  Las listas sueltas (`Personajes.md`, `Arreglos.md`) no llevan plantilla:
 *  son texto libre y `vacia` alcanza.
 *
 *  Puro: sin DOM, sin Angular. Cubierto por `scripts/run-note-templates-smoke.mjs`.
 */

export type NoteTemplateId = 'vacia' | 'personaje' | 'mundo';

export interface NoteTemplate {
  id: NoteTemplateId;
  label: string;
  /** Secciones `##` del cuerpo. Vacío = solo el `# título`. */
  secciones: readonly string[];
}

export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  { id: 'vacia', label: 'Vacía', secciones: [] },
  {
    id: 'personaje',
    label: 'Personaje',
    secciones: ['Raza', 'Características', 'Objetos', 'Magia'],
  },
  {
    id: 'mundo',
    label: 'Mundo (estado del libro)',
    secciones: ['General', 'Lugares', 'Personajes'],
  },
] as const;

/** Renderiza el markdown inicial de una nota. `titulo` va como `# ` arriba.
 *  Devuelve `null` para `vacia` — el backend ya escribe `# <nombre>` solo,
 *  así que no hay nada que mandar. */
export function renderNoteTemplate(
  id: NoteTemplateId,
  titulo: string,
): string | null {
  const tpl = NOTE_TEMPLATES.find((t) => t.id === id);
  if (!tpl || tpl.secciones.length === 0) return null;
  const cuerpo = tpl.secciones.map((s) => `## ${s}\n- \n`).join('\n');
  return `# ${titulo}\n\n${cuerpo}`;
}
