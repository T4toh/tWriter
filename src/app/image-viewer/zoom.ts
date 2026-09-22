// Matemática pura del visor de imágenes: encaje, zoom alrededor de un punto y
// clamp del pan. Sin DOM, así la corre `scripts/run-zoom-smoke.mjs`.

export interface Vista {
  scale: number;
  tx: number;
  ty: number;
}

/** Tamaño natural de la imagen y del viewport que la contiene, en px. */
export interface Caja {
  imgW: number;
  imgH: number;
  boxW: number;
  boxH: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

/** Escala que hace entrar la imagen entera; nunca agranda una chica. */
export function fitScale(c: Caja): number {
  if (c.imgW <= 0 || c.imgH <= 0) return 1;
  return Math.min(c.boxW / c.imgW, c.boxH / c.imgH, 1);
}

/** Vista con la imagen a `scale`, centrada en la caja. */
export function centrar(scale: number, c: Caja): Vista {
  return clampPan({ scale, tx: 0, ty: 0 }, c);
}

/**
 * Si la imagen escalada entra en un eje, va centrada en ese eje; si excede,
 * el borde no puede despegarse del viewport (no queda fondo vacío).
 */
export function clampPan(v: Vista, c: Caja): Vista {
  const w = c.imgW * v.scale;
  const h = c.imgH * v.scale;
  const eje = (t: number, img: number, box: number): number =>
    img <= box ? (box - img) / 2 : Math.min(0, Math.max(box - img, t));
  return { scale: v.scale, tx: eje(v.tx, w, c.boxW), ty: eje(v.ty, h, c.boxH) };
}

/** Multiplica la escala por `factor` dejando fijo el punto (px, py) del viewport. */
export function zoomAt(v: Vista, c: Caja, factor: number, px: number, py: number): Vista {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const k = scale / v.scale;
  return clampPan({ scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k }, c);
}

/** Factor de zoom para un `deltaY` de rueda: notch de mouse ≈ ×0.82, pinch suave. */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-Math.max(-100, Math.min(100, deltaY)) * 0.002);
}
