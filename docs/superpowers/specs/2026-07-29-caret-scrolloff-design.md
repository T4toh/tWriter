# Scroll al caret: margen de respiro tipo scrolloff al tipear

Fecha: 2026-07-29

## Problema

Cuando el cursor pasa a una línea nueva al final del viewport, el texto se escribe pegado
al borde inferior del pane. No hay margen de respiro: la línea que se está tipeando es la
última visible, así que no se ve el contexto de lo que viene ni queda claro cuánto espacio
resta. El autor lo describe como "escribir a ciegas contra el borde".

La causa no es que la vista no siga al caret. ProseMirror **sí** scrollea al tipear:
`readDOMChange` cierra sus transacciones con `tr.scrollIntoView()`
(`prosemirror-view/dist/index.js:5168`), y los cambios de selección por teclado también
(línea 5027). El problema es *cuánto* scrollea. `scrollRectIntoView` (línea 209) lee dos
`editorProps` que tWriter nunca setea:

```js
let scrollThreshold = view.someProp("scrollThreshold") || 0,
    scrollMargin    = view.someProp("scrollMargin")    || 5;
```

Con los defaults, el caret se acomoda a **5px** del borde. Además, el scroller que
`scrollRectIntoView` encuentra al subir por los ancestros es `.editor-host`, y lo mide con
`clientRect()` — o sea su *padding box*. El `padding: 2.5rem` del host queda del lado de
adentro del rect, así que no aporta respiro alguno: los 5px se cuentan desde el borde
visual del pane.

## Alcance

Cubre los dos editores tipeables:

- `src/app/editor/editor.ts` — editor de capítulos.
- `src/app/notes-editor/notes-editor.ts` — editor de notas.

Quedan **fuera**:

- `markdown-reader` — es read-only, no hay caret ni transacciones marcadas
  `scrollIntoView()` que seguir.
- **Typewriter mode** (caret clavado a una altura fija de la pantalla, el texto moviéndose
  debajo). Se evaluó y se descartó para esta iteración: mueve la vista en cada Enter y
  molesta al editar texto viejo. Si en algún momento se quiere, entra como setting aparte.
- Scroll suave / animado. El scroll de ProseMirror es un salto de `scrollTop`; que el
  incremento sea de una línea alcanza para que no se note.
- Los otros bugs de caret anotados en `TODO.md` (cursor fantasma, marcador naranja
  huérfano). Son estado que no se limpia, problema distinto.

## Decisiones de diseño

- **Scrolloff, no typewriter.** La vista queda quieta mientras el caret esté cómodo y solo
  se mueve cuando entra en la zona de guarda del borde. Es el comportamiento de vim
  (`scrolloff`) y de VS Code (`cursorSurroundingLines`).
- **`threshold == margin`.** Con los dos valores iguales, la condición de disparo y la
  posición de reposo coinciden: el caret entra en la zona y queda justo en el borde de la
  zona. El scroll resultante es de exactamente una línea por línea nueva — nunca un salto
  grande que reubique el párrafo.
- **El respiro escala con la fuente.** El tamaño del editor es configurable (12–28px,
  default 17). Una constante en px daría ~4 líneas de respiro a 12px y ~1.6 a 28px. Se
  calcula desde el `line-height` computado, así que son 2 líneas en toda la escala.
- **Se reusa la matemática de ProseMirror.** El bug es "falta margen", no "el cálculo de
  PM está mal". Setear dos props es menos superficie que reimplementar
  `scrollRectIntoView` vía el hook `handleScrollToSelection` (que además reemplazaría el
  scroll de PM en *todos* los paths: Enter, paste, undo, flechas).
- **El factor de `line-height` no se duplica en el TS.** El SCSS usa 1.5 en el editor de
  capítulos y 1.55 en notas; hardcodear esos números en TypeScript los deja a merced del
  drift cuando alguien edite el SCSS. Se lee el computado de `view.dom` y el factor
  aparece solo como fallback defensivo.

## Diseño

### Módulo puro: `src/app/editor/caret-scrolloff.ts`

Sin DOM, sin Angular — mismo patrón que `popover-position.ts`, testeable con el smoke
runner de `tsc` a tmpdir.

```ts
/** Líneas de respiro entre el caret y el borde del viewport. */
export const SCROLLOFF_LINES = 2;

/** Factor de fallback, alineado con el `line-height` del SCSS del editor. */
export const FALLBACK_LINE_HEIGHT = 1.5;

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
 * `getComputedStyle` devuelve px cuando el valor resuelve ("25.5px"), pero
 * `normal` queda sin resolver y en teoría puede venir un valor no parseable.
 * En esos casos cae al factor del SCSS por el tamaño de fuente activo.
 */
export function lineHeightPxFrom(computed: string, fontSizePx: number): number;

/**
 * Threshold y margin en px para los `editorProps` de ProseMirror.
 * Iguales entre sí a propósito (ver Decisiones de diseño).
 */
export function caretScrolloff(lineHeightPx: number, lines?: number): ScrolloffProps;
```

`caretScrolloff` devuelve `top` y `bottom` en `Math.round(lineHeightPx * lines)` y
`left`/`right` en `0` — el host es `overflow-x: hidden`, no hay scroll horizontal que
amortiguar. El respiro es **simétrico**: mover el caret hacia arriba con las flechas
también deja 2 líneas de contexto arriba, no lo pega al techo.

Ambas funciones son defensivas con entradas basura (`NaN`, negativos, `0`): el resultado
nunca es negativo ni `NaN`, porque un inset inválido rompería la aritmética de
`scrollRectIntoView` y dejaría el scroll trabado.

