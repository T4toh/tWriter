# Form de creación de notas con plantillas guardables

Fecha: 2026-08-31

## Problema

El creador de notas de hoy no sirve. `createNoteIn`
(`shared/node-actions-service.ts:737`) es un `modal.selectPrompt`: un `<select>` de
plantilla y un input de nombre. Las tres plantillas (`Vacía`, `Personaje`, `Mundo`,
en `shared/note-templates.ts`) solo insertan headings `##` vacíos. El autor las probó
y dejó dicho en el TODO que le dan lo mismo que crear la nota vacía y tipear a mano —
porque es literalmente eso: un esqueleto y después escribí.

Lo que falta es cargar el contenido **en el momento de crear**, con la forma que las
notas ya tienen, y poder guardar una forma nueva como plantilla sin tocar la app.

## Relevamiento del corpus (2026-08-31)

114 `.md` en `~/novelas/Notas`. Las formas reales, contadas, no supuestas:

| Forma | Archivos | Estructura |
|---|---|---|
| Personaje (por libro) | 20 | `## Raza` · `## Características` · `## Objetos` · `## Magia`/`## Detalles`, todo bullets |
| Conjuro | 15 | `## Descripción` · `## Atajos e Encantaciones` · `## Conjuro` — 100% consistente |
| Catálogo por entradas | ~25 | un heading por entrada + prosa (Monstruos, `Lugares.md`, `Vieja República/Personajes.md`) |
| Mundo (por libro) | 4 | `## General` · `## Lugares` · `## Personajes`, prosa (0 bullets) |
| Lista agrupada | ~3 | `## Principales` / `## Secundarios (Orden de Aparición)` + bullets |
| Prosa libre | ~20 | sin headings (`Lugares/*.md`, con `\` de salto duro) |
| Stub vacío | ~20 | 0-1 líneas (`Pociones/*`, `Gentes/Elfos.md`) |

Dos hallazgos que cambian el diseño:

1. **Casi ninguna nota tiene `# Título`.** `Personajes.md` arranca con `## Principales`,
   `Idiomas.md` con bullets, los `Conjuros (Lista)/*` con `## Descripción`. Y en los
   catálogos el `#` es **separador de entrada**, no título del archivo.
2. **Los niveles se mezclan dentro de un archivo**: `Monstruos/Animales mágicos.md` tiene
   `## Oso de las tormentas` y `# Cardenal de Helios` como hermanos. Eso es basura real,
   pero arreglarla es la fase 2, no esta.

## Alcance

**Entra**: el modal de creación con bloques editables, las plantillas de fábrica sacadas
de la tabla de arriba, y guardar/cargar plantillas propias desde `<root>/Plantillas/*.md`.

**No entra** (fase 2, spec aparte): normalizar las 114 notas existentes a estos formatos.
Se decidió partirlo para que el parser destructivo se especifique cuando los formatos ya
hayan aguantado uso real — el corpus tiene los dos casos torcidos de arriba y reescribir
114 archivos del autor sin eso es apostar.

## Modelo de datos

Un bloque es una parte del markdown. Cuatro tipos, ni uno más:

```ts
export type BloqueTipo = 'h1' | 'h2' | 'lista' | 'parrafo';

export interface Bloque {
  tipo: BloqueTipo;
  /** h1/h2: el título. parrafo: el cuerpo (puede tener saltos). lista: ''. */
  texto: string;
  /** Solo `lista`. Vacío en los otros tipos. */
  items: string[];
}
```

No hay `id`: el índice en el array alcanza para el `@for` y para mover con ↑/↓, y un id
sintético sería estado extra que hay que mantener sincronizado.

### `shared/note-blocks.ts` (puro)

```ts
markdownABloques(md: string): Bloque[]
bloquesAMarkdown(bloques: readonly Bloque[], opts?: { plantilla?: boolean }): string
```

Reglas del parser, en orden:

- `# x` → `h1`. `## x` y cualquier `###+ x` → `h2`.
  <!-- ponytail: el modelo tiene dos niveles; ###+ colapsa a h2. Si aparece
       una nota con jerarquía de tres niveles que importe, sumar 'h3'. -->
