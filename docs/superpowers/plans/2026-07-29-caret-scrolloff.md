# Caret Scrolloff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el caret nunca quede pegado al borde del viewport al tipear — siempre con ~2 líneas de aire arriba y abajo, en el editor de capítulos y en el de notas.

**Architecture:** ProseMirror ya scrollea al tipear (`readDOMChange` marca sus transacciones con `scrollIntoView()`), pero `scrollRectIntoView` usa los defaults `scrollThreshold = 0` / `scrollMargin = 5px`. Se setean esos dos `editorProps` con insets calculados desde el `line-height` computado de `view.dom`, vía un módulo puro sin DOM, y se reaplican con `tiptap.setOptions()` cuando cambia el tamaño de fuente. Cero dependencias nuevas, cero Rust.

**Tech Stack:** Angular 21 (signals, standalone), TipTap 3 / ProseMirror, TypeScript 5.9 strict. Tests de funciones puras con el patrón `tsc` a tmpdir + `node:assert` que ya usa el repo (`scripts/run-popover-position-smoke.mjs`).

**Spec:** `docs/superpowers/specs/2026-07-29-caret-scrolloff-design.md`

**Branch:** `feat/caret-scrolloff` (ya creada, con el commit del spec).

## Global Constraints

- **Cero dependencias npm nuevas.** Todo sale de `@tiptap/core`, `@tiptap/pm/view` y el DOM.
- **Convenciones del repo** (`CLAUDE.md`): standalone components, signals, `@if`/`@for`, sin `public` explícito, **return types explícitos en todos los métodos**, `inject()` para DI, comentarios y nombres de dominio en español.
- **Naming de archivos**: `caret-scrolloff.ts` y `editor-props.ts`, sin sufijos tipo `.util.ts`.
- **Los `editorProps` viven en un solo lugar.** Los dos editores tipeables tienen hoy exactamente los mismos (los 6 atributos anti-corrector) y el mismo cálculo de insets, así que la función es compartida — no se duplica el bloque en cada componente. (Ruling del autor sobre el texto original de este plan, que mandaba duplicar; ver Task 2.)
- **`caret-scrolloff.ts` no toca el DOM ni importa nada.** Es lo que lo hace testeable con el runner de `tsc` aislado: si importara `@tiptap/pm/view` o usara `getComputedStyle`, la compilación del smoke runner necesitaría el `lib` de DOM y la resolución de subpath exports. Todo lo que toca DOM vive en `editor-props.ts`.
- **`threshold == margin`**: los dos insets se calculan del mismo valor. No divergen.
- **Insets simétricos**: `top === bottom`; `left === right === 0` (el host es `overflow-x: hidden`).
- **`SCROLLOFF_LINES = 2`**, **`FALLBACK_LINE_HEIGHT = 1.5`**, **`FALLBACK_FONT_SIZE = 17`** (espeja `FONT_DEFAULT` de `settings-service.ts:19`).
- **No tocar** los dos paths de scroll manual: la restauración al abrir (`editor.ts:426-467`, `notes-editor.ts:149-175`) y el salto de búsqueda (`core/search-highlight.ts:129`).
- **`pnpm build` tiene que pasar** al cerrar cada task que toque `src/app/`.
- **El item de `TODO.md` NO se marca `[x]`** en este plan: la verificación manual la hace el autor con la app levantada.
- **Enmienda (revisión final de `feat/caret-scrolloff`, post-Task 4)**: dos constraints de
  arriba describían el diseño original y quedaron desactualizadas — se anotan acá en vez de
  reescribirse, para no perder el rastro de por qué cambiaron.
  - `"threshold == margin"` y `"left === right === 0"` ya no son exactos tal cual. Lo que
    se mantiene: el inset **vertical** (`top`/`bottom`) sigue compartido entre
    `scrollThreshold` y `scrollMargin`. Lo que cambió: en `left`/`right`, `scrollThreshold`
    sigue en `0` pero `scrollMargin` pasó a `PM_DEFAULT_SCROLL_MARGIN_X` (`5`, el default
    histórico de `scrollMargin` de ProseMirror) — "el host es `overflow-x: hidden`" es
    cierto para `editor.scss` pero falso para `notes-editor.scss` (su `pre` de code block
    es `overflow-x: auto`, scroller real), así que aplastar los dos ejes a `0` regresionaba
    el respiro horizontal nativo de PM ahí.
  - `markdown-reader.ts` se sumó como tercer consumidor de `buildEditorProps()`: su modo
    edit (`this.svc.editing()` gatea `editable`) también tiene caret, no es read-only como
    asumía el texto original. No suma el effect de `editorFontSize` — su tamaño de fuente
    es fijo en el SCSS. Ver la sección "Alcance" y "Wiring en los componentes" de la spec.

