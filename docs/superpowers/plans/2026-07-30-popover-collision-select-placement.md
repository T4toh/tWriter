# Colisión de popovers + placement del select: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un click sobre una palabra con decoración de gramática **y** de RAE abra un solo popover (el de RAE), y que el panel de `app-select` se ubique con `placePopover` en vez de su propia matemática.

**Architecture:** Dos deudas independientes del PR #63. La primera colapsa los dos `addEventListener('click')` de `.editor-host` en uno solo, con la prioridad escrita en código en vez de heredada del orden de registro. La segunda hace que `select.ts` mida el panel ya renderizado (patrón de `grammar-popover.ts`) y delegue el lado, el clamp de X y el `maxHeight` en `placePopover`, borrando su `panelHeight = 320` duplicado y su flip por `transform`.

**Tech Stack:** Angular 21 (signals, standalone, `afterRenderEffect`), TipTap 3 / ProseMirror, TypeScript 5.9 strict, SCSS.

**Spec:** `docs/superpowers/specs/2026-07-30-popover-collision-select-placement-design.md`

**Branch:** `fix/popover-collision-select-placement` (ya creada, con el commit del spec).

## Global Constraints

- **Cero dependencias npm nuevas.** Nada de librerías de posicionamiento (`floating-ui` y compañía): `placePopover` ya existe y alcanza.
- **`src/app/editor/popover-position.ts` NO se toca.** Ya hace todo lo necesario y sus 9 casos de smoke tienen que seguir pasando idénticos — son la prueba de que la refactorización no movió la matemática que ahora comparten tres consumidores.
- **Convenciones del repo** (`CLAUDE.md`): standalone components, signals, `@if`/`@for`, sin `public` explícito, **return types explícitos en todos los métodos**, `inject()` para DI, comentarios y nombres de dominio en español.
- **RAE gana sobre gramática** cuando las dos decoraciones matchean. La prioridad va escrita como dos `if` en orden explícito, no como `stopImmediatePropagation()` + orden de registro.
- **No se fusionan los dos popovers** en uno con dos secciones: fuera de alcance por el spec.
- **El `max-height: 320px` de `select.scss` se queda** y sigue siendo la única fuente de verdad del cap. Lo que se borra es la copia en TypeScript. No se parsea el computed style: el panel ya sale capeado (ver Task 2).
- **`pnpm build` tiene que pasar** al cerrar cada task que toque `src/app/`.
- **Este cambio no suma tests automáticos** — todo lo nuevo es DOM y componente. No inventar una función pura para tener algo verde. La verificación es el checklist manual del spec, que el autor corre con la app levantada.
- **El item de `TODO.md` NO se marca `[x]`** en este plan: la verificación manual la hace el autor.

---

### Task 1: Un solo handler de click en el host del editor

Hoy hay dos listeners de `click` sobre el mismo nodo (`.editor-host`). El `event.stopPropagation()` que ya tienen corta el bubbling hacia los ancestros, no los demás listeners del mismo elemento, así que los dos corren y los dos popovers se abren. Se unifican en uno.

**Files:**
- Modify: `src/app/editor/editor.ts` — campos privados (`363-364`), `ngOnDestroy` (`665-672`), los dos handlers (`1169-1218`), el registro en `createEditor` (`1315-1324`)

**Interfaces:**
- Consumes: nada de tasks anteriores.
- Produces: nada que consuman otras tasks. Todo es privado de la clase `Editor`.

- [ ] **Step 1: Reemplazar los dos campos de listener por uno**

En `src/app/editor/editor.ts`, líneas 363-364, esto:

```ts
  private grammarHostListener: ((e: MouseEvent) => void) | null = null;
  private raeHostListener: ((e: MouseEvent) => void) | null = null;
```

pasa a:

```ts
  private hostClickListener: ((e: MouseEvent) => void) | null = null;
```

- [ ] **Step 2: Convertir los dos handlers en `openRaePopover` / `openGrammarPopover` + un dispatcher**

