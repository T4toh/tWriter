# Colisión de popovers en el editor y ubicación del panel de `app-select`

Fecha: 2026-07-30

## Problema

Las dos deudas que quedaron anotadas al cerrar el PR #63. Son independientes entre sí, pero
las dos son la misma clase de bug — posicionamiento y prioridad de superficies flotantes — y
la segunda termina de cobrar la deuda que dejó `popover-position.ts` al nacer.

### 1. Los dos popovers del editor se abren superpuestos

Una palabra puede tener a la vez decoración de gramática (`.grammar-error`, de LanguageTool)
y de RAE (`.rae-violation`, de las reglas propias). El caso típico: LT marca el verbo dicendi
como error de mayúsculas o de concordancia justo donde el validador RAE marca la raya. Al
hacer click se abren **los dos popovers**, uno encima del otro.

La causa no es la que sugiere el `TODO.md`. Los dos listeners viven en el **mismo** nodo
(`.editor-host`, registrados en `editor.ts:1318-1324`), así que el `event.stopPropagation()`
que ya tienen (`editor.ts:1180`, `:1199`) no puede ayudar: corta el bubbling hacia los
ancestros, no los demás listeners del mismo elemento. Para eso haría falta
`stopImmediatePropagation()`, y aun así la prioridad quedaría determinada por el **orden de
registro** — hoy gramática primero, RAE después.

### 2. `select.ts` no usa `placePopover`

`popover-position.ts` nació en el PR #63 para que los popovers del editor dejaran de abrirse
fuera de pantalla. `shared/select.ts` quedó afuera y sigue con su propia matemática
(`select.ts:316-325`):

```ts
private measurePanel(): void {
  const rect = this.elRef.nativeElement.getBoundingClientRect();
  const panelHeight = 320;
  const spaceBelow = window.innerHeight - rect.bottom;
  const flipUp = spaceBelow < panelHeight && rect.top > spaceBelow;
  ...
}
```

Tres problemas concretos:

- **`panelHeight = 320` duplica el `max-height: 320px` de `select.scss:84`.** Dos fuentes de
  verdad para el mismo número, sin nada que falle si una se mueve.
- **Cero clamp horizontal.** `panelLeft` es `rect.left` pelado. El panel usa
  `min-width: <ancho del anchor>` pero el contenido puede ser más ancho (el selector de
  fuentes renderiza nombres largos), así que un select cerca del borde derecho se sale de la
  pantalla. `placePopover` clampea X desde que existe; el select nunca se enteró.
- **Contenido cortado.** Si no entra ni arriba ni abajo, el panel igual mide 320 y se corta.
  `placePopover` devuelve un `maxHeight` para que scrollee adentro.

La razón de fondo por la que se estimó la altura en vez de medirla: `measurePanel()` corre
**antes** de `open.set(true)` (`select.ts:194`) y el contenido del panel está detrás de un
`@if (open())`, así que en ese momento el panel mide 0.

## Alcance

- `src/app/editor/editor.ts` — unificar los dos listeners de click del host.
- `src/app/shared/select.ts` + `select.html` + `select.scss` — medir de verdad y delegar en
  `placePopover`.
- `src/app/editor/popover-position.ts` — **no se toca**: ya hace todo lo que hace falta (ver
  "El cap del CSS no hay que parsearlo" más abajo).

Queda **fuera**:

- **Fusionar los dos popovers en uno** con sección de gramática y sección de RAE. Se evaluó:
  mejor UX en teoría, pero es un componente nuevo y bastante más superficie que arreglar la
  colisión. Si el popover ganador resulta insuficiente en la práctica, entra como feature
  aparte.
- Los otros popovers/paneles de la app que no sean `app-select` (el menú contextual del
  árbol, los modales). No comparten el problema: no son flotantes anclados a un elemento.
- Los demás items abiertos del `TODO.md`.

## Decisiones de diseño

- **RAE gana sobre gramática.** Las violaciones RAE son reglas propias y deterministas, y su
  popover ofrece el fix del conversor; LanguageTool es opinable y justo sobre rayas y verbos
  dicendi es donde más falsea. El popover de gramática de esa palabra sigue alcanzable desde
  el panel de gramática.