---

### Task 1: Módulo puro `caret-scrolloff.ts` + smoke runner

Las dos funciones que traducen "2 líneas de respiro" a los insets en px que ProseMirror entiende. Sin DOM, sin Angular: entra un string de `getComputedStyle` y un número, salen números.

**Files:**
- Create: `src/app/editor/caret-scrolloff.ts`
- Create: `scripts/run-caret-scrolloff-smoke.mjs`

**Interfaces:**
- Consumes: nada (primera task).
- Produces:
  - `SCROLLOFF_LINES: number` (= 2)
  - `FALLBACK_LINE_HEIGHT: number` (= 1.5)
  - `FALLBACK_FONT_SIZE: number` (= 17)
  - `interface ScrolloffInsets { top: number; right: number; bottom: number; left: number }`
  - `interface ScrolloffProps { scrollThreshold: ScrolloffInsets; scrollMargin: ScrolloffInsets }`
  - `lineHeightPxFrom(computed: string, fontSizePx: number): number`
  - `caretScrolloff(lineHeightPx: number, lines?: number): ScrolloffProps`

- [ ] **Step 1: Escribir el smoke runner con los casos que fallan**

Crear `scripts/run-caret-scrolloff-smoke.mjs`. Es un calco de `scripts/run-popover-position-smoke.mjs` (compila el TS a un tmpdir con `tsc` en CommonJS y corre aserciones con `node:assert`):

```js
#!/usr/bin/env node
// Smoke runner de caret-scrolloff. No es parte del build de Angular.
// Compila el TS necesario a un dir temporal (CommonJS) y corre las aserciones.
// Uso: node scripts/run-caret-scrolloff-smoke.mjs
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'caret-scrolloff-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--allowSyntheticDefaultImports',
    '--outDir', outDir,
    'src/app/editor/caret-scrolloff.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

// Insets esperados: top/bottom iguales, costados en cero (host overflow-x: hidden).
const insets = (v) => ({ top: v, right: 0, bottom: v, left: 0 });
const props = (v) => ({ scrollThreshold: insets(v), scrollMargin: insets(v) });

let exitCode = 0;
try {
  const mod = await import(pathToFileURL(join(outDir, 'caret-scrolloff.js')).href);
  const { lineHeightPxFrom, caretScrolloff } = mod;

  // El fallback es 17 * 1.5 = 25.5px (FONT_DEFAULT del settings-service).
  const lineHeightCases = [
    ['px resuelto del editor de capítulos (17 * 1.5)', () => lineHeightPxFrom('25.5px', 17), 25.5],
    ['px resuelto del editor de notas (17 * 1.55)', () => lineHeightPxFrom('26.35px', 17), 26.35],
    ['normal → fallback 1.5', () => lineHeightPxFrom('normal', 17), 25.5],
    ['string vacío → fallback', () => lineHeightPxFrom('', 17), 25.5],
    ['sin unidad px (unitless) → fallback', () => lineHeightPxFrom('1.5', 17), 25.5],
    ['con espacios alrededor', () => lineHeightPxFrom('  42px  ', 28), 42],
    ['px válido gana aunque el fontSize sea basura', () => lineHeightPxFrom('25.5px', Number.NaN), 25.5],
    ['fontSize inválido con normal → fallback de fuente 17', () => lineHeightPxFrom('normal', 0), 25.5],
  ];

  const scrolloffCases = [
    ['2 líneas a 17px de fuente', () => caretScrolloff(25.5), props(51)],
    ['2 líneas a 12px (mínimo)', () => caretScrolloff(18), props(36)],
    ['2 líneas a 28px (máximo)', () => caretScrolloff(42), props(84)],
    ['redondea el line-height de notas (26.35 * 2)', () => caretScrolloff(26.35), props(53)],
    ['lines custom', () => caretScrolloff(25.5, 3), props(77)],
    ['line-height NaN → fallback 25.5 * 2', () => caretScrolloff(Number.NaN), props(51)],
    ['line-height negativo → fallback', () => caretScrolloff(-10), props(51)],
    ['lines 0 → default 2', () => caretScrolloff(25.5, 0), props(51)],
    ['lines negativo → default 2', () => caretScrolloff(25.5, -1), props(51)],
  ];

  let passed = 0;
  for (const [name, run, expected] of lineHeightCases) {
    const got = run();
    assert.deepStrictEqual(got, expected, `\n  case: ${name}\n  got:  ${JSON.stringify(got)}\n  exp:  ${JSON.stringify(expected)}`);
    passed++;
  }
  console.log(`lineHeightPxFrom: ${passed}/${lineHeightCases.length} ok`);

  passed = 0;
  for (const [name, run, expected] of scrolloffCases) {
    const got = run();
    assert.deepStrictEqual(got, expected, `\n  case: ${name}\n  got:  ${JSON.stringify(got)}\n  exp:  ${JSON.stringify(expected)}`);
    // threshold y margin son iguales por diseño, pero objetos distintos (no alias).
    assert.deepStrictEqual(got.scrollThreshold, got.scrollMargin, `threshold != margin en: ${name}`);
    assert.notStrictEqual(got.scrollThreshold, got.scrollMargin, `threshold y margin son el mismo objeto en: ${name}`);
    passed++;
  }
  console.log(`caretScrolloff: ${passed}/${scrolloffCases.length} ok`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

process.exit(exitCode);
```

