# Editor de guion para las escenas del juego

**Fecha**: 2026-11-03
**Estado**: diseño, sin implementar
**Contexto**: `TODO.md` → «Escenas de juego (rpg-copado)». El formato de las
escenas está definido en el repo del juego,
`~/Repos/rpg-copado/docs/superpowers/specs/2026-11-03-dialogos-design.md`, con
el ejemplo canónico en `game/historia/prologo/01-llegada.md` y los personajes
con retrato en `game/historia/personajes.md`.

## Por qué

El autor va a escribir las escenas del juego (rpg-copado) como guion en
archivos `.md` de formato propio que lee el juego en Godot. Hoy la alternativa
es Kate o Writer. Quiere escribirlas en tWriter porque pesa poco y lo tiene en
todas sus PCs, con el corrector y el tesauro que ya usa para las novelas.

Las escenas **no son Markdown**: son texto plano orientado a línea y sangría
con extensión `.md`. El editor de notas de tWriter (TipTap + `tiptap-markdown`)
las rompe en el round-trip: pega al párrafo anterior las líneas con sangría de
2 espacios después de `[si: x]`, convierte 4 espacios de sangría en code block
y descarta los comentarios `<!-- -->`. Por eso hace falta un editor de fuente,
no completar el WYSIWYG de notas.

Esto es «un guion y ya» (palabras del autor): sin integración con el juego,
sin detección mágica, sin validador. Lo mínimo para no usar Kate.

## Objetivos

- Abrir, editar y guardar los `.md` de `game/historia/` desde tWriter como
  texto plano, **byte a byte** como los lee el juego.
- Resaltar lo variable del formato (nombre del personaje, gesto,
  instrucciones, opciones, narración, comentarios) para que se lea como guion.
- Corrector (LanguageTool, el mismo de los capítulos) y tesauro sobre el
  texto hablado. Es texto que va a producción, no una nota: lo pidió el autor.
- Que en el repo de novelas no cambie nada.

## No objetivos

- Completar nombres de personajes o gestos.
- Llamar al validador del juego (`tools/Historia -- revisar`) o marcar
  errores de formato.
- Cambio rápido de raíz («recientes»). Se cambia con el picker que ya hay.
- Vista previa, render, exportación.
- Raya e idioma del capítulo: apagados en este editor.

## Anti-objetivos

- Que el archivo guardado difiera del que se abrió sin que el autor haya
  tocado esa línea: ni sangrías normalizadas, ni blancos colapsados, ni
  comentarios perdidos, ni `\r\n`.
- Una dependencia nueva de npm para resaltar texto.
- Que tWriter commitee solo en el repo del juego.

## Cuándo se activa (decisión del autor: una carpeta marcada como guion)

Una carpeta es «de guion» cuando tiene adentro un archivo vacío
**`.twriter-guion`**, mismo mecanismo que `.twriter-ignore`. La marca viaja con
el repo (git), así que aparece sola en todas las PCs del autor; no va nada a
`settings.json`. Es paralelo a lo que ya hay: no colisiona con sagas, libros,
notas ni carpetas libres.

- Se pone y se saca con click derecho sobre una carpeta → «Marcar como
  guion» / «Quitar marca de guion». Sobre la raíz, desde el menú del espacio
  vacío del árbol.
- El walk del árbol (`fs.rs`) propaga la marca: todo `.md` dentro de esa
  carpeta y sus subcarpetas sale con un flag de guion en el `TreeNode`, como
  hoy sale `excluded`. La carpeta muestra un badge «guion».
- Un `.md` con ese flag abre en el editor de guion: click simple, doble click
  y Shift+click hacen lo mismo (no hay reader lateral para guiones). La
  búsqueda (Ctrl+F) lo indexa como nota.
- Sin la marca, nada cambia: los `.md` siguen abriendo en el reader o en el
  editor de notas.