Los dos métodos actuales (`onRaeHostClick` en `1169-1186` y `onGrammarHostClick` en `1188-1218`) se reemplazan por tres. El dispatcher decide, y cada `open*` recibe el span ya resuelto — el cuerpo es el que ya existía, menos el `closest()` y el early-return, más el cierre explícito del otro popover:

```ts
  /**
   * Único listener de click del host. Los dos popovers (gramática y RAE) se
   * anclan a decoraciones que pueden solaparse sobre la misma palabra — un
   * verbo dicendi tras una raya suele tener las dos — y antes había un listener
   * por popover sobre este mismo nodo: `stopPropagation()` no corta al hermano
   * (para eso haría falta `stopImmediatePropagation()`), así que los dos
   * abrían y quedaban superpuestos. Con un solo handler la prioridad se lee
   * acá en vez de depender de cuál se registró primero.
   */
  private onHostClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const raeSpan = target?.closest('.rae-violation') as HTMLElement | null;
    const grammarSpan = target?.closest('.grammar-error') as HTMLElement | null;
    // RAE gana: es regla propia y determinista, y su popover ofrece el fix del
    // conversor. LanguageTool es opinable y justo sobre rayas y verbos dicendi
    // es donde más falsea.
    if (raeSpan) {
      this.openRaePopover(raeSpan, event);
      return;
    }
    if (grammarSpan) {
      this.openGrammarPopover(grammarSpan, event);
      return;
    }
    if (this.raePopover()) this.raePopover.set(null);
    if (this.grammarPopover()) this.closeGrammarPopover();
  }

  private openRaePopover(span: HTMLElement, event: MouseEvent): void {
    const idx = parseInt(span.dataset['raeIdx'] ?? '-1', 10);
    const v = this.raeViolations()[idx];
    if (!v) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.grammarPopover()) this.closeGrammarPopover();
    const rect = span.getBoundingClientRect();
    this.raePopover.set({
      violation: v,
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
    });
  }

  private openGrammarPopover(span: HTMLElement, event: MouseEvent): void {
    const idx = parseInt(span.dataset['grammarIdx'] ?? '-1', 10);
    const m = this.grammarMatches()[idx];
    if (!m) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.raePopover()) this.raePopover.set(null);
    const rect = span.getBoundingClientRect();
    // El diccionario de la saga hasta ahora solo silenciaba falsos positivos.
    // Para los TYPOS también aporta candidatos: si el autor escribió mal un
    // nombre propio del mundo, LT nunca lo va a ofrecer.
    const word = this.tiptap?.state.doc.textBetween(m.from, m.to, ' ').trim() ?? '';
    const dictSuggestions =
      m.category === 'TYPOS' && word.length > 0
        ? suggestFromDictionary(word, this.sagaCtx.dictionaryWords(), 3).filter(
            (s) => !m.replacements.some((r) => r.toLowerCase() === s.toLowerCase()),
          )
        : [];
    this.grammarPopover.set({
      match: m,
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
      from: m.from,
      to: m.to,
      dictSuggestions,
    });
  }
```

Ojo con dos detalles que **no** cambian: el `preventDefault()` + `stopPropagation()` sobre el span sigue ahí (evita que el click burbujee y cierre lo que se acaba de abrir), y `closeGrammarPopover()` es un método que ya existe en `editor.ts:1048` — no lo redefinas.

- [ ] **Step 3: Registrar un solo listener en `createEditor`**

En `createEditor()`, el bloque de las líneas 1315-1324 (los dos `if (this.…HostListener)` + los dos `addEventListener`) queda:

```ts
    if (this.hostClickListener) {
      this.hostRef.nativeElement.removeEventListener('click', this.hostClickListener);
    }
    this.hostClickListener = (e) => this.onHostClick(e);
    this.hostRef.nativeElement.addEventListener('click', this.hostClickListener);
```

- [ ] **Step 4: Limpiar `ngOnDestroy`**