- [ ] **Step 2: Correr el runner para verificar que falla**

Run: `node scripts/run-caret-scrolloff-smoke.mjs`
Expected: FAIL — `tsc` sale con status distinto de 0 y el stderr dice algo como
`error TS6053: File 'src/app/editor/caret-scrolloff.ts' not found.`

- [ ] **Step 3: Escribir el módulo**

Crear `src/app/editor/caret-scrolloff.ts`:

```ts
/**
 * Margen de respiro entre el caret y el borde del viewport del editor.
 *
 * ProseMirror ya scrollea al tipear (las transacciones de `readDOMChange` van
 * con `scrollIntoView()`), pero `scrollRectIntoView` usa sus defaults
 * `scrollThreshold = 0` / `scrollMargin = 5px`, así que el caret queda pegado
 * al borde del pane y se escribe a ciegas. Estas funciones traducen "N líneas
 * de aire" a los insets en px que esos dos `editorProps` esperan.
 *
 * Sin DOM a propósito: entra el string de `getComputedStyle(...).lineHeight` y
 * el tamaño de fuente activo, salen números. Los tests viven en
 * `scripts/run-caret-scrolloff-smoke.mjs`.
 */

/** Líneas de respiro entre el caret y el borde del viewport. */
export const SCROLLOFF_LINES = 2;

/** Factor de fallback, alineado con el `line-height` del SCSS del editor. */
export const FALLBACK_LINE_HEIGHT = 1.5;

/** Espeja `FONT_DEFAULT` de `settings-service.ts`. */
export const FALLBACK_FONT_SIZE = 17;

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
 *
 * `getComputedStyle` devuelve px cuando el valor resuelve (`"25.5px"`), pero
 * `normal` queda sin resolver. Se exige el sufijo `px` justamente para no
 * comerse un valor unitless (`"1.5"`) como si fueran 1.5 píxeles, que dejaría
 * el respiro en 3px y parecería que el fix no hizo nada.
 */
export function lineHeightPxFrom(computed: string, fontSizePx: number): number {
  const trimmed = computed.trim();
  if (trimmed.endsWith('px')) {
    const px = Number.parseFloat(trimmed);
    if (Number.isFinite(px) && px > 0) return px;
  }
  const fontSize = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : FALLBACK_FONT_SIZE;
  return fontSize * FALLBACK_LINE_HEIGHT;
}

/**
 * Threshold y margin en px para los `editorProps` de ProseMirror.
 *
 * Los dos valen lo mismo a propósito: la condición de disparo y la posición de
 * reposo coinciden, así que el caret entra en la zona de guarda y queda justo
 * en su borde — el scroll resultante es de una línea por línea nueva, sin
 * saltos que reubiquen el párrafo. Simétrico arriba y abajo (subir con las
 * flechas también deja contexto); costados en cero, el host no scrollea en X.
 *
 * Defensivo con entradas inválidas: un inset `NaN` o negativo rompería la
 * aritmética de `scrollRectIntoView` y dejaría el scroll trabado.
 */
export function caretScrolloff(lineHeightPx: number, lines: number = SCROLLOFF_LINES): ScrolloffProps {
  const safeLineHeight =
    Number.isFinite(lineHeightPx) && lineHeightPx > 0
      ? lineHeightPx
      : FALLBACK_FONT_SIZE * FALLBACK_LINE_HEIGHT;
  const safeLines = Number.isFinite(lines) && lines > 0 ? lines : SCROLLOFF_LINES;
  const inset = Math.round(safeLineHeight * safeLines);
  return {
    scrollThreshold: { top: inset, right: 0, bottom: inset, left: 0 },
    scrollMargin: { top: inset, right: 0, bottom: inset, left: 0 },
  };
}
```

