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

const repKey = new PluginKey<DecorationSet>('repeticiones');

export const RepeticionesExtension = Extension.create({
  name: 'repeticiones',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: repKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, oldSet) {
            const meta = tr.getMeta(repKey);
            if (meta && meta.type === 'set') {
              return buildDecorations(tr.doc, meta.repeticiones as RepeticionPos[]);
            }
            return oldSet.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return repKey.getState(state) ?? DecorationSet.empty;
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

function buildDecorations(doc: PmNode, reps: RepeticionPos[]): DecorationSet {
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
