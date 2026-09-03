# Revisión del libro: elegir qué correcciones correr y aplicarlas de una

**Fecha**: 2026-09-02
**Estado**: diseño aprobado, pendiente de plan de implementación

## Problema

Las correcciones automáticas de tWriter están repartidas y medio escondidas.
Sobre un libro entero hoy existen **dos** acciones, y las dos viven detrás de
un click derecho en el árbol o en la galería:

- **Revisar RAE** (`node-actions-service.ts:343`) — abre el panel lateral con
  la lista de violaciones y click-to-jump. No aplica nada.
- **Arreglar comillas** (`:348`) — `quotes-fix-service.fixScope()` recorre el
  libro, saltea los capítulos que no son inglés y escribe los que cambian.
  Aplica de una tras un confirm con conteo: no muestra qué va a tocar.

Y faltan tres cosas:

1. Aplicar las **rayas** (el converter de diálogos) al libro entero. Hoy es
   capítulo por capítulo desde el toolbar del editor.
2. Ver **repeticiones** a nivel libro. Hoy solo existen inline en el editor.
3. El **bulk auto-fix** de las violaciones RAE, que quedó fuera de v1 (ver el
   item de `TODO.md`) por miedo a pisar markup inline.

El pedido del autor: una vista, a nivel **libro**, para **elegir qué correr y
aplicarlo**. Explícitamente **no** una lista unificada de hallazgos — una
acción por tipo. Y explícitamente fuera del editor: "en la vista del editor no
necesitamos nada".

## Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Alcance | Un libro | Es donde rinde el bulk. El capítulo suelto ya está cubierto por el toolbar del editor. |
| Dónde vive | Botón en la tarjeta del libro, al lado de exportar | Mismo lugar donde el autor ya hace acciones sobre un libro. El editor no se toca. |
| Forma | Una acción por tipo, con tilde | Pedido explícito del autor. Una lista unificada mezclaría detectores que no son la misma clase de cosa. |
| Flujo | Escanear → mostrar conteos → aplicar lo tildado | Evita el salto de fe del "Arreglar comillas" actual, que escribe sin mostrar nada. |
| Repeticiones | Solo reporte, sin tilde | No son auto-fixables: una repetición se arregla reescribiendo, no reemplazando. |
| Panel «Revisar RAE» | Se queda como está | Son dos herramientas distintas: una aplica, la otra navega. Cero riesgo de romper lo que anda. |
| Menú contextual | Conserva sus dos entradas | El modal es la puerta visible; sacarlas sería una regresión para quien ya las usa. |

## Los cuatro detectores no son la misma clase de cosa

Es la asimetría que condiciona el diseño:

- `validateRae(plain, lang)` y `detectRepeticiones(...)` devuelven **listas de
  hallazgos con posición**.
- `convert(text)` y `educateQuotes(html)` devuelven `{ text, changes: number }`:
  transforman el documento entero y solo dicen **cuántos** cambios hubo, no
  dónde.

Por eso la vista cuenta y aplica, en vez de listar hallazgo por hallazgo: es la
forma que los cuatro pueden dar hoy sin inventarles una API nueva.

## Escaneo

Un servicio nuevo (`revision-libro-service.ts`) reusa
`list_chapters_for_audit` — el mismo comando de Rust que ya usan el panel RAE y
`fixScope`, así que no hay backend nuevo — y corre los cuatro detectores en
memoria, sin escribir nada:

| Detector | Qué cuenta | Se aplica |
|---|---|---|
| Rayas RAE | `convert()` por capítulo, `changes` | sí |
| Comillas | `educateQuotes()`, solo capítulos en inglés | sí |
| Arreglos RAE | violaciones con `autoFix` definido | sí |
| Repeticiones | `detectRepeticiones()`, conteo | no |

Cada fila muestra cuántos cambios y en cuántos capítulos. El autor tilda y
aplica; se escribe un `write_chapter` por capítulo que efectivamente cambió.

El escaneo cede el event loop cada N capítulos, igual que `fixScope`, para no
congelar la UI en libros grandes.

## La parte riesgosa: aplicar fixes de RAE sin pisar markup

Las violaciones de `validateRae` traen offsets sobre el **texto plano**, y el
archivo en disco es HTML. El `TODO.md` dejó esto afuera de v1 justamente por
ahí: reconstruir HTML desde texto plano borra `<em>`/`<strong>`.

`htmlToPlain` (`validator.ts:133`) es lossy de cuatro formas a la vez:

1. saca todos los tags,
2. decodifica entidades (`&nbsp;` son 6 caracteres que pasan a 1),
3. hace `.trim()` de cada bloque,
4. **descarta los bloques vacíos**, así que los índices de bloque tampoco
   alinean.

Ningún cálculo de offsets a posteriori sobrevive esas cuatro cosas juntas.

**La solución es construir el plano y el mapa de posiciones en la misma
pasada.** Una función pura:

```ts
planoConMapa(html: string): { plain: string; mapa: Int32Array }
```

donde `mapa[i]` es el índice **en el HTML** del carácter `i` del plano. Con eso
aplicar un fix es exacto por construcción, no por reconstrucción. `plain` tiene
que salir **idéntico** al de `htmlToPlain` — es la condición que hace que los
offsets de `validateRae` signifiquen algo, y va cubierta por tests.

```ts
aplicarFixesHtml(html, fixes): { html: string; aplicados: number; salteados: number }
```

aplica en **orden descendente de offset** (si no, cada reemplazo corre los
siguientes) y devuelve cuántos salteó.

### El guard que hace esto seguro

Si el rango HTML de un fix **contiene un tag** — o sea, el fix cruza el borde de
una cursiva — **no se aplica**. El modal reporta cuántos se saltearon y por qué.

Saltear cinco fixes es infinitamente preferible a comerse un `</em>` en veinte
capítulos, en una operación masiva que el autor no va a revisar archivo por
archivo. Ese es exactamente el escenario que el `TODO.md` temía.

### Dónde vive el código

`planoConMapa` y `aplicarFixesHtml` son TS puro sin DOM: van en `dialogos/` con
su smoke runner en `scripts/`, según el criterio del `CLAUDE.md` de partir el
código nuevo del frontend en una mitad pura y una mitad con DOM. Precedente del
tokenizador tag-aware: `quotes/educate.ts`, que ya recorre tags vs texto y
transforma solo el texto.

Casos que el smoke runner tiene que cubrir:

- fix enteramente adentro de una cursiva → se aplica, la cursiva sobrevive
- fix que cruza el borde de un tag → se saltea, el HTML no cambia
- fix en un párrafo posterior a un párrafo vacío → offset correcto pese al
  bloque descartado
- fix después de una entidad (`&nbsp;`, `&amp;`) → offset correcto pese al
  cambio de longitud
- fix en un bloque con espacios al principio → offset correcto pese al `.trim()`
- varios fixes en el mismo párrafo → todos aplicados, sin corrimiento
- `planoConMapa(html).plain === htmlToPlain(html)` sobre varios HTML reales

## Qué NO entra

- **Diff visual por capítulo.** El escaneo da conteos, no un preview línea por
  línea. Un diff de libro entero es otra feature.
- **Deshacer dentro del modal.** El undo es git, que para eso está. El repo de
  novelas se auto-commitea.
- **Repeticiones aplicables** ni click-to-jump desde esta vista.
- **Alcance saga.** Un libro por vez; el bulk sobre una saga entera multiplica
  el blast radius sin que nadie lo haya pedido.