- [ ] **Step 4: Correr el runner para verificar que pasa**

Run: `node scripts/run-caret-scrolloff-smoke.mjs`
Expected: PASS con
```
lineHeightPxFrom: 8/8 ok
caretScrolloff: 9/9 ok
```

- [ ] **Step 5: Commit**

```bash
git add src/app/editor/caret-scrolloff.ts scripts/run-caret-scrolloff-smoke.mjs
git commit -m "feat(editor): módulo puro de scrolloff del caret

Traduce 'N líneas de respiro' a los insets en px de scrollThreshold y
scrollMargin de ProseMirror. lineHeightPxFrom exige el sufijo px para no
comerse un line-height unitless como si fueran píxeles.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `editor-props.ts` compartido + enganche en el editor de capítulos

El adaptador DOM del módulo puro, más el primer consumidor. Los `editorProps` de los dos editores tipeables son hoy idénticos (los mismos 6 atributos anti-corrector), así que la función es una sola y vive fuera de los componentes.

**Files:**
- Create: `src/app/editor/editor-props.ts`
- Modify: `src/app/editor/editor.ts` (imports del tope; `createEditor()` en `1209-1308`; constructor, después del último effect que cierra en `637`)

**Interfaces:**
- Consumes: `FALLBACK_LINE_HEIGHT`, `caretScrolloff`, `lineHeightPxFrom` de `./caret-scrolloff` (Task 1).
- Produces: `buildEditorProps(dom: HTMLElement | null, fontSizePx: number): EditorProps` exportada de `src/app/editor/editor-props.ts`. Task 3 importa **esta misma función**, no replica nada.

- [ ] **Step 1: Crear `editor-props.ts`**

Crear `src/app/editor/editor-props.ts`:

```ts
import type { EditorProps } from '@tiptap/pm/view';
import { FALLBACK_LINE_HEIGHT, caretScrolloff, lineHeightPxFrom } from './caret-scrolloff';

/**
 * Props de ProseMirror compartidas por los dos editores tipeables (capítulos y
 * notas). Son una función y no un literal porque se reaplican al cambiar el
 * tamaño de fuente: el respiro del caret escala con la línea.
 *
 * Ojo con `setOptions`: reemplaza la key `editorProps` entera en vez de
 * mergearla, así que esta función tiene que devolver **todo** — si faltaran los
 * `attributes`, un `setEditable()` posterior los borraría.
 *
 * El OS no opina sobre el texto: sin corrector, sin autocorrección y sin
 * autocapitalización. Las comillas y rayas las hace Typography de TipTap.
 * Explícito acá además de heredado desde <html> como defensa en profundidad: si
 * algo intermedio (extensión, wrapper, un `<iframe>`) rompiera la herencia de
 * esos atributos, este bloque los repone.
 *
 * @param dom El `view.dom` del editor, o `null` si todavía no existe (durante
 *   la construcción de la instancia). Sin él no hay `line-height` computado que
 *   leer y se cae al factor del SCSS; los componentes reaplican apenas
 *   instancian, con el valor real.
 */
