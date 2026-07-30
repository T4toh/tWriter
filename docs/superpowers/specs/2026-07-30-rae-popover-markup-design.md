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

Módulo nuevo `src/app/editor/rae-apply.ts`:

```ts
serializeRange(doc: PmNode, from: number, to: number): string
convertedHtmlForRange(doc: PmNode, from: number, to: number): string | null
```

`serializeRange` usa el `DOMSerializer` del schema sobre `doc.slice(from, to).content`,
serializando a un contenedor desprendido y devolviendo su `innerHTML`.
`convertedHtmlForRange` encadena eso con `convert()` y devuelve `null` cuando el resultado no
cambió respecto del input.

`applyRaeParagraph` (`editor.ts:1131-1147`) pasa a: serializar `paragraphFrom..paragraphTo` →
`convert()` → `insertContentAt({ from, to }, html)`.

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
reemplaza contenido de bloque. Funciona sin código extra — pero se verifica con un test, no
se asume.

## Lo que no cambia

El filtrado de la violación aplicada de `raeViolations`, el re-decorado y el
`scheduleRaeRecheck()` posterior quedan igual en los dos métodos. El popover no muestra
preview del replacement (`rae-popover.ts:36-65`), así que no hay nada que sincronizar entre lo
que se ve y lo que se aplica.

## Testing

`convert()` sobre fragmentos con markup ya está cubierto por el path del toolbar. Lo nuevo
—serialización y reemplazo— necesita DOM real, así que va a Karma: `rae-apply.spec.ts`,
armando un documento ProseMirror y verificando el HTML resultante.

Casos:

- Párrafo con diálogo entre comillas y un `<em>` adentro → convierte a raya y la itálica
  sigue ahí, envolviendo las mismas palabras.
- Bloque con `<br>` y dos diálogos → solo se reemplaza el segmento de la violación; el otro
  segmento y el hard break quedan intactos.
- Rango sin cambios → `convertedHtmlForRange` devuelve `null` y no se dispara transacción.
- Rango que cruza bloques → reemplaza contenido de bloque sin romper el documento.
- Fix puntual con marca activa en `fixFrom` → el texto nuevo la conserva.
- Fix puntual con `replacement` vacío → borra sin excepción.

## Verificación a mano (la hace el autor)

1. Capítulo con un párrafo de diálogo entre comillas que tenga una palabra en itálica →
   click en la decoración naranja → "Aplicar RAE al párrafo" → sale con raya y con la
   itálica intacta.
2. El mismo párrafo por el botón "RAE" del toolbar → mismo resultado que por el popover.
3. Un párrafo armado con Shift+Enter (dos diálogos separados por `<br>`) → aplicar sobre uno
   solo y confirmar que el otro no se tocó.
4. Un fix puntual (carácter/typo) sobre texto en itálica → el reemplazo queda en itálica.
