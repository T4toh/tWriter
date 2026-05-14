# tWriter

App desktop para escribir novelas en español e inglés. Centraliza el flujo: editor → conversor de diálogos a estilo RAE → chequeo de gramática → exportación EPUB. Reemplaza LibreOffice + Reedsy en una sola herramienta.

Las novelas viven en un repo privado aparte (HTML + JSON). Esta app es solo el editor.

**Stack**: Tauri 2 + Angular 21 + TipTap. Backend Rust, frontend signals.

## Layout de archivos

Cada saga/libro en el repo de novelas sigue una convención canónica para
distinguir capítulos (lo que va al EPUB) de extras (manuscritos viejos, mapas,
glosarios, tapas alternativas) y notas (research / worldbuilding).

```
<root>/
  README.md                        # opcional, visible en GitHub, oculto en la app
  themes/                          # opcional, temas reutilizables
    <id>/
      theme.json                   # { body_font, body_size, heading_font, heading_size, line_height, page_margin }
      fonts/                       # .ttf/.otf/.woff/.woff2
  <carpeta-libre>/                 # opcional, kind: folder — notas y subcarpetas sueltas
    <cualquier-archivo>.md         # notas markdown
    <subcarpeta>/                  # recursivo
  <cualquier-archivo>.md           # opcional, notas sueltas en root
  <saga>/
    saga.json
    cover.{jpg,png,jpeg,webp}      # opcional, tapa de la serie
    extras/                        # opcional, mapas/glosarios saga-level
      <cualquier-archivo>
    fonts/                         # opcional, override de fuentes per-saga
    notas/                         # opcional, notas saga-level (📒)
    <libro>/
      book.json
      cover.{jpg,png,jpeg,webp}    # opcional
      back-cover.{jpg,png,jpeg,webp} # opcional, contratapa
      extras/                      # opcional, manuscritos/refs book-level
        <cualquier-archivo>
      fonts/                       # opcional, override de fuentes per-libro
      notas/                       # opcional, notas book-level
      <n>.html + <n>.meta.json     # capítulos
      <sección>?/<n>.html          # capítulos en secciones
```

Reglas:

- `cover.*` y `back-cover.*` son archivos directos en la raíz del nivel. Si no
  los tenés explícitos en `book.json`/`saga.json`, la app los autodetecta del
  filesystem.
- `extras/` es flat. Podés crear subcarpetas si querés; la app no impone
  taxonomía. Cualquier tipo de archivo entra (imagen, docx, odt, txt, md, pdf).
- `extras/`, `notas/`, `fonts/`, `themes/` y `.twriter/` (índice de búsqueda)
  quedan auto-excluidos del export EPUB y del walk del tree. No necesitan
  `.twriter-ignore`.
- `README.md` y `.gitignore` en root tampoco aparecen en el tree (sirven para
  GitHub, no para la app).
- Carpetas en root sin `saga.json`/`book.json` y sin capítulos `.html`/`.odt`/`.docx`
  se tratan como **carpetas libres** (`kind: folder`, 📁). Contienen notas `.md`
  y subcarpetas recursivas para organización libre (worldbuilding, research, etc.).
  No participan del TOC ni del EPUB.
- Para libros standalone (sin saga padre), el layout del libro es idéntico —
  `<book>/cover.*`, `<book>/extras/`, `<book>/fonts/`, etc.
- `themes/` vive solo en la raíz del repo. Cada tema es autocontenido (su
  propio `theme.json` + carpeta `fonts/`). Sagas y libros referencian un tema
  por id en `saga.json::theme.base` / `book.json::theme.base`.

## Features

### Editor

- TipTap con HTML subset: `<p>`, `<i>`, `<em>`, `<strong>`, `<u>`, `<hr>`, `<h1>`, `<blockquote>`.
- Autosave debounced 1.5s.
- Toolbar: B/I/U, alineación, salto de escena, RAE, gramática, ancho hoja, font size.
- Menú contextual propio.
- Modo focus (F11 / Esc): oculta tree, deja toolbar y footer.
- Indicador de idioma en footer (badge color) + toggle ES/EN.
- Diálogos custom (prompt/confirm/alert) coherentes con el resto de los modales — sin headers feos de WebKit.
- `<app-select>` Angular standalone reemplaza los `<select>` nativos en todos los modales (no más widget del DE distinto por distro). Typeahead automático cuando hay >10 opciones.
- File pickers nativos vía `rfd` 0.15 con feature `xdg-portal` — en KDE/Wayland abre el portal del sistema en vez del diálogo GTK 3 foreign del plugin-dialog.
- **Split view**: arrastrá un capítulo o nota del árbol al panel central para abrir un segundo editor. Combos: chapter+chapter (comparar/escribir en paralelo) o chapter+note (nota como referencia mientras escribís). Cada pane tiene su propio autosave, idioma, gramática y RAE. Botón ⬍/⬌ cambia entre split horizontal (lado a lado) y vertical (apilado). Botón × cierra el pane secundario y vuelve a single-pane. Estado no persistido entre sesiones (cada vez arranca single).

### Notas (Markdown)

- Editor separado para `.md` con TipTap + `tiptap-markdown` (no toca el flow de capítulos HTML).
- Toolbar: B/I/S/code inline + H1/H2/H3 + listas bullet/numerada + blockquote + code block + hr. Sin RAE, LT ni idioma.
- Convivencia con capítulos: mutex de un solo editor a la vez. El icono y footer marcan claramente "Nota".
- `.md` aparecen en cualquier ubicación del árbol (root, carpeta libre, saga, libro, sección); las carpetas `<saga>/notas/` y `<book>/notas/` se renderizan como 📒 expandibles. Carpetas libres en root (sin saga.json/book.json) se renderizan como 📁.
- Creación libre en root: click derecho en el área vacía del tree → "Nueva carpeta…" o "Nueva nota…" arman estructura paralela al TOC para worldbuilding/research. Click derecho sobre una carpeta 📁 permite anidar recursivo.
- `notas/` y los `.md` quedan auto-excluidos del export EPUB y de la vista de tarjetas (la vista de tarjetas es para contenido del libro).
- "Nueva nota…" desde context menu de saga/libro/carpeta `notas/` (autocrea el dir si no existe).
- `.md` que viven en `extras/` también abren en este editor (no en `xdg-open`).
- **Reader en panel derecho**: click sobre `.md` (en `notas/` o `extras/`) abre la nota como render read-only al costado, sin desplazar al capítulo del centro. Botón ✏️ promueve la nota al editor del centro para editar; 🗙 cierra. Mutex con image viewer y font preview.
- **Doble click** sobre `.md` abre directamente en el editor central (ahorra el click+✏️ del reader). Shift+click también. Mismo comportamiento en resultados de búsqueda y en archivos `.md` que vivan en `extras/`.
- **Ancho del panel derecho**: botón en el header del reader cicla 4 presets (compacto 280px / normal 380px / ancho 560px / pantalla — oculta el centro). Persiste en `settings.json::rightPanelWidth`.