### Wiring en los componentes

En cada uno de los dos componentes, el objeto `editorProps` que hoy está inline en
`createEditor()` pasa a un método privado:

```ts
private buildEditorProps(fontSizePx: number): EditorProps {
  const lineHeightPx = this.tiptap
    ? lineHeightPxFrom(getComputedStyle(this.tiptap.view.dom).lineHeight, fontSizePx)
    : fontSizePx * FALLBACK_LINE_HEIGHT;
  return {
    attributes: { /* spellcheck / autocorrect / … sin cambios */ },
    ...caretScrolloff(lineHeightPx),
  };
}
```

En `createEditor()` todavía no existe `this.tiptap` (se está construyendo), así que esa
primera llamada cae al fallback. Para no depender de eso, `createEditor()` reaplica una
sola vez inmediatamente después de instanciar, cuando ya hay `view.dom` del que leer el
computado:

```ts
this.tiptap = new TipTapEditor({ /* … */ editorProps: this.buildEditorProps(this.fontSize()) });
// Ahora sí existe view.dom: releer el line-height real y reaplicar.
this.tiptap.setOptions({ editorProps: this.buildEditorProps(this.fontSize()) });
```

Es explícito y no depende del orden relativo entre este método y el effect de abajo (los
effects de Angular corren al menos una vez, pero cuándo respecto de la carga del capítulo
no está garantizado — que el reapply sea idempotente lo hace irrelevante).

El effect nuevo reaplica los props cuando cambia el tamaño de fuente:

```ts
effect(() => {
  const px = this.fontSize();          // única dependencia trackeada
  if (!this.tiptap) return;
  this.tiptap.setOptions({ editorProps: this.buildEditorProps(px) });
});
```

Dos detalles de TipTap que condicionan la forma del código:

- `setOptions` hace un spread **shallow** sobre `this.options` y después
  `view.setProps(this.options.editorProps)` (`@tiptap/core/dist/index.js:4837`). Reemplaza
  la key `editorProps` entera, no la mergea. De ahí que `buildEditorProps()` tenga que
  devolver también los `attributes`: si se pasara solo el scrolloff, `options.editorProps`
  quedaría sin los atributos anti-corrector (ProseMirror los conservaría porque su
  `setProps` sí mergea, pero el objeto de TipTap quedaría inconsistente y el próximo
  `setEditable` — que llama `setOptions` — reaplicaría el objeto incompleto).
- `setOptions` cierra con `view.updateState(this.state)` sin flag de scroll, así que cae en
  el path `"preserve"` de `updateStateInner` (guarda y restaura la posición de scroll). El
  cambio de fuente no mueve la vista por culpa de este effect.

Si el effect corre antes de que exista el editor, sale por el guard y no reagenda (
`this.tiptap` no es signal, pasar de `null` a instancia no lo despierta) — pero el reapply
de `createEditor()` cubre ese caso, así que el guard no pierde nada.

## No-regresión

El scrolloff solo entra en juego por transacciones marcadas `scrollIntoView()`. Los dos
paths de scroll que la app maneja a mano no pasan por ahí:

1. **Restauración al abrir capítulo/nota** (`editor.ts:426-467`,
   `notes-editor.ts:149-175`). Termina en `hostRef.nativeElement.scrollTop = 0`
   *después* de `setContent`/`setTextSelection`, y el `focus` de cursor-restore va
   explícitamente con `{ scrollIntoView: false }`. La asignación directa de `scrollTop`
   gana sobre cualquier scroll que PM haya hecho sincrónicamente antes.
2. **Salto de búsqueda** (`core/search-highlight.ts:129`). Usa
   `parentEl.scrollIntoView({ block: 'center' })` nativo del DOM — no toca ProseMirror.

Ninguno de los dos se modifica. Los dos se verifican a mano.

## Testing

- `scripts/run-caret-scrolloff-smoke.mjs`, calcado de `run-popover-position-smoke.mjs`:
  compila `caret-scrolloff.ts` a un tmpdir con `tsc` y corre las aserciones con
  `node:assert`. Casos:
  - `lineHeightPxFrom("25.5px", 17)` → `25.5`.
  - `lineHeightPxFrom("normal", 17)` → `25.5` (fallback 1.5).
  - `lineHeightPxFrom("", 17)` y un valor no parseable → fallback, sin `NaN`.
  - `caretScrolloff(25.5)` → insets de 51 arriba/abajo, 0 a los costados.
  - `caretScrolloff` a 12px y a 28px de fuente → 36 y 84, confirmando el escalado.
  - `lines` custom (3) y simetría `top === bottom`.
  - Entradas basura (`NaN`, negativo, `0`) → insets `>= 0`, nunca `NaN`.
- `pnpm build` sin errores.

## Verificación manual (la hace el autor)

1. Tipear al final de un capítulo largo hasta pasar el borde inferior: la línea nueva
   queda con ~2 líneas de aire abajo, y el scroll avanza de a una línea sin saltos.
2. Ídem con flecha arriba desde la primera línea visible: queda con aire arriba.
3. Cambiar el tamaño de fuente (`Ctrl/Cmd +/-`) y repetir: el respiro escala y la vista
   **no** salta al cambiar de tamaño.
4. Abrir un capítulo que se cerró con el cursor al final: la vista arranca arriba
   (`scrollTop = 0`), como hoy.
5. `Ctrl+F` → click en un resultado: el salto sigue centrando el match.
6. Repetir 1 y 3 en el editor de notas.