export function buildEditorProps(dom: HTMLElement | null, fontSizePx: number): EditorProps {
  const lineHeightPx = dom
    ? lineHeightPxFrom(getComputedStyle(dom).lineHeight, fontSizePx)
    : fontSizePx * FALLBACK_LINE_HEIGHT;
  return {
    attributes: {
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      autocomplete: 'off',
      'data-gramm': 'false',
      'data-gramm_editor': 'false',
    },
    ...caretScrolloff(lineHeightPx),
  };
}
```

(`@tiptap/pm/view` re-exporta `prosemirror-view`; el repo ya lo usa así en `rae-extension.ts:3`.)

- [ ] **Step 2: Reemplazar el literal en `editor.ts`**

En el bloque de imports de `src/app/editor/editor.ts`, junto a los otros imports relativos de `./`:

```ts
import { buildEditorProps } from './editor-props';
```

En `createEditor()`, reemplazar el bloque literal actual (`editorProps: { attributes: {...} }`, líneas ~1228-1242, **junto con el comentario de 6 líneas que lo precede** — ese comentario ya vive en el JSDoc de `buildEditorProps`) por una sola línea:

```ts
      editorProps: buildEditorProps(null, this.fontSize()),
```

Va `null` porque acá `this.tiptap` todavía se está construyendo: no hay `view.dom` del que leer el computado. El Step 3 reaplica con el valor real.

- [ ] **Step 3: Reaplicar apenas existe la view**

En `createEditor()`, justo después del `});` que cierra el `new TipTapEditor({ ... })` (línea ~1308, antes del bloque `if (this.grammarHostListener) {`), agregar:

```ts
    // Recién ahora existe `view.dom`: releer el line-height computado real (el
    // literal de arriba usó el factor de fallback) y reaplicar. Idempotente,
    // así que no importa si el effect de fontSize ya corrió o no.
    this.tiptap.setOptions({
      editorProps: buildEditorProps(this.tiptap.view.dom, this.fontSize()),
    });
```

El narrowing de `this.tiptap` sobrevive a la asignación de arriba, así que no hace falta el `!`. Si TypeScript igual se queja de que puede ser `null`, guardar la instancia en un `const` local y llamar `setOptions` sobre él — nunca meter un `!` ni un cast a `unknown`.

- [ ] **Step 4: Agregar el effect que reacciona al tamaño de fuente**

Al final del constructor, después del `});` que cierra el effect de auto-check RAE (línea ~637) y antes del `}` que cierra el constructor:

```ts
    // El respiro del caret escala con la línea, así que cambia con la fuente.
    // `setOptions` termina en `view.updateState(state)` sin flag de scroll →
    // path "preserve" de ProseMirror: reaplica los props sin mover la vista.
    effect(() => {
      const fontSizePx = this.fontSize();
      const editor = this.tiptap;
      if (!editor) return;
      editor.setOptions({ editorProps: buildEditorProps(editor.view.dom, fontSizePx) });
    });
```

- [ ] **Step 5: Verificar que compila**

Run: `pnpm build`
Expected: build de Angular sin errores. Si TypeScript se queja del tipo de `view.dom`, **no** castear a `unknown`: revisar que el import en `editor-props.ts` sea `import type { EditorProps } from '@tiptap/pm/view';`.

- [ ] **Step 6: Verificar que los smoke runners siguen verdes**

Run: `node scripts/run-caret-scrolloff-smoke.mjs && node scripts/run-popover-position-smoke.mjs`
Expected: los tres conteos en `N/N ok` (`lineHeightPxFrom: 8/8`, `caretScrolloff: 9/9`, `placePopover: 9/9`).

- [ ] **Step 7: Commit**

```bash
git add src/app/editor/editor-props.ts src/app/editor/editor.ts
git commit -m "feat(editor): scrolloff de 2 líneas al tipear en el editor de capítulos

