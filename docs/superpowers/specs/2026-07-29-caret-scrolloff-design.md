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

Cubre las tres superficies tipeables (`markdown-reader` tiene modo edit —
`this.svc.editing()` gatea `editable` en su `createEditor()` — así que también
tiene caret y transacciones `scrollIntoView()` que seguir; no es read-only):

- `src/app/editor/editor.ts` — editor de capítulos.
- `src/app/notes-editor/notes-editor.ts` — editor de notas.
- `src/app/markdown-reader/markdown-reader.ts` — modo edit del visor de notas
  Markdown. Sin tamaño de fuente configurable (fijo en el SCSS), así que no
  suma el effect de `editorFontSize` que sí tienen los otros dos.

Quedan **fuera**:

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

`caretScrolloff` devuelve `top` y `bottom` en `Math.round(lineHeightPx * lines)`, iguales
entre `scrollThreshold` y `scrollMargin` — ese es el respiro vertical, y es **simétrico**:
mover el caret hacia arriba con las flechas también deja 2 líneas de contexto arriba, no
lo pega al techo.

En `left`/`right` los dos objetos NO son iguales: `scrollThreshold` queda en `0` y
`scrollMargin` en `PM_DEFAULT_SCROLL_MARGIN_X` (`5`, el default histórico de
`scrollMargin` de ProseMirror). No alcanza con "el host es `overflow-x: hidden`" como
justificación para aplastar los dos a `0` — cierto para `.editor-host` (`editor.scss:110`)
pero falso para notas: `notes-editor.scss` solo setea `overflow-y` en el host, y su `pre`
de code block es `overflow-x: auto`, un scroller horizontal real que `scrollRectIntoView`
recorre al subir por los ancestros. Con `0` en los dos ejes, tipear una línea larga dentro
de un code block de nota dejaba el caret pegado al borde derecho del `pre` — una
regresión respecto del comportamiento nativo de PM. Manteniendo `threshold` en `0` el
punto de disparo en X no cambia, y con `margin` en `5` la posición de reposo en X tampoco
cambia: el eje horizontal queda bit a bit como estaba antes del scrolloff.

Ambas funciones son defensivas con entradas basura (`NaN`, negativos, `0`): el resultado
nunca es negativo ni `NaN`, porque un inset inválido rompería la aritmética de
`scrollRectIntoView` y dejaría el scroll trabado.

### Wiring en los componentes

**Ruling del autor**: la primera versión de este plan mandaba un método privado
`buildEditorProps(fontSizePx: number): EditorProps` duplicado en cada componente, leyendo
`this.tiptap`. Se descartó (commit `a92d91b`) a favor de **una sola función compartida**
— los tres componentes tienen exactamente los mismos 6 atributos anti-corrector y el mismo
cálculo de insets, así que no hay razón de dominio para triplicarla, y una función pura
(sin `this`) es más fácil de testear y de leer.

`src/app/editor/editor-props.ts` expone el adaptador DOM que consumen los tres:

```ts
export function buildEditorProps(dom: HTMLElement | null, fontSizePx: number): EditorProps {
  const lineHeightPx = dom
    ? lineHeightPxFrom(getComputedStyle(dom).lineHeight, fontSizePx)
    : fontSizePx * FALLBACK_LINE_HEIGHT;
  return {
    attributes: { /* spellcheck / autocorrect / … */ },
    ...caretScrolloff(lineHeightPx),
  };
}
```

**Contrato del parámetro `dom`**: es `view.dom` del editor, o `null` si todavía no existe.
En `createEditor()`, al momento de armar el literal de `new TipTapEditor({ ... })`,
`this.tiptap` (o `this.svc`/lo que sea que lo exponga) todavía se está construyendo — no
hay `view.dom` del que leer el `line-height` computado, así que esa primera llamada pasa
`null` y cae al factor de fallback (`fontSizePx * FALLBACK_LINE_HEIGHT`):

```ts
this.tiptap = new TipTapEditor({ /* … */ editorProps: buildEditorProps(null, fontSizePx) });
```

Inmediatamente después, ya con `view.dom` real, cada componente reaplica una sola vez:

```ts
this.tiptap.setOptions({
  editorProps: buildEditorProps(this.tiptap.view.dom, fontSizePx),
});
```

Es explícito y no depende del orden relativo entre esta reaplicación y el effect de
fuente (ver abajo): los effects de Angular corren al menos una vez, pero cuándo respecto
de la carga del capítulo/nota no está garantizado — que el reapply sea idempotente lo hace
irrelevante.

