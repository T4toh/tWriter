/** Las tres fuentes de la app: slots, la custom property de cada uno y cómo
 *  se resuelve la elección del usuario al stack CSS final.
 *
 *  Vive afuera de `settings-service` porque eso importa Angular y Tauri, y
 *  entonces no se puede cargar desde node: acá adentro no hay nada de eso, así
 *  que `scripts/run-app-fonts-smoke.mjs` lo compila y lo ejercita solo. */

/** Los tres slots de fuente de la **app**, cada uno mapeado a la custom
 *  property que ya usan los componentes. Distinto del selector del editor:
 *  ese pisa la fuente del texto que se escribe (`--editor-font-family`), esto
 *  es la tipografía de la app. */
export type AppFontSlot = 'ui' | 'body' | 'mono';

export const APP_FONT_VAR: Record<AppFontSlot, string> = {
  ui: '--font-ui',
  body: '--font-body',
  mono: '--font-mono',
};

export const APP_FONT_LABEL: Record<AppFontSlot, string> = {
  ui: 'Interfaz',
  body: 'Lectura',
  mono: 'Monoespaciada',
};

/** Con qué se completa el stack detrás de la familia elegida, por slot: si la
 *  fuente no está disponible en esta PC, cae a algo del mismo tipo en vez de
 *  al serif de todo. No incluye la familia bundleada del default a propósito
 *  —quien elige otra fuente no quiere Merriweather de fallback— pero sí deja
 *  un genérico, que es lo que impide que la app quede sin tipografía. */
const APP_FONT_FALLBACK: Record<AppFontSlot, string> = {
  ui: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  body: "georgia, 'Times New Roman', serif",
  mono: 'ui-monospace, monospace',
};

/** Resuelve la elección de un slot al stack CSS que se escribe en la custom
 *  property. `null` (o vacío) significa "el default de la app", y devuelve
 *  `null`: el llamador tiene que **borrar** la property y dejar que gane el
 *  valor de `styles.scss`, que es la única forma de que el default siga siendo
 *  uno solo y no una copia que se desincroniza. */
export function resolveAppFontStack(slot: AppFontSlot, family: string | null): string | null {
  if (!family) return null;
  const limpio = family.trim();
  if (!limpio) return null;
  // Cita el nombre para soportar familias con espacios ("EB Garamond").
  return `'${limpio.replace(/'/g, "\\'")}', ${APP_FONT_FALLBACK[slot]}`;
}