Los editorProps salen del literal inline a buildEditorProps() en
editor-props.ts (compartida con el editor de notas), que suma
scrollThreshold y scrollMargin calculados desde el line-height computado
de view.dom. Se reaplican al instanciar (ya hay view.dom real) y en un
effect sobre editorFontSize, porque el respiro escala con la línea.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Enganchar el scrolloff en el editor de notas

Consumidor de la función que creó Task 2. Mismos tres enganches que en el editor de capítulos, sin código nuevo propio: el `line-height` de notas (1.55 en el SCSS, contra 1.5 en capítulos) sale solo porque se lee el computado de su propio `view.dom`.

**Files:**
- Modify: `src/app/notes-editor/notes-editor.ts` (imports del tope; `createEditor()` en `335-388`; constructor, línea `133`)

**Interfaces:**
- Consumes: `buildEditorProps(dom: HTMLElement | null, fontSizePx: number): EditorProps` de `../editor/editor-props` (Task 2). **No** se replica la función ni se escribe otra versión del literal de atributos.
- Produces: nada que consuman otras tasks.

- [ ] **Step 1: Agregar el import**

En `src/app/notes-editor/notes-editor.ts`, junto a los otros imports relativos a `../editor/`:

```ts
import { buildEditorProps } from '../editor/editor-props';
```

- [ ] **Step 2: Reemplazar el literal**

En `createEditor()`, reemplazar el bloque literal actual (`editorProps: { attributes: {...} }`, líneas ~356-370, **junto con el comentario de 6 líneas que lo precede** — ya vive en el JSDoc de `buildEditorProps`) por:

```ts
      editorProps: buildEditorProps(null, this.fontSize()),
```

- [ ] **Step 3: Reaplicar apenas existe la view**

En `createEditor()`, justo después del `});` que cierra el `new TipTapEditor({ ... })` (línea ~388) y antes del `}` que cierra el método:

```ts
    // Recién ahora existe `view.dom`: releer el line-height computado real (el
    // literal de arriba usó el factor de fallback, y el SCSS de notas usa 1.55)
    // y reaplicar. Idempotente, así que no importa si el effect de fontSize ya
    // corrió o no.
    this.tiptap.setOptions({
      editorProps: buildEditorProps(this.tiptap.view.dom, this.fontSize()),
    });
```

Igual que en Task 2: si TypeScript se queja de que `this.tiptap` puede ser `null`, guardar la instancia en un `const` local, sin `!` ni casts.

**Cuidado con el `autofocus: 'end'`** de este componente (línea ~376): el pane 0 abre la nota con el cursor al final de forma asíncrona. El `setOptions` recién agregado no lo altera — cae en el path `"preserve"` de `updateStateInner`, que guarda y restaura la posición de scroll — pero es el punto exacto a mirar si en la verificación manual una nota abre en un lugar raro.

- [ ] **Step 4: Agregar el effect que reacciona al tamaño de fuente**

Al final del constructor de `NotesEditor` (constructor en línea `133`), después del último effect y antes del `}` que lo cierra:

```ts
    // El respiro del caret escala con la línea, así que cambia con la fuente.
    // `setOptions` termina en `view.updateState(state)` sin flag de scroll →
    // path "preserve" de ProseMirror: reaplica los props sin mover la vista.
    effect(() => {
      const fontSizePx = this.fontSize();
      const editor = this.tiptap;
      if (!editor) return;
      editor.setOptions({ editorProps: buildEditorProps(editor.view.dom, fontSizePx) });
    });
```

- [ ] **Step 5: Verificar que compila**

Run: `pnpm build`
Expected: build sin errores.

- [ ] **Step 6: Verificar que los smoke runners siguen verdes**

Run: `node scripts/run-caret-scrolloff-smoke.mjs && node scripts/run-rae-smoke.mjs && node scripts/run-suggest-smoke.mjs && node scripts/run-popover-position-smoke.mjs`
Expected: todos los conteos en `N/N ok`.

- [ ] **Step 7: Commit**

