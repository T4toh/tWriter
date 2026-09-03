# Reemplazar en lote: buscar y reemplazar a través del repo, sagas y libros

**Fecha**: 2026-09-03
**Estado**: diseño aprobado. Plan en `docs/superpowers/plans/2026-09-03-reemplazar-en-lote.md`

## Problema

La búsqueda encuentra todo y el reemplazo no existe. Corregir un nombre mal
escrito desde el principio —el caso que lo motivó, reportado el 2026-09-03:
"estuve buscando Angelica para cambiar por Angélica a mano como mono"— es hoy
buscar, abrir cada hit, corregir a mano y acordarse de dónde se quedó, repartido
en decenas de capítulos.

El item de `TODO.md:1798` deja el problema planteado y dice explícitamente que
nada está diseñado. Este spec cierra las cinco decisiones que enumeraba
(alcance, preview, deshacer, mayúsculas/palabra completa, y dónde vive la UI).

Las piezas del lado de encontrar ya están: `findAllMatchesInPlain` devuelve
**todos** los rangos de un texto, `esPalabraCompleta`/`buscarPalabraCompleta`
resuelven los bordes de palabra, `list_chapters_for_audit` enumera los
capítulos de un scope, y `QuotesFixService` es el precedente exacto de
escritura en lote (itera payloads, `write_chapter`, `loadTree` +
`refreshStatus`, toast con conteo). Falta el otro lado.

## Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Dónde vive | Dentro del panel de búsqueda, toggle `⇄` | Reusa el selector de scope y la lista agrupada por capítulo que ya están. Es donde el autor ya está parado cuando descubre el problema. |
| Motor | Rust (`replace.rs`), no TS | CLAUDE.md manda que lo que toca muchos archivos viva en Rust. Cruzan snippets por el bridge, no 925 HTML enteros en cada keystroke. Y hay runner de tests (`cargo test`); el frontend no tiene. |
| Alcance de archivos | Solo capítulos `.html` | El `walk` de `audit.rs` ya saltea `notas/`; las notas necesitarían otra enumeración y `write_note`. El scope `Notas` queda deshabilitado **diciendo por qué**, no mintiendo. |
| Matcheo | Toggles explícitos tipo editor (`Aa`, `ab`), sin preservación de caso | Predecible y familiar. Lo que se tipea en "Reemplazar" se escribe literal. |
| Fuzzy (`≈`) | Deshabilitado en modo reemplazo | Reemplazar sobre un match Levenshtein cambia palabras que no se pidieron. |
| Plegado de acentos | Nunca | `Angelica` no debe matchear `Angélica`, o el reemplazo sería un no-op infinito. |
| Granularidad | Checkbox por ocurrencia, capítulo tri-estado | Deja afuera la ocurrencia suelta que en ese párrafo es otra cosa (una cita textual, otro personaje). |
| Deshacer | Snapshot local en `.twriter/undo/<ts>/` + botón Deshacer | Un solo camino: funciona igual en repo git, Dropbox o carpeta local. El repo de prueba no es git. |
| Dónde va el "Deshacer" | Barra dentro del panel, no en el toast | `ToastService` es `{id, level, message}` y no soporta botones de acción. En el panel además persiste, en vez de desaparecer en 4 s. |
| Formato inline | Las ocurrencias que cruzan un tag no se reemplazan | Se listan aparte, con snippet y sin checkbox. Nunca se pisa una cursiva. |

## Arquitectura

Piezas nuevas: `src-tauri/src/replace.rs`, `src/app/core/replace-service.ts`,
`src/app/core/replace-selection.ts`, y cambios en
`search-panel.{ts,html,scss}`. Nada más.

