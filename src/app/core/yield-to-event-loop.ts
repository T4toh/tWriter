/**
 * Cede el control al event loop para que el navegador pinte.
 *
 * Los auditores (`rae-audit-service`, `repeticiones-audit-service`,
 * `quotes-fix-service`) recorren el libro entero capítulo por capítulo en un
 * loop `async`. Sin ceder, el `progress` que publican en cada vuelta se
 * setea pero no se renderiza hasta el final: Angular no llega a correr
 * change detection ni el browser a pintar, así que la barra salta de 0 a 100
 * y la app se ve trabada. Con esto la señal se ve avanzar de verdad.
 *
 * `setTimeout(0)` y no `queueMicrotask` a propósito: la microtask corre antes
 * del paint, así que no cede nada. `requestAnimationFrame` funcionaría pero
 * lo atan a la frecuencia de refresco y se frena si la ventana está oculta,
 * que es justo cuando conviene que el escaneo largo siga a full.
 *
 * Estaba copiada en los tres servicios. Salió acá al aparecer el tercero,
 * que es el criterio que dejó anotado el autor en TODO.md.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