El uso previsto es apuntar tWriter a `~/Repos/rpg-copado/game/historia` y
marcar la raíz, pero una carpeta de guion adentro del repo de novelas también
funciona.

## El editor

Un componente nuevo (`src/app/guion/`), hermano de `notes-editor/`, que usa el
pane central igual que las notas (un pane muestra una sola cosa a la vez; split
view sigue funcionando).

**Modelo (decisión de esta spec):** ProseMirror pelado (`@tiptap/pm`, ya
instalado), con un schema propio de **un nodo de bloque por línea** del
archivo, sin marcas. Abrir = partir el texto por `\n` y armar un nodo por
línea. Guardar = `textContent` de cada línea unido por `\n`. Con eso el
round-trip es exacto por construcción: lo único que puede cambiar es lo que el
autor escribió.

- `white-space: pre-wrap` para que las sangrías con espacios se vean.
- Tab inserta dos espacios (la sangría del formato); Shift+Tab los saca si
  están. Enter arranca una línea nueva **copiando la sangría de la actual**
  (lo que más se escribe son bloques anidados).
- Sin autocierre de nada, sin tipografía inteligente (no convertir `--`,
  comillas, etc.: `Typography` de TipTap no va acá).
- Deshacer no cruza de un archivo a otro (mismo criterio que
  `run-undo-capitulo-smoke.mjs`).
- Autosave con el mismo tiempo que las notas (1,5 s) por `write_note`, que ya
  garantiza el `\n` final. Si el archivo venía con `\r\n`, se guarda con `\n`
  (el juego lee UTF-8 con `\n`; es el único cambio aceptado).

**Resaltado:** un plugin de decoraciones de ProseMirror que, por cada línea,
corre una función pura `resaltar(linea): Span[]` y pone clases CSS en rangos.
Esa función vive en `src/app/guion/resaltar.ts`, sin DOM, con su smoke runner
`scripts/run-guion-smoke.mjs` (patrón de `run-raya-smoke.mjs`) sobre el
ejemplo canónico. Lo que reconoce, sobre la línea sin la sangría:

| Línea | Qué se marca |
|---|---|
| `# Título` | título de escena (apagado: no se ve en el juego) |
| `## Capítulo · Lugar` | título de lugar |
| `NOMBRE (gesto): texto` | `NOMBRE` fuerte; `(gesto)` atenuado; el texto normal. Nombre = mayúsculas, dígitos y `_`, con acentos y Ñ. |
| `NOMBRE: texto` | lo mismo sin gesto |
| `> texto` | narración, en cursiva |
| `[fondo: x]`, `[entra: X]`, `[sale: X]`, `[recordar: x]`, `[si: x]`, `[si no]` | instrucción (color propio); el nombre dentro de `[entra:]`/`[sale:]` fuerte |
| `- [Habilidad CD n] texto` | opción con tirada: el `-` y la tirada marcados |
| `- éxito:` / `- falla:` | etiqueta de resultado |
| `- texto` | opción |
| `<!-- … -->` | comentario, apagado. Puede abarcar varias líneas: el estado «adentro de comentario» se arrastra línea a línea, así que `resaltar` recibe y devuelve ese estado. |
| cualquier otra | texto suelto (continúa hablando el último): normal |

Lo que no calza con nada se deja normal: **no se marcan errores**. Un nombre
que no está en `personajes.md` se ve igual que uno que sí; eso es del
validador del juego, fuera de alcance.

**Aspecto:** misma fuente, tamaño y ancho que el editor de capítulos (los
mismos settings `editorFontFamily`, tamaño y el menú **Vista**). Los colores
salen de los tokens del tema (`--accent`, `--muted`, etc.), nada cableado, y
funcionan en claro y oscuro. Footer con el nombre del archivo y el estado de
guardado, como las notas, pero diciendo «Guion».

**Corrector (decisión del autor: tiene que haber).** Las notas no tienen
corrector a propósito (son borradores, copiados, en cualquier idioma); el guion
sí, porque es texto que sale en el juego. Es el mismo LanguageTool de los
capítulos (`GrammarService.check`), con estas diferencias:

- **Solo se corrige lo hablado.** A LT van únicamente los tramos de prosa
  que `resaltar` clasifica como texto: lo que sigue a `NOMBRE (gesto):`, a
  `> `, el texto de una opción (sin la tirada `[Habilidad CD n]`) y las
  líneas sueltas de continuación. Nombres, gestos, instrucciones, títulos y
  comentarios **no se mandan nunca**, así `HERMANO` o `[si no]` no aparecen
  como errores ni hay que meterlos en el diccionario. Una función pura
  `textoParaCorregir(lineas)` devuelve los tramos con su rango en el
  documento, para mapear las marcas de LT de vuelta; va con su smoke runner.
- **Idioma fijo: español.** El juego es en castellano.
- **Diccionario propio del guion:** `diccionario.txt` en la carpeta marcada,
  al lado de `.twriter-guion`, con los mismos comandos `get_saga_dictionary` /
  `set_saga_dictionary` apuntados a esa carpeta (andan sin `saga.json`, ya
  está verificado) y el mismo modal «Diccionario…» desde el menú contextual
  de la carpeta. Viaja con git como la marca. «Agregar al diccionario» desde
  la marca de LT funciona igual que en un capítulo.
- Las reglas desactivadas por saga (`reglas_lt_desactivadas`) no aplican: no
  hay saga. Con la lista global de la app alcanza.
- El chequeo automático y el «Revisar» siguen el mismo comportamiento que en
  el editor de capítulos (mismo `autoEnabled`, misma disponibilidad de LT).

**Tesauro:** sinónimos bajo el cursor desde el menú contextual, como en el
editor de capítulos (`TesauroService` + `palabraEn`). Español.

## Git y raíz (decisión de esta spec)

**La raíz prevista es `~/Repos/rpg-copado/game/historia/`**, marcada como
guion, no el repo entero (si no el árbol muestra `src/`, `docs/`, `tests/`).

**Cuando la raíz está marcada como guion, git queda apagado del todo**, como si
el backend fuera `Local`: no se tocan `.gitignore` ni `.gitattributes`, no hay
fetch, auto-pull, auto-commit, auto-push, ni sync al cerrar la ventana o antes
de suspender, y los controles git se esconden. Motivo: es el repo del código
del juego; los commits los arma el autor desde ahí. Un solo guard, donde
`GitService` decide si el backend es git, no uno por cada punto.

El índice de búsqueda `.twriter/` cae dentro de `game/historia/`. El export
Android filtra `historia/*.md`, así que no entra al APK, pero queda untracked:
va una línea `.twriter/` en el `.gitignore` de rpg-copado (se agrega a mano,
una vez). Una carpeta de guion adentro del repo de novelas se commitea como
siempre.

## Restricciones

- Sin dependencia nueva. ProseMirror ya está.
- `resaltar` y `textoParaCorregir` son puras y se prueban desde node con el
  smoke runner; el componente se valida con `pnpm build` y a mano.
- Nada nuevo en `settings.json`.
- Línea en `CHANGELOG.md → [Unreleased] → Added`.
- README: una sección corta en Features, después de «Notas (Markdown)».

## Queda a quien construya

- Nombres de archivos, clases y del nodo de línea del schema.
- Cómo enganchar el componente en `app.ts` y en `NoteService`/`tree.ts`
  (reusar `NotePane` o un servicio propio).
- Las regex exactas de `resaltar` y las clases CSS.
- Ícono y badge de la carpeta marcada en el árbol.

## Abierto (del autor), fuera de esta spec

- Completado de personajes y gestos desde `personajes.md`.
- Correr el validador del juego y marcar la línea (`dotnet` no está en todas
  sus PCs; habría que dar el remedio adentro de la app).
- Reglas de LT desactivadas por guion, si alguna molesta.
- Raíces recientes para saltar entre novelas y guion sin el picker.