```
usuario tipea "Angelica" → "Angélica", toggles Aa/ab
                    │
   ReplaceService.preview()  (debounce 250 ms, cancela por requestId)
                    │  1. chapter.flushAllDirty()          ← ya existe
                    │  2. resuelve scope a un PATH (findAncestorByKind(…).path)
                    ▼
   invoke('replace_preview', {scopePath, needle, caseSensitive, wholeWord})
                    │  walk del scope (el walk de audit.rs, extraído a compartido)
                    │  por archivo: plain + runs → buscar literal → ocurrencias
                    ▼
   [{path, title, occurrences: [{id, snippet, htmlStart, htmlEnd}], skipped}]
                    │  el frontend guarda esto + un Set de ids deseleccionados
                    ▼
   usuario destilda lo que no va → [ Reemplazar las 21 ]
                    ▼
   invoke('replace_apply', {edits: [{path, ranges}], replacement})
                    │  1. snapshot de los N archivos a .twriter/undo/<ts>/
                    │  2. valida que el needle siga en cada range
                    │  3. por archivo: splice de atrás para adelante
                    │  4. fs::write_chapter (ya reindexa tantivy solo)
                    │  5. stats: un read_stats / insert × N / write_stats
                    ▼
   {files, occurrences, skippedFiles, snapshotId}
                    │  chapter.reloadIfChanged(paths as 'modified')  ← ya existe
                    │  project.loadTree() + git.refreshStatus()      ← patrón QuotesFix
                    ▼
   toast "Angelica → Angélica: 21 en 6 capítulos"
   + barra en el panel: "Último reemplazo · Deshacer"
```

`flushAllDirty()` antes de enumerar es lo que permite que **todo** el motor sea
disk-based, incluido el scope `Archivo actual`: después del flush, el disco es
igual al buffer del editor. Sin eso haría falta un segundo camino por TipTap
solo para el capítulo abierto.

### Comandos nuevos

Payload del preview, tal como lo consume el panel:

```ts
interface ReplaceOccurrence {
  /** `<path>#<htmlStart>` — estable entre previews del mismo archivo, así que
   *  destildar una ocurrencia sobrevive a un re-preview por debounce. */
  id: string;
  snippet: string;      // recortado del plain, ±120 chars alrededor del match
  htmlStart: number;    // byte offset en el HTML crudo
  htmlEnd: number;
}

interface ReplaceSkipped {
  snippet: string;
  reason: 'cruzaTag' | 'cruzaEntidad' | 'cruzaBloque';
}

interface ReplaceGroup {
  path: string;
  /** `titulo` de `<stem>.meta.json` si existe, si no el nombre del archivo sin
   *  extensión. Mismo criterio que `titleFromPath` en `rae-audit-service.ts`,
   *  más el meta que ese no lee. */
  title: string;
  occurrences: ReplaceOccurrence[];
  skipped: ReplaceSkipped[];
}

