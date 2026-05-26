# tWriter

App desktop para escribir novelas en español e inglés. Centraliza el flujo: editor → conversor de diálogos a estilo RAE → chequeo de gramática → exportación EPUB. Reemplaza LibreOffice + Reedsy en una sola herramienta.

Las novelas viven en un repo privado aparte (HTML + JSON). Esta app es solo el editor.

**Stack**: Tauri 2 + Angular 21 + TipTap. Backend Rust, frontend signals.

## Tabla de contenidos

- [tWriter](#twriter)
  - [Tabla de contenidos](#tabla-de-contenidos)
  - [Instalación](#instalación)
    - [Arch / CachyOS](#arch--cachyos)
    - [Debian / Ubuntu](#debian--ubuntu)
    - [Windows](#windows)
    - [macOS](#macos)
    - [Dependencias opcionales](#dependencias-opcionales)
  - [Features](#features)
    - [Editor](#editor)
    - [Notas (Markdown)](#notas-markdown)
    - [Tree explorer](#tree-explorer)
    - [Búsqueda (Ctrl+F)](#búsqueda-ctrlf)
    - [Conversor RAE](#conversor-rae)
    - [Validador RAE (inline + batch)](#validador-rae-inline--batch)
    - [Gramática + ortografía (LanguageTool)](#gramática--ortografía-languagetool)
    - [Importer](#importer)
      - [Notas externas](#notas-externas)
    - [Extras + covers](#extras--covers)
    - [Export EPUB](#export-epub)
    - [Temas + fuentes embebidas](#temas--fuentes-embebidas)
    - [Debug / observabilidad](#debug--observabilidad)
    - [Storage backend (git / cloud / local)](#storage-backend-git--cloud--local)
    - [Git auto-sync (cuando backend = git)](#git-auto-sync-cuando-backend--git)
  - [Configuración avanzada](#configuración-avanzada)
    - [LanguageTool (3 backends)](#languagetool-3-backends)
      - [API público (default)](#api-público-default)
      - [Local (Docker)](#local-docker)
      - [URL custom — self-hosted o LT Premium](#url-custom--self-hosted-o-lt-premium)
  - [Para desarrollar](#para-desarrollar)
    - [Layout de archivos del repo de novelas](#layout-de-archivos-del-repo-de-novelas)
    - [Setup local](#setup-local)
      - [1. Toolchain Rust](#1-toolchain-rust)
      - [2. Node.js + pnpm](#2-nodejs--pnpm)
      - [3. System libs (Tauri 2 + WebKit)](#3-system-libs-tauri-2--webkit)
      - [4. Pandoc (importer .docx/.odt)](#4-pandoc-importer-docxodt)
      - [5. Docker (opcional, para LanguageTool local)](#5-docker-opcional-para-languagetool-local)
      - [6. Clonar e instalar](#6-clonar-e-instalar)
    - [Comandos](#comandos)
    - [Distribución](#distribución)
      - [Cortar release](#cortar-release)
      - [Publicar a AUR](#publicar-a-aur)
  - [TODO](#todo)
  - [Licencia](#licencia)

## Instalación

Releases en <https://github.com/T4toh/tWriter/releases>.

### Arch / CachyOS

**Opción A: AUR** (cuando esté publicado, ver "Publicar a AUR" abajo):

```bash
yay -S twriter-bin     # o paru, pikaur, etc
```

**Opción B: PKGBUILD local** (uso actual del autor):

```bash
git clone https://github.com/T4toh/tWriter
cd tWriter
./packaging/aur/test.sh
```

Requiere `pacman-contrib` (`updpkgsums`) y `base-devel`. Para actualizar:

```bash
git pull
./packaging/aur/test.sh <version>     # e.g. 0.2.0
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

Diferido hasta que el autor arregle la pantalla del MacBook Pro. Mientras tanto, build manual desde fuente — ver [Setup local](#setup-local).

### Dependencias opcionales

- **Pandoc** (para importar `.docx`/`.odt`): `sudo pacman -S pandoc` / `sudo apt install pandoc` / [pandoc.org](https://pandoc.org/installing.html) en Windows. Sin Pandoc, el importer queda inhabilitado pero el resto de la app funciona.
- **Docker** (para LanguageTool local): ver [LanguageTool](#languagetool-3-backends). Sin Docker, la app usa el API público de LT por default.

## Features

### Editor

- TipTap con HTML subset: `<p>`, `<i>`, `<em>`, `<strong>`, `<u>`, `<hr>`, `<h1>`, `<blockquote>`.
- Autosave debounced 1.5s.
- Toolbar: undo/redo, B/I/U, alineación, salto de escena, RAE, gramática, font size, familia tipográfica, espaciado de párrafos, ancho hoja.
- Menú contextual propio.
- **Layout flat**: el editor renderea párrafos sin `text-indent` y con `text-align: left` para que escribir no "salte" word-spacing por línea ni se vean indents que confunden. El EPUB exportado mantiene `text-indent: 1.5em` + `text-align: justify` desde `reedsy-subset.scss` — formato editorial al exportar, layout cómodo al escribir.
- **Selector de fuente del editor**: dropdown estilo LibreOffice/Word con búsqueda. Cuatro grupos: **Recientes** (top 5, persistido en `settings.json::editorFontRecents`), **Del tema** (body / heading / editorial del tema resuelto del capítulo activo — saga + libro override), **Presets** (`Serif / Sans / Mono / Sistema`, los 4 stacks hardcodeados originales), **Pool del repo** (familias deduplicadas de `<root>/fonts/`) y **Sistema (N)** (todas las familias instaladas en el OS, listadas via crate `fontdb` 0.23 en `src-tauri/src/system_fonts.rs::list_system_fonts`, cache lazy `Mutex<Option<Vec>>` + `refresh_system_fonts` para re-scan). Cada ítem renderea su nombre en su propia tipografía (FontFace API on-hover via `SystemFontsService::loadFace`, idempotente). Valor persistido en `settings.json::editorFontFamily` como `string` libre (los 4 keywords presets siguen siendo válidos). CSS var `--editor-font-family` sobre `.ProseMirror` aplica el stack resuelto vía `resolveEditorFontStack()` (preset → stack hardcoded, sino familia + fallback serif). **Fallback + badge**: si la familia guardada no existe en OS ni pool ni presets (típico al sincronizar settings entre PCs), el editor cae a serif default y el footer muestra badge `⚠ <nombre>` con tooltip explicativo; el valor en settings no se sobrescribe (al volver a la otra PC vuelve a aplicarse). Para el `<app-select>` se sumaron `groups` y `itemTemplate` manteniendo compat con el shape `options` plano.
- **Gap cursor desactivado**: `StarterKit.configure({ gapcursor: false })` para evitar el marker vertical huérfano que aparecía en zonas vacías del editor (entre hr/h1/párrafos, click fuera del texto).
- Modo focus (F11 / Esc): oculta tree, deja toolbar y footer.
- Indicador de idioma en footer (badge color) + toggle ES/EN.
- Diálogos custom (prompt/confirm/alert) coherentes con el resto de los modales — sin headers feos de WebKit.
- `<app-select>` Angular standalone reemplaza los `<select>` nativos en todos los modales (no más widget del DE distinto por distro). Typeahead automático cuando hay >10 opciones.
- File pickers nativos vía `rfd` 0.15 con feature `xdg-portal` — en KDE/Wayland abre el portal del sistema en vez del diálogo GTK 3 foreign del plugin-dialog.
- **Split view**: arrastrá un capítulo o nota del árbol al panel central para abrir un segundo editor. Combos: chapter+chapter (comparar/escribir en paralelo) o chapter+note (nota como referencia mientras escribís). Cada pane tiene su propio autosave, idioma, gramática y RAE. Botón ⬍/⬌ cambia entre split horizontal (lado a lado) y vertical (apilado). Botón × cierra el pane secundario y vuelve a single-pane. Estado no persistido entre sesiones (cada vez arranca single).
- **Indicador de posición en el footer**: `P. N · Col M` al lado del wordCount, contando bloques top-level (párrafos / headings / blockquotes) y el offset dentro del bloque que contiene al cursor. Estable contra wrap (no depende del ancho de hoja / font size); alinea con los offsets per-paragraph que reportan validador RAE / LT / batch audit. Cada pane (split view) tiene su propio indicador.
- **Auto-replace `...` → `…`**: TipTap Typography activo en runtime (ya convertía al tipear). Sumamos normalización post-import en `clean_html` (`src-tauri/src/import.rs`) — los `.docx`/`.odt` que llegaban con `...` literal ahora se guardan con `…` (U+2026) directo.
- **Lectura idempotente (no más "dirty fantasma")**: `read_chapter` (`src-tauri/src/fs.rs::normalize_chapter_html`) colapsa el whitespace-con-newline entre tags antes de devolver el HTML al frontend. TipTap `getHTML()` no emite `\n` entre block tags, pero los `.html` importados vía Pandoc sí los tenían — sin normalizar, abrir un cap marcaba `dirty` y lanzaba autosave aunque el usuario no editara nada (después se acumulaba como "modified" en `git status` con diff puramente whitespace). La regex `>\s*\n\s*<` solo matchea cuando hay `\n` real (preserva espacios entre inlines tipo `<em>x</em> <strong>y</strong>`). El disco no se reescribe hasta que el usuario edita de verdad. Tests `fs::tests` (4) cubren block tags, inlines preservados, idempotencia y edge case inline-newline.

### Notas (Markdown)

- Editor separado para `.md` con TipTap + `tiptap-markdown` (no toca el flow de capítulos HTML).
- Toolbar: B/I/S/code inline + H1/H2/H3 + listas bullet/numerada + blockquote + code block + hr. Sin RAE, LT ni idioma.
- Convivencia con capítulos: mutex de un solo editor a la vez. El icono y footer marcan claramente "Nota".
- `.md` aparecen en cualquier ubicación del árbol (root, carpeta libre, saga, libro, sección); las carpetas `<saga>/notas/` y `<book>/notas/` se renderizan como 📒 expandibles. Carpetas libres en root (sin saga.json/book.json) se renderizan como 📁.
- Creación libre en root: click derecho en el área vacía del tree → "Nueva carpeta…" o "Nueva nota…" arman estructura paralela al TOC para worldbuilding/research. Click derecho sobre una carpeta 📁 permite anidar recursivo.
- `notas/` y los `.md` quedan auto-excluidos del export EPUB y de la vista de tarjetas (la vista de tarjetas es para contenido del libro).
- "Nueva nota…" desde context menu de saga/libro/carpeta `notas/` (autocrea el dir si no existe).
- `.md` que viven en `extras/` también abren en este editor (no en `xdg-open`).
- **Reader en panel derecho**: click sobre `.md` (en `notas/` o `extras/`) abre la nota como render read-only al costado, sin desplazar al capítulo del centro. Botón ✏️ togglea **modo edit in-place** (toolbar reducida B/I/H1-3/listas/cita/code + autosave 1.5s) para tocar la nota sin perder el capítulo de contexto; ✓ vuelve a read-only; 🗙 cierra (flush sync si hay cambios). Mutex: si la misma nota se abre en el pane central, el reader cierra solo. Esc en edit → vuelve a read; Esc otra vez → cierra. Mutex con image viewer y font preview.
- **Doble click** sobre `.md` abre directamente en el editor central (ahorra el click+✏️ del reader). Shift+click también. Mismo comportamiento en resultados de búsqueda y en archivos `.md` que vivan en `extras/`.
- **Ancho del panel derecho**: botón en el header del reader cicla 4 presets (compacto 280px / normal 380px / ancho 560px / pantalla — oculta el centro). Persiste en `settings.json::rightPanelWidth`.

### Tree explorer

- Jerarquía Saga / Libro / Sección / Capítulo + Notas + carpetas `notas/` + carpetas libres 📁 en root.
- Context menu: crear, mover, renombrar, importar, exportar EPUB, configurar libro, excluir del EPUB. Para notas: abrir, renombrar, borrar. Para carpetas libres: nueva nota, nueva carpeta, renombrar, borrar.
- Right-click en área vacía del tree → "Crear saga / novela", "Nueva carpeta…" (📁 libre), "Nueva nota…" (`.md` suelta).
- Reorder vía drag & drop (sagas, libros, secciones, capítulos, notas) + mover cross-parent (capítulo entre secciones, sección entre libros, libro entre sagas). Context menu ↑/↓ sigue disponible. Sagas/libros/secciones sin prefijo numérico se migran a `1..N` automáticamente en el primer DnD.
- **Insertar parte intermedia**: right-click sobre una parte numerada
  (`<N>.html` dentro de una sección) → "Agregar parte nueva" inserta un
  `<N+1>.html` vacío y shiftea las siguientes (`N+1` → `N+2`, `N+2` →
  `N+3`, …) renombrando los `.html` + `.meta.json` en orden descendente
  para evitar colisiones y actualizando el campo `orden` en cada meta
  movida. Comando Rust `insert_part_after` con revert on error (si falla
  mid-shift, deshace los renames hechos).
- Archivos no-chapter visibles en el tree con íconos por tipo (🖼 imagen, 📄 documento, 📝 texto, 📦 otro). Notas con 📝 y badge `.md`.
- Template inicial precargado (saga/libro/capítulo dummy) al crear sagas/libros nuevos.
- Badge "excluido" para `.twriter-ignore`.
- Selector de carpeta raíz persistido + auto-load del último capítulo abierto.
- **Restaurar sesión**: al boot reabre el último cap/nota del pane 0 con el cursor en la posición exacta (`pmPos` de ProseMirror) y reaplica las carpetas que estaban expandidas (saga/libro/sección/folder libre + Extras + Extras subdirs + Exportados). Vive en `settings.json::lastSession` + `treeExpanded`/`treeExtrasExpanded`/`treeExtrasDirsExpanded`/`treeExportsExpanded`. Si el cap se borró/renombró entre sesiones, silent skip + clear del slot. Cap más corto (editado en otra PC) clampea el cursor al final. La vista siempre arranca arriba del capítulo — el cursor preserva posición para flechas/End, pero el scroll no salta al cursor guardado (`focus(undefined, { scrollIntoView: false })` + `scrollTop = 0`). Antes, cerrar con cursor al final reabría el cap al final. Split view (pane 1) no se restaura — sigue arrancando single como antes.
- **Último editado a la vista**: cada capítulo muestra a la derecha un badge mono discreto con el tiempo relativo desde el último edit (`recién`, `hace 5 min`, `ayer`, `hace 3 d`, `hace 2 sem`, `hace 4 meses`). El más reciente del proyecto se marca con un border-left accent + badge resaltado para encontrarlo de un vistazo al abrir la app. Tooltip del row tiene el timestamp absoluto (`YYYY-MM-DD HH:mm`). Helpers en `src/app/core/relative-time.ts`; tick interno de 60s en `tree.ts` para que los strings se refresquen sin re-render. Data viene del `modifiedMs` que ya emitía `get_tree` — cero cambios backend.

### Búsqueda (Ctrl+F)

- Panel lateral con full-text search sobre notas (`.md`) + capítulos (`.html`) + títulos de carpetas (sagas/libros/secciones/folders/notas).
- Backend: [tantivy](https://github.com/quickwit-oss/tantivy) (in-process, sin servicio externo). Índice persistido en `<root>/.twriter/search-index/` — auto-excluido del tree y del export EPUB. Schema versionado (`<root>/.twriter/search-index/.version`): cambios de schema disparan wipe + full reindex automático al boot.
- **Multi-palabra = AND**: query con 2+ términos requiere TODOS (no AT-LEAST-ONE). El default del `QueryParser` de tantivy es OR; lo forzamos a AND en `search.rs::search_query_impl` vía `parser.set_conjunction_by_default()`.
- **Operadores explícitos**:
  - `duendes mansión` → ambos (AND default).
  - `duendes OR mansión` → cualquiera.
  - `"casa encantada"` → frase exacta.
  - `-trampa duendes` → excluye `trampa`.
  - `kind:note duendes`, `kind:chapter duendes` → filtra por tipo.
    El botón `?` del header lista la sintaxis en tooltip.
- **Scope persistido** (selector debajo del input): `Todo el repo / Saga actual / Libro actual / Solo capítulos / Solo notas`. `Saga actual` y `Libro actual` se resuelven contra el capítulo abierto en el pane principal (la app walkea ancestros saga/book del path activo). Si no hay cap activo, el scope cae a `Todo el repo` y aparece un hint sutil `⚠ sin cap activo`. La elección persiste en `settings.json::searchScope`.
- **Ranking ES**: tokenizer custom `es_text` (`SimpleTokenizer + RemoveLongFilter(40) + LowerCaser + StopWordFilter::Spanish`) aplicado a `title` y `content`. Stopwords ES estándar (`el/la/los/las/de/del/que/y/o/...`, vía snowball embebido en tantivy `feature = "stopwords"`) no entran al índice — buscar `de` solo devuelve 0 hits y queries multi-término no ranquean por basura conectora. Field boost `title × 2.5` (`parser.set_field_boost`): un match en título ranquea sobre el body.
- **Modo debug BM25** (toggle 🐞 en header, persistido en `settings.json::searchDebug`): muestra `BM25 X.XX` debajo del título de cada hit para diagnosticar el ranking. Off por default.
- **Forma exacta gana** (mayúsculas + `¡¿?!`): el tokenizer de tantivy stripea puntuación y lowercaseа, así que `¡Duendes!` indexa como `duendes`. Para que `¡Duendes!` priorice el grito específico y no el primer `duendes` lowercase de cualquier párrafo, agregamos tres capas: (1) **snippet centra en el literal** si aparece en el doc; (2) **boost de ranking ×2** sobre docs cuyo contenido contiene la forma rica (substring case-insensitive); (3) **jump-to-term** salta al primer match literal del raw query antes de fallback a tokens. Query sin formas ricas (`duendes` solo) sigue ranqueando puro BM25.
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

   | ruleId                | qué detecta                                                                                                             | severidad | auto-fix             |
   | --------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- | -------------------- |
   | `dash-short`          | `-`, `--` o `–` (en-dash) al inicio del diálogo en vez de `—` (em-dash)                                                 | error     | sí (reemplazo a `—`) |
   | `dash-orphan`         | apertura `—texto` sin raya de cierre cuando hay verbo dicendi después en el mismo párrafo, indicando inciso mal cerrado | warning   | no                   |
   | `dash-quote-mix`      | mismo párrafo con `—` y `"` (señal de parseo parcial)                                                                   | error     | no                   |
   | `paragraph-collapsed` | ≥3 transiciones `[.?!…]\s+—` + ≥3 verbos dicendi → varios turns de diálogo aplastados en un solo `<p>`                  | error     | no                   |
   | `space-after-open`    | `— Texto` (espacio sobrante después de raya inicial)                                                                    | warning   | sí (borra espacio)   |
   | `space-before-verb`   | `—Texto—dijo` (sin espacio antes de raya del verbo)                                                                     | warning   | sí (inserta espacio) |
   | `verb-capitalized`    | `—Dijo` post-inciso (DPD pide minúscula tras la raya del verbo)                                                         | warning   | sí (minúscula)       |
   | `period-before-verb`  | `—Texto. —dijo` cuando D2 debería haber absorbido el punto                                                              | warning   | sí (borra punto)     |

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

- 3 modos: público (`api.languagetool.org`), local (Docker), custom URL (self-hosted o LT Premium). Ver [Configuración avanzada → LanguageTool](#languagetool-3-backends) para detalles de cada uno.
- Underlines diferenciados: orto (rojo sólido), gramática (rojo wavy), estilo (amarillo wavy).
- Popover con sugerencias clickeables + atribución LT.
- Rate-limit client-side (18 req/min, 70KB/min) + chunking >20KB transparente.
- **Offsets UTF-16 alineados + tolerancia a caídas de LT**: `split_chunks`
  (`grammar.rs`) lleva un cursor UTF-16 paralelo al byte cursor — los
  `match.offset` de LT (UTF-16 code units) se suman al `chunk.start` UTF-16
  y caen sobre el carácter correcto aún con em-dashes (3 bytes UTF-8 / 2
  UTF-16) y acentos. `find_split` snapea al char boundary previo antes
  del slice para no panickear en mitad de multibyte. Si LT cae transitorio,
  `GrammarService` re-pinga cada 30s mientras `!available` y la limpieza
  de marcas se desacopla del flip de availability — solo limpia ante toggle
  explícito del usuario, no por una caída momentánea. Tests `grammar::tests`
  (5) cubren em-dash + acento + boundary panic.
- Auto-check auto-on en modo local/custom tras ping ok. Toggle persistido (`settings.json::grammarAutoDisabled`). Público queda off por ToS.
- Variantes regionales (es-AR, es-ES, en-US, en-GB…) globales + override per-saga (`saga.json::variante_es`/`variante_en`). Click en badge del footer abre dropdown.
- Diccionario per-saga: "+ diccionario" en popover de TYPOS filtra matches. **Re-filtrado reactivo**: `SagaContextService.dictionary()` es un signal — un effect en `editor.ts` lo observa y re-filtra los `grammarMatches` actuales sin pegarle de nuevo a LT. Cubre el race típico (el saga.json carga async después del primer `checkGrammar`, así que palabras del mundo aparecían marcadas hasta cerrar/reabrir el cap) y el agregar palabra desde el popover (limpia el squiggle on the spot).
- **Vista dedicada del diccionario** (botón 📖 en saga-header de landing + item "Editar diccionario…" en context menu de saga): modal con contador, búsqueda live, lista alfabética (Intl.Collator), agregar con validación en vivo, borrar con confirm inline, banner opt-in "Limpiar" cuando detecta entradas problemáticas (puntuación al borde, duplicados case-insensitive, solo dígitos, fuera de los límites 2–64). El validador (`dictionary/word-validator.ts`) sanea los bordes (`.`, `,`, `…`, comillas, paréntesis…) y se aplica también en el path "+ diccionario" del popover para que no se cuelen entradas con punto al final. Persiste por acción (cada add/remove escribe `saga.json`); el archivo en disco sigue siendo `Option<Vec<String>>` plano, sin migración.
- **UX Docker explicativa**: stepper visual con fases `checking → pulling → starting → loading → ready` durante el arranque + bloque "Por qué Docker" con links a docker.com, languagetool.org, el repo oficial de LT y la imagen `erikvl87/languagetool` que usamos. Eventos `languagetool-progress` emitidos desde Rust con `tauri::Emitter`.
- **LT Premium / self-hosted con auth**: en modo Custom URL podés pegar tu username + apiKey. El apiKey va al **keyring del OS** (libsecret/Keychain/Credential Manager) vía el módulo `secrets`. Ver [Configuración avanzada → LanguageTool](#languagetool-3-backends) para el detalle del keyring.

### Importer

- Pandoc CLI shell-out (`.docx`/`.odt` → HTML subset). Single chapter o bulk.
- **Reestructurar capítulo plano en partes** (right-click → "Reestructurar
  en partes…"): convierte un `.docx`/`.odt`/`.html` viejo (cada capítulo
  era un solo archivo con las partes adentro, separadas por headings o
  labels `1`/`Parte 2`/`III`) a la estructura moderna (folder por
  capítulo con `<N>.html` + `<N>.meta.json` por parte). El modal muestra
  los bloques parseados con candidates (`H1`/`H2`/`HR`/`#`) y el usuario
  toggea boundaries; default pre-marca los splits razonables y respeta
  un primer bloque tipo título como arranque de parte 1. Al apply:
  `strip_label_blocks` descarta el primer bloque de parte 1 si parece
  título (heading o `<p>` ≤4 palabras no numérico — pandoc convierte
  títulos ODT a `<p>` planos) y los labels `short-numeric` al inicio de
  cada parte (el folder name guarda el título, el filename guarda el
  número). El `.odt`/`.docx` original se archiva en `_originales/` por
  si hace falta volver atrás. Modo bulk "Reestructurar libro entero…"
  (botón derecho sobre el libro) procesa todos los capítulos planos en
  cola. Post-apply, si `idioma=es`, aparece el botón **"Aplicar RAE a
  partes"** que corre el converter D1–D5 sobre cada parte recién
  creada y reescribe los HTML modificados (toast con el conteo).
- Wizard de importación de saga/novela (📥 en header): trae carpeta externa al repo con detección heurística de estructura, decisión per-carpeta sobre conversión, metadata de saga + libros (nombre / autor / idioma / imprenta), normalización de tapas y extras, progress bar con eventos. La presentación EPUB (template, dropcap, prefijo y numeración de capítulos) **no** se pregunta acá — vive en el tema (`theme.json` + `saga.json::theme.overrides` / `book.json::theme.overrides`) y se edita desde el theme editor. `SagaConfig`/`BookConfig` mantienen los 6 campos legacy como `Option<…>` y `theme.rs::resolve_theme` los lee de root para repos viejos (backcompat read-side intacta).
- **Captura de extras con estructura**: subcarpetas sin `.docx`/`.odt` (ej. `versiones viejas/`) y subcarpetas dentro de secciones (`convertidos/`, `original/`, `Revisiones/`) se importan como extras preservando subpath, no se vuelven fake sections ni se pierden silenciosamente. Skip-list del importer separado del walker del tree (`fs.rs::SKIP_DIRS`) — el tree oculta `convertidos/` para no llenar la navegación; el importer lo agarra igual y lo guarda como backup. Wizard expone cada extra (incluyendo subpath) con su target path completo en el step "estructura".
- **Toggle "Centralizar extras en `<saga>/extras/`"** (default ON, visible en step `saga-config`): redirige todos los extras (book + section + subpath) a la carpeta `extras/` de la saga preservando estructura `<book>/<section>/<subpath>/<file>`. El TOC de cada libro queda limpio (solo caps + book.json + cover). OFF mantiene comportamiento legacy con extras adentro de cada libro/sección.
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
- **Tree view jerárquico**: subcarpetas dentro de `extras/` (ej. `1 - La Caballera Esmeralda/convertidos/`, `original/`) se renderean como folders expandibles independientes. Backend `list_extras` ya devuelve `relative_path` con subpath; frontend `buildExtrasTree` arma la jerarquía y un recursive template (`extrasNodeTpl`) la pinta.
- **Cache de covers en landing**: los covers de saga-header / book-card / saga-card se cargan vía `convertFileSrc` (asset protocol) y se cachean como `Blob` + `URL.createObjectURL` en `src/app/core/cover-cache.ts`. Reemplaza el flujo viejo `invoke('read_image') → base64 data URL` que re-leía el disco y re-encodeaba en cada navegación. Re-visitar una saga o cambiar de carpeta no refetchea nada — bytes en heap JS. Cache versionado con `cfgService.savedAt()`: al guardar la tapa desde el modal, el blob viejo se revoca y se carga el nuevo. Los `<img>` además llevan `transform: translateZ(0) + will-change: transform + backface-visibility: hidden` y los slots `contain: paint`, para que el `transform: translateY(-1px)` del `:hover` no fuerce re-decode del bitmap en WebKitGTK (causaba flash al pasar el mouse o perder focus).

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
- **Italic/bold sintetizados desde la regular**: por default no se embeben faces italic/bold separadas — sólo la regular. El reader EPUB aplica `font-style: italic` / `font-weight: bold` al renderizar `<em>`/`<strong>`. Tres tunings opcionales en el tema cuando el default no alcanza: `italic_oblique_deg` (ángulo del oblique sintético, ej. `14`), `italic_weight` (peso 100-900 para italic), `bold_weight` (peso 100-900 para bold). Cascade: si `italic_weight` está vacío y `bold_weight` set, italic hereda el peso bold (caso clásico donde la italic se confunde con la regular — subís bold y la italic también queda diferenciada). Combo `<strong><em>` siempre usa `bold_weight` vía regla `strong em, em strong, ...` para ser bold sin importar anidamiento.
- **Tema editorial**: `editorial_body_font` + `editorial_heading_font` aíslan tipografía de páginas no-autor (title page, copyright, dedicatoria, TOC, sobre el autor) de la prosa.
- **Posición del título de capítulo**: `chapter_title_position` (`top`/`center`/`bottom`) con fallback `@media amzn-kf8` para que Kindle también centre.
- **Preview de fuente en panel derecho**: click en una fuente del pool abre el viewer (FontFace API): hero `Aa Bb Cc` a 96px + alfabeto + signos ES + escala 14/20/32/48 + párrafo Lorem ipsum. Mutex con el image viewer (un panel a la vez). Esc o × cierra.
- **Theme editor con tabs y preview live**: modal de altura fija con tabs `Tipografía / Capítulos / Editoriales / Página / Fuentes`. Controles agrupados en `ctrl-group` cards (Identidad, Cuerpo, Títulos, Italic sintético, Bold sintético, Prefijo y título, Inicio del cuerpo, Partes, etc.). Preview live por tab a la derecha: cuerpo con inline italic/bold/bold+italic, página standalone de capítulo (mock con aspect-ratio según template + posición `top/center/bottom`), páginas editoriales (TOC + dedicatoria + título), mock EPUB. Selector de fuente unificado con el editor toolbar (`<app-select>` + itemTemplate que renderea cada nombre en su tipografía, FontFace lazy on-hover). Pool de fuentes con virtual scroll (cdk) y FontFace eager-load. Scroll-lock real al body mientras está abierto.
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
- Status polling 30 s; cuando detecta `behind > 0` corre auto-pull en background. La decisión `ff-only` vs `rebase --autostash` mira tanto `ahead > 0` como `has_changes`: si hay working tree dirty (típico cuando el editor está abierto sobre un cap que también cambió remoto), pull plano abortaría — vamos directo a `--rebase --autostash` para sobrevivir el race sin que el usuario tenga que cerrar la app.
- **Auto-upstream on pull**: si la rama local no tiene upstream seteado (caso típico: clonaste desde otra PC con `git clone` pero la branch nunca pusheó), `git pull` plano falla con `"There is no tracking information for the current branch"`. `git_pull_impl` / `git_pull_rebase_impl` detectan esto vía `git rev-parse --abbrev-ref @{u}`, ejecutan el pull pasando `origin <branch>` explícito, y al éxito setean el upstream con `git branch --set-upstream-to=origin/<branch>`. Los próximos pulls usan el camino vanilla. Tests `pull_sets_upstream_when_missing` + `pull_rebase_sets_upstream_when_missing` cubren ambos paths.
- **Push auto-rebase**: si el remoto avanzó desde otra PC, `git push` falla con non-FF; el backend corre `git pull --rebase --autostash` y reintenta el push una vez. Si el rebase choca, lo aborta y la UI muestra "Conflicto entre esta PC y el remoto. Abrí el panel 🐛 para detalle." (sin terminal jargon).
- **`.twriter/` auto-ignorado al boot** (`git_ensure_twriter_ignored`): agrega `.twriter/` al `.gitignore` si falta y corre `git rm -r --cached .twriter` si está trackeado. Idempotente — los cambios quedan uncommitted y los pickea el próximo auto-commit. Evita conflictos add/add del índice tantivy entre PCs.
- **Errores categorizados**: stderr del CLI git se clasifica en `auth` / `network` / `conflict` / `rejected` / `unknown` desde Rust; el frontend (`git-service.ts::friendlyError`) los mapea a strings en español. La UI nunca expone hints crudos de git.
- **Throttle**: 3 fallas consecutivas de auto-pull pausan el loop 5 min para no spamear el panel 🐛. Sync manual (⇅) resetea el throttle. Conflict pausa de inmediato hasta sync manual.
- **Boot sin race condition con storage detect**: `StorageService.detect`
  resuelve async; el effect de `GitService` espera viendo `backend() ===
'unknown'` antes de comprometerse, en vez de leer un `isGit=false` stale
  durante la ventana. `storage-service.ts` resetea `backend='unknown'` antes
  de cada `detect` para que los consumers vean "pendiente" hasta la
  resolución. De yapa cubre el switch root git → non-git: el `git_status`
  ya no dispara sobre la carpeta nueva con el backend viejo.
- Botón "sync ahora" (⇅) en header.

## Configuración avanzada

### LanguageTool (3 backends)

tWriter soporta 3 backends de LanguageTool. Todos hablan el mismo endpoint
HTTP (`/v2/check`); cambia dónde corre y cómo se autentica.

#### API público (default)

`api.languagetool.org` — gratis, sin instalación. Limitado a 20 req/min,
75KB/min, 20KB/req. El texto se envía a servidores LT.

- Solo chequeo on-demand (sin auto-recheck mientras escribís — el ToS lo prohíbe).
- Banner naranja avisa la primera vez que activás la feature en una sesión.

#### Local (Docker)

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

#### URL custom — self-hosted o LT Premium

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

## Para desarrollar

### Layout de archivos del repo de novelas

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

### Setup local

Instrucciones para **Arch / CachyOS** desde cero. En otros distros adaptar los gestores de paquetes.

#### 1. Toolchain Rust

Usar `rustup` (toolchain manager oficial), no el paquete `rust` de Arch.

```bash
sudo pacman -S rustup
rustup default stable
```

#### 2. Node.js + pnpm

```bash
sudo pacman -S nodejs pnpm
```

#### 3. System libs (Tauri 2 + WebKit)

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

#### 4. Pandoc (importer .docx/.odt)

```bash
sudo pacman -S pandoc
```

#### 5. Docker (opcional, para LanguageTool local)

```bash
sudo pacman -S docker
sudo systemctl start docker        # arrancar on-demand, no enable
sudo usermod -aG docker $USER     # logout/login para que tome efecto
```

Sin Docker la app igual anda — usa el API público de LanguageTool por default.

#### 6. Clonar e instalar

```bash
git clone <repo-url> tWriter
cd tWriter
pnpm install
pnpm tauri dev
```

Primera build de Rust ~5 min (compila `git2`, `webkit`, `zip`, etc.). Después es incremental.

### Comandos

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

### Distribución

- CI: `.github/workflows/release.yml`. Trigger: `git push --tags v*.*.*`. Linux job buildea `.deb`, Windows job buildea `.msi` + `.exe`. Ambos firmados ed25519.
- **Linux Arch / CachyOS**: PKGBUILD `twriter-bin` local en `packaging/aur/`. Pull el `.deb` del release, instala vía pacman. Update: `./packaging/aur/test.sh <version>`.
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

Flujo completo de una release (asumiendo setup hecho):

```bash
# 1) Bump de versión en package.json, Cargo.toml, tauri.conf.json, Cargo.lock
#    y packaging/aur/PKGBUILD (pkgver + pkgrel=1)
./scripts/bump-version.sh 0.2.0
git add -A && git commit -m "chore: bump v0.2.0"
git tag v0.2.0
git push && git push --tags

# 2) Esperar a que el GitHub Action publique el .deb / .msi / .exe
gh run watch

# 3) Revisar el draft release y publicarlo manual (changelog, etc.)

# 4) Test local del PKGBUILD: valida pkgver, recalcula sha256,
#    namcap, makepkg -si. Falla si el .deb no está en el release.
./packaging/aur/test.sh

# 5) Smoke test manual
twriter                       # abrir, cargar proyecto, exportar EPUB

# 6) Publicar al AUR (clona repo aur@…, regenera .SRCINFO, pide confirmación)
./packaging/aur/publish.sh
```

#### Publicar a AUR

El flujo automatizado vive en `packaging/aur/test.sh` (build + install local) y `packaging/aur/publish.sh` (push al AUR). Esta sección documenta el setup inicial y qué hace cada paso por dentro, por si hay que debuggear a mano.

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

Cada release nueva: usar `./packaging/aur/test.sh` + `./packaging/aur/publish.sh` (ver _Cortar release_ arriba). Los scripts encapsulan el bump del `pkgver`, `updpkgsums`, `makepkg -si`, regeneración de `.SRCINFO` y push al remoto `aur@aur.archlinux.org`.

Bumpear `pkgrel` (no `pkgver`) si cambia el PKGBUILD pero no la versión de tWriter — editar a mano `packaging/aur/PKGBUILD` y correr `publish.sh` directo (saltea `test.sh` si el .deb del release ya está vivo).

Una vez publicado, los usuarios pueden instalar con cualquier AUR helper:

```bash
yay -S twriter-bin
# o
paru -S twriter-bin
```

## TODO

Ver [TODO.md](TODO.md) — pendientes, bugs conocidos y mejoras planificadas, agrupados por área (Editor / UX, Tree, EPUB, Validador RAE, Git, etc.).

## Licencia

MIT