En `ngOnDestroy` (líneas 665-672), los dos bloques de `removeEventListener` quedan en uno. El bloque de `popoverScrollListener` que viene después **no se toca**:

```ts
    if (this.hostClickListener) {
      this.hostRef.nativeElement.removeEventListener('click', this.hostClickListener);
      this.hostClickListener = null;
    }
```

- [ ] **Step 5: Verificar que no quedó ninguna referencia a los nombres viejos**

Run: `grep -rn "grammarHostListener\|raeHostListener\|onGrammarHostClick\|onRaeHostClick" src/`
Expected: sin resultados. Si aparece alguno, es una referencia huérfana que hay que migrar.

- [ ] **Step 6: Verificar que compila**

Run: `pnpm build`
Expected: build de Angular sin errores (los warnings de budget/CJS son preexistentes). Tarda un par de minutos.

- [ ] **Step 7: Commit**

```bash
git add src/app/editor/editor.ts
git commit -m "fix(editor): un solo popover cuando la palabra tiene gramática y RAE

Los dos listeners de click vivían en el mismo nodo (.editor-host), así que
el stopPropagation() que ya tenían no cortaba al hermano — para eso haría
falta stopImmediatePropagation() — y una palabra con las dos decoraciones
abría los dos popovers superpuestos. Ahora hay un handler único con la
prioridad escrita: gana RAE, que es regla propia y determinista y cuyo
popover ofrece el fix del conversor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: El panel de `app-select` se mide y usa `placePopover`

`measurePanel()` estima la altura con un `320` hardcodeado porque corre **antes** de `open.set(true)` y el contenido del panel está detrás de un `@if (open())`: en ese momento el panel mide 0. Se invierte el orden y se mide en un `afterRenderEffect`, como hace `grammar-popover.ts:105-140`.

**Files:**
- Modify: `src/app/shared/select.ts` — imports (`1-16`), signals del panel (`83-86`), `openPanel()` (`192-204`), `onViewportChange()` (`310-314`), `measurePanel()` (`316-325`)
- Modify: `src/app/shared/select.html` — el `<div #panel>` (`17-26`)
- Modify: `src/app/shared/select.scss` — `.sel-panel` (`73-101`) y el keyframe `sel-fade-up` (`114-122`)

**Interfaces:**
- Consumes: `placePopover(anchor, size, viewport, gap?, margin?)` y el tipo `Placement` de `../editor/popover-position` (existente, no se modifica). `Placement` es `{ x: number; y: number; placement: 'below' | 'above'; maxHeight: number }`.
- Produces: nada que consuman otras tasks.

- [ ] **Step 1: Sumar los imports**

En `src/app/shared/select.ts`, agregar `afterRenderEffect` a la lista de imports de `@angular/core` (ya trae `afterNextRender`, `computed`, `signal`, `viewChild`, etc. — mantené el orden alfabético del bloque), y el import del módulo de posicionamiento junto a los otros relativos:

```ts
import { Placement, placePopover } from '../editor/popover-position';
```

Sí, `shared/` importando de `editor/`: es el patrón que ya usa el repo para esa función (`notes-editor` la alcanza igual vía `../editor/`), y mover `popover-position.ts` a `shared/` es un refactor que este plan no pide.

- [ ] **Step 2: Reemplazar los signals de posición**

Las líneas 83-86:

```ts
  protected readonly panelTop = signal(0);
  protected readonly panelLeft = signal(0);
  protected readonly panelWidth = signal(0);
  protected readonly panelFlipUp = signal(false);
```

pasan a:

```ts
  /** `null` hasta la primera medición: el panel se renderiza invisible para que
   *  no se vea el salto desde la posición inicial. */
  protected readonly placed = signal<Placement | null>(null);
  /** `min-width` del panel = ancho del trigger, para que no quede más angosto. */
  protected readonly panelWidth = signal(0);
  /** `max-height` a bindear, o `null` cuando el panel entró completo. Bindearlo
   *  siempre puede dejar el tope un pixel más corto que el alto real (las
   *  medidas del DOM son enteros redondeados) y hacer aparecer un scrollbar
   *  espurio con lugar de sobra adentro. Mismo pozo que en `grammar-popover.ts`. */
  protected readonly clippedMaxHeight = signal<number | null>(null);
  private readonly resizeTick = signal(0);
```