- Líneas consecutivas que arrancan con `- `, `* ` o `+ ` → un `lista` con esos items.
- Cualquier otra línea no vacía → `parrafo`; las consecutivas se unen con `\n` en un solo
  bloque (así los `\` de salto duro de `Lugares/*.md` sobreviven al round-trip).
- Línea vacía = separador; no genera bloque.

El renderer es la inversa, con una línea en blanco entre bloques. Dos modos:

- **nota** (default): descarta items de lista vacíos y bloques sin contenido, para que
  llenar tres de cinco secciones no deje headings huérfanos.
- **plantilla** (`{ plantilla: true }`): vacía el contenido y **conserva un `- ` solo** por
  cada bloque `lista`. Ese bullet vacío es lo que marca "esta sección es una lista" cuando
  el archivo se vuelve a parsear. Sin él, `## Objetos` seguido de nada vuelve como heading
  pelado y el tipo se pierde.

O sea: **la plantilla es un `.md` vacío**, no un formato nuevo. Se edita a mano en
cualquier editor y el tipo de cada bloque se infiere del propio markdown.

## Plantillas de fábrica

Se definen como markdown en `shared/note-templates.ts` y se parsean con
`markdownABloques` al cargar. Un solo camino de código para las de fábrica y las del
autor; se borran el `NoteTemplate.secciones` y `renderNoteTemplate()` actuales.

| id | Bloques |
|---|---|
| `vacia` | `h1` (el nombre de la nota) |
| `personaje` | `h2 Raza`(lista) · `h2 Características`(lista) · `h2 Objetos`(lista) · `h2 Magia`(lista) · `h2 Detalles`(lista) |
| `conjuro` | `h2 Descripción`(párrafo) · `h2 Atajos e Encantaciones`(lista) · `h2 Conjuro`(párrafo) |
| `mundo` | `h2 General` · `h2 Lugares` · `h2 Personajes` (párrafo cada uno) |
| `lista-agrupada` | `h2 Principales`(lista) · `h2 Secundarios (Orden de Aparición)`(lista) |
| `catalogo` | `h1` (nombre) · `h2` con título vacío + párrafo (la primera entrada; `+ Subtítulo` agrega las que siguen) |

Son **seis, no ocho**: se cayeron `Lugar` y `Monstruo` del borrador. Las notas de lugares
son prosa libre sin estructura (no hay plantilla que sacar de ahí, sería inventarla) y las
de monstruos son exactamente la forma `catalogo` — un heading por bicho y prosa abajo.

`personaje` lleva `Magia` **y** `Detalles` aunque ninguna ficha tenga las dos: Aedan usa
`Magia`, Yiri y Bastien usan `Detalles`. Borrar la que no va es un click, y para eso está
el form.

**Refinamiento de la decisión 4 del chat**: el bloque `h1` no va en todas. Va en `vacia` y
`catalogo`; `personaje`, `conjuro`, `mundo` y `lista-agrupada` arrancan sin él, porque las
20 fichas y los 15 conjuros del corpus no tienen H1. El botón `+ Título` está siempre
disponible, así que agregarlo cuesta un click y el default no miente sobre las notas que
el autor ya escribe.

## Persistencia — `<root>/Plantillas/`

Las plantillas del autor son archivos `.md` en `<root>/Plantillas/`. Sincronizan por git
con el resto del repo `Novelas/` (el auto-commit de `git.rs` ya toma todo el working tree),
se editan a mano, y "Guardar plantilla" es escribir un archivo.

`Plantillas` se agrega a `SKIP_DIRS` (`fs.rs:40`) para que la carpeta no aparezca como
notas en el árbol. Efecto lateral aceptado: esconde cualquier dir llamado `Plantillas` a
cualquier nivel, igual que ya pasa con `exports` o `Revisiones`.

**Colisión de nombres**: si `Plantillas/Conjuro.md` existe, le gana a la de fábrica con el
mismo nombre. Así el autor puede pisar una plantilla shipeada sin tocar la app ni esperar
un release.

### Backend — dos comandos nuevos en `notes.rs`

```rust
#[tauri::command]
pub fn list_note_templates(root: String) -> Result<Vec<NoteTemplateFile>, String>
// <root>/Plantillas/*.md, ordenado por nombre, ignora subdirs y no-.md.
// Carpeta ausente => Ok(vec![]), igual que list_extras.

#[tauri::command]
pub fn save_note_template(root: String, nombre: String, markdown: String, overwrite: bool)
    -> Result<String, String>
// Valida nombre (no vacío, sin `/` ni `\`), crea <root>/Plantillas/ si falta,
// escribe <nombre>.md. Sin overwrite y con el archivo presente => Err.
```

`NoteTemplateFile { nombre, path, markdown }`. No se pasa por `write_note` porque exige
que la carpeta padre ya exista, y la primera plantilla es justamente la que la crea.
Tampoco se indexan en tantivy: una plantilla vacía no es contenido buscable.

Crear la nota **no necesita Rust nuevo**: `create_note(parent_dir, name, body)`
(`notes.rs:67`) ya acepta el body renderizado y escribe una sola vez.

## Frontend

| Archivo | Qué hace |
|---|---|
| `shared/note-blocks.ts` | **nuevo**, puro. Tipos + parser + renderer. |
| `shared/note-templates.ts` | reescrito: las 6 de fábrica como markdown. Se va `renderNoteTemplate`. |
| `note-form/note-form-modal.{ts,html,scss}` | **nuevo**. El form. |
| `core/note-form-service.ts` | **nuevo**. `editing` signal (null = cerrado), carga de plantillas (fábrica + archivos, el archivo gana) y guardado. Un solo service, como `split-chapter-service.ts`, que también junta estado del modal e `invoke`. |
| `shared/node-actions-service.ts` | `createNoteIn` abre el modal nuevo en vez del `selectPrompt`. |

El `modal-host` genérico tiene cuatro `ModalKind` fijos y esto no entra ahí. El patrón que
se sigue es el de `split-chapter-modal`: componente standalone montado en `app.html` (al
lado de `<app-split-chapter-modal />`, línea 338), abierto por un service con un signal
`editing` que es `null` cuando está cerrado.

### El form

```
┌─ Nueva nota ──────────────────────────────┐
│ Se crea en: Notas/Meridian/Magia y aso…   │
│ Plantilla: [ Conjuro            ▾]        │
│ Nombre:    [ Bola de Fuego            ]   │
│───────────────────────────────────────────│
│ H2  [ Descripción            ]  ↑ ↓ ✕     │
│     [ Esfera de fuego que…            ]   │
│ H2  [ Atajos e Encantaciones ]  ↑ ↓ ✕     │
│     • [ ¡Bola de fuego!            ] ✕    │
│     • [ +                          ]      │
│ H2  [ Conjuro                ]  ↑ ↓ ✕     │
│     [                                 ]   │
│───────────────────────────────────────────│
│ [+ Título] [+ Subtítulo] [+ Lista] [+ ¶]  │
│      [Guardar plantilla…]  [Crear]        │
└───────────────────────────────────────────┘
```

- Los títulos de sección son **editables**: la plantilla propone `Descripción`, el autor
  puede escribir otra cosa sin salir del form.
- Reorden con ↑/↓, no drag. `cdkDropList` hoy solo vive en `tree.ts`; el drag suma código,
  IDs de dropList y problemas de foco por una ganancia estética.
  **El drag queda acordado como pulido posterior** (autor, 2026-08-31): primero que el form
  funcione, después `cdkDropList` + `moveItemInArray` sobre el mismo array de bloques, que
  es todo lo que hace falta — el modelo no cambia.
  <!-- ponytail: reorden con botones; el drag es pulido acordado, no un rediseño. -->
- Cambiar de plantilla con bloques ya llenos **pide confirmación** (`modal.confirm`, que ya
  existe) antes de descartar lo escrito.
- "Guardar plantilla…" pide nombre (`modal.prompt`) y guarda `bloquesAMarkdown(bloques,
  { plantilla: true })` — la estructura sin el contenido. Si el nombre ya existe,
  `modal.confirm` de sobrescribir y recién ahí `overwrite: true`.
- El destino (`Se crea en:`) y los entry points no cambian: menú contextual "Nueva nota…"
  de `notes`/`folder`/`saga`/`book`, y el botón `+` del header del panel Notas
  (`notesQuickTarget()`).

## Errores

| Caso | Qué pasa |
|---|---|
| `<root>/Plantillas/` no existe | Lista vacía, sin error. Es el estado inicial normal. |
| Una plantilla del autor no parsea a nada | Se ignora ese archivo y se avisa por toast con el nombre. Un `.md` vacío no es un error del que haya que rescatar al autor, pero tampoco puede desaparecer en silencio. |
| Nombre de nota ya existente | `create_note` ya devuelve `ya existe: <path>`; el toast actual sirve. El modal queda abierto con lo escrito. |
| Nombre de plantilla con `/` o `\` | Rechazado en el `validate` del prompt y otra vez en Rust. |
| Sin root elegido | No hay entry point: `notesQuickTarget()` ya devuelve `null`. |

## Testing

**Puro** — `scripts/run-note-blocks-smoke.mjs` (patrón de `run-note-templates-smoke.mjs`,
que se actualiza porque `renderNoteTemplate` desaparece):

- Round-trip de las 6 de fábrica: markdown → bloques → markdown → bloques, estable.
- `plantilla: true` conserva el `- ` de las listas vacías y borra el contenido.
- Modo nota descarta items vacíos y bloques sin contenido.
- `###+` colapsa a `h2`; líneas de prosa consecutivas quedan en **un** párrafo (incluidas
  las que terminan en `\`); bullets `-`, `*` y `+` mezclados entran a la misma lista.
- Texto sin ningún heading (`Idiomas.md`, `Lugares/Saxon.md`) sobrevive el round-trip.

**Rust** — tests en `notes.rs`: `list_note_templates` con carpeta ausente, orden por
nombre, ignorando subdirs y no-`.md`; `save_note_template` con nombre con separadores,
colisión sin `overwrite`, y creación de la carpeta en la primera plantilla.

**Manual (el autor)**: todo lo que toca DOM. No hay runner de frontend en este repo y el
modal es DOM puro. El item del TODO no se marca hasta que él lo pruebe con la app
levantada.

## Fuera de alcance

Normalizar las notas existentes (fase 2). Drag para reordenar. Plantillas por saga.
Frontmatter. Campos tipados (fecha, número, referencia a otra nota). Traducir las
plantillas de fábrica al inglés — las sagas en inglés se arman las propias en
`Plantillas/`, que es justamente el punto de que sean archivos.
