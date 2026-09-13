import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { splitHardBreaks } from './split-hard-breaks';

/**
 * Ningún `hardBreak` sobrevive a una transacción: apenas uno entra al doc (por
 * tecla, pegado o `setContent`) se convierte en corte de párrafo. Ver
 * `split-hard-breaks.ts` para el porqué. El cursor queda al principio del
 * párrafo nuevo, igual que con Enter.
 */
export const NoHardBreak = Extension.create({
  name: 'noHardBreak',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('noHardBreak'),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return splitHardBreaks(newState.doc, newState.tr);
        },
      }),
    ];
  },
});