- [ ] **Step 3: Medir y ubicar en un `afterRenderEffect`**

Dentro del `constructor()` (que hoy solo tiene el `afterNextRender` del portal, líneas 93-103), **después** de ese bloque, agregar:

```ts
    // Medición real: el alto depende de cuántas opciones haya y del filtro, así
    // que no se puede estimar desde el CSS — antes se asumía el `max-height` de
    // 320px y el panel se cortaba o se salía de pantalla. Se mide el panel ya
    // renderizado y se ubica en el mismo ciclo.
    afterRenderEffect(() => {
      this.resizeTick();
      const isOpen = this.open();
      // Se leen para remedir cuando cambia el contenido: filtrar acorta la lista.
      this.filter();
      this.visibleOptions();
      const el = this.panelEl()?.nativeElement;
      if (!isOpen || !el) {
        this.placed.set(null);
        this.clippedMaxHeight.set(null);
        return;
      }
      const rect = this.elRef.nativeElement.getBoundingClientRect();
      // `offsetHeight` es border-box y ya viene capeado por el `max-height` del
      // SCSS: la lista interna (`.sel-list`, `overflow-y: auto; flex: 1`) encoge
      // y scrollea en vez de empujar al panel. Distinto del popover de
      // gramática, que no tiene cap ni scroller y hay que preguntarle cuánto
      // *querría* medir con `scrollHeight`.
      const height = el.offsetHeight;
      // El panel lleva `min-width` = ancho del trigger, y ese bind se aplica
      // DESPUÉS de esta medición en el primer render: si le pasáramos el
      // `offsetWidth` crudo, el clamp de X se calcularía con un ancho más chico
      // que el final y el panel podría salirse igual por la derecha. El ancho
      // efectivo es el mayor de los dos.
      const width = Math.max(el.offsetWidth, rect.width);
      this.panelWidth.set(rect.width);
      const result = placePopover(
        { left: rect.left, top: rect.top, bottom: rect.bottom },
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
        4, // gap: preserva la separación visual de antes (`rect.bottom + 4`)
      );
      this.placed.set(result);
      this.clippedMaxHeight.set(result.maxHeight < height ? result.maxHeight : null);
    });
```

- [ ] **Step 4: Invertir el orden en `openPanel()` y sacar `measurePanel()`**

`openPanel()` (líneas 192-204) llama `this.measurePanel()` como primera cosa, antes de `open.set(true)`. Esa llamada **se borra** — el `afterRenderEffect` mide cuando el panel ya existe. El resto del método queda igual:

```ts
  protected openPanel(): void {
    if (this.isDisabled()) return;
    this.filter.set('');
    const vals = this.visibleOptions();
    const cur = this.value();
    const idx = vals.findIndex((o) => o.value === cur);
    this.highlightIdx.set(idx >= 0 ? idx : 0);
    this.open.set(true);
    if (this.showFilter()) {
      queueMicrotask(() => this.filterInput()?.nativeElement.focus());
    }
  }
```

Y el método `measurePanel()` completo (líneas 316-325) se **elimina**.

- [ ] **Step 5: Enganchar `resizeTick` a los listeners de viewport**

`onViewportChange()` (líneas 310-314) llamaba a `measurePanel()`. Ahora bumpea el tick, que es lo que el effect lee:

```ts
  @HostListener('window:resize')
  @HostListener('window:scroll')
  protected onViewportChange(): void {
    if (this.open()) this.resizeTick.update((n) => n + 1);
  }
```

- [ ] **Step 6: Actualizar el template**

En `src/app/shared/select.html`, el `<div #panel>` (líneas 17-26) queda:

