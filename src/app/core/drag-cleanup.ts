/**
 * Cierre de un drag nativo HTML5 por dos caminos **independientes**, porque
 * ninguno de los dos alcanza solo.
 *
 * El `dragend` se despacha *en el nodo origen*. Si el nodo sigue conectado, un
 * listener en `window` lo ve (el event path se arma al despachar e incluye a
 * los ancestros). Pero si el framework lo **desconectó** antes — Angular
 * re-renderizando el árbol a mitad del drag — el path de un nodo suelto es el
 * nodo y nada más: no hay ancestros, así que `window` no se entera. Y Firefox
 * históricamente no despacha `dragend` en ese caso. O sea que un listener en
 * `window` arregla el caso "listener destruido con el elemento" pero NO el caso
 * "elemento destruido".
 *
 * El camino que no depende del nodo es el reloj: mientras un drag está vivo el
 * navegador despacha `dragover` cada ~350 ms (el modelo de procesamiento de
 * drag-and-drop del spec corre en loop). Si dejan de llegar, el drag terminó
 * — se soltó, se canceló con Escape, o el puntero salió de la ventana. Con eso
 * el cierre no necesita que el nodo origen exista.
 *
 * **`drop` NO se escucha acá a propósito.** En captura sobre `window` correría
 * antes del handler de drop del shell, que lee el estado del drag para saber
 * qué abrir; lo dejaría en null y rompería el split.
 */

/** Handle opaco de timer: `number` en el browser, objeto en node. */
type Handle = unknown;

export interface Timers {
  set(cb: () => void, ms: number): Handle;
  clear(h: Handle): void;
}

/** Lo mínimo de `EventTarget` que se necesita — así el smoke runner pasa un doble. */
export interface DragEventTarget {
  addEventListener(type: string, cb: () => void, capture: boolean): void;
  removeEventListener(type: string, cb: () => void, capture: boolean): void;
}

/**
 * Sin `dragover` por este tiempo, el drag se considera terminado. El loop del
 * spec corre cada ~350 ms, así que 1200 ms da tres vueltas de margen para un
 * frame perdido. El costo de errarle por exceso es que el cartel de drop tarda
 * ~1 s en apagarse en el peor caso; el de errarle por defecto sería cortar un
 * drag vivo, que es mucho peor.
 */
export const DRAG_WATCHDOG_MS = 1200;

/**
 * Arma el cierre y devuelve la función para desarmarlo. `cerrar` se llama
 * **una sola vez** como máximo, y siempre después de desarmar los listeners.
 * Desarmar es idempotente y no llama a `cerrar`, así que el caller puede
 * invocarlo desde su propio cierre explícito sin recursión.
 */
export function armarCierreDeDrag(
  target: DragEventTarget,
  cerrar: () => void,
  timers: Timers,
  watchdogMs: number = DRAG_WATCHDOG_MS,
): () => void {
  let vivo = true;
  let timer: Handle = null;

  const desarmar = (): void => {
    if (!vivo) return;
    vivo = false;
    if (timer !== null) timers.clear(timer);
    timer = null;
    target.removeEventListener('dragend', onDragEnd, true);
    target.removeEventListener('dragover', onDragOver, true);
  };

  const cerrarUnaVez = (): void => {
    if (!vivo) return;
    desarmar();
    cerrar();
  };

  function onDragEnd(): void {
    cerrarUnaVez();
  }

  function onDragOver(): void {
    if (!vivo) return;
    if (timer !== null) timers.clear(timer);
    timer = timers.set(cerrarUnaVez, watchdogMs);
  }

  target.addEventListener('dragend', onDragEnd, true);
  target.addEventListener('dragover', onDragOver, true);
  // Armado desde el arranque: si el drag muere antes del primer `dragover`
  // (arrastre que nunca entra a la ventana), el watchdog igual cierra.
  timer = timers.set(cerrarUnaVez, watchdogMs);

  return desarmar;
}
