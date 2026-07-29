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
 * Los dos valen lo mismo a propósito: la condición de disparo y la posición de
 * reposo coinciden, así que el caret entra en la zona de guarda y queda justo
 * en su borde — el scroll resultante es de una línea por línea nueva, sin
 * saltos que reubiquen el párrafo. Simétrico arriba y abajo (subir con las
 * flechas también deja contexto); costados en cero, el host no scrollea en X.
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
    scrollMargin: { top: inset, right: 0, bottom: inset, left: 0 },
  };
}