```html
<div
  #panel
  class="sel-panel"
  [class.is-open]="open()"
  [class.sel-panel--measuring]="placed() === null"
  [style.top.px]="placed()?.y ?? 0"
  [style.left.px]="placed()?.x ?? 0"
  [style.max-height.px]="clippedMaxHeight()"
  [style.minWidth.px]="panelWidth()"
  (keydown)="onPanelKeydown($event)"
>
```

Cambios: se fue `[class.flip-up]`, entró `[class.sel-panel--measuring]`, `top`/`left` salen de `placed()` y se sumó el `max-height` inline. El `@if (open())` que viene abajo y el resto del contenido **no se tocan**.

- [ ] **Step 7: Actualizar el SCSS**

En `src/app/shared/select.scss`:

1. El `max-height: 320px` de `.sel-panel` (línea 84) **se queda** — es el cap de diseño y la única fuente de verdad. El `max-height` inline del Step 6 solo lo baja cuando el viewport es más chico.
2. Agregar, dentro del bloque `.sel-panel` (junto a `&.is-open`), el estado de medición:

```scss
  // Medido pero todavía sin ubicar: visible para el layout (hace falta para
  // medirlo) pero no para el ojo, así no se ve el salto desde el 0,0 inicial.
  &.sel-panel--measuring {
    visibility: hidden;
  }
```

3. Borrar el bloque `.sel-panel.flip-up.is-open` completo (líneas 98-101) y el keyframe `@keyframes sel-fade-up` completo (líneas 114-122). `placePopover` devuelve el `y` absoluto del borde superior, así que ya no hay `transform: translateY(-100%)` que animar: los dos lados usan `sel-fade`.
4. En el bloque `@media (prefers-reduced-motion: reduce)` (líneas 125-130), borrar el selector `.sel-panel.flip-up.is-open` de la lista, dejando solo `.sel-panel.is-open`.

- [ ] **Step 8: Verificar que no quedó nada huérfano**

Run: `grep -rn "flip-up\|panelFlipUp\|sel-fade-up\|panelTop\|panelLeft\|measurePanel" src/`
Expected: sin resultados.

- [ ] **Step 9: Verificar que compila y que `placePopover` sigue intacto**

Run: `pnpm build && node scripts/run-popover-position-smoke.mjs && git diff --stat src/app/editor/popover-position.ts`
Expected: build sin errores; `placePopover: 9/9 ok`; el `git diff --stat` sin salida (el archivo no se tocó).

- [ ] **Step 10: Commit**

```bash
git add src/app/shared/select.ts src/app/shared/select.html src/app/shared/select.scss
git commit -m "fix(select): ubicar el panel con placePopover en vez de matemática propia

measurePanel() corría antes de open.set(true), con el contenido detrás de un
@if(open()), así que el panel medía 0 y la altura se estimaba con un 320
hardcodeado que duplicaba el max-height del SCSS. Ahora se mide el panel ya
renderizado en un afterRenderEffect (patrón de grammar-popover.ts) y
placePopover decide el lado.

De yapa arregla dos bugs que nadie había anotado: no había clamp horizontal
(un select con opciones largas cerca del borde derecho se salía de la
pantalla) y el contenido se cortaba si no entraba ni arriba ni abajo, en vez
de scrollear adentro. Se van el transform: translateY(-100%) y el keyframe
sel-fade-up: con el y absoluto los dos lados comparten sel-fade.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Documentar en `TODO.md`

Las dos deudas están anotadas dentro del item `[x] Control total del tipeo` (el del PR #63), en su párrafo final de "Deuda anotada aparte". Ese párrafo se actualiza para reflejar que se cobraron, sin marcar nada nuevo: la verificación manual la hace el autor.

**Files:**
- Modify: `TODO.md` — el párrafo de deuda al final del item de "Control total del tipeo"

**Interfaces:**
- Consumes: nada de código.
- Produces: nada de código.

- [ ] **Step 1: Localizar el párrafo exacto**

Run: `grep -n "Deuda anotada aparte" TODO.md`

Son las líneas 106-109, dentro del item `[x] **Control total del tipeo…**`. Ojo: el párrafo **arranca a mitad de la línea 106**, después de `que se deja así.` — ese prefijo se conserva. El texto a reemplazar es exactamente:

```markdown
Deuda anotada aparte: una palabra con decoración de
  gramática **y** de RAE abre los dos popovers superpuestos (preexistente,
  necesita `stopImmediatePropagation()`), y `shared/select.ts` sigue con su
  `panelHeight = 320` y su propio flip en vez de usar `placePopover`.