- **La prioridad se escribe, no se hereda del orden de registro.** Un solo handler con dos
  `if` en orden explícito, en vez de dos listeners y un `stopImmediatePropagation()` cuyo
  efecto depende de cuál se registró primero.
- **Se descarta "gana el span más interno".** Suena natural, pero el anidamiento de los
  `<span>` lo decide el orden en que ProseMirror aplica las decoraciones, no la semántica:
  el ganador sería impredecible y cambiaría entre casos.
- **El `max-height` del SCSS sigue siendo la fuente de verdad del cap.** Es una decisión de
  diseño legítima ("un select no mide más de 320px ni en una pantalla enorme") y vive donde
  viven las decisiones de diseño. Lo que se elimina es la copia en TypeScript.
- **El cap del CSS no hay que parsearlo.** La primera versión de este diseño agregaba una
  función `cssMaxHeightPx` para leer el `320px` del computed style. Es innecesaria: el panel
  es flex-column con `overflow: hidden` y `max-height: 320px`, y su lista (`.sel-list`,
  `select.scss:154-159`) es `overflow-y: auto; flex: 1`. Como la lista tiene `overflow`
  distinto de `visible`, su tamaño mínimo automático resuelve a 0, así que **encoge y
  scrollea adentro en vez de empujar al panel**. El panel entonces nunca supera el cap y su
  `offsetHeight` ya es la altura real y capeada: medirlo alcanza. Menos código y una función
  pura menos que mantener — a cambio, esta parte no suma casos al smoke runner (ver Testing).
- **`placePopover` no se toca.** Ya hace lo que hace falta y tiene sus 9 casos verdes.

## Diseño

### Parte 1: un solo handler de click en el host del editor

`grammarHostListener` y `raeHostListener` colapsan en `hostClickListener`. Los cuerpos de
`onRaeHostClick` y `onGrammarHostClick` se mueven casi tal cual a `openRaePopover(span)` y
`openGrammarPopover(span)` — incluido el bloque de `suggestFromDictionary` que arma los
candidatos del diccionario de la saga — y cada uno cierra el popover del otro tipo al abrir
el suyo:

```ts
private onHostClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const raeSpan = target?.closest('.rae-violation') as HTMLElement | null;
  const grammarSpan = target?.closest('.grammar-error') as HTMLElement | null;
  // RAE gana: regla propia y determinista, y su popover ofrece el fix del conversor.
  if (raeSpan) {
    this.openRaePopover(raeSpan, event);
    return;
  }
  if (grammarSpan) {
    this.openGrammarPopover(grammarSpan, event);
    return;
  }
  this.closeBothPopovers();
}
```

Cerrar el otro popover al abrir uno ya pasaba de rebote: el early-return del handler que no
matcheaba lo cerraba. Ahora es explícito y no depende de que los dos listeners corran.

Los dos bloques de `removeEventListener` de `ngOnDestroy` (`editor.ts:665-672`) y los dos de
`createEditor` (`editor.ts:1315-1324`) se reducen a uno cada uno.

Comportamiento invariante: el click en un span sigue haciendo `preventDefault()` +
`stopPropagation()` (para que no burbujee al `.editor-host` y cierre lo que se acaba de
abrir), y el click en zona sin decoración sigue cerrando lo que hubiera abierto.

### Parte 2: el panel de `app-select` se mide y se ubica

`measurePanel()` desaparece. En su lugar, el patrón ya documentado de
`grammar-popover.ts:105-140`:

- `openPanel()` hace `open.set(true)` **primero**, para que el contenido exista y el panel
  tenga tamaño real.
