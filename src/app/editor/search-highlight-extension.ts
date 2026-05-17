import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as PmNode } from '@tiptap/pm/model';

export interface SearchHitRange {
  from: number;
  to: number;
}

const searchHlKey = new PluginKey<DecorationSet>('searchHighlight');

export const SearchHighlight = Extension.create({
  name: 'searchHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: searchHlKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, oldSet) {
            const meta = tr.getMeta(searchHlKey);
            if (meta && meta.type === 'set') {
              return buildDecorations(tr.doc, meta.ranges as SearchHitRange[]);
            }
            return oldSet.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return searchHlKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function setSearchHighlights(
  view: { dispatch: (tr: unknown) => void; state: { tr: unknown } },
  ranges: SearchHitRange[],
): void {
  const tr = (view.state.tr as { setMeta: (k: unknown, v: unknown) => unknown }).setMeta(
    searchHlKey,
    { type: 'set', ranges },
  );
  view.dispatch(tr);
}

function buildDecorations(doc: PmNode, ranges: SearchHitRange[]): DecorationSet {
  const decos: Decoration[] = [];
  const docSize = doc.content.size;
  for (const r of ranges) {
    if (r.from < 0 || r.to <= r.from || r.to > docSize) continue;
    decos.push(
      Decoration.inline(r.from, r.to, { class: 'search-hit' }),
    );
  }
  return DecorationSet.create(doc, decos);
}