```bash
git add src/app/notes-editor/notes-editor.ts
git commit -m "feat(notes): scrolloff de 2 líneas al tipear en el editor de notas

Consume la buildEditorProps() compartida de editor-props.ts: mismos
insets, reaplicados al instanciar y en un effect sobre editorFontSize. El
line-height propio de notas (1.55) sale del computado de su view.dom.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Documentar en `TODO.md`

El item queda **sin marcar** (`- **Scroll a la línea nueva al tipear**`, sin `[x]`): la verificación manual la hace el autor con la app levantada, y el item se cierra recién ahí.

**Files:**
- Modify: `TODO.md:30-36`

**Interfaces:**
- Consumes: nada de código.
- Produces: nada de código.

- [ ] **Step 1: Reescribir el item**

Reemplazar el bullet actual (líneas 30-36):

```markdown
- **Scroll a la línea nueva al tipear**: cuando el cursor pasa a una línea
  nueva al final del viewport, la vista no lo sigue — se escribe a ciegas
  contra el borde inferior. Hace falta mantener el caret visible (con un
  margen de respiro tipo "scrolloff", no pegado al borde). Ojo con no pisar
  la restauración de posición al abrir capítulo (`editor.ts:426-463` setea
  `scrollTop = 0` y usa `focus(undefined, { scrollIntoView: false })` a
  propósito).
```

por:

```markdown
- **Scroll a la línea nueva al tipear**: cuando el cursor pasa a una línea
  nueva al final del viewport, la vista queda pegada al borde inferior — se
  escribe a ciegas. Hace falta un margen de respiro tipo "scrolloff". Ojo con
  no pisar la restauración de posición al abrir capítulo (`editor.ts:426-463`
  setea `scrollTop = 0` y usa `focus(undefined, { scrollIntoView: false })` a
  propósito).

  **Implementado (`feat/caret-scrolloff`)**: spec en
  `docs/superpowers/specs/2026-07-29-caret-scrolloff-design.md`. La causa no era
  que la vista no siguiera al caret: ProseMirror ya scrollea al tipear
  (`readDOMChange` cierra sus transacciones con `tr.scrollIntoView()`), pero
  `scrollRectIntoView` usa los defaults `scrollThreshold = 0` /
  `scrollMargin = 5px`, y mide el *padding box* de `.editor-host` — o sea que
  el `padding: 2.5rem` del host no aporta respiro y el caret queda a 5px del
  borde visual. Fix: `caret-scrolloff.ts` (módulo puro) calcula insets de 2
  líneas desde el `line-height` computado de `view.dom`, y los dos editores
  tipeables los pasan por `editorProps` vía la `buildEditorProps()` compartida
  de `editor-props.ts` (que también centraliza los atributos anti-corrector que
  antes estaban duplicados en los dos componentes), reaplicados
  al instanciar y en un effect sobre `editorFontSize` (el respiro escala con la
  fuente, 12–28px). `threshold == margin` a propósito: el scroll avanza de a
  una línea, sin saltos. `markdown-reader` queda afuera (read-only). No se
  tocaron los dos paths de scroll manual: la restauración al abrir y el salto
  de búsqueda (`scrollIntoView({block:'center'})` nativo). Tests:
  `scripts/run-caret-scrolloff-smoke.mjs` (17 casos) + `pnpm build`. **Falta
  verificación manual del autor** con la app levantada.
```

- [ ] **Step 2: Commit**

```bash
git add TODO.md
git commit -m "docs: anotar el scrolloff del caret como implementado, pendiente de verificación manual

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verificación manual (la hace el autor, con la app levantada)

`pnpm tauri dev`, y sobre un capítulo largo:

1. Tipear hasta pasar el borde inferior: la línea nueva queda con ~2 líneas de aire abajo y el scroll avanza de a una línea, sin saltos.
2. Flecha arriba desde la primera línea visible: queda con aire arriba, no pegada al techo.
3. `Ctrl/Cmd +/-` para cambiar el tamaño de fuente y repetir 1: el respiro escala, y el cambio de tamaño **no** mueve la vista por sí solo.
4. Abrir un capítulo que se cerró con el cursor al final: la vista arranca arriba (`scrollTop = 0`), igual que hoy.
5. `Ctrl+F` → click en un resultado: el salto sigue centrando el match.
6. Repetir 1 y 3 en el editor de notas; abrir una nota en el pane principal y confirmar que el `autofocus: 'end'` sigue comportándose como antes.
