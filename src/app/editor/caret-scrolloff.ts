/**
 * Margen de respiro entre el caret y el borde del viewport del editor.
 *
 * ProseMirror ya scrollea al tipear (las transacciones de `readDOMChange` van
 * con `scrollIntoView()`), pero `scrollRectIntoView` usa sus defaults
 * `scrollThreshold = 0` / `scrollMargin = 5px`, así que el caret queda pegado
 * al borde del pane y se escribe a ciegas. Estas funciones traducen "N líneas
 * de aire" a los insets en px que esos dos `editorProps` esperan.
 *
 * Sin DOM a propósito: entra el string de `getComputedStyle(...).lineHeight` y
 * el tamaño de fuente activo, salen números. Los tests viven en
 * `scripts/run-caret-scrolloff-smoke.mjs`.
 */

/** Líneas de respiro entre el caret y el borde del viewport. */
export const SCROLLOFF_LINES = 2;

/** Factor de fallback, alineado con el `line-height` del SCSS del editor. */
export const FALLBACK_LINE_HEIGHT = 1.5;

/** Espeja `FONT_DEFAULT` de `settings-service.ts`. */
export const FALLBACK_FONT_SIZE = 17;

/**
 * Espeja el default de `scrollMargin` de ProseMirror (`scrollRectIntoView`
 * cae a `5` si el editorProp no está seteado). Se usa en el eje X: no todos
 * los hosts son `overflow-x: hidden` (el `pre` de un code block en notas sí
 * scrollea horizontal), así que hay que preservar el respiro que PM ya traía
 * de fábrica en vez de aplastarlo a 0.
 */
export const PM_DEFAULT_SCROLL_MARGIN_X = 5;

export interface ScrolloffInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ScrolloffProps {
  scrollThreshold: ScrolloffInsets;
  scrollMargin: ScrolloffInsets;
}

/**
 * Resuelve a px el `line-height` computado de un elemento.
 *
 * `getComputedStyle` devuelve px cuando el valor resuelve (`"25.5px"`), pero
 * `normal` queda sin resolver. Se exige el sufijo `px` justamente para no
 * comerse un valor unitless (`"1.5"`) como si fueran 1.5 píxeles, que dejaría
 * el respiro en 3px y parecería que el fix no hizo nada.
 */
export function lineHeightPxFrom(computed: string, fontSizePx: number): number {
  const trimmed = computed.trim();
  if (trimmed.endsWith('px')) {
    const px = Number.parseFloat(trimmed);
    if (Number.isFinite(px) && px > 0) return px;
  }
  const fontSize = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : FALLBACK_FONT_SIZE;
  return fontSize * FALLBACK_LINE_HEIGHT;
}

/**
 * Threshold y margin en px para los `editorProps` de ProseMirror.
 *
 * El eje vertical vale lo mismo en los dos a propósito: la condición de
 * disparo y la posición de reposo coinciden, así que el caret entra en la
 * zona de guarda y queda justo en su borde — el scroll resultante es de una
 * línea por línea nueva, sin saltos que reubiquen el párrafo. Simétrico
 * arriba y abajo (subir con las flechas también deja contexto).
 *
 * El eje horizontal reproduce el default histórico de ProseMirror en vez de
 * aplastarlo a 0: `scrollThreshold` en `left`/`right` sigue en `0` (el punto
 * de disparo en X no cambia) y `scrollMargin` en `left`/`right` sigue en
 * `PM_DEFAULT_SCROLL_MARGIN_X` (la posición de reposo en X tampoco cambia).
 * Necesario porque no todos los hosts son `overflow-x: hidden` — un `pre` de
 * code block en notas sí scrollea horizontal, y con `0` el caret quedaría
 * pegado a su borde derecho.
 *
 * Defensivo con entradas inválidas: un inset `NaN` o negativo rompería la
 * aritmética de `scrollRectIntoView` y dejaría el scroll trabado.
 */
export function caretScrolloff(lineHeightPx: number, lines: number = SCROLLOFF_LINES): ScrolloffProps {
  const safeLineHeight =
    Number.isFinite(lineHeightPx) && lineHeightPx > 0
      ? lineHeightPx
      : FALLBACK_FONT_SIZE * FALLBACK_LINE_HEIGHT;
  const safeLines = Number.isFinite(lines) && lines > 0 ? lines : SCROLLOFF_LINES;
  const inset = Math.round(safeLineHeight * safeLines);
  return {
    scrollThreshold: { top: inset, right: 0, bottom: inset, left: 0 },
    scrollMargin: { top: inset, right: PM_DEFAULT_SCROLL_MARGIN_X, bottom: inset, left: PM_DEFAULT_SCROLL_MARGIN_X },
  };
}
