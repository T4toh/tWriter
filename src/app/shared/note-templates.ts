/**
 * Plantillas de notas. Las formas salen del relevamiento del corpus real
 * (`~/novelas/Notas`, 114 `.md`, 2026-08-31), no de un modelo inventado:
 *
 *  - `personaje`: 20 fichas `Notas/Meridian/<libro>/<nombre>.md`
 *  - `conjuro`: 15 archivos `Magia y asociados/Conjuros (Lista)/*.md`
 *  - `mundo`: 4 archivos `Notas/Meridian/<libro>/Mundo.md`
 *  - `lista-agrupada`: `Personajes.md` de Meridian y Buenos Aires 2077
 *  - `catalogo`: ~25 archivos con un heading por entrada (Monstruos, Lugares.md)
 *
 * La plantilla ES markdown: así las de fábrica y las que el autor guarda en
 * `<root>/Plantillas/*.md` comparten un solo camino de código. Ojo con el H1:
 * `personaje`, `conjuro`, `mundo` y `lista-agrupada` arrancan SIN título, porque
 * las notas que el autor ya escribe no lo tienen.
 *
 * Puro: sin DOM, sin Angular. Cubierto por `scripts/run-note-templates-smoke.mjs`.
 */
import { Bloque, markdownABloques } from './note-blocks';

export interface NoteTemplate {
  id: string;
  label: string;
  markdown: string;
  origen: 'fabrica' | 'archivo';
}

export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  { id: 'vacia', label: 'Vacía', origen: 'fabrica', markdown: '# \n' },
  {
    id: 'personaje',
    label: 'Personaje',
    origen: 'fabrica',
    markdown: '## Raza\n-\n\n## Características\n-\n\n## Objetos\n-\n\n## Magia\n-\n\n## Detalles\n-\n',
  },
  {
    id: 'conjuro',
    label: 'Conjuro',
    origen: 'fabrica',
    markdown: '## Descripción\n\n## Atajos e Encantaciones\n-\n\n## Conjuro\n',
  },
  {
    id: 'mundo',
    label: 'Mundo (estado del libro)',
    origen: 'fabrica',
    markdown: '## General\n\n## Lugares\n\n## Personajes\n',
  },
  {
    id: 'lista-agrupada',
    label: 'Lista agrupada',
    origen: 'fabrica',
    markdown: '## Principales\n-\n\n## Secundarios (Orden de Aparición)\n-\n',
  },
  { id: 'catalogo', label: 'Catálogo por entradas', origen: 'fabrica', markdown: '# \n\n## \n' },
] as const;

export function bloquesDePlantilla(tpl: NoteTemplate): Bloque[] {
  return markdownABloques(tpl.markdown);
}

/** Junta las de fábrica con los `.md` de `<root>/Plantillas/`. El archivo del
 *  autor le gana a la de fábrica con el mismo nombre — comparación
 *  case-insensitive contra el `id` o el `label` de la de fábrica, porque el
 *  nombre natural del archivo (`Mundo.md`) suele ser el `id` corto y no el
 *  `label` completo (`Mundo (estado del libro)`) — así puede pisar una
 *  plantilla shipeada sin esperar un release. Las que no existen de fábrica
 *  se suman al final, alfabéticas. Una plantilla que no parsea a ningún
 *  bloque se descarta. */
export function combinarPlantillas(
  fabrica: readonly NoteTemplate[],
  archivos: readonly { nombre: string; markdown: string }[],
): NoteTemplate[] {
  const utiles = archivos.filter((a) => markdownABloques(a.markdown).length > 0);
  const porNombre = new Map<string, { nombre: string; markdown: string }>();
  for (const a of utiles) porNombre.set(a.nombre.toLowerCase(), a);

  const out: NoteTemplate[] = fabrica.map((t) => {
    const clave = porNombre.has(t.id.toLowerCase()) ? t.id.toLowerCase() : t.label.toLowerCase();
    const propia = porNombre.get(clave);
    if (!propia) return t;
    porNombre.delete(clave);
    return { id: t.id, label: propia.nombre, markdown: propia.markdown, origen: 'archivo' };
  });

  const extras = [...porNombre.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  for (const e of extras) {
    out.push({ id: `archivo:${e.nombre}`, label: e.nombre, markdown: e.markdown, origen: 'archivo' });
  }
  return out;
}
