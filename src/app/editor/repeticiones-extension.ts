import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as PmNode } from '@tiptap/pm/model';
import { Repeticion } from '../core/types';
import { TextRange, offsetToPm } from './grammar-extension';

export interface RepeticionPos extends Repeticion {
  id: string;
  from: number;
  to: number;
  /** Posición PM de la aparición previa, para el "ir a la anterior". */
  fromPrevio: number;
  toPrevio: number;
}

let _repIdSeq = 0;
function newRepId(): string {
  _repIdSeq += 1;
  return `rep${Date.now().toString(36)}-${_repIdSeq}`;
}

/** Rango de una aparición del grupo activo (la que se está mirando en el
 *  popover y sus hermanas). */
export interface RangoPm {
  from: number;
  to: number;
}

interface RepState {
  set: DecorationSet;
  /** Las marcas permanentes. */
  reps: RepeticionPos[];
  /** El grupo resaltado mientras el popover está abierto. Vacío el resto del
   *  tiempo. */
  grupo: RangoPm[];
}

const repKey = new PluginKey<RepState>('repeticiones');
const ESTADO_VACIO: RepState = { set: DecorationSet.empty, reps: [], grupo: [] };

export const RepeticionesExtension = Extension.create({
  name: 'repeticiones',
  addProseMirrorPlugins() {
    return [
      new Plugin<RepState>({
        key: repKey,
        state: {
          init: () => ESTADO_VACIO,
          apply(tr, prev) {
            const meta = tr.getMeta(repKey);
            if (meta && meta.type === 'set') {
              // Un check nuevo tira el grupo: el popover ya no está abierto (o
              // se está por cerrar) y sus posiciones son de la corrida vieja.
              const reps = meta.repeticiones as RepeticionPos[];
              return { set: buildDecorations(tr.doc, reps, []), reps, grupo: [] };
            }
            if (meta && meta.type === 'grupo') {
              const grupo = meta.grupo as RangoPm[];
              return { ...prev, grupo, set: buildDecorations(tr.doc, prev.reps, grupo) };
            }
            if (!tr.docChanged) return prev;
            // Editar cierra el popover, así que el grupo se va con él. Las
            // marcas se mapean nomás: el editor redispatcha un `set` con las
            // posiciones remapeadas en la misma transacción.
            return {
              reps: prev.reps,
              grupo: [],
              set: prev.set.map(tr.mapping, tr.doc),
            };
          },
        },
        props: {
          decorations(state) {
            return repKey.getState(state)?.set ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function setRepeticiones(
  view: { dispatch: (tr: unknown) => void; state: { tr: unknown } },
  repeticiones: RepeticionPos[],
): void {
  const tr = (view.state.tr as { setMeta: (k: unknown, v: unknown) => unknown }).setMeta(
    repKey,
    { type: 'set', repeticiones },
  );
  view.dispatch(tr);
}

/** Resalta el grupo entero de la repetición que se está mirando. Lista vacía
 *  para apagarlo. */
export function setGrupoRepeticion(
  view: { dispatch: (tr: unknown) => void; state: { tr: unknown } },
  grupo: RangoPm[],
): void {
  const tr = (view.state.tr as { setMeta: (k: unknown, v: unknown) => unknown }).setMeta(
    repKey,
    { type: 'grupo', grupo },
  );
  view.dispatch(tr);
}

function buildDecorations(
  doc: PmNode,
  reps: RepeticionPos[],
  grupo: RangoPm[],
): DecorationSet {
  const decos: Decoration[] = [];
  const docSize = doc.content.size;
  for (let i = 0; i < reps.length; i++) {
    const r = reps[i];
    if (r.from < 0 || r.to <= r.from || r.to > docSize) continue;
    decos.push(
      Decoration.inline(r.from, r.to, {
        class: 'repeticion',
        'data-repeticion-idx': String(i),
      }),
    );
  }
  // El grupo va después para que su clase se sume sobre la marca permanente
  // (ProseMirror concatena las clases de decoraciones solapadas).
  for (const g of grupo) {
    if (g.from < 0 || g.to <= g.from || g.to > docSize) continue;
    decos.push(Decoration.inline(g.from, g.to, { class: 'repeticion-grupo' }));
  }
  return DecorationSet.create(doc, decos);
}

export function mapRepeticionesToPm(
  reps: Repeticion[],
  ranges: TextRange[],
): RepeticionPos[] {
  const out: RepeticionPos[] = [];
  for (const r of reps) {
    const from = offsetToPm(r.offset, ranges);
    const to = offsetToPm(r.offset + r.length, ranges);
    const fromPrevio = offsetToPm(r.offsetPrevio, ranges);
    const toPrevio = offsetToPm(r.offsetPrevio + r.length, ranges);
    if (from === null || to === null || to <= from) continue;
    if (fromPrevio === null || toPrevio === null) continue;
    out.push({ ...r, id: newRepId(), from, to, fromPrevio, toPrevio });
  }
  return out;
}