```

Si el texto en el archivo no coincide palabra por palabra con eso, **no adivines**: reportá lo que encontraste antes de editar.

- [ ] **Step 2: Reemplazarlo**

Por este bloque (sin tocar el `que se deja así.` que lo precede en la misma línea):

```markdown
Deuda cobrada en `fix/popover-collision-select-placement` (spec en
  `docs/superpowers/specs/2026-07-30-popover-collision-select-placement-design.md`):
  (a) la palabra con las dos decoraciones abría los dos popovers porque los dos
  listeners de click vivían en el **mismo** nodo (`.editor-host`) — el
  `stopPropagation()` que ya tenían corta el bubbling, no al listener hermano, y
  `stopImmediatePropagation()` habría dejado la prioridad atada al orden de
  registro. Ahora hay un handler único con la prioridad escrita: **gana RAE**,
  que es regla propia y determinista y cuyo popover ofrece el fix del conversor.
  (b) `shared/select.ts` usa `placePopover`: mide el panel ya renderizado en un
  `afterRenderEffect` (antes `measurePanel()` corría antes de `open.set(true)`,
  con el contenido detrás de un `@if`, así que medía 0 y de ahí el `320`
  hardcodeado). De yapa gana el clamp horizontal que no tenía — un select con
  opciones largas cerca del borde derecho se salía de la pantalla — y el
  `maxHeight` con scroll interno en vez de cortarse. Se fueron el
  `transform: translateY(-100%)` y el keyframe `sel-fade-up`. **Falta
  verificación manual del autor** con la app levantada.
```

- [ ] **Step 3: Verificar que no se marcó nada nuevo ni se tocó otra cosa**

Run: `git diff --stat && git diff TODO.md`
Expected: un solo archivo modificado; en el diff, ningún `[x]` nuevo y ningún cambio fuera de ese párrafo.

- [ ] **Step 4: Commit**

```bash
git add TODO.md
git commit -m "docs: anotar las dos deudas del #63 como cobradas, pendientes de verificación manual

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verificación manual (la hace el autor, con la app levantada)

`pnpm tauri dev`, con LanguageTool corriendo en `:8081` (`./scripts/start-languagetool.sh`) para los puntos 1-4.

1. Capítulo en español con gramática y RAE prendidos, sobre una palabra que tenga las **dos** decoraciones (un verbo dicendi tras una raya suele servir): el click abre **solo** el popover de RAE.
2. Click en una palabra con solo decoración de gramática: abre el de gramática, y si estaba abierto el de RAE se cierra.
3. Click en zona sin decoración: se cierran los dos.
4. Aplicar un fix desde cada popover sigue funcionando — RAE: el replacement del conversor; gramática: un candidato de LT y uno del diccionario de la saga con su chip "tu diccionario".
5. `app-select` cerca del borde **derecho** de la pantalla (el selector de fuentes del theme editor, con nombres largos): el panel ya no se sale.
6. `app-select` cerca del borde **inferior**: abre hacia arriba, sin salto visible al abrir.
7. Ventana chica de alto, select con muchas opciones: el panel se limita y scrollea adentro en vez de cortarse — y **no** aparece un scrollbar cuando el contenido entra de sobra.
8. Scrollear el contenedor con un select abierto (el theme editor scrollea): el panel sigue al anchor.
9. Filtrar dentro de un select abierto cerca del borde inferior: al acortarse la lista el panel se reubica, no queda flotando.
