import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as PmNode } from '@tiptap/pm/model';
import { RayaCategory, RayaViolation } from '../core/types';

export interface RayaViolationPos extends RayaViolation {
  id: string;
  from: number;
  to: number;
  fixFrom?: number;
  fixTo?: number;
  /** El texto que el arreglo espera encontrar entre `fixFrom` y `fixTo`. Las
   *  posiciones se remapean al tipear, pero el reemplazo se calculó sobre
   *  este texto: si ya no está, el arreglo es viejo y no se aplica. */
  fixText?: string;
  paragraphFrom?: number;
  paragraphTo?: number;
}

let _rayaIdSeq = 0;
function newRayaId(): string {
  _rayaIdSeq += 1;
  return `r${Date.now().toString(36)}-${_rayaIdSeq}`;
}

export interface TextRange {
  plainStart: number;
  plainEnd: number;
  pmPos: number;
}

const rayaKey = new PluginKey<DecorationSet>('raya');

export const RayaExtension = Extension.create({
  name: 'raya',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: rayaKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, oldSet) {
            const meta = tr.getMeta(rayaKey);
            if (meta && meta.type === 'set') {
              return buildDecorations(tr.doc, meta.violations as RayaViolationPos[]);
            }
            return oldSet.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return rayaKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function setRayaViolations(
  view: { dispatch: (tr: unknown) => void; state: { tr: unknown } },
  violations: RayaViolationPos[],
): void {
  const tr = (view.state.tr as { setMeta: (k: unknown, v: unknown) => unknown }).setMeta(
    rayaKey,
    { type: 'set', violations },
  );
  view.dispatch(tr);
}

function buildDecorations(doc: PmNode, violations: RayaViolationPos[]): DecorationSet {
  const decos: Decoration[] = [];
  const docSize = doc.content.size;
  for (let i = 0; i < violations.length; i++) {
    const v = violations[i];
    if (v.from < 0 || v.to <= v.from || v.to > docSize) continue;
    decos.push(
      Decoration.inline(v.from, v.to, {
        class: cssClassFor(v.category),
        'data-raya-idx': String(i),
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

function cssClassFor(category: RayaCategory): string {
  switch (category) {
    case 'char':
      return 'raya-violation raya-violation--char';
    case 'pending-conversion':
      return 'raya-violation raya-violation--pending';
    case 'structure':
      return 'raya-violation raya-violation--structure';
    case 'typo':
      return 'raya-violation raya-violation--typo';
    case 'mayusculas':
      return 'raya-violation raya-violation--mayusculas';
  }
}

export function mapViolationsToPm(
  violations: RayaViolation[],
  ranges: TextRange[],
  doc: PmNode,
): RayaViolationPos[] {
  const out: RayaViolationPos[] = [];
  for (const v of violations) {
    const from = offsetToPm(v.offset, ranges);
    const to = offsetToPm(v.offset + v.length, ranges);
    if (from === null || to === null || to <= from) continue;
    const fromBlock = doc.resolve(from).parent;
    const toBlock = doc.resolve(to).parent;
    if (fromBlock !== toBlock && v.category !== 'pending-conversion') continue;
    let fixFrom: number | undefined;
    let fixTo: number | undefined;
    let fixText: string | undefined;
    if (v.autoFix) {
      const ff = offsetToPm(v.autoFix.offset, ranges);
      const ft = offsetToPm(v.autoFix.offset + v.autoFix.length, ranges);
      if (ff !== null && ft !== null && ft >= ff) {
        fixFrom = ff;
        fixTo = ft;
        fixText = doc.textBetween(ff, ft);
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
      id: newRayaId(),
      from,
      to,
      fixFrom,
      fixTo,
      fixText,
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
