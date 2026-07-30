# El popover de RAE deja de tirar el markup inline

Fecha: 2026-07-30

## Problema

Aplicar un fix de RAE desde el popover inline borra las itálicas y negritas del párrafo.

Los dos botones del popover (`rae-popover.ts:42-56`) terminan en el mismo antipatrón:
reemplazan un rango del documento con **texto plano**.

```ts
// editor.ts:1137-1142 — "Aplicar RAE al párrafo"
.setTextSelection({ from: v.paragraphFrom, to: v.paragraphTo })
.insertContent(v.autoFix.replacement)
```

`v.autoFix.replacement` es plano por construcción: el validador corre sobre el texto plano
extraído del documento (`editor.ts:1098`, `extractPlainText`) y `pushPendingConversion`
(`validator.ts:76-92`) guarda como replacement el output de `convert(para)` sobre ese plano.
Cuando eso se reinserta, todo `<em>` / `<strong>` que vivía en el rango desaparece.

El daño es peor en el botón de párrafo, que barre un párrafo entero de una novela — donde
las itálicas son pensamiento, énfasis o títulos citados, no decoración. El botón "RAE" del
toolbar (modal de capítulo entero) **no** tiene el problema: le pasa el HTML al converter y
recibe HTML.

## Solución

Dos caminos distintos rompen por razones distintas, así que el fix no es uno solo.

### 1. "Aplicar RAE al párrafo" — round-trip por HTML

Módulo nuevo `src/app/editor/rae-apply.ts`, partido a propósito en una mitad sin DOM y otra
con DOM (ver la sección de testing — el repo no tiene runner de tests con DOM):

```ts
// Sin DOM: string → string. Testeable con el patrón de smoke runner de scripts/.
convertFragmentHtml(html: string): string | null

// Con DOM: envuelve getHTMLFromFragment de @tiptap/core.
serializeRange(doc: PmNode, from: number, to: number, schema: Schema): string
```

`serializeRange` serializa `doc.slice(from, to).content` con
`getHTMLFromFragment(fragment, schema)`. `convertFragmentHtml` pasa ese HTML por `convert()` y
devuelve `null` cuando el resultado no cambió respecto del input.

`applyRaeParagraph` (`editor.ts:1131-1147`) pasa a: `serializeRange` sobre
`paragraphFrom..paragraphTo` → `convertFragmentHtml` → `insertContentAt({ from, to }, html)`,
y no hace nada si el convert devolvió `null`.

Esto **no inventa un camino nuevo**. La fidelidad es idéntica a la del botón "RAE" del
toolbar: ahí `convert()` ya recibe HTML con markup inline adentro y lo procesa con
`convertLine` sobre el fragmento crudo (`converter.ts:29-61`). Le estamos dando al converter
la misma clase de input que ya acepta, sobre un rango más chico.

Lo que **no** se puede hacer es reemplazar el nodo `<p>` entero. `extractPlainText` mapea cada
`<br>` a `\n\n` (`grammar-extension.ts:118-123`) y el validador parte por `\n\n`
(`validator.ts:57`), así que un "párrafo" del validador puede ser un segmento **adentro** de
un bloque con hard breaks. El rango manda, siempre.

### 2. Fixes puntuales — preservar las marcas

`applyRaeFix` (`editor.ts:1114-1129`) reemplaza spans cortos con el replacement ya calculado
por las reglas dedicadas. Como no sale de `convert()`, no hay HTML para reinsertar: lo que se
puede salvar son las marcas.

`insertContent(texto)` pasa a una transacción explícita: leer las marcas vivas en `fixFrom`
(`doc.resolve(fixFrom).marks()`) y `tr.replaceWith(from, to, schema.text(replacement, marks))`.
Una itálica que envuelve el span sobrevive.

Dos bordes:

- `replacement` vacío → `schema.text('')` tira excepción. Va por `tr.delete(from, to)`.
- Span con marcas mixtas adentro → se homogeneiza a las de `fixFrom`. Es una pérdida acotada
  y muy poco probable en un span de pocos caracteres, contra la de hoy que las borra todas.

### Degradación cuando el rango cruza bloques

`mapViolationsToPm` (`rae-extension.ts:109`) permite que una violación `pending-conversion`
tenga `from` y `to` en bloques distintos. Si `paragraphFrom`/`paragraphTo` caen así, el slice
serializa con `<p>` adentro, `convert()` entra por su rama de `<p>` y `insertContentAt`
reemplaza contenido de bloque. Funciona sin código extra — pero no se asume: el lado del
converter va como caso del smoke runner, y el del `insertContentAt` al checklist manual.

## Lo que no cambia

El filtrado de la violación aplicada de `raeViolations`, el re-decorado y el
`scheduleRaeRecheck()` posterior quedan igual en los dos métodos. El popover no muestra
preview del replacement (`rae-popover.ts:36-65`), así que no hay nada que sincronizar entre lo
que se ve y lo que se aplica.

## Testing

**El repo no tiene runner de tests con DOM.** `angular.json` no define target `test` y
`package.json` no trae karma/jasmine/vitest/jsdom; los `.spec.ts` que existen están dormidos
y lo que corre de verdad son los smoke runners de `scripts/` (`tsc` a un tmpdir + import del
JS resultante). El comentario de cabecera de `search-highlight.spec.ts` ya deja sentado el
criterio: lo que depende del DOM se valida por E2E manual.

Por eso el módulo está partido en dos, y el testing sigue esa división:

**Automatizado** — `scripts/run-rae-apply-smoke.mjs`, mismo patrón que `run-rae-smoke.mjs`,
sobre `convertFragmentHtml`, que es `string → string | null`:

- Fragmento con diálogo entre comillas y un `<em>` adentro → convierte a raya y el `<em>`
  sigue presente, envolviendo las mismas palabras.
- Fragmento sin nada que convertir → `null`.
- Fragmento con `<strong>` fuera del tramo de diálogo → intacto.
- Fragmento que ya viene con `<p>` (el caso de rango cruzando bloques) → entra por la rama
  `<p>` del converter y no colapsa los párrafos.

**Manual + compilador** — `serializeRange`, `insertContentAt` y la transacción de marcas
dependen del DOM y del schema vivo de TipTap: los cubre `pnpm build` (tipos) más el
checklist de verificación de abajo. Es la misma decisión que se tomó para
`highlightFirstMatch`.

## Verificación a mano (la hace el autor)

1. Capítulo con un párrafo de diálogo entre comillas que tenga una palabra en itálica →
   click en la decoración naranja → "Aplicar RAE al párrafo" → sale con raya y con la
   itálica intacta.
2. El mismo párrafo por el botón "RAE" del toolbar → mismo resultado que por el popover.
3. Un párrafo armado con Shift+Enter (dos diálogos separados por `<br>`) → aplicar sobre uno
   solo y confirmar que el otro no se tocó.
4. Un fix puntual (carácter/typo) sobre texto en itálica → el reemplazo queda en itálica.
