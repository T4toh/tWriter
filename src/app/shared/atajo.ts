/**
 * Etiquetas de atajos de teclado por plataforma.
 *
 * El repo mostraba `Ctrl+B`, `Ctrl+Z`, `Ctrl+C` en las tres plataformas, y en
 * Mac eso es mentira: los atajos de edición son del sistema y los de formato los
 * bindea TipTap con `Mod-`, que ahí resuelve a Cmd. O sea que la barra decía
 * `Ctrl+B` mientras la negrita se hacía con ⌘B.
 *
 * Solo formatea la etiqueta. El binding vive donde siempre — en las teclas de
 * TipTap o en el `@HostListener` del componente — así que si acá dice ⌘ y allá
 * hay `control`, la etiqueta vuelve a mentir: los dos lados se cambian juntos.
 */
export const ES_MAC = navigator.userAgent.includes('Mac');

/** El modificador principal: `⌘` en Mac, `Ctrl+` en el resto. */
const MOD = ES_MAC ? '⌘' : 'Ctrl+';
const SHIFT = ES_MAC ? '⇧' : 'Shift+';

/**
 * `atajo('B')` → `⌘B` / `Ctrl+B`. `atajo('Z', true)` → `⌘⇧Z` / `Ctrl+Shift+Z`.
 *
 * En Mac los modificadores se escriben pegados y sin `+`, que es la convención
 * de la plataforma.
 */
export function atajo(tecla: string, conShift = false): string {
  return `${MOD}${conShift ? SHIFT : ''}${tecla}`;
}
