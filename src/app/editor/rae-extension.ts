import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as PmNode } from '@tiptap/pm/model';
import { RaeCategory, RaeViolation } from '../core/types';

export interface RaeViolationPos extends RaeViolation {
  id: string;
  from: number;
  to: number;
  fixFrom?: number;
  fixTo?: number;
  paragraphFrom?: number;
  paragraphTo?: number;
}

let _raeIdSeq = 0;
function newRaeId(): string {
  _raeIdSeq += 1;
  return `r${Date.now().toString(36)}-${_raeIdSeq}`;
}

export interface TextRange {
  plainStart: number;
  plainEnd: number;
  pmPos: number;
}

const raeKey = new PluginKey<DecorationSet>('rae');

export const RaeExtension = Extension.create({
  name: 'rae',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: raeKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, oldSet) {
            const meta = tr.getMeta(raeKey);
            if (meta && meta.type === 'set') {
              return buildDecorations(tr.doc, meta.violations as RaeViolationPos[]);
            }
            return oldSet.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return raeKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function setRaeViolations(
  view: { dispatch: (tr: unknown) => void; state: { tr: unknown } },
  violations: RaeViolationPos[],
): void {
  const tr = (view.state.tr as { setMeta: (k: unknown, v: unknown) => unknown }).setMeta(
    raeKey,
    { type: 'set', violations },
  );
  view.dispatch(tr);
}

function buildDecorations(doc: PmNode, violations: RaeViolationPos[]): DecorationSet {
  const decos: Decoration[] = [];
  const docSize = doc.content.size;
  for (let i = 0; i < violations.length; i++) {
    const v = violations[i];
    if (v.from < 0 || v.to <= v.from || v.to > docSize) continue;
    decos.push(
      Decoration.inline(v.from, v.to, {
        class: cssClassFor(v.category),
        'data-rae-idx': String(i),
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

function cssClassFor(category: RaeCategory): string {
  switch (category) {
    case 'char':
      return 'rae-violation rae-violation--char';
    case 'pending-conversion':
      return 'rae-violation rae-violation--pending';
    case 'structure':
      return 'rae-violation rae-violation--structure';
    case 'typo':
      return 'rae-violation rae-violation--typo';
  }
}

export function mapViolationsToPm(
  violations: RaeViolation[],
  ranges: TextRange[],
  doc: PmNode,
): RaeViolationPos[] {
  const out: RaeViolationPos[] = [];
  for (const v of violations) {
    const from = offsetToPm(v.offset, ranges);
    const to = offsetToPm(v.offset + v.length, ranges);
    if (from === null || to === null || to <= from) continue;
    const fromBlock = doc.resolve(from).parent;
    const toBlock = doc.resolve(to).parent;
    if (fromBlock !== toBlock && v.category !== 'pending-conversion') continue;
    let fixFrom: number | undefined;
    let fixTo: number | undefined;
    if (v.autoFix) {
      const ff = offsetToPm(v.autoFix.offset, ranges);
      const ft = offsetToPm(v.autoFix.offset + v.autoFix.length, ranges);
      if (ff !== null && ft !== null && ft >= ff) {
        fixFrom = ff;
        fixTo = ft;
      }
    }
    let paragraphFrom: number | undefined;
    let paragraphTo: number | undefined;
    if (v.paragraphRange) {
      const pf = offsetToPm(v.paragraphRange.offset, ranges);
      const pt = offsetToPm(
        v.paragraphRange.offset + v.paragraphRange.length,
        ranges,
      );
      if (pf !== null && pt !== null && pt >= pf) {
        paragraphFrom = pf;
        paragraphTo = pt;
      }
    }
    out.push({
      ...v,
      id: newRaeId(),
      from,
      to,
      fixFrom,
      fixTo,
      paragraphFrom,
      paragraphTo,
    });
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
