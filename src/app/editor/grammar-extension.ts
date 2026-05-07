import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as PmNode } from '@tiptap/pm/model';
import { GrammarMatch } from '../core/types';

export interface GrammarMatchPos extends GrammarMatch {
  id: string;
  from: number;
  to: number;
}

let _grammarIdSeq = 0;
function newGrammarId(): string {
  _grammarIdSeq += 1;
  return `g${Date.now().toString(36)}-${_grammarIdSeq}`;
}

interface TextRange {
  plainStart: number;
  plainEnd: number;
  pmPos: number;
}

const grammarKey = new PluginKey<DecorationSet>('grammar');

export const Grammar = Extension.create({
  name: 'grammar',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: grammarKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, oldSet) {
            const meta = tr.getMeta(grammarKey);
            if (meta && meta.type === 'set') {
              return buildDecorations(tr.doc, meta.matches as GrammarMatchPos[]);
            }
            return oldSet.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return grammarKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function setGrammarMatches(
  view: { dispatch: (tr: unknown) => void; state: { tr: unknown } },
  matches: GrammarMatchPos[],
): void {
  const tr = (view.state.tr as { setMeta: (k: unknown, v: unknown) => unknown }).setMeta(
    grammarKey,
    { type: 'set', matches },
  );
  view.dispatch(tr);
}

function buildDecorations(doc: PmNode, matches: GrammarMatchPos[]): DecorationSet {
  const decos: Decoration[] = [];
  const docSize = doc.content.size;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.from < 0 || m.to <= m.from || m.to > docSize) continue;
    decos.push(
      Decoration.inline(m.from, m.to, {
        class: cssClassFor(m.category),
        'data-grammar-idx': String(i),
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

function cssClassFor(category: string): string {
  const c = category.toUpperCase();
  if (c.startsWith('TYPO')) return 'grammar-error grammar-error--typo';
  if (c.includes('GRAMMAR')) return 'grammar-error grammar-error--grammar';
  if (c === 'STYLE' || c === 'REDUNDANCY' || c === 'TYPOGRAPHY' || c === 'PLAIN_PARAPHRASE') {
    return 'grammar-error grammar-error--style';
  }
  return 'grammar-error grammar-error--misc';
}

export function extractPlainText(doc: PmNode): { plain: string; ranges: TextRange[] } {
  const ranges: TextRange[] = [];
  let plain = '';
  let isFirstBlock = true;

  doc.forEach((node, offset) => {
    walkBlock(node, offset + 1, () => {
      if (!isFirstBlock) plain += '\n\n';
      isFirstBlock = false;
    });
  });

  function walkBlock(node: PmNode, startPos: number, onBlockStart: () => void): void {
    if (node.type.name === 'horizontalRule') {
      if (!isFirstBlock) plain += '\n\n';
      plain += '* * *';
      isFirstBlock = false;
      return;
    }
    if (node.isTextblock) {
      onBlockStart();
      let cursor = startPos;
      node.forEach((child) => {
        if (child.isText) {
          const start = plain.length;
          const text = child.text ?? '';
          plain += text;
          ranges.push({ plainStart: start, plainEnd: plain.length, pmPos: cursor });
        }
        cursor += child.nodeSize;
      });
      return;
    }
    if (node.isBlock) {
      let inner = startPos;
      node.forEach((child) => {
        walkBlock(child, inner + 1, onBlockStart);
        inner += child.nodeSize;
      });
    }
  }

  return { plain, ranges };
}

export function mapMatchesToPm(
  matches: GrammarMatch[],
  ranges: TextRange[],
  doc: PmNode,
  plain: string,
): GrammarMatchPos[] {
  const out: GrammarMatchPos[] = [];
  for (const m of matches) {
    const slice = plain.slice(m.offset, m.offset + m.length);
    if (slice.includes('\n')) continue;
    const from = offsetToPm(m.offset, ranges);
    const to = offsetToPm(m.offset + m.length, ranges);
    if (from === null || to === null || to <= from) continue;
    const fromBlock = doc.resolve(from).parent;
    const toBlock = doc.resolve(to).parent;
    if (fromBlock !== toBlock) continue;
    out.push({ ...m, id: newGrammarId(), from, to });
  }
  return out;
}

function offsetToPm(offset: number, ranges: TextRange[]): number | null {
  for (const r of ranges) {
    if (offset >= r.plainStart && offset <= r.plainEnd) {
      return r.pmPos + (offset - r.plainStart);
    }
  }
  return null;
}