interface ReplacePreview {
  groups: ReplaceGroup[];
  total: number;          // ocurrencias reemplazables
  totalSkipped: number;
  /** True si se cortó por el tope de 2000/500. La UI muestra el aviso. */
  truncated: boolean;
}
```

```rust
#[tauri::command]
pub fn replace_preview(
    scope_path: String,
    needle: String,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<ReplacePreview, String>;

#[tauri::command]
pub fn replace_apply(
    root: String,
    needle: String,             // ↓ los tres se repiten para revalidar
    case_sensitive: bool,
    whole_word: bool,
    edits: Vec<FileEdit>,       // { path, ranges: Vec<(usize, usize)> }
    replacement: String,
    ultima_edicion: String,     // ISO del frontend: Rust no tiene crate de fechas
) -> Result<ReplaceOutcome, String>;

#[tauri::command]
pub fn replace_undo(
    root: String,
    snapshot_id: String,
    force_paths: Vec<String>,   // los que el usuario confirmó pisar
    ultima_edicion: String,
) -> Result<UndoOutcome, String>;
```

## El motor de matcheo: runs

El problema real es que las ocurrencias se ven en texto plano pero se escriben
en HTML, y los offsets no coinciden: los tags no están en el plain, y las
entidades cambian de largo (`&amp;` son 5 bytes que valen 1 char).

Al leer un `.html` se construye `plain: String` más `runs: Vec<Run>`, donde un
run es un tramo máximo de texto plano que se corresponde byte a byte con el
HTML:

```rust
struct Run {
    plain_start: usize,
    plain_end: usize,
    html_start: usize,
}
```

Un tag abre y cierra run. Una entidad también, porque cambia de largo. Los
cierres de bloque (`</p>`, `</h1>`, `<hr/>`, `</blockquote>`, `</li>`) meten un
`\n` en el plain que no pertenece a ningún run.

**Regla: una ocurrencia es reemplazable solo si cae entera dentro de un run.**

Eso rechaza gratis los tres casos peligrosos —frase partida por una cursiva,
match que abarca una entidad, match que cruza dos párrafos— sin código especial
para cada uno. Las rechazadas se cuentan y se muestran con su snippet y sin
checkbox: `2 ocurrencias no se pueden reemplazar (cruzan cursivas)`.

El snippet se recorta del `plain` completo, no del run, así el contexto se lee
bien aunque el match esté pegado a un `<em>`.

Referencias para no reescribir lo que ya existe: `search.rs::html_to_text` (el
strip + decode de entidades), `split_chapter.rs::strip_tags`, y el walker
char-por-char con `in_tag` de `import.rs:315` para el conteo de palabras.

### Los toggles

| toggle | default | efecto |
|---|---|---|
| `Aa` distinguir may/min | off | off ⇒ compara en lowercase; on ⇒ literal |
| `ab` palabra completa | **on** | borde `\p{L}\p{N}` a los dos lados (espejo de `esPalabraCompleta`) |
| `≈` fuzzy | — | **deshabilitado**, con el motivo al hover |

Las reglas de borde de palabra se escriben en Rust como espejo de
`search-highlight.ts`. El repo ya tiene ese patrón documentado (`foldAccents` ↔
`fold_accents`, `TERMINO_CORTO_MAX` ↔ `FUZZY_LEN_EXACT_MAX`).

Ojo con una diferencia deliberada contra la búsqueda: la búsqueda matchea por
**prefijo** los términos de más de 3 chars, porque para proofreading `golpear`
tiene que encontrar `golpearon`. El reemplazo **no**: con `ab` prendido exige
palabra completa a los dos lados, porque reemplazar `golpear` no debe convertir
`golpearon` en `golpeóon`.

## La UI

Botón `⇄` nuevo en el header, al lado del `≈`. Prendido, aparece una segunda
fila y la lista de abajo cambia de "resultados de búsqueda" a "preview de
reemplazo".

```
┌ Buscar ────────────────────────────── ✕ ┐
│ 🔍 [Angelica          ]  ? ≈ ⇄ 🐛 ✕ ⟳  │  ≈ deshabilitado, con motivo al hover
│ ⇄  [Angélica          ]  Aa  ab        │  ab (palabra completa) ON por default
│ Scope  [ Todo el repo        ▾ ]        │  mismo selector, mismo signal
│ ─────────────────────────────────────── │
│ 23 en 7 capítulos · 21 seleccionadas    │
│ ▾ ▣ 1 - La Ciudad de las Luces    4/5  │  ▣ = tri-estado (indeterminate)
│    ☑ …y Angelica dijo que no…          │
│    ☐ …la novela "Angelica" de…         │
│ ▸ ☑ 2 - Más que un trabajo        3/3  │
│ ─────────────────────────────────────── │
│ ⚠ 2 no se pueden reemplazar (cruzan     │  sin checkbox, con snippet
│   cursivas)                             │
│ ─────────────────────────────────────── │
│ Último: Angelica→Angélica · 21  Deshacer│  barra solo si hay snapshot vivo
│      [ Reemplazar las 21 seleccionadas ]│
└─────────────────────────────────────────┘
```

### Estado

```ts
// ReplaceService
replacement   = signal<string>('')
groups        = signal<ReplaceGroup[]>([])       // del preview
deselected    = signal<Set<string>>(new Set())   // ids apagados; default todo ON
lastUndo      = signal<UndoInfo | null>(null)
applying      = signal<boolean>(false)
```

El toggle `⇄` vive en `SearchService` (`replaceMode`), **no** en
`ReplaceService`, para que no haya DI circular: `ReplaceService` inyecta
`SearchService` (necesita `query()` y `applyPathChanges()`), nunca al revés.

`caseSensitive` y `wholeWord` se persisten en settings al lado de `searchFuzzy`
y `searchDebug` — son preferencias del autor, no estado de sesión.

Con `replaceMode` prendido la query a tantivy **no corre**: el `effect` de
`runSearch` chequea el flag y sale. El resalto vivo en el editor
(`highlightTerms`) se queda, que ahí sí ayuda. Apagar el modo re-corre la
búsqueda sola, porque el effect ya depende de esos signals.

`deselected` guarda los apagados en vez de los prendidos para que un preview
nuevo arranque con todo seleccionado sin código extra.

### Cuándo se deshabilita el botón

Con el motivo **visible al lado**, no en un tooltip, según la regla de "el
remedio se da adentro de la app":

- query vacía
- `needle === replacement`
- scope `Notas`, o scope `Archivo actual` apuntando a un `.md` → "El reemplazo
  solo toca capítulos."
- 0 seleccionadas
- scope `Saga actual` / `Libro actual` sin capítulo abierto → reusa el hint de
  `scopeNeedsContext` que ya existe

Replacement vacío **sí** se permite: borrar una muletilla repetida es un caso
real. El botón pasa a decir "Borrar las 21".

## Snapshot y deshacer

```
.twriter/undo/20260903-152130/
  manifest.json
  1 - La Ciudad de las Luces/3.html      ← relativo al root, jerarquía espejada
  1 - La Ciudad de las Luces/7.html
```

`manifest.json`:

```json
{
  "id": "20260903-152130",
  "when": "2026-09-03T15:21:30Z",
  "needle": "Angelica",
  "replacement": "Angélica",
  "scopePath": "/Users/tatoh/Repos/Personal/Novelas",
  "files": [
    {
      "rel": "1 - La Ciudad de las Luces/3.html",
      "occurrences": 5,
      "mtimeAfterApply": 1772806890
    }
  ]
}
```

Se guarda **solo el último**: al crear uno nuevo se borra el anterior.
`.twriter/` ya lo destrackea `git_ensure_twriter_ignored`, así que el snapshot
no ensucia el repo ni genera conflictos entre las dos PCs.

`replace_undo` copia los archivos de vuelta, los reescribe con
`fs::write_chapter` (que reindexa solo), recalcula stats y borra el snapshot.
**Con un guard**: si el mtime actual de un archivo es más nuevo que el
`mtimeAfterApply` del manifest, ese archivo se editó después del reemplazo y
restaurarlo se comería esa edición. Esos no se pisan; se listan y se pide
confirmación explícita, y solo los que vengan en `force_paths` se restauran.

Deshacer también hace `flushAllDirty()` antes y `reloadIfChanged()` después,
igual que aplicar.

## Bordes que sí importan

- **El archivo cambió entre el preview y el apply.** Son dos invokes separados,
  y en el medio pasa el autosave, un pull o la otra PC. Por eso `replace_apply`
  recibe de nuevo el `needle` y los dos toggles: **re-escanea cada archivo** y
  exige que los ranges pedidos estén entre los que el re-escaneo encuentra. Si
  alguno no está, saltea ese archivo entero y lo reporta: "3 de 7 capítulos
  cambiaron desde el preview, no los toqué". Sin esto el splice escribe basura
  en medio de una palabra.
- **Escritura parcial.** Si falla el archivo 5 de 7, los 4 ya escritos están en
  el snapshot ⇒ Deshacer los cubre. Se reporta el conteo real, no "listo": el
  `ReplaceOutcome` trae `failedFiles` (`"<path>: <error>"` por entrada) aparte de
  `skippedFiles`, y `replace_apply` devuelve `Ok` con el conteo real en vez de
  un `Err` que tiraría el conteo y el `snapshotId`. El `manifest.json` del
  snapshot se escribe **antes** de la primera escritura y se reescribe al final
  con los mtimes reales, para que un fallo a mitad de lote no deje el snapshot
  huérfano y sin forma de deshacerlo.
- **0 ocurrencias.** Mensaje que dice por qué, porque la búsqueda de arriba sí
  encuentra cosas y eso confunde: "Sin ocurrencias exactas. El reemplazo no usa
  ≈ ni pliega acentos: `Angelica` no matchea `Angélica`."
- **Demasiadas.** Tope de 2000 ocurrencias / 500 archivos en el preview. Pasado
  eso no se renderiza la pared: "Más de 2000 ocurrencias — acotá el scope o el
  término." La alternativa era virtualizar la lista, y no vale el código para un
  caso que se resuelve eligiendo mejor el scope.
- **`palabras` quedó desactualizado.** Ya no vive en `meta.json`, se migró a
  `.twriter/stats.json` (`stats.rs`). `QuotesFixService` no lo actualiza y por
  eso deja el conteo viejo; `replace_apply` sí, con **un** `read_stats` /
  `write_stats` para todos los archivos, no uno por archivo (`upsert_stat`
  reescribe el mapa entero en cada llamada). El `ultima_edicion` lo manda el
  frontend en el invoke: `src-tauri/Cargo.toml` no tiene crate de fechas y no
  vale agregar una para formatear un string, así que se sigue el camino que ya
  usa cada save (`chapter-service.ts:199`).

## Verificación

`cargo test` en `replace.rs` cubre lo que se rompe callado:

- match que cruza `<em>` → no reemplazable
- match que abarca `&amp;` → no reemplazable
- palabra completa on/off (`casa` vs `casarse`; `golpear` vs `golpearon`)
- case-sensitive on/off
- varios ranges en un mismo archivo: que el splice de atrás para adelante no
  desfase las posiciones
- needle vacío, needle igual al replacement, replacement vacío
- la validación de stale (el archivo cambió después del preview)
- roundtrip snapshot → apply → undo en `TempDir` (patrón que ya usa `stats.rs`)
- el guard de mtime del undo: archivo tocado después del apply no se pisa

Del frontend, la parte que vale testear es la de los contadores y el
tri-estado: "21 de 23 en 6 capítulos" es exactamente lo que se rompe sin que se
note. Va como funciones puras en `src/app/core/replace-selection.ts` con
`scripts/run-replace-selection-smoke.mjs`, siguiendo la regla de CLAUDE.md de
partir en mitad pura + mitad DOM.

La mitad DOM la verifica el autor con la app levantada, sobre el repo de
prueba (no-git, descartable). El item de `TODO.md:1798` no se marca hasta
entonces.

## Fuera de alcance

- **Notas `.md`.** Ver la tabla de decisiones. El scope `Notas` queda
  deshabilitado con el motivo visible.
- **Undo de ProseMirror para el capítulo abierto.** El snapshot ya cubre el
  deshacer, y un segundo camino por TipTap (`insertContentAt` sobre los rangos
  anclados con `offsetToPm`) sería código duplicado para el mismo resultado.
- **Regex / grupos de captura.** El caso real es un nombre propio. Un motor de
  regex expuesto al usuario es otra feature y otro spec.
- **Más de un snapshot / historial de reemplazos.** Se guarda el último. Si
  hace falta ir más atrás, para eso está el historial de git.
- **Reemplazo dentro de `book.json` / `saga.json` / títulos de capítulo.** Solo
  el cuerpo de los `.html`. Renombrar un personaje en los títulos es a mano,
  o un item aparte.