### Tree explorer

- Jerarquía Saga / Libro / Sección / Capítulo + Notas + carpetas `notas/` + carpetas libres 📁 en root.
- Context menu: crear, mover, renombrar, importar, exportar EPUB, configurar libro, excluir del EPUB. Para notas: abrir, renombrar, borrar. Para carpetas libres: nueva nota, nueva carpeta, renombrar, borrar.
- Right-click en área vacía del tree → "Crear saga / novela", "Nueva carpeta…" (📁 libre), "Nueva nota…" (`.md` suelta).
- Reorder de capítulos via context menu (↑ subir / ↓ bajar).
- Archivos no-chapter visibles en el tree con íconos por tipo (🖼 imagen, 📄 documento, 📝 texto, 📦 otro). Notas con 📝 y badge `.md`.
- Template inicial precargado (saga/libro/capítulo dummy) al crear sagas/libros nuevos.
- Badge "excluido" para `.twriter-ignore`.
- Selector de carpeta raíz persistido + auto-load del último capítulo abierto.

### Búsqueda (Ctrl+F)

- Panel lateral con full-text search sobre notas (`.md`) + capítulos (`.html`) + títulos de carpetas (sagas/libros/secciones/folders/notas).
- Backend: [tantivy](https://github.com/quickwit-oss/tantivy) (in-process, sin servicio externo). Índice persistido en `<root>/.twriter/search-index/` — auto-excluido del tree y del export EPUB.
- **Reindex incremental on-save**: cada `write_note` / `write_chapter` / `create_*` actualiza el índice de ese archivo. Render fresco en la próxima query, sin reindex manual.
- **Reindex full** al boot si hay root configurado (async, no bloquea startup). Botón ↻ en el header del panel relanza un reindex completo si hace falta.
- Resultados rankeados por relevancia (BM25), con snippet centrado en el primer match y highlight `<mark>` de los términos.
- Click en un resultado: capítulo → abre en el editor central; nota → reader derecho (Shift+click la abre en el notes-editor central); carpeta → expande el árbol y navega.
- **Jump-to-term**: al clickear un hit, el editor/reader hace scroll automático al primer match dentro del contenido y selecciona el término (selección nativa del browser). Cualquier movimiento del cursor la limpia. Funciona en chapter editor, notes editor y markdown reader vía DOM `TreeWalker` (sin depender de TipTap commands).
- HTML strip simple para indexar capítulos (tags `<p>`, `<em>`, `<strong>`, etc. se desnudan a texto plano). El render del snippet sigue siendo texto + highlight, sin re-renderizar HTML.
- Mutex con image-viewer / font-preview / markdown-reader: el panel de búsqueda usa el mismo slot derecho y cierra a los otros tres cuando se abre.

### Conversor RAE

- Port TS de reglas D1–D5 desde [`dialogos_a_esp`](https://github.com/T4toh/dialogos_a_esp) — **el repo Python está deprecado**; arrastraba bugs (`\b` ASCII-only no matchea acentos, colapso de párrafos, D3/D5 incompletos) que se arreglaron del lado TS. Las reglas vivas viven acá; el Python queda solo como referencia histórica.
- Botón "RAE" en toolbar (solo cuando `idioma === 'es'`).
- Preview side-by-side antes de aplicar.
- **Procesamiento per-paragraph**: el converter detecta el HTML del editor y
  corre las reglas independiente por cada `<p>…</p>` y por cada chunk separado
  por `<br>` adentro. Sin esto, el HTML del editor (sin newlines reales) hace
  que D1 sólo dispare en el primer diálogo. Plain text (sin `<p>`) sigue
  procesándose línea por línea como en el CLI Python.
- **Verbos dicendi acentuados (`preguntó`, `murmuró`, `exclamó`…)**: usamos
  `(?!\p{L})` con flag `u` en vez de `\b`. El `\b` de JavaScript es ASCII-only
  y nunca matchea después de `ó` — la mitad de la lista de verbos dicendi
  estaba inactiva en la port TS (el Python original no tiene este problema
  porque `\b` ahí es Unicode-aware).
- **Reglas RAE 3 y 5 (inciso con continuación)**: el diálogo `"texto1" verbo
inciso. "texto2"` ahora cierra la raya antes del punto y deja el texto2 sin
  raya de apertura — `—texto1 —verbo inciso—. texto2`. Aplica tanto a inciso
  con verbo dicendi (D3) como a inciso de acción sin verbo (D4). El punto
  del primer diálogo se preserva en D4 (acción) y se absorbe en D3 (verbo
  dicendi), siguiendo la distinción de [DPD raya](https://www.rae.es/dpd/raya).

### Validador RAE (inline + batch)

Detecta violaciones de la regla DPD de diálogos sobre texto ya escrito — tanto
diálogos sin convertir (con `"..."`) como diálogos convertidos pero mal
parseados por versiones viejas del converter (rayas huérfanas, párrafos
colapsados, mezcla raya/comilla, etc.). Ground truth: [DPD raya](https://www.rae.es/dpd/raya).

**Detección híbrida** (`src/app/dialogos/validator.ts` + `rules-dedicated.ts`):

1. **Diff-based** (categoría `pending-conversion`): corre `convert()` sobre
   cada párrafo; si el output difiere del input (más allá de la normalización
   trivial de comillas tipográficas), emite violación con `autoFix` =
   replacement del converter.
2. **Reglas dedicadas** (texto ya convertido pero roto): 8 patrones regex
   independientes para casos que el converter no toca por estar "ya con raya":

   | ruleId | qué detecta | severidad | auto-fix |
   |---|---|---|---|
   | `dash-short` | `-`, `--` o `–` (en-dash) al inicio del diálogo en vez de `—` (em-dash) | error | sí (reemplazo a `—`) |
   | `dash-orphan` | apertura `—texto` sin raya de cierre cuando hay verbo dicendi después en el mismo párrafo, indicando inciso mal cerrado | warning | no |
   | `dash-quote-mix` | mismo párrafo con `—` y `"` (señal de parseo parcial) | error | no |
   | `paragraph-collapsed` | ≥3 transiciones `[.?!…]\s+—` + ≥3 verbos dicendi → varios turns de diálogo aplastados en un solo `<p>` | error | no |
   | `space-after-open` | `— Texto` (espacio sobrante después de raya inicial) | warning | sí (borra espacio) |
   | `space-before-verb` | `—Texto—dijo` (sin espacio antes de raya del verbo) | warning | sí (inserta espacio) |
   | `verb-capitalized` | `—Dijo` post-inciso (DPD pide minúscula tras la raya del verbo) | warning | sí (minúscula) |
   | `period-before-verb` | `—Texto. —dijo` cuando D2 debería haber absorbido el punto | warning | sí (borra punto) |

**Heurísticas anti-falso-positivo**:

- `dash-orphan` solo dispara si el verbo está precedido por **sentence-end**
  (`.?!…`), la palabra siguiente al verbo NO es subordinante (`que`/`si`/
  `cuando`/`porque`/…), y entre el verbo y el próximo `.?!…` hay ≤4 palabras
  (dicendi-inciso típico es corto: `<verbo> <sujeto>.`). Ej. `—Así le dicen
  al oro, Adi.` no flagea (mid-content), `Dicen que una mansión está encantada`
  no flagea (subordinante), `Bueno… dicen bastantes estupideces` no flagea
  (más de 4 palabras entre tag y próximo `.`).
- `paragraph-collapsed` exige tanto 3+ transiciones como 3+ verbos dicendi
  distintos (un monólogo legítimo con 2 incisos no dispara).
- `verb-capitalized` skipea raya de apertura del párrafo (`—Dicen eso...` =
  primera palabra del speech) y raya post-sentence-end (`. —Dicen otra cosa`
  = nuevo segmento del mismo hablante).
- Validator exit-early si `meta.idioma !== 'es'`. Diff-based ignora cambios
  por sola normalización de comillas tipográficas (`«»“”‘’`) para no flagear
  apóstrofes ingleses (`Anar's rest`).

**Inline UX** (`rae-extension.ts` + `rae-popover.ts`, mirror del patrón de
`grammar-extension`):

- Squiggle por categoría: char (rojo sólido), pending-conversion (naranja
  wavy), structure (rojo punteado), typo (amarillo wavy).
- Auto-check on chapter open + debounce 1.5s después de cada save. Toggle
  `✓RAE` en toolbar persistido en `settings.json::raeAutoDisabled`. Solo
  cuando `idioma == 'es'`.
- Popover por severidad: char/typo → "Aplicar" (auto-fix directo). pending
  → "Aplicar RAE al párrafo" (replacement con autoFix del converter).
  structure → solo "OK" (flag + tooltip, edit manual).

**Batch audit** (`RaeAuditService` + `RaeAuditPanel`):

- Trigger: context menu de saga/libro/sección → "Revisar RAE".
- Backend Rust `list_chapters_for_audit` (`src-tauri/src/audit.rs`) walks
  el scope, lee cada `.html` + parsea `meta.json::idioma`, devuelve lote
  completo en un solo invoke (sin round-trip por capítulo).
- Frontend filtra a `idioma == 'es'` (con fallback `detectLang` heurístico
  para chapters sin meta), corre validator sobre cada plain text, agrupa
  por capítulo con snippet + severidad.
- Mutex con search / image-viewer / font-preview / markdown-reader: al
  abrir cierra a los otros tres.
- Click en una violación → navega al capítulo + `requestHighlight` del
  término para que el editor scrollee al match.

**Verificación** (`scripts/run-rae-smoke.mjs`): 21 casos contra fixtures
(diálogos simples, raya huérfana, pending D2, dash-short, párrafo colapsado,
cita interna `«»` válida, multi-párrafo, monólogo con incisos, verbo regular
mid-content, post-sentence-boundary, etc.). Tested contra Meridian 2.0 cap 1
y 2 (`/home/tatoh/Dropbox/Novelas/Meridian 2.0/2 - Más que un trabajo/1 - Brickwell/convertidos/`):
ambos parsean como 1 solo párrafo gigante por el bug del converter Python
viejo, validador los detecta correctamente con `paragraph-collapsed`.

### Gramática + ortografía (LanguageTool)

- 3 modos: público (`api.languagetool.org`), local (Docker), custom URL (self-hosted o LT Premium).
- Underlines diferenciados: orto (rojo sólido), gramática (rojo wavy), estilo (amarillo wavy).
- Popover con sugerencias clickeables + atribución LT.
- Rate-limit client-side (18 req/min, 70KB/min) + chunking >20KB transparente.
- Auto-check auto-on en modo local/custom tras ping ok. Toggle persistido (`settings.json::grammarAutoDisabled`). Público queda off por ToS.
- Variantes regionales (es-AR, es-ES, en-US, en-GB…) globales + override per-saga (`saga.json::variante_es`/`variante_en`). Click en badge del footer abre dropdown.
- Diccionario per-saga: "+ diccionario" en popover de TYPOS filtra matches.
- **UX Docker explicativa**: stepper visual con fases `checking → pulling → starting → loading → ready` durante el arranque + bloque "Por qué Docker" con links a docker.com, languagetool.org, el repo oficial de LT y la imagen `erikvl87/languagetool` que usamos. Eventos `languagetool-progress` emitidos desde Rust con `tauri::Emitter`.
- **LT Premium / self-hosted con auth**: en modo Custom URL podés pegar tu username + apiKey. El apiKey va al **keyring del OS** (libsecret/Keychain/Credential Manager) vía el módulo `secrets`. Detalle abajo.

### Importer

- Pandoc CLI shell-out (`.docx`/`.odt` → HTML subset). Single chapter o bulk.
- Wizard de importación de saga/novela (📥 en header): trae carpeta externa al repo con detección heurística de estructura, decisión per-carpeta sobre conversión, metadata de saga + libros, normalización de tapas y extras, progress bar con eventos.
- **Generar demo** (mismo wizard 📥, tercer tipo): crea una saga de ejemplo con
  1 libro, 5 capítulos × 3 partes (15 archivos `.html`) con prosa fantasy
  hardcoded en ES o EN. Incluye diálogos en estilo RAE, `<em>`, `<strong>`,
  `<hr class="scene-break"/>` y un `<blockquote>` para cubrir el subset HTML
  del editor. Auto-sufijo `(N)` si el nombre ya existe. Contenido y estructura
  viven en `src-tauri/src/demo_template.rs` + `src-tauri/src/demo_content/`.
  Los archivos generados son normales — el usuario los puede editar, renombrar
  o borrar como cualquier otro.

#### Notas externas

Botón 📝 en el header del tree abre un wizard separado para traer notas markdown de fuentes externas, preservando la jerarquía de carpetas.

- **Joplin (Markdown export)**: en Joplin `File → Export all → MD - Markdown`. Apuntá el wizard a la carpeta exportada, elegí destino dentro del repo (default = nombre del folder source) y opciones:
  - **Saltar notas vacías**: omite `.md` con 0 bytes o contenido sólo whitespace.
  - **Conflicto de nombre**: sufijo (`nota-2.md`), saltar, o sobrescribir.
- La estructura de carpetas se preserva 1:1. `_resources/` y carpetas que empiezan con `.` se ignoran (Joplin no exporta los adjuntos de imagen en este formato).
- Las notas copiadas se indexan automáticamente para Ctrl+F al terminar.

**Arquitectura extensible** — backend en `src-tauri/src/import_notes.rs` con trait `NoteImporter { id, name, scan, apply }`. Para sumar un source nuevo (Obsidian, Notion, Bear, Logseq, Markdown plano):

1. Implementar el trait con `scan` (devuelve `ImportPreview`) y `apply` (copia + emite `<id>-import-progress`).
2. Exponer comandos Tauri `<id>_scan` y `<id>_import_apply`.
3. Crear servicio + componente frontend siguiendo el patrón de `import-joplin-service.ts` / `import-joplin/`.

### Extras + covers

- Layout canónico: `<saga>/extras/`, `<book>/extras/`, `cover.*`, `back-cover.*`.
- Auto-discovery de covers desde disco (las novelas viejas no se rompen).
- Drag&drop de archivos del OS al saga/libro.
- Context menu por extra: abrir, renombrar, borrar.
- `back-cover` embebida al final del EPUB si está presente.

### Export EPUB

- Builder Rust con `zip` + `uuid`. Estructura EPUB 3.
- CSS subset estilo Reedsy embebido.
- Templates 6×9" / 5×8" / A5 inyectados como `@page`.
- Cover image, dedicatoria, copyright, TOC navegable.
- Página "Sobre el autor" generada al final con foto + bio configurables (auto-detect de `author.*`/`autor.*` desde disco).

### Temas + fuentes embebidas

- Temas reutilizables a nivel root (`<root>/themes/<id>/`) con tipografía + márgenes.
- **Pool global de fuentes** en `<root>/fonts/`. Sección "Fuentes" en el árbol al nivel root — un solo lugar para subir y mantener todas las fuentes del repo. Los temas resuelven por nombre de familia; no hay copias per-tema ni per-saga.
- **Marca de uso**: cada fuente del pool tiene flag visual — 🔤 si algún tema/saga/libro la referencia, 🔇 + itálica desaturada si no la usa nadie. Tooltip indica el estado.
- **Botones de mantenimiento** en el header de Fuentes:
  - **⇲ Consolidar**: mueve fuentes dispersas (legacy `<theme>/fonts/`, `<saga>/fonts/`, `<book>/fonts/`) al pool global. Dedupa por nombre+tamaño (borra dupes), avisa colisiones de nombre con tamaño distinto, limpia carpetas `fonts/` vacías.
  - **🧹 Limpiar no usadas**: borra del disco las fuentes sin uso conocido (confirm modal con count).
- Override per-saga/per-libro: `saga.json::theme = { base, overrides }`, mismo shape en `book.json`. Fonts overrides locales aún se pueden poner en `<saga>/fonts/` o `<book>/fonts/` y tienen prioridad sobre el pool global (search order: book → saga → root → legacy `<theme>/fonts/`).
- Detección automática de bold/italic via sufijos en filename (`-Regular`, `-Bold`, `-Italic`, `-BoldItalic`, case-insensitive).
- **Per-style faces explícitas**: `body_font_italic`/`body_font_bold`/`body_font_bold_italic` apuntan a un filename stem específico para `<em>`/`<strong>`. Pisa el auto-pick. Útil cuando la italic auto es muy sutil.
- **Tema editorial**: `editorial_body_font` + `editorial_heading_font` aíslan tipografía de páginas no-autor (title page, copyright, dedicatoria, TOC, sobre el autor) de la prosa.
- **Posición del título de capítulo**: `chapter_title_position` (`top`/`center`/`bottom`) con fallback `@media amzn-kf8` para que Kindle también centre.
- **Preview de fuente en panel derecho**: click en una fuente del pool abre el viewer (FontFace API): hero `Aa Bb Cc` a 96px + alfabeto + signos ES + escala 14/20/32/48 + párrafo Lorem ipsum. Mutex con el image viewer (un panel a la vez). Esc o × cierra.
- Theme editor con preview real via `FontFace` API; lee fuentes del pool global (no tiene UI propia de upload).
- Modal de config de novela: el option "Heredar de saga" muestra el id/nombre del tema que la saga tiene actualmente seteado (carga `saga.json` del padre via `find_saga_dir`).
- Cero regresión: sin tema configurado, CSS byte-idéntico al de pre-temas.

### Debug / observabilidad

- Panel 🐛 toggleable en header (35vh fixed bottom, monospace).
- Log timestamped (HH:MM:SS.mmm) con niveles info / warn / error, source y mensaje + details opcionales.
- **Bridge Rust → frontend** vía `tracing` crate. `EmitLayer` custom forwardea cada `tracing::info!/warn!/error!` al evento Tauri `debug-log`. El listener Angular (`RustLogBridge`) lo empuja al mismo `DebugService`. Targets cubiertos: `fs`, `git`, `epub`, `import`, `import-wizard`, `grammar`, `theme`, `create`, `reorder`, `dialog`, `boot`. Filtro por env: `RUST_LOG=twriter_lib=info,warn,error` por default.
- Services frontend instrumentados: `ChapterService`, `UpdaterService`, `GrammarService`, `ThemesService`, `ProjectService`, `ImportWizardService`. App component captura `chapter/project/git.error()` vía effects.
- **Filtros**: 3 toggles de nivel (info/warn/error) + input de búsqueda por source.
- **Copiar**: botón en header serializa entradas filtradas a clipboard como texto plano (útil para bug reports).
- **Snapshot**: botón 📸 dumpea el estado actual (settings, project tree counts, capítulo activo, git status, grammar mode) como entrada `[snapshot]` con JSON pretty.
- **Persistencia sessionStorage**: log + visible + filtros sobreviven F5 (no entre sesiones).
- Max 200 entries (drop oldest).

### Storage backend (git / cloud / local)

tWriter auto-detecta cómo está versionada/sincronizada la carpeta raíz y adapta la UI:

- **Git** (`.git/` presente): auto-commit cada 5 min, status polling 30s, botones ⇅/⤓ visibles, badge dot con color por estado.
- **Cloud** (path bajo `Dropbox/`, `pCloud/`, `Nextcloud/`, `OneDrive/`, `Google Drive/`, `iCloud Drive/`, `Syncthing/`, `MEGA/`): badge con el nombre del servicio. La app solo escribe archivos — el cliente del servicio sincroniza.
- **Local**: badge `💾 Local`. Cero versionado, cero sync — el usuario respalda por su cuenta.

Cuando no es git, los controles ⇅/⤓ no aparecen y un botón `❓` al lado del badge abre un modal con la receta paso a paso para hacer `git init` + push a GitHub. Al cerrar el modal, la app re-chequea el folder, así que si corriste `git init` en una terminal aparte, el badge cambia a Git solo, sin reabrir la carpeta.

Si la carpeta es git _y_ además está adentro de Dropbox (caso "Dropbox como segundo sync"), gana git — los controles versionados son los que mostramos. Dropbox queda como redundancia invisible.

### Git auto-sync (cuando backend = git)

Objetivo: sync seamless entre PCs sin que el usuario tenga que abrir terminal
ni saber qué es `git pull --rebase`.

- `git2` crate (libgit2) para status + commit. Push/pull delegan al binario `git` del sistema (más estable para SSH/agent que libssh2).
- SSH agent + fallback a `~/.ssh/id_ed25519/id_rsa/id_ecdsa`.
- Auto-commit cada 5 min cuando hay cambios.
- Status polling 30 s; cuando detecta `behind > 0` corre auto-pull en background (`git pull --ff-only` o `git pull --rebase --autostash` si la rama está divergente).
- **Push auto-rebase**: si el remoto avanzó desde otra PC, `git push` falla con non-FF; el backend corre `git pull --rebase --autostash` y reintenta el push una vez. Si el rebase choca, lo aborta y la UI muestra "Conflicto entre esta PC y el remoto. Abrí el panel 🐛 para detalle." (sin terminal jargon).
- **`.twriter/` auto-ignorado al boot** (`git_ensure_twriter_ignored`): agrega `.twriter/` al `.gitignore` si falta y corre `git rm -r --cached .twriter` si está trackeado. Idempotente — los cambios quedan uncommitted y los pickea el próximo auto-commit. Evita conflictos add/add del índice tantivy entre PCs.
- **Errores categorizados**: stderr del CLI git se clasifica en `auth` / `network` / `conflict` / `rejected` / `unknown` desde Rust; el frontend (`git-service.ts::friendlyError`) los mapea a strings en español. La UI nunca expone hints crudos de git.
- **Throttle**: 3 fallas consecutivas de auto-pull pausan el loop 5 min para no spamear el panel 🐛. Sync manual (⇅) resetea el throttle. Conflict pausa de inmediato hasta sync manual.
- Botón "sync ahora" (⇅) en header.

### Distribución

- CI: `.github/workflows/release.yml`. Trigger: `git push --tags v*.*.*`. Linux job buildea `.deb`, Windows job buildea `.msi` + `.exe`. Ambos firmados ed25519.
- **Linux Arch / CachyOS**: PKGBUILD `twriter-bin` local en `packaging/aur/`. Pull el `.deb` del release, instala vía pacman. Update: `./packaging/aur/rebuild.sh <version>`.
- **Linux Debian / Ubuntu**: descargar `.deb`, `sudo apt install ./twriter_*.deb`. Sin auto-update.
- **Windows**: descargar `.msi` o `.exe`. Auto-update Tauri-native vía banner in-app contra `releases/latest/download/latest.json`.
- **macOS**: diferido hasta que arregle la pantalla del MacBook Pro.

#### Cortar release

Setup inicial (una sola vez):

```bash
pnpm tauri signer generate -w ~/.tauri/twriter.key --password "<password>"
```

Privada en `~/.tauri/twriter.key` — nunca commitear. Pública ya embebida en `tauri.conf.json::plugins.updater.pubkey`. En GitHub repo settings → Secrets:

- `TAURI_SIGNING_PRIVATE_KEY` ← contenido de `~/.tauri/twriter.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ← password elegida

Después cada release:

```bash
./scripts/bump-version.sh 0.2.0
git add -A && git commit -m "chore: bump v0.2.0"
git tag v0.2.0
git push && git push --tags
```

CI buildea + sube a draft release. Revisás changelog y publicás manual. En Arch (instalación local):

```bash
./packaging/aur/rebuild.sh 0.2.0
```

#### Publicar a AUR

> **Estado actual**: el PKGBUILD vive en `packaging/aur/` para uso personal (instalación local via `rebuild.sh`). No publicado todavía en AUR — esta sección es la receta cuando lo haga.

Setup inicial (una sola vez):

1. Crear cuenta en <https://aur.archlinux.org>.
2. Subir la clave SSH pública en _My Account → SSH Public Key_.
3. Instalar utilidades de packaging:

   ```bash
   sudo pacman -S pacman-contrib base-devel
   ```

4. Clonar el repo vacío del paquete:

   ```bash
   git clone ssh://aur@aur.archlinux.org/twriter-bin.git aur-twriter-bin
   cd aur-twriter-bin
   ```

5. Copiar archivos de packaging desde tWriter:

   ```bash
   cp ~/Repos/Personal/tWriter/packaging/aur/PKGBUILD .
   cp ~/Repos/Personal/tWriter/packaging/aur/twriter-bin.install .
   ```

6. Reemplazar `sha256sums=('SKIP')` por el hash real (AUR rechaza `SKIP`):

   ```bash
   updpkgsums
   ```

7. Generar `.SRCINFO` (AUR lo requiere para indexar metadata):

   ```bash
   makepkg --printsrcinfo > .SRCINFO
   ```

8. Verificar que builda y se instala limpio:

   ```bash
   makepkg -si
   ```

9. Commit + push al AUR:

   ```bash
   git add PKGBUILD .SRCINFO twriter-bin.install
   git commit -m "initial release: 0.1.12-1"
   git push origin master
   ```

Cada release nueva (después del setup inicial):

```bash
cd aur-twriter-bin
sed -i -E "s/^pkgver=.*/pkgver=0.2.0/" PKGBUILD
sed -i -E "s/^pkgrel=.*/pkgrel=1/" PKGBUILD
updpkgsums
makepkg --printsrcinfo > .SRCINFO
makepkg -si                                  # smoke test local
git add PKGBUILD .SRCINFO
git commit -m "upgpkg: twriter-bin 0.2.0-1"
git push origin master
```

Bumpear `pkgrel` (no `pkgver`) si cambia el PKGBUILD pero no la versión de tWriter.

Una vez publicado, los usuarios pueden instalar con cualquier AUR helper:

```bash
yay -S twriter-bin
# o
paru -S twriter-bin
```

## TODO

### Editor / UX

- Más variantes de divisor de escena (más allá del `* * *`).
- Divisor automático de partes (reglas confusas, hoy lo hace a mano).
- Drag & drop reorder de capítulos (hoy solo via context menu ↑/↓).
- Auto-abrir modal de configuración de LanguageTool cuando el chequeo tira error (hoy falla silencioso o solo loggea).
- Buscar más alternativas para la gramática.
- **Offsets de LT se desfasan ("se corre") intermitente**: a veces el
  squiggle queda sobre la palabra equivocada y el popover ofrece sugerencias
  para otra palabra (ej. marca "casa" pero sugiere fixes para "cosa" que
  está 2 chars antes). Difícil de reproducir. Sospechosos:
  (a) `extractPlainText` en `grammar-extension.ts:90` mete `\n\n` por cada
  `<br>` hard-break adentro de `<p>` — si LT cuenta los `\n\n` distinto que
  PM, el offset → pmPos se corre. (b) `applyGrammarReplacement` no remapea
  el resto de las matches con `transaction.mapping` después de insertar el
  replacement, queda el array viejo con offsets stale hasta el próximo
  check. (c) Caracteres especiales tipo NBSP / soft-hyphen / zero-width
  joiners en el HTML del importer Pandoc cuentan distinto en plain vs PM.
  Plan: agregar log target=`grammar` con `from/to/expected_word/actual_word`
  al click del popover, ver si la divergencia es siempre por edits intermedios
  o también en chapters recién abiertos.
- **Auto-replace `...` → `…` al escribir**: TipTap Typography extension ya
  está cargada (debería convertir `...` a `…` U+2026 en tiempo real), pero
  hay capítulos donde aparecen `...` literales (caso reportado: cap 2 de
  "Amigo del Bosque" tiene "Gracias..." en dos formas distintas). Verificar
  que la regla `ellipsis` de Typography esté activa + agregar shortcut de
  teclado o input rule por si el auto-replace está pisado por algo. Si vino
  del importer Pandoc, agregar normalización post-import (`<p>` content:
  `\.\.\.` → `…`).
- **Indicador de línea/columna en footer del editor**: hoy solo muestra
  palabras y estado guardado. Agregar `Ln 42, Col 15` (o número de párrafo)
  para poder ubicar offsets reportados por el validador RAE / LT / batch
  audit. Posición se lee de la selección de ProseMirror; render junto a
  `wordCount` en `editor.html`.
- Operadores en la búsqueda (AND, OR, "frase exacta" entre comillas, filtros por kind). Hoy parsea como query libre con BM25.
- **Búsqueda multi-palabra trae basura**: con 2+ palabras devuelve cualquier
  documento que tenga AT LEAST ONE término (semántica OR del query parser
  de tantivy por default) en vez de los que tienen TODOS. Resultados
  rankean por BM25, así que el "más relevante" sube primero, pero la lista
  larga de coincidencias parciales confunde. Fix: pasar el `default_operator`
  a `AND` al construir el `QueryParser` en `src-tauri/src/search.rs`, o
  reescribir la query a `+term1 +term2` antes de parsear. Alternativa más
  potente: usar el operador parser de tantivy y exponer query syntax al
  usuario (ver item de arriba).

### Tree / Importer

- **Importer no ve `convertidos/`**: el walker del tree (`fs.rs::SKIP_DIRS`)
  excluye `convertidos/`, `Revisiones/`, etc. para no mostrar backups en el
  árbol. Side effect: el wizard de importar tampoco los ve, así que si la
  carpeta de origen (ej. `Meridian 2.0/2 - Más que un trabajo/1 - Brickwell/`)
  tiene sus `.odt` modernos del converter Python en `convertidos/`, el
  wizard ofrece solo los `.odt` originales del root (sin RAE). Fix posible:
  (a) toggle en el wizard "incluir también `convertidos/`" para casos de
  migración, o (b) detección heurística — si la carpeta tiene tanto `.odt`
  raw como `convertidos/<n>_convertido.odt`, ofrecer el convertido por
  default. Tested contra Meridian 2.0 cap 1 y 2: ambos parsean a 1 solo
  párrafo gigante (bug del converter Python viejo, ya conocido) y el
  validador RAE lo flagea con `paragraph-collapsed` correctamente.
- Re-importar capítulo sobrescribiendo el `.html` existente (hoy hay que borrar primero).
- Borrar entradas individuales del diccionario per-saga desde UI (hoy se editan en bloque vía textarea del modal de configuración; agregar funciona desde el popover de typos).
- Sumar más importers de notas: Obsidian (vault con `.obsidian/`), Notion (export ZIP), Bear (`.bear`), Logseq (graph), Markdown plano con frontmatter. El trait `NoteImporter` ya está armado — agregar uno nuevo no requiere tocar el wizard genérico.
- Joplin JEX format (preserva adjuntos + tags + timestamps). Hoy solo soporta el export raw MD.
- ~~Limpiar restos de tema en el wizard importador~~ ✅ El paso `saga-config`
  del wizard ya no pregunta los 6 defaults EPUB (`template`,
  `prefijo_capitulo`, `mostrar_titulo_capitulo`, `dropcap`,
  `mostrar_numero_parte`, `formato_parte`). Quedó enfocado en
  estructura/metadata/conversión + nombre/autor/idioma/imprenta. La
  presentación se configura en el theme editor + `saga.json::theme` /
  `book.json::theme`. Demo template y `applySagaDefaultsToBooks` stripeados
  en consonancia. Read-side legacy fallback en `theme.rs::resolve_theme`
  intacto para repos viejos que tengan los 6 campos al root de
  saga.json/book.json.

### EPUB

- Lista "Otros libros del mismo autor" en EPUB (contratapa ya está embebida).
- Preview tipo Kindle (B/N, distintos tamaños — Paperwhite, Oasis, Scribe). Amazon discontinuó Kindle Previewer en Linux.
- Pesos extra de fuente (300 Light, 600 SemiBold, 900 Black). Hoy solo Regular/Bold/Italic/BoldItalic; pesos custom requieren edit manual del `theme.json`.
- Auto-migración de tema renombrado: hoy renombrar un tema deja sagas/libros con `base` dangling (warning). Implementar scan recursivo de `*.json` y rewrite del `base`.
- Colores en el tema (body color, heading color, scene-break color). Hoy el tema es solo tipografía + márgenes.
- Theme presets compartibles entre repos distintos (export/import como zip).
- Revisiones de EPUB: hoy sobreescribe siempre `Exportados/<titulo>.epub`. Sumar "guardar últimas N revisiones" (default 5) — renombrar la actual a `<titulo>-revN.epub` antes de generar la nueva.
- Diseño de la página "Sobre el autor": hoy funcional pero genérico (foto circular + bio justified). Pensar layout más editorial (dos columnas, variantes de retrato, epígrafe).
- Bio + foto del autor a nivel saga (heredados a libros nuevos) y/o `settings.json` (defaults globales del repo). Hoy solo `book.json`.
- Vista copada para diseñar temas (Con preview de todo. Título, copyright, capítulo y una página.)

### Archivos

- Changelog screen in-app: panel/modal accesible desde el header (junto a 🐛) parseando `CHANGELOG.md` o release notes de GitHub. Útil para gente nueva post-AUR.
- Guía in-app de primer uso: tour con flechas la primera vez que se abre la app (tree explorer, idioma, RAE, gramática, sync). Persiste flag en `settings.json`.
- Botón "Abrir en terminal" dentro del modal storage-help (`xdg-open` / `konsole` / `gnome-terminal` / `wt`).

### Observabilidad / Stats

- Diff/historial visual via `git log`.
- Stats: gráfico palabras/día.
- Preview pre-push: hoy el indicador del header dice "15 archivos para subir" sin detalle. Tooltip con lista de paths (M/A/D) en hover, y/o dialog "Ver cambios pendientes" con `git status --short` + `git diff --stat`.

### Validador RAE

- **Bulk auto-fix** desde el panel "Revisar RAE": hoy el panel es solo lista
  + click-to-jump. La acción "Aplicar todos los auto-fixables (N)"
  (replacements char/typo agrupados por archivo en orden descendente de
  offset, un `write_chapter` por archivo) quedó fuera de v1 — el riesgo es
  pisar inline markup (`<em>`/`<strong>`) al reconstruir HTML desde plain
  text. Implementar con patch quirúrgico HTML-aware: encontrar el rango en
  el HTML que corresponde al span del fix y reemplazar solo eso, sin tocar
  el resto del párrafo.
- **Fix de `pending-conversion` desde popover inline**: hoy aplica el
  replacement del converter como plain text sobre el rango del párrafo, lo
  que strip-ea inline markup en ese párrafo. Para párrafos con markup, usar
  el botón "RAE" del toolbar (modal de capítulo entero) que sí preserva
  markup vía el path `<p>…</p>` del converter. Solución: serializar el slice
  ProseMirror del párrafo a HTML antes de invocar `convert()`, y replazar el
  rango con el HTML resultante en vez de `insertContent` plano.
- **Jump-to-exact-offset desde el batch**: el click en una violación del
  panel usa el patrón `requestHighlight` de search (busca el término en el
  capítulo y scrollea al primer match). Funciona para violaciones con
  término único, pero para snippets repetidos (ej. `—dijo` que aparece 30
  veces) salta al primer match, no al específico de la violación.
  Implementar `consumePendingRaeJump(path)` que devuelva offset+length y el
  editor mapee al `pmPos` correcto al render.
- **Atribución D1-D5 en `pending-conversion`**: hoy el ruleId es genérico
  `pending-conversion`. Para fine-grain (saber qué regla del converter
  mordió en cada violación), instrumentar `convert()` con hooks que reporten
  qué subpattern matcheó por párrafo.
- **Salvaguardas adicionales**: `dash-orphan` puede dar falso positivo en
  diálogos donde el verbo dicendi aparece dentro de una cita interna larga
  (`—Me dijo «si pudieras venir, dijo...»`). Refinar: solo flaggear si el
  verbo está en el nivel "narrativo" del párrafo, no dentro de `« »`.
- **Tests con fixtures reales**: cuando `/home/tatoh/Repos/novelas/` tenga
  los capítulos viejos de Meridian 2.0 pulleados, sumar `validator.spec.ts`
  cases con párrafos textuales de esos archivos (incluyendo el caso "todo
  colapsado en un párrafo" detectado en exploración) para regresión.

### Plataformas

- Mobile (no urgente, capaz solo un exportador a EPUB para ver archivos desde gh).

## Gramática (LanguageTool)

tWriter soporta 3 backends de LanguageTool. Todos hablan el mismo endpoint
HTTP (`/v2/check`); cambia dónde corre y cómo se autentica.

### 1. API público (default)

`api.languagetool.org` — gratis, sin instalación. Limitado a 20 req/min,
75KB/min, 20KB/req. El texto se envía a servidores LT.

- Solo chequeo on-demand (sin auto-recheck mientras escribís — el ToS lo prohíbe).
- Banner naranja avisa la primera vez que activás la feature en una sesión.

### 2. Local (Docker)

Para uso intensivo y privacidad total. La app puede levantarlo desde el
modal de gramática (⚙ del header → "Local (Docker)" → "Levantar LanguageTool"),
o por CLI:

```bash
./scripts/start-languagetool.sh   # primera vez tarda ~30s en cargar modelos
./scripts/stop-languagetool.sh
```

Detalles bajo el hood:

- Imagen [erikvl87/languagetool](https://hub.docker.com/r/erikvl87/languagetool)
  ([repo](https://github.com/Erikvl87/docker-languagetool)) — Java 17 + LT
  - hunspell, expone `:8010` que mapeamos a `localhost:8081`.
- ~2GB RAM en runtime, ~300MB de imagen on disk. Hunspell incluido cubre
  ES/EN — no necesitás diccionario aparte.
- Auto-check on-by-default cuando el ping responde. Toggle persiste en
  `settings.json::grammarAutoDisabled`.
- El backend Rust emite eventos `languagetool-progress` con fases
  `checking → pulling → starting → loading → ready`; el modal muestra
  un stepper en vivo.

### 3. URL custom — self-hosted o LT Premium

Para apuntar a un endpoint LT propio (proxy / instancia interna) o a
**LanguageTool Premium** (`api.languagetoolplus.com`).

Premium requiere `username` + `apiKey` en cada POST a `/v2/check`:

- **Username** queda en `settings.json` (no es sensible — es un email).
- **API key** va al **keyring del OS**:
  - Linux: libsecret / Secret Service API → resuelven `gnome-keyring`,
    `kwalletd6` (Plasma 6+) u otros.
  - macOS: Keychain.
  - Windows: Credential Manager.
  - El crate Rust [`keyring`](https://crates.io/crates/keyring) v3 abstrae
    los tres.
- Si el OS no expone un Secret Service (sistema sin DE, daemon caído),
  caemos a `secrets-fallback.json` en `app_config_dir` con permisos `0600`
  y un warning visible en el modal (`⚠ Plaintext (sin keyring disponible)`).

El apiKey **nunca cruza el bridge JS → Rust** en operación normal: el
backend la lee del keyring server-side cuando arma el form POST. El
módulo `secrets` solo expone `lt_api_key_status` (devuelve `{present,
backend, keyring_available}`) y `lt_api_key_save(value)` (escribir o
borrar). El struct `GrammarConfig` tiene un `impl Debug` manual que
enmascara el campo apiKey como `***` para que no aparezca jamás en logs,
tracing ni snapshots del panel 🐛.

Para sacar key de LT Premium: <https://languagetool.org/proofreading-api>.

## Instalación

Releases en <https://github.com/T4toh/tWriter/releases>.

### Arch / CachyOS

**Opción A: AUR** (cuando esté publicado, ver "Publicar a AUR" arriba):

```bash
yay -S twriter-bin     # o paru, pikaur, etc
```

**Opción B: PKGBUILD local** (uso actual del autor):

```bash
git clone https://github.com/T4toh/tWriter
cd tWriter
./packaging/aur/rebuild.sh
```

Requiere `pacman-contrib` (`updpkgsums`) y `base-devel`. Para actualizar:

```bash
git pull
./packaging/aur/rebuild.sh <version>     # e.g. 0.2.0
```

### Debian / Ubuntu

Descargar el `.deb` del último release e instalar:

```bash
wget https://github.com/T4toh/tWriter/releases/latest/download/twriter_*_amd64.deb
sudo apt install ./twriter_*_amd64.deb
```

Sin auto-update — recheckear releases manualmente.

### Windows

Descargar de releases:

- `.msi` (instalador limpio, recomendado para uso normal), **o**
- `.exe` (NSIS, instalador alternativo)

Auto-update Tauri-native: la app chequea `releases/latest/download/latest.json` y muestra banner in-app cuando hay versión nueva. Aceptar el banner descarga e instala sin pasar por el browser.

### macOS

Diferido hasta que el autor arregle la pantalla del MacBook Pro. Mientras tanto, build manual desde fuente — ver "Setup de desarrollo" abajo.

### Dependencias opcionales

- **Pandoc** (para importar `.docx`/`.odt`): `sudo pacman -S pandoc` / `sudo apt install pandoc` / [pandoc.org](https://pandoc.org/installing.html) en Windows. Sin Pandoc, el importer queda inhabilitado pero el resto de la app funciona.
- **Docker** (para LanguageTool local): ver sección "Gramática" arriba. Sin Docker, la app usa el API público de LT por default.

## Setup de desarrollo

Instrucciones para **Arch / CachyOS** desde cero. En otros distros adaptar los gestores de paquetes.

### 1. Toolchain Rust

Usar `rustup` (toolchain manager oficial), no el paquete `rust` de Arch.

```bash
sudo pacman -S rustup
rustup default stable
```

### 2. Node.js + pnpm

```bash
sudo pacman -S nodejs pnpm
```

### 3. System libs (Tauri 2 + WebKit)

```bash
sudo pacman -S --needed \
  webkit2gtk-4.1 \
  librsvg \
  libayatana-appindicator \
  base-devel \
  openssl \
  gtk3 \
  file
```

`base-devel` trae `gcc`, `make`, `pkg-config` (necesarios para compilar crates nativas como `git2`).

### 4. Pandoc (importer .docx/.odt)

```bash
sudo pacman -S pandoc
```

### 5. Docker (opcional, para LanguageTool local)

```bash
sudo pacman -S docker
sudo systemctl start docker        # arrancar on-demand, no enable
sudo usermod -aG docker $USER     # logout/login para que tome efecto
```

Sin Docker la app igual anda — usa el API público de LanguageTool por default.

### 6. Clonar e instalar

```bash
git clone <repo-url> tWriter
cd tWriter
pnpm install
pnpm tauri dev
```

Primera build de Rust ~5 min (compila `git2`, `webkit`, `zip`, etc.). Después es incremental.

## Desarrollo

```bash
pnpm tauri dev      # frontend :1420 + backend Rust
pnpm build          # solo Angular
pnpm tauri build    # paquete (.AppImage / .deb)
ng test             # Karma tests (Angular)
cargo test --manifest-path src-tauri/Cargo.toml   # tests Rust
```

En **Arch / CachyOS** (system libs con secciones ELF `.relr.dyn`) el `strip` que linuxdeploy embebe falla. Workaround para `tauri build`:

```bash
NO_STRIP=true pnpm tauri build
```

CI (Ubuntu 22.04) no necesita este flag — system libs ahí son ELF clásico.

## Licencia

MIT
