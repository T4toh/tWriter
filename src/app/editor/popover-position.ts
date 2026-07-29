/**
 * Ubicación de los popovers flotantes del editor (gramática y RAE).
 *
 * Antes se posicionaban con `y = rect.bottom + 4` fijo y un clamp de X con
 * constantes mágicas que ni coincidían con el `max-width` del CSS: un error
 * cerca del borde inferior abría un popup que no se veía. Acá se decide el lado
 * con el espacio real disponible y, si no entra en ninguno, se limita la altura
 * para que el popover scrollee adentro en vez de cortarse.
 *
 * Pura y sin DOM: la mide el componente y le pasa los números.
 */

/** Caja del elemento que ancla el popover, en coordenadas de viewport
 *  (`getBoundingClientRect`). Los popovers son `position: fixed`. */
export interface AnchorBox {
  left: number;
  top: number;
  bottom: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface ViewportBox {
  width: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  placement: 'below' | 'above';
  /** Alto máximo que el popover puede ocupar. Igual a `size.height` cuando
   *  entra completo; menor cuando hubo que limitarlo (el componente aplica
   *  `overflow-y: auto`). */
  maxHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function placePopover(
  anchor: AnchorBox,
  size: PopoverSize,
  viewport: ViewportBox,
  gap = 6,
  margin = 8,
): Placement {
  const x = clamp(anchor.left, margin, viewport.width - size.width - margin);
  const spaceBelow = viewport.height - margin - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap - margin;

  if (size.height <= spaceBelow) {
    return { x, y: anchor.bottom + gap, placement: 'below', maxHeight: size.height };
  }
  if (size.height <= spaceAbove) {
    return { x, y: anchor.top - gap - size.height, placement: 'above', maxHeight: size.height };
  }
  // No entra completo en ninguno: gana el lado con más aire y el popover
  // scrollea adentro. Empate → abajo (lectura natural desde el anchor).
  if (spaceBelow >= spaceAbove) {
    return {
      x,
      y: anchor.bottom + gap,
      placement: 'below',
      maxHeight: Math.max(0, spaceBelow),
    };
  }
  return { x, y: margin, placement: 'above', maxHeight: Math.max(0, spaceAbove) };
}
