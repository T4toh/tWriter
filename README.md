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
    - [Comillas tipográficas (inglés)](#comillas-tipográficas-inglés)
    - [Validador RAE (inline + batch)](#validador-rae-inline--batch)
    - [Gramática + ortografía (LanguageTool)](#gramática--ortografía-languagetool)
    - [Detector de repeticiones cercanas (es + en)](#detector-de-repeticiones-cercanas-es--en)
    - [Tesauro de sinónimos (offline)](#tesauro-de-sinónimos-offline)
    - [Revisión por libro](#revisión-por-libro)
    - [Importer](#importer)
      - [Notas externas](#notas-externas)
    - [Extras + covers](#extras--covers)
    - [Export EPUB](#export-epub)
    - [Temas + fuentes embebidas](#temas--fuentes-embebidas)
    - [Apariencia (tema de la app + fuentes de UI)](#apariencia-tema-de-la-app--fuentes-de-ui)
    - [Configuración](#configuración)
    - [Debug / observabilidad](#debug--observabilidad)
    - [Storage backend (git / cloud / local)](#storage-backend-git--cloud--local)
    - [Git auto-sync (cuando backend = git)](#git-auto-sync-cuando-backend--git)
    - [Sync del diccionario entre PCs](#sync-del-diccionario-entre-pcs)
  - [Configuración avanzada](#configuración-avanzada)
    - [LanguageTool (3 backends)](#languagetool-3-backends)
      - [API público (default)](#api-público-default)
      - [Local (Docker / Podman / Apple container)](#local-docker--podman--apple-container)
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

Descargar el `.dmg` del último release:

- **Apple Silicon (M1/M2/M3/…)**: el `.dmg` con `aarch64`.
- **Intel**: el `.dmg` con `x64`.

Abrir el `.dmg`, arrastrar tWriter a Applications.

**App sin firmar** (no hay Apple Developer ID): en el primer arranque macOS la bloquea. Destrabala con una de estas:

- **Finder**: click derecho sobre tWriter → **Abrir** → en el diálogo, **Abrir**. (En Sequoia 15+: si solo ofrece "Mover a papelera", andá a **Ajustes → Privacidad y seguridad** → **Abrir de todos modos**.)
- **Terminal** (de una): `xattr -dr com.apple.quarantine /Applications/tWriter.app`

Después abre normal. Es solo la primera vez.

> Ambos `.dmg` se compilan en CI sobre runner Apple Silicon (`macos-14`); el `x64` se cross-compila a `x86_64-apple-darwin`. Auto-update Tauri-native vía `latest.json` (incluye `darwin-aarch64` + `darwin-x86_64`).

**LanguageTool en macOS**: la gramática local corre en un container, y la app
maneja cualquiera de los 3 runtimes comunes (autodetecta el que tengas). Elegí uno:

```bash
# Opción A — Apple container (nativo, sin VM que administres)
brew install container
container system start

# Opción B — colima (Docker, liviano, sin la GUI de Docker Desktop)
brew install colima docker
colima start                 # brew services start colima para auto-boot

# Opción C — Podman
brew install podman
podman machine init && podman machine start
```

Con cualquiera corriendo, la app baja la imagen y levanta LanguageTool sola desde
el modal de gramática. Si usás **Docker** y antes tuviste Docker Desktop (y lo
desinstalaste), borrá la línea `"credsStore": "desktop"` de `~/.docker/config.json`
— si no, `docker pull` falla con `docker-credential-desktop ... not found`. Sin
ningún runtime, la app igual anda usando el API público de LT por default.

**Pandoc** (importar `.docx`/`.odt`): `brew install pandoc`.

### Dependencias opcionales

- **Pandoc** (para importar `.docx`/`.odt`): `sudo pacman -S pandoc` / `sudo apt install pandoc` / [pandoc.org](https://pandoc.org/installing.html) en Windows. Sin Pandoc, el importer queda inhabilitado pero el resto de la app funciona.
- **Runtime de containers** (para LanguageTool local): Docker, Podman o Apple `container` — la app autodetecta el que esté instalado y con daemon vivo. Ver [LanguageTool](#languagetool-3-backends). Sin ninguno, la app usa el API público de LT por default.

## Features

### Editor

- TipTap con HTML subset: `<p>`, `<i>`, `<em>`, `<strong>`, `<u>`, `<hr>`, `<h1>`, `<blockquote>`.
- Autosave debounced 1.5s.
- Toolbar: undo/redo, B/I/U, alineación, salto de escena, RAE, gramática, font size, familia tipográfica, espaciado de párrafos, ancho hoja.
- Menú contextual propio.
- **Layout flat**: el editor renderea párrafos sin `text-indent` y con `text-align: left` para que escribir no "salte" word-spacing por línea ni se vean indents que confunden. El EPUB exportado mantiene `text-indent: 1.5em` + `text-align: justify` desde `.chapter-content p` en `src-tauri/resources/epub_style.css` — formato editorial al exportar, layout cómodo al escribir.
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

- **Corrector del OS apagado** (`feat/control-total-tipeo`): macOS reescribía el texto adentro de la webview (autocorrección + sustituciones) y arruinaba el voseo. `spellcheck`/`autocorrect`/`autocapitalize` off heredados desde `<html>` y explícitos en los `editorProps` de los tres editores TipTap, más `macos_text.rs` apagando las sustituciones nativas (`registerDefaults` + setters de `NSTextCheckingClient` sobre la `WKWebView`, gateados por `respondsToSelector:`). Typography de TipTap queda como única fuente de comillas y rayas.
- **Sugerencias del diccionario propio**: el diccionario per-saga además de silenciar typos ahora sugiere — `dictionary/suggest.ts` (Levenshtein con umbral por longitud, acentos plegados) mete hasta 3 candidatos con chip "tu diccionario" en el popover de gramática.
- **Popovers bien ubicados**: `popover-position.ts` con flip arriba/abajo, clamp de X, `maxHeight` + scroll interno cuando no entra, medición real del popover (`afterRenderEffect` + `visibility:hidden`), recálculo en `resize` y cierre cuando el ancla se escapa del viewport (los flotantes son `position: fixed` anclados a coordenadas de viewport, así que scrollear los dejaba flotando sobre texto ajeno).
- **Scrolloff del caret** (`feat/caret-scrolloff`): ProseMirror ya scrollea al tipear, pero con `scrollMargin` 5px sobre el *padding box* el caret quedaba pegado al borde inferior. `caret-scrolloff.ts` calcula insets de 2 líneas desde el `line-height` computado y las tres superficies tipeables los pasan por la `buildEditorProps()` compartida de `editor-props.ts`.
- **Scroll-lock real en modales**: con un modal abierto la rueda sobre el backdrop ya no scrollea lo de atrás (editor / tree / landing); los panes con diff propio (RAE / Comillas) scrollean su contenido vía `grid-template-rows: minmax(0,1fr)` + `min-height:0` + `overscroll-behavior: contain`.
- **Volver a la raíz**: botón 🏠 primero en la fila de acciones del panel izquierdo + `Cmd/Ctrl+Shift+H` (el modo focus esconde el panel). Flushea, cierra capítulo y nota y vuelve al landing — antes había que bajar a una saga para poder subir por el breadcrumb.

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

- **Tabs "Este libro" / "Todas"** en el panel de notas (`tree/notas-del-libro.ts`, puro, 28 aserciones en su smoke runner). Las fichas están duplicadas por libro **a propósito** (son acumulativas, hay cuatro `Aedan.md`), así que el trabajo no es navegar sino acertar cuál. `Este libro` es una lista plana con las notas de `Notas/<saga>/<libro>/` + el `notas/` del libro en el árbol de novelas, y abajo las `.md` sueltas de la saga. El vínculo saga ↔ carpeta de notas se **adivina** (`calzaSaga`: pela el prefijo numérico y busca calce exacto o por prefijo) — cero configuración. El `+` con esa tab activa crea en la carpeta del libro, aunque todavía no exista.
- **Creación con form + plantillas**: "Nueva nota…" abre un form de verdad (no un prompt de un input) con las plantillas de `shared/note-templates.ts` — data pura con su smoke runner, copiadas de las que el autor ya escribe a mano en `Notas/`.

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

- **Doble click en carpeta → vista de tarjetas** (galería de la carpeta), y el árbol de notas es un segundo tree que no le roba el foco al principal.
- **Mazo de tapas en el header de saga**: hasta 3 tapas apiladas (`translateY` + rotación alternada + `brightness` bajando) en vez de una sola imagen que hacía ver una saga de 4 libros como una novela suelta. El tag "heredada" sigue apareciendo solo cuando el frente es prestado del primer libro.
- **Contadores que no mienten**: "N libros" filtra `kind === 'book'` (antes sumaba la carpeta `notas` y los `.md` sueltos) y la tarjeta de libro cuenta **capítulos** (`chapterCount`), sumando los nietos de cada sección — un libro de 3 partes × 8 capítulos decía "3 cap." en vez de 24. Las secciones con `excluded: true` suman 0.

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
- **Dos modos, porque las necesidades chocaban** (`≈` en la barra, persistido en `settings.searchFuzzy`):
  - **Exacto (default)**: índice v4 con tokenizer fiel — `SimpleTokenizer + RemoveLongFilter(40) + LowerCaser`, sin fold de acentos y **sin drop de stopwords**, más QueryParser literal accent-sensitive. Encontrás el texto tal cual, que es lo que sirve para corregir frases anotadas en la Kindle: `mansion` no trae `mansión`.
  - **Fuzzy (opt-in)**: builder fuzzy/OR con Levenshtein escalado por longitud (≤3 chars exacto, 4–7 distancia 1, ≥8 distancia 2 — tantivy 0.22 solo cachea autómatas hasta 2), tolera typos y acentos para nombres inventados (`kellai` → `Kallai`).
  El flag `fold` viaja por todo el highlight (panel, editor, notas, md-reader): exacto accent-sensitive, fuzzy plega acentos. `foldAccents` (TS) espeja `fold_accents` (Rust) length-preserving para mantener alineados los offsets DOM/PM.
- **Field boost `title × 2.5`** (`parser.set_field_boost`): un match en título ranquea sobre el body.
- **El match viaja con offset**: cada `SearchHit` trae la posición real de la ocurrencia y `matchedTerms` con la palabra **del documento** que matcheó (`resolve_matched_words`), así el snippet centra en ella y el click salta a *ese* hit — no al primer token de la query, que era lo que hacía el jump inútil cuando un capítulo tenía varias apariciones.
- **Modo debug BM25** (toggle 🐞 en header, persistido en `settings.json::searchDebug`): muestra `BM25 X.XX` debajo del título de cada hit para diagnosticar el ranking. Off por default.
- **Forma exacta gana** (mayúsculas + `¡¿?!`): el tokenizer de tantivy stripea puntuación y lowercaseа, así que `¡Duendes!` indexa como `duendes`. Para que `¡Duendes!` priorice el grito específico y no el primer `duendes` lowercase de cualquier párrafo, agregamos tres capas: (1) **snippet centra en el literal** si aparece en el doc; (2) **boost de ranking ×2** sobre docs cuyo contenido contiene la forma rica (substring case-insensitive); (3) **jump-to-term** salta al primer match literal del raw query antes de fallback a tokens. Query sin formas ricas (`duendes` solo) sigue ranqueando puro BM25.
- **Reindex incremental on-save**: cada `write_note` / `write_chapter` / `create_*` actualiza el índice de ese archivo. Render fresco en la próxima query, sin reindex manual.
- **Reindex full** al boot si hay root configurado (async, no bloquea startup). Botón ↻ en el header del panel relanza un reindex completo si hace falta.
- Resultados rankeados por relevancia (BM25), con snippet centrado en el primer match y highlight `<mark>` de los términos.
- Click en un resultado: capítulo → abre en el editor central; nota → reader derecho (Shift+click la abre en el notes-editor central); carpeta → expande el árbol y navega.
- **Jump-to-term**: al clickear un hit, el editor/reader hace scroll automático al primer match dentro del contenido y selecciona el término (selección nativa del browser). Cualquier movimiento del cursor la limpia. Funciona en chapter editor, notes editor y markdown reader vía DOM `TreeWalker` (sin depender de TipTap commands).
- HTML strip simple para indexar capítulos (tags `<p>`, `<em>`, `<strong>`, etc. se desnudan a texto plano). El render del snippet sigue siendo texto + highlight, sin re-renderizar HTML.
- Mutex con image-viewer / font-preview / markdown-reader: el panel de búsqueda usa el mismo slot derecho y cierra a los otros tres cuando se abre.

- **Reemplazar en lote** (toggle `⇄` del header del panel): reusa el selector de scope de la búsqueda (capítulo / libro / saga / todo el repo) y agrega "reemplazar por" con toggles `Aa` (mayúsculas) y `ab` (palabra completa); `≈` queda deshabilitado en este modo con el motivo al lado — un match aproximado cambiaría palabras que nadie pidió. El preview (`replace_preview`, debounce 250 ms) lee del **disco**, no del índice, así que es inmune a un índice desactualizado; se agrupa por capítulo con checkbox tri-estado por grupo y por ocurrencia. `replace_apply` snapshotea los originales antes de escribir.
  La pieza no obvia es el **mapeo plain ↔ HTML por runs** (`src-tauri/src/replace.rs`): se busca sobre el texto plano (lo que el autor ve) y se escribe sobre el HTML, y los offsets no coinciden — el plain se construye junto con una lista de runs que se corresponden byte a byte con el HTML.

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

### Comillas tipográficas (inglés)

Contraparte en inglés del conversor a rayas, para novelas importadas que quedaron con comillas rectas ASCII.

- `quotes/educate.ts` (`educateQuotes`) convierte `"` → `“ ”` (open/close contextual) y `'` → `‘ ’` (cita) o `’` (apóstrofe, posesivo, elisiones `'em` / `'90s`).
- **Tag-aware**: tokeniza tags vs. texto y educa solo el texto, así `class="scene-break"` y demás atributos quedan intactos (un `.replace` global rompía el HTML).
- Botón "Comillas" por capítulo (gate `idioma === 'en'`) con modal diff que reusa los estilos del de RAE, y acción masiva "Arreglar comillas" en el menú de saga/libro/sección (`quotes-fix-service.ts`: confirm con conteo, escribe solo los que cambian, refresca árbol + git status). Cero Rust nuevo, cero deps npm.

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
- **Falsos positivos: nombrarlos y matarlos** (`saga.json::reglas_lt_desactivadas`). "Ignorar" solo saca el match de la lista en memoria y vuelve en el próximo chequeo, así que el popover ahora muestra el **`ruleId`** —el dato ya viajaba entero desde `grammar.rs` hasta `GrammarMatch`, solo no se renderizaba— y suma **"Nunca más esta regla"**, que lo persiste junto con la oración que lo disparó. Esa lista *es* el registro de FP: con el id se reporta upstream, con el ejemplo se decide si conviene. Los ids se mandan como `disabledRules` en `/v2/check`, que el request no usaba nunca. Alcance **por saga** y no global: `saga.json` ya es donde vive la variante regional, así que la desactivación viaja por git con el repo de novelas en vez de quedarse en el `settings.json` de una máquina. Se reactivan desde el modal de config de saga, al lado de las variantes. Ojo con la granularidad: `/v2/check` desactiva la regla **entera**, no la subregla (el id que devuelve la API es `AGREEMENT_POSTPONED_ADJ`, sin el `[3]` que se ve en los reportes).
- Diccionario per-saga: "+ diccionario" en popover de TYPOS filtra matches. **Re-filtrado reactivo**: `SagaContextService.dictionary()` es un signal — un effect en `editor.ts` lo observa y re-filtra los `grammarMatches` actuales sin pegarle de nuevo a LT. Cubre el race típico (el saga.json carga async después del primer `checkGrammar`, así que palabras del mundo aparecían marcadas hasta cerrar/reabrir el cap) y el agregar palabra desde el popover (limpia el squiggle on the spot).
- **Vista dedicada del diccionario** (botón 📖 en saga-header de landing + item "Editar diccionario…" en context menu de saga): modal con contador, búsqueda live, lista alfabética (Intl.Collator), agregar con validación en vivo, borrar con confirm inline, banner opt-in "Limpiar" cuando detecta entradas problemáticas (puntuación al borde, duplicados case-insensitive, solo dígitos, fuera de los límites 2–64). El validador (`dictionary/word-validator.ts`) sanea los bordes (`.`, `,`, `…`, comillas, paréntesis…) y se aplica también en el path "+ diccionario" del popover para que no se cuelen entradas con punto al final. Persiste por acción (cada add/remove escribe el archivo). El storage es un `<saga>/diccionario.txt` (una palabra por línea) — ver [sync del diccionario](#sync-del-diccionario-entre-pcs) abajo para el detalle de cómo se fusiona entre PCs.
- **Formas derivadas al agregar una palabra** (`dictionary/derived-forms.ts` + `derived-forms-panel`): agregar `teletransportar` tenía que silenciar también `teletransportó`, `teletransportaba`, `teletransportándose`. Dos mecanismos con una regla que los divide — **el generador nunca escribe un plural**: los plurales y los enclíticos se **pelan al filtrar** (`-s`/`-es`/`-ces` en español, `-s` en inglés) y los verbos (15 formas) y el género de los adjetivos se **generan al archivo** con preview tildable. Medido sobre las 439 entradas reales: 39 de 42 familias eran singular/plural, futuro/condicional/subjuntivo tienen 0 apariciones en tres novelas (de ahí 15 formas y no ~60), y en inglés no hay nada que conjugar. Los irregulares no se modelan — se destilda la forma que no existe antes de escribir. El flujo arranca en el popover porque el infinitivo casi nunca está cargado: se infiere el lema hacia atrás (`inferLemma`) desde la forma que marcó LT. Seguridad del pelador sobre el texto completo: 3 palabras nuevas silenciadas sobre 25.444 únicas, las tres plurales legítimos.
- **Términos compuestos** (`dictionary/compound-terms.ts`): `Kun Lian` (un reino), `Tres Torres` (un vino) o `Amalut de las Arenas` se guardaban bien y no servían para nada, porque todos los consumidores eran de a una palabra. Ahora las entradas de varias palabras se separan al cargar y se matchean **como frase sobre el texto plano**, devolviendo los **rangos** cubiertos; los consumidores que ya trabajan con offsets sobre el plano (filtro de LT, detector de repeticiones) descartan lo que caiga adentro. El filtro es por **contención**, no por igualdad: LT marca `las Arenas` con `AGREEMENT_DET_NOUN`, un span más corto que la entrada. Y adentro de un nombre propio del mundo no se filtran solo los typos: la restricción a `category === 'TYPOS'` se levanta para los rangos compuestos.
- **UX Docker explicativa**: stepper visual con fases `checking → pulling → starting → loading → ready` durante el arranque + bloque "Por qué Docker" con links a docker.com, languagetool.org, el repo oficial de LT y la imagen `erikvl87/languagetool` que usamos. Eventos `languagetool-progress` emitidos desde Rust con `tauri::Emitter`.
- **LT Premium / self-hosted con auth**: en modo Custom URL podés pegar tu username + apiKey. El apiKey va al **keyring del OS** (libsecret/Keychain/Credential Manager) vía el módulo `secrets`. Ver [Configuración avanzada → LanguageTool](#languagetool-3-backends) para el detalle del keyring.

### Detector de repeticiones cercanas (es + en)

El agujero más claro de LanguageTool, y no es del español: LT solo detecta duplicados literales pegados (`la nave nave`, `SPANISH_WORD_REPEAT_RULE`). Verificado que `"Era una nave oscura, oscura como el vacío."` no da ni una marca, ni en `es-AR` ni en `en-US`, ni en `default` ni en `picky`.

- **En TS, no en Rust** — medido: 59 KB / 10.008 palabras tardan **1,07 ms** (media de 50 corridas), menos que serializar el capítulo de ida y los hits de vuelta por el bridge. El detector toca solo el capítulo activo, que ya está en memoria del frontend (mismo criterio que `validator.ts`). "Repeticiones en el libro entero" sí es Rust: son N archivos.
- Ventana deslizante sobre el texto plano, normalizando (minúsculas + sin diacríticos) y marcando la palabra de contenido que reaparece dentro de N palabras. Sin POS tagger, sin FreeLing ni spaCy.
- **Calibrado contra prosa real**, no a ojo: el prototipo tiraba 6.095 hits en 59 KB (inusable). Con seis capas de exclusión — stopwords, largo mínimo, verbos dicendi, diccionario per-saga, capitalizado mid-oración y repetición deliberada — queda en **0,8 hits por 1.000 palabras en español y 0,7 en inglés** (`scripts/densidad-repeticiones.mjs` sobre dos libros enteros).
- Las tres formas de repetición **deliberada** (construcción hecha, frase o locución repetida, anáfora) tienen un flag cada una en el modal de Configuración.
- `repeticiones/detector.ts` es la función pura (32 casos en `scripts/run-repeticiones-smoke.mjs`); `repeticiones-extension.ts` + `repeticiones-popover.ts` son la mitad con DOM. Al abrir el popover se resalta el grupo entero, que es lo que hace entendible la sugerencia.

### Tesauro de sinónimos (offline)

Sinónimos en el popover de repetición como chips clickeables — LT no tiene ningún endpoint de sinónimos. También se pide solo, sin estar sobre una repetición: `⌘⇧Y` (`Ctrl+Shift+Y` fuera de Mac) sobre la palabra del cursor y "Sinónimos de «X»" en el menú contextual, que resuelve la palabra por las **coordenadas del click** porque WebKit no mueve el caret con el botón derecho (`editor/palabra-en.ts`).

- Dos `.dat` MyThes bundleados como `resources`: **español** `th_es_v2.dat` (21.846 entradas, 2,8 MB, de OpenThesaurus-es vía rla-es) e **inglés** `th_en_us.dat` (140.835 entradas, 11,2 MB, WordNet 2.1 vía LibreOffice, podado con `scripts/podar-tesauro-en.mjs`). Encoding **ISO-8859-1**, decodificado a mano en Rust (latin-1 mapea 1:1 a los primeros 256 codepoints, cero crates de encoding).
- **Acá sí conviene Rust**: son ~14 MB que no queremos mandar por el bridge ni tener en el heap del webview. Se lee el `.dat` entero una vez por idioma a un `String` cacheado en `OnceLock` y por el bridge cruza solo la entrada consultada — sin `.idx` ni `seek`, la pasada entera no se nota. `tesauro.rs` (parser + normalizaciones + `tesauro_lookup`, 19 tests inline) y `core/tesauro-service.ts` (caché de 50 consultas).
- **Cobertura medida** contra `Buenos Aires 2077` (90 capítulos, 109 hits del detector): 14 de 20 formas realmente marcadas tienen entrada (~70%), y con las normalizaciones de enclítico (`mirarlo` → `mirar`) y plural simple (`naves` → `nave`, re-pluralizando los sinónimos) sube a ~75-80%. El resto son conjugaciones y huecos léxicos puntuales.
- **No se lematiza a propósito**: un lema sin re-conjugar sugiere algo que no concuerda con la oración (`eres` → `ser` → ofrecer `existir` rompe la frase), y re-conjugar pide un conjugador de español propio — un subsistema entero para el último 20%.
- El reemplazo hereda las marcas del span (`marcasParaReemplazo` en `editor.ts`, compartido con el auto-fix de RAE), así que cambiar una palabra pegada al borde de una cursiva no se come la itálica. En inglés los chips se agrupan por categoría gramatical (`sustantivo` / `verbo`).
- **Licencias**: el español va **sin modificar un byte** con su `COPYING` LGPL 2.1 al lado (es la condición); el inglés es WordNet 2.1 (permite modificar con aviso) y se regenera corriendo el script sobre la fuente de LibreOffice, nunca a mano. Detalle en `src-tauri/resources/tesauro/LICENCIAS.md`.

### Revisión por libro

Botón en la tarjeta del libro → modal que escanea el libro entero con los cuatro detectores (rayas RAE, comillas tipográficas, arreglos RAE, repeticiones), muestra qué encontró cada uno y aplica los tildados. **Una acción por tipo**, no una lista unificada de hallazgos. El panel lateral "Revisar RAE" y las entradas del menú contextual quedan como estaban.

- **Bulk auto-fix sin comerse el markup**: los offsets de `validateRae` son sobre texto plano y el archivo es HTML. `dialogos/plano-con-mapa.ts` construye el plano **y** el índice HTML de cada carácter en la misma pasada (incluido el doble-decode de entidades de `htmlToPlain`, que se replica a propósito porque es el comportamiento que vieron todas las violaciones calculadas hasta hoy). `dialogos/aplicar-fixes.ts` aplica en orden descendente y **saltea** todo fix cuyo rango HTML contenga un tag: antes de comerse un `</em>` en veinte capítulos, no lo aplica y lo reporta.
- **Repeticiones va sin checkbox** — no son auto-fixables: se reescriben a mano. Pero la lista no se queda en un número: cada ocurrencia lleva `path` + offset, muestra el snippet con contexto (±40 caracteres, la forma del `rae-audit-panel`) y el click abre el capítulo **con el popover de sinónimos ya abierto** sobre la aparición, que es lo único que sirve para arreglarla. La identificación no puede ser por offset (el del plano no coincide con el del editor por los `<hr>`): es por palabra normalizada + cercanía al bloque que resaltó el ancla, vía un `pendingPopover` que espera a que el chequeo pinte las decoraciones. La lista agrupa por capítulo y colapsa.

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
- **Back matter completo** (spec en `docs/superpowers/specs/2026-09-01-back-matter-epub-design.md`):
  - **"Otros libros"**: se arma escaneando el root (`catalogo.rs`) — un libro está publicado si su `book.json` tiene `link`.
  - **Perfil global del autor** en `autor.json` (`autor.rs`): bio ES/EN, foto, web y QR. Se hereda a todos los libros del repo.
  - **Página legal con incisos elegibles y editables**, bilingües como el copyright (`epub.rs::texto_inciso_default` + fieldset "Página legal" del modal del libro): `reserva` (derechos reservados), `ficcion` ("cualquier parecido con personas reales… es coincidencia") e `ia` (declara que la IA se usó solo para generar imágenes y que el texto es obra del autor — hay libros sin imágenes generadas, por eso es opcional). `ficcion` arranca en true por su cuenta: antes heredaba el valor de `reserva`, así que apagar la reserva se llevaba puesto el aviso de ficción.
  - Todas las páginas editoriales entran al índice con `class="toc-editorial"`.
- **Imágenes reescaladas al embeberse** (crate `image`): la tapa iba a resolución de imprenta adentro del EPUB. El archivo del repo se deja intacto — es la misma tapa que se manda a imprimir.
- **XHTML válido de verdad**: Apple Books usa un parser estricto y aborta en el primer `<br>` sin `/` (`Opening and ending tag mismatch: br`); Thorium es tolerante, por eso no se notaba. `close_void_elements()` (`epub.rs`, aplicado en `load_part()`) autocierra `<br>`/`<hr>` sueltos a la salida sin tocar atributos ni texto — arregló los 200 capítulos del repo real de una sola vez, en el export, sin escribir nada en el repo de novelas.
- **Rutas de imagen que sobreviven el cambio de PC**: al elegir una tapa/contratapa/foto, `book_config.rs::adopt_image` la guarda **relativa** si cae bajo la carpeta del libro o de la saga, y la copia como `cover|back-cover|author.<ext>` si viene de afuera (los `book.json` viejos tenían `/home/tatoh/Downloads/…` y en la otra PC mostraban placeholder). Al leer y al exportar, `image_field_unusable()` reemplazó al chequeo de "campo vacío" en los 6 lugares que autodescubrían: un path **muerto** también dispara `find_cover_in`, así que los `book.json` viejos resuelven al `cover.png` de al lado sin tocar el repo de contenido. Al reemplazar, la elegida barre las otras extensiones del mismo stem.
- **Índice legible** (`toc.xhtml`): numeral del capítulo en una columna angosta con la fuente de títulos del tema y el título al lado en la del cuerpo, separados por un espacio real (el menú del reader lee el texto plano). Las partes que son solo números salen con `hidden` en la sub-lista —mecanismo del spec EPUB 3: no se imprimen en la página pero el reader las sigue mostrando en su menú; verificado en calibre— y aparecen si alguna tiene título propio en su `meta.json`. Respeta el prefijo del tema (`roman`/`decimal`/`none`: sin prefijo no hay columna) y el idioma del libro. Links sin subrayar, editoriales atenuadas y alineadas con los títulos, margen de página como «Sobre el autor».
- **Modal de export: libro completo, muestra, o los dos** (default los dos). La **muestra** son los primeros N capítulos —por defecto los que suman ~10 % de las palabras, la proporción de la vista previa de Amazon—, cortada en fin de capítulo y sin epílogo. Lleva `dc:title` y nombre de archivo con sufijo `— Muestra`/`— Sample` (la portada interior queda igual), una página de cierre «Seguir leyendo» con el `link` del `book.json`, y el back matter completo («Otros libros» + «Sobre el autor»). Sin `link` sale igual y el export avisa. Las tiendas (Amazon, Kobo, Google) arman su propia vista previa del EPUB completo y no reciben este archivo; sirve para la web del autor, Apple Books (que sí acepta una muestra propia) y plataformas tipo BookFunnel. `export_book(bookPath, muestra: Option<u32>)`; default de capítulos en `export/muestra.ts` (`scripts/run-muestra-smoke.mjs`).
- **Progreso del export**: `export_impl` recibe un callback de progreso (igual que `search::full_reindex`, así el impl sigue sin tipos de Tauri y los tests no necesitan `AppHandle`) y `export_book` lo traduce al evento `epub-export-progress`. La tarjeta del libro ya tenía spinner; el que no mostraba nada era exportar desde el menú contextual.

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

### Apariencia (tema de la app + fuentes de UI)

Bloque "Apariencia" en el modal de Configuración. Ojo con no confundirlo con el theme editor de arriba: ese es la tipografía del **EPUB**, esto es el chrome de la app.

- **`appTheme`** (`'system' | 'light' | 'dark'`) persistido en `settings.json` y aplicado con `data-theme` en el `<html>`. Los 29 tokens de color entran por dos vías —`prefers-color-scheme` (con `:not([data-theme])`) y el override manual— compartiendo un mixin, y `color-scheme` sigue al elegido y no al del OS, o los scrollbars y widgets nativos quedan del tema contrario. La ventana nativa acompaña: el mismo effect llama `setTheme()` de Tauri (`null` para 'system') con `core:window:allow-set-theme` en las capabilities — sin eso la barra de título quedaba clara con el tema forzado a oscuro.
- **Fuentes bundleadas**: cinco `.woff2` del subset latin (Merriweather / Lato / Roboto Mono, ~190 kB) en `src/assets/fonts/` declaradas en `src/styles/fonts.scss`, con sus OFL y las entradas en `generar-licencias.mjs`. Antes los `--font-body` / `--font-ui` / `--font-mono` no tenían un solo `@font-face`: si el usuario no las tenía instaladas la app caía al serif/sans del sistema y nadie se enteraba.
- **Fuente de Interfaz y Monoespaciada elegibles** entre las instaladas en la PC, con preview de cada opción en su propia tipografía al hover. La mitad pura vive en `core/app-fonts.ts` (`scripts/run-app-fonts-smoke.mjs`, 11 aserciones); elegir el default guarda `null` y **borra** la custom property, así el default sigue definido en un solo lugar (`styles.scss`).
- **El serif de lectura no es un slot de Apariencia** (decisión del autor): la fuente del texto se elige en el toolbar del editor, y la comparten las tres superficies del mismo contenido — editor de capítulos, editor de notas y lector de Markdown. El resto de los controles del editor (tamaño, ancho, espaciado de párrafo) también se quedan en el toolbar.
- El tema de la app **no** se filtra al EPUB exportado.

### Configuración

- El engranaje abre `settings-modal/` con bloques colapsables (`<details>` nativo): **General** (incluye el toggle del panel de debug, que antes vivía en el header), **Apariencia** y **Gramática** (variantes regionales, nivel de chequeo, repeticiones). Antes era un modal que solo configuraba LanguageTool.
- `show()` recibe qué bloque desplegar: el effect que abre el modal cuando LT se cae pide `gramatica`, así el remedio no queda detrás de un click. El estado colapsado no se persiste, por lo mismo.

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
- **Refresh post-pull**: `git_pull` / `git_pull_rebase` devuelven `Vec<PullPathChange>`, así que tras un pull se refrescan el árbol, el capítulo abierto y el índice de búsqueda solo por lo que cambió — sin reabrir la carpeta a mano.
- **Fetch silencioso al abrir + antes de pushear**: `GitService.bootstrapSync()` corre `git fetch --prune` al detectar el repo, y `syncNow()` refetchea antes del push para no descubrir el non-FF recién en el rechazo.
- **`run_git` endurecido contra cuelgues sin TTY**: `git.rs::run_git_with_timeout` setea `GIT_TERMINAL_PROMPT=0` + `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` y mata el proceso por timeout — sin eso, un git que pide credenciales por consola dejaba la app esperando para siempre.
- Botón "sync ahora" (⇅) en header.

### Sync del diccionario entre PCs

El diccionario per-saga (las palabras que agregás para que LanguageTool deje
de marcarlas como typo) se sincroniza solo, junto con el repo de novelas, y
resuelve diferencias entre PCs como **unión sin repetidos**.

- **Storage line-based**: cada saga guarda su diccionario en
  `<saga>/diccionario.txt`, una palabra por línea (antes vivía en un array
  dentro de `saga.json`). Es la fuente de verdad; la app deduplica
  case-insensitive y ordena al leer.
- **Merge por unión automático**: al detectar un repo git, la app asegura una
  línea `diccionario.txt merge=union` en `<root>/.gitattributes`. El patrón no
  lleva `/`, así que matchea por basename a cualquier profundidad — **una sola
  regla cubre todas las sagas**. Con el driver `union` de git, si dos PCs
  agregan palabras distintas a la vez, el merge/rebase toma ambos lados (la
  suma) en vez de tirar conflicto. Por eso conviene un archivo de texto y no el
  JSON: `union` solo funciona línea por línea.
- **Recarga tras pull**: cuando un `pull` trae cambios en algún
  `diccionario.txt`, la app recarga el de la saga abierta sin que tengas que
  cerrarla — el subrayado del editor refleja las palabras nuevas al toque.
- **Migración transparente**: la primera vez que abrís una saga vieja, las
  palabras que estaban en `saga.json` se mueven al `.txt` y el campo legacy se
  borra. No perdés nada.
- **Versiones mezcladas**: si una PC corre una versión vieja de la app (que aún
  escribe en `saga.json`) y otra la nueva, la nueva **absorbe** lo que la vieja
  haya escrito, así nunca se pierden palabras. Lo que agregues en la versión
  nueva, eso sí, no lo ve la vieja hasta que la actualices. Recomendación:
  mantené ambas PCs en la misma versión.

## Configuración avanzada

### LanguageTool (3 backends)

tWriter soporta 3 backends de LanguageTool. Todos hablan el mismo endpoint
HTTP (`/v2/check`); cambia dónde corre y cómo se autentica.

#### API público (default)

`api.languagetool.org` — gratis, sin instalación. Limitado a 20 req/min,
75KB/min, 20KB/req. El texto se envía a servidores LT.

- Solo chequeo on-demand (sin auto-recheck mientras escribís — el ToS lo prohíbe).
- Banner naranja avisa la primera vez que activás la feature en una sesión.

#### Local (Docker / Podman / Apple container)

Para uso intensivo y privacidad total. La app maneja los 3 runtimes de
containers comunes y **autodetecta** el que tengas instalado y con daemon vivo
(prioridad: el que ya tenga el container de LT levantado → Docker → Podman →
Apple `container`). Absorbe las diferencias de CLI entre ellos (Apple no soporta
`--restart` y usa `ls --format json` en vez de Go templates; el mapeo de puerto
`-p 8081:8010` a `localhost` funciona en los tres). Podés levantarlo desde el
modal de gramática (⚙ del header → "Local (Docker)" → "Levantar LanguageTool") —
el status muestra vía qué runtime corre —, o por CLI:

```bash
./scripts/start-languagetool.sh   # primera vez tarda ~30s en cargar modelos
./scripts/stop-languagetool.sh
```

Los scripts asumen **Docker**; con Podman o Apple `container` hay que levantarlo
desde el modal de gramática, que es el que conoce los tres runtimes.

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

#### 5. Runtime de containers (opcional, para LanguageTool local)

Cualquiera de los tres sirve — la app autodetecta el que tengas. En Linux, Docker:

```bash
sudo pacman -S docker
sudo systemctl start docker        # arrancar on-demand, no enable
sudo usermod -aG docker $USER     # logout/login para que tome efecto
```

En macOS, ver [Instalación → macOS](#macos) (Apple `container`, colima o Podman).

Sin ningún runtime la app igual anda — usa el API público de LanguageTool por default.

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