En capítulos y notas, que tienen tamaño de fuente configurable (`editorFontSize`, 12–28px),
un effect adicional reaplica los props cuando cambia:

```ts
effect(() => {
  const px = this.fontSize();          // única dependencia trackeada
  const editor = this.tiptap;
  if (!editor) return;
  editor.setOptions({ editorProps: buildEditorProps(editor.view.dom, px) });
});
```

`markdown-reader` **no** suma este effect: su `font-size` es fijo en el SCSS (sin
`--editor-font-size` ni señal propia), así que no hay nada a lo que reaccionar — solo
tiene el literal de construcción (con `null`) y el reapply post-instanciación (con
`FALLBACK_FONT_SIZE`, la única constante de tamaño disponible ahí).

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

Si el effect (en capítulos/notas) corre antes de que exista el editor, sale por el guard y
no reagenda (`this.tiptap` no es signal, pasar de `null` a instancia no lo despierta) —
pero el reapply de `createEditor()` cubre ese caso, así que el guard no pierde nada. En los
tres componentes, las lecturas de la señal de fuente dentro de `createEditor()` van
envueltas en `untracked(...)` porque `createEditor()` se invoca desde dentro del effect de
carga de capítulo/nota — sin eso, `editorFontSize` quedaría como dependencia espuria de ese
effect y un `Ctrl/Cmd +/-` lo re-entraría innecesariamente.

## No-regresión

El scrolloff solo entra en juego por transacciones marcadas `scrollIntoView()`. Los dos
paths de scroll que la app maneja a mano no pasan por ahí:

1. **Restauración al abrir capítulo/nota** (`editor.ts:430-469`,
   `notes-editor.ts:150-176`). Termina en `hostRef.nativeElement.scrollTop = 0`
   *después* de `setContent`/`setTextSelection`, y el `focus` de cursor-restore va
   explícitamente con `{ scrollIntoView: false }`. La asignación directa de `scrollTop`
   gana sobre cualquier scroll que PM haya hecho sincrónicamente antes.
2. **Salto de búsqueda** (`core/search-highlight.ts:129`). Usa
   `parentEl.scrollIntoView({ block: 'center' })` nativo del DOM — no toca ProseMirror.

Ninguno de los dos se modifica. Los dos se verifican a mano.

## Testing

- `scripts/run-caret-scrolloff-smoke.mjs`, calcado de `run-popover-position-smoke.mjs`:
  compila `caret-scrolloff.ts` a un tmpdir con `tsc` y corre las aserciones con
  `node:assert`. `lineHeightPxFrom`: 9 casos, `caretScrolloff`: 10 casos.
  - `lineHeightPxFrom("25.5px", 17)` → `25.5`.
  - `lineHeightPxFrom("normal", 17)` → `25.5` (fallback 1.5).
  - `lineHeightPxFrom("", 17)` y un valor no parseable → fallback, sin `NaN`.
  - `lineHeightPxFrom("0px", 17)` → `25.5` (el guard `> 0` rechaza `"0px"`, cae a fallback
    — caso agregado en la revisión final: antes solo estaba cubierto `lines = 0`, no
    `lineHeightPx` resuelto a `0`).
  - Dos casos con inputs elegidos para que el fallback y el resultado esperado
    **difieran** (`lineHeightPxFrom("  42px  ", 20)` → `42`, no `30`;
    `lineHeightPxFrom("30px", NaN)` → `30`, no `25.5`) — versión anterior de estos dos
    casos tenía el bug de que el valor esperado coincidía con el fallback, así que
    pasaban aunque el código estuviera roto (ej. borrando el `.trim()`).
  - `caretScrolloff(25.5)` → insets verticales de 51 (`scrollThreshold` y `scrollMargin`
    comparten el inset vertical); horizontal `scrollThreshold` en 0, `scrollMargin` en 5.
  - `caretScrolloff` a 12px y a 28px de fuente → 36 y 84, confirmando el escalado.
  - `lines` custom (3) y simetría `top === bottom` en cada objeto.
  - Entradas basura (`NaN`, negativo, `0`) → insets `>= 0`, nunca `NaN`; `caretScrolloff(0)`
    da los mismos insets que `caretScrolloff(NaN)` (agregado en la revisión final).
  - `scrollThreshold` y `scrollMargin` son objetos distintos (`notStrictEqual`), no un
    alias compartido.
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