- Un `afterRenderEffect` lee `open()` y un `resizeTick` (bumpeado por los `HostListener` de
  `window:resize` y `window:scroll` que ya existen en `select.ts:310-314`), mide el panel
  renderizado y llama a `placePopover`:

  ```ts
  const anchorRect = this.elRef.nativeElement.getBoundingClientRect();
  // `offsetHeight` es border-box y ya viene capeado por el `max-height` del SCSS:
  // la lista interna encoge y scrollea en vez de empujar al panel.
  const height = el.offsetHeight;
  const result = placePopover(
    { left: anchorRect.left, top: anchorRect.top, bottom: anchorRect.bottom },
    { width: el.offsetWidth, height },
    { width: window.innerWidth, height: window.innerHeight },
    4, // gap: preserva la separación visual actual (`rect.bottom + 4`)
  );
  ```

  A diferencia del popover de gramática, acá **no** se usa
  `scrollHeight + offsetHeight - clientHeight`. Ese cálculo existe en
  `grammar-popover.ts:128-131` porque ese popover no tiene cap ni scroller interno y crece
  libre, así que hay que preguntarle cuánto *querría* medir. El panel del select ya está
  capeado y con scroll adentro: lo que mide es lo que ocupa.

- `placed` es un `signal<Placement | null>`, `null` hasta la primera medición. Mientras es
  `null` el panel se renderiza con `visibility: hidden` (clase `sel-panel--measuring`) para
  que no se vea el salto desde la posición inicial.
- `max-height` inline se bindea **solo** cuando `result.maxHeight < height`. Bindearlo
  siempre puede dejar un tope un pixel más corto que el alto real (los `scrollHeight` /
  `offsetHeight` / `clientHeight` son enteros redondeados) y, con `overflow-y: auto`, hacer
  aparecer un scrollbar espurio con lugar de sobra adentro — el mismo pozo documentado en
  `grammar-popover.ts:97-101`.

**Lo que se borra:** el signal `panelFlipUp`, la clase `.flip-up`, el
`transform: translateY(-100%)` de `select.scss:98-101` y el keyframe `sel-fade-up`.
`placePopover` devuelve el `y` absoluto del borde superior, así que los dos lados quedan con
la misma animación `sel-fade`. `panelTop`/`panelLeft` pasan a venir de `placed()`;
`panelWidth` (el `min-width` del anchor) se mantiene como está.

## Testing

Este cambio **no suma tests automáticos**, y conviene decirlo en voz alta en vez de inventar
una función pura para tener algo que testear. Toda la lógica nueva es DOM y componente: el
handler unificado (qué `closest()` matcheó) y el wiring del panel (medir, ubicar, bindear). El
repo no tiene harness para eso — los `.spec.ts` existen pero no hay target `test` en
`angular.json`; el harness real son los `scripts/run-*-smoke.mjs` sobre funciones puras. La
matemática de posicionamiento, que es la parte que se puede equivocar en silencio, ya está
cubierta por los 9 casos de `placePopover`, y ahora el select los hereda en vez de tener su
propia versión sin cubrir.

- `node scripts/run-popover-position-smoke.mjs` verde y sin cambios (`placePopover: 9/9 ok`) —
  confirma que la refactorización no tocó la función que ahora comparten tres consumidores.
- El resto de los runners (`caret-scrolloff`, `rae`, `suggest`) verdes, y `cargo test` verde:
  red de seguridad, no cobertura de esto.
- `pnpm build` sin errores.
- El checklist manual de abajo es la verificación real.

## Verificación manual (la hace el autor)

1. Capítulo en español con gramática y RAE prendidos, sobre una palabra que tenga las **dos**
   decoraciones (un verbo dicendi tras una raya suele servir): click abre **solo** el popover
   de RAE.
2. Click en una palabra con solo decoración de gramática: abre el de gramática, y si estaba
   abierto el de RAE se cierra.
3. Click en zona sin decoración: se cierran los dos.
4. Aplicar un fix desde cada popover sigue funcionando (RAE: el replacement del conversor;
   gramática: un candidato de LT y uno del diccionario de la saga con su chip).
5. `app-select` cerca del borde **derecho** de la pantalla (el selector de fuentes del theme
   editor con nombres largos): el panel ya no se sale.
6. `app-select` cerca del borde **inferior**: abre hacia arriba, sin salto visible al abrir.
7. Ventana chica en altura, select con muchas opciones: el panel se limita y scrollea adentro
   en vez de cortarse, y no aparece un scrollbar cuando el contenido entra.
8. Scrollear el contenedor con un select abierto (el theme editor scrollea): el panel sigue
   al anchor.
