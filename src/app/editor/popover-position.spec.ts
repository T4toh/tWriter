/**
 * Tests de `popover-position.ts` — ubicación de los popovers de gramática y RAE.
 *
 * Sin Karma en el repo: los casos viven acá y `scripts/run-popover-position-smoke.mjs`
 * los corre compilando a CommonJS temporal. La función es pura (no toca DOM),
 * así que se testea entera.
 */
import { placePopover } from './popover-position';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toEqual: (expected: unknown) => void;
};

const VIEWPORT = { width: 1000, height: 800 };
const SIZE = { width: 320, height: 200 };

describe('placePopover', () => {
  it('abre abajo cuando entra abajo', () => {
    const anchor = { left: 100, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, VIEWPORT)).toEqual({
      x: 100,
      y: 126,
      placement: 'below',
      maxHeight: 200,
    });
  });

  it('flipea arriba cuando no entra abajo pero sí arriba', () => {
    // bottom=700: 700+6+200=906 > 800-8. Arriba: 650-6-200=444 >= 8 → cabe.
    const anchor = { left: 100, top: 650, bottom: 700 };
    expect(placePopover(anchor, SIZE, VIEWPORT)).toEqual({
      x: 100,
      y: 444,
      placement: 'above',
      maxHeight: 200,
    });
  });

  it('cuando no entra en ningún lado elige el lado con más espacio y limita la altura', () => {
    // Viewport chico: 300 de alto. anchor top=140 bottom=160.
    // Abajo: 300-8-160-6 = 126. Arriba: 140-6-8 = 126. Empate → below.
    const anchor = { left: 100, top: 140, bottom: 160 };
    expect(placePopover(anchor, SIZE, { width: 1000, height: 300 })).toEqual({
      x: 100,
      y: 166,
      placement: 'below',
      maxHeight: 126,
    });
  });

  it('cuando hay más espacio arriba que abajo, pega arriba con altura limitada', () => {
    // Viewport 300. anchor top=250 bottom=280. Abajo: 300-8-280-6=6.
    // Arriba: 250-6-8=236 → gana arriba, cabe el popover → y=250-6-200=44, maxHeight=200.
    const anchor = { left: 100, top: 250, bottom: 280 };
    expect(placePopover(anchor, SIZE, { width: 1000, height: 300 })).toEqual({
      x: 100,
      y: 44,
      placement: 'above',
      maxHeight: 200,
    });
  });

  it('clampea X contra el borde derecho', () => {
    const anchor = { left: 950, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, VIEWPORT)).toEqual({
      x: 672, // 1000 - 320 - 8
      y: 126,
      placement: 'below',
      maxHeight: 200,
    });
  });

  it('clampea X contra el borde izquierdo', () => {
    const anchor = { left: -50, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, VIEWPORT)).toEqual({
      x: 8,
      y: 126,
      placement: 'below',
      maxHeight: 200,
    });
  });

  it('con viewport más angosto que el popover deja X en el margen', () => {
    const anchor = { left: 40, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, { width: 200, height: 800 })).toEqual({
      x: 8,
      y: 126,
      placement: 'below',
      maxHeight: 200,
    });
  });

  it('respeta gap y margin custom', () => {
    const anchor = { left: 100, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, VIEWPORT, 20, 40)).toEqual({
      x: 100,
      y: 140,
      placement: 'below',
      maxHeight: 200,
    });
  });
});
