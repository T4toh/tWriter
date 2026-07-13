# TODO

Pendientes, bugs conocidos y mejoras planificadas de tWriter. Issues concretos van a GitHub Issues; acá quedan ideas, refactors abiertos y diseño en discusión.

## Editor / UX

- Más variantes de divisor de escena (más allá del `* * *`).
- Auto-abrir modal de configuración de LanguageTool cuando el chequeo tira error (hoy falla silencioso o solo loggea).
- Buscar más alternativas para la gramática.
- **Marcador huérfano post jump-to-term**: el highlight naranja de
  `requestHighlight` (search → click resultado) o de la selección nativa
  del jump queda pegado sobre el carácter (típicamente un em-dash) aún
  después de mover el cursor. Repro: search → click hit → click en otra
  parte del párrafo → el highlight persiste. La limpieza por mouseup /
  keydown se está escapando para algún path (chapter editor, no notes
  reader). Revisar el cleanup en `editor.ts` que monta el `TreeWalker`.
- **Bug — cursor fantasma**: queda una barra de cursor pintada en un
  punto del editor (típicamente arriba a la izquierda, fuera del flujo de
  texto) además del caret real donde se está escribiendo. Ver captura.
  Probable caret residual de TipTap/ProseMirror al perder/recuperar foco o
  tras un scroll. Investigar si es el caret nativo o un overlay de
  decoración (highlight/gapcursor) que no se limpia.
- **Performance en archivos grandes**: lag/scroll pesado en capítulos
  largos. Puede ser el scroll nativo de Windows/Linux, pero medir primero:
  si es el render de ProseMirror, evaluar virtualización o paginar el
  documento. Confirmar si el costo está en el editor o en el repintado del
  árbol/status.
- [x] **Educador de comillas tipográficas (inglés)** (`feat/comillas-tipograficas-en`,
  PR #60): contraparte en inglés del conversor a rayas RAE, para novelas
  importadas que quedaron con comillas rectas ASCII. `quotes/educate.ts`
  (`educateQuotes`) convierte `"`→`“ ”` (open/close contextual), `'`→`‘ ’`
  (cita) / `’` (apóstrofe, posesivo, elisiones `'em`/`'90s`). **Tag-aware**:
  tokeniza tags vs texto y educa solo texto → `class="scene-break"` y demás
  atributos quedan intactos (no se puede hacer `.replace` global). Botón
  "Comillas" por capítulo (gate `idioma === 'en'`) con modal diff reusando
  estilos RAE; acción masiva "Arreglar comillas" en menú saga/libro/sección
  (`quotes-fix-service.ts`, confirm con conteo, escribe solo los que cambian,
  refresca árbol + git status) reusando `list_chapters_for_audit`/`write_chapter`
  (cero Rust nuevo, cero deps npm). Spec + smoke runner (`node --experimental-strip-types`).
- [x] **Fix scroll del modal diff (RAE/Comillas)** (misma PR): `.rae-pane`
  (grid item) tenía `min-height:auto` → crecía con el contenido y `.rae-content`
  nunca activaba su `overflow-y`, scrolleando el archivo de fondo. Fix:
  `grid-template-rows: minmax(0,1fr)` + `min-height:0` + `overscroll-behavior:contain`.

## Búsqueda

- [x] **Mejorar la búsqueda — exacta por default + toggle ≈ (fuzzy/acentos)**
  (`feat/search-exact-default-fuzzy-toggle`, PR #52): se rediseñó en dos modos
  porque las necesidades chocaban. **Exacto (default)**: índice v4 con tokenizer
  fiel (lowercase, sin fold de acentos, sin drop de stopwords) + QueryParser
  literal accent-sensitive → encontrás el texto tal cual, ideal para corregir
  errores anotados en la Kindle (`mansion` no trae `mansión`). **Fuzzy (opt-in,
  botón `≈` en la barra, persistido en `settings.searchFuzzy`)**: builder
  fuzzy/OR (Levenshtein escalado por longitud, máx 2) que tolera typos y acentos
  para nombres inventados (`kellai`→`Kallai`). Fix del snippet "encuentra nada":
  `resolve_matched_words` ubica la palabra REAL del doc que matcheó, centra el
  snippet en ella y la expone como `matchedTerms` por hit; el frontend la usa
  para resaltar/saltar al término existente. El flag `fold` viaja por todo el
  highlight (panel, editor, notas, md-reader): exacto accent-sensitive, fuzzy
  plega acentos; `foldAccents` (TS) espeja `fold_accents` (Rust) length-preserving
  para mantener offsets DOM/PM alineados. Tests 184/0 + `search-highlight.spec.ts`.
  Bump `INDEX_VERSION` 2→4 (wipe+reindex auto). **Pendiente** (no en este PR):
  autocompletar términos del proyecto (tipear `kel` → sugerir `Kallai`) para
  atacar de raíz el "me olvido cómo se escribe".

## Tree / Importer

- **Bug — cartel de split colgado**: el overlay "Soltar acá para abrir en
  split" queda pintado después de soltar el drop. Ver captura. El handler
  de `drop` / `dragend` no está limpiando el estado del hint. Asegurar que
  se resetee también en `dragleave` fuera de la ventana y al soltar.
- [x] **Doble árbol para notas** (`feat/notes-second-tree-no-focus-loss`):
  panel secundario colapsable + redimensionable abajo del principal, dedicado
  a notas. El `Tree` ahora toma un input `variant` (`main`/`notes`) y deriva un
  `root` filtrado de `project.tree()`: `pruneToChapters` saca del principal todo
  subárbol `note`/`notes` + el nodo "Notas" general (carpetas que solo tienen
  notas); `pruneToNotes` conserva solo ramas con notas preservando la jerarquía
  saga/libro. Click en nota → visor derecho (`markdown-reader`) sin tocar el
  editor; doble-click/Shift → editor central. De yapa se arregló el **foco
  perdido al navegar**: `toggle()` ya no hace `chapter.close()`/`note.close()`,
  así expandir/colapsar carpetas mantiene el capítulo abierto en vez de tapar el
  editor con la galería `app-landing`. Estado del panel (`notesPaneCollapsed`,
  `notesPaneHeight`) y expansión del árbol de notas (`treeNotesExpanded`)
  persisten aparte en `settings.json` (+ campos en el `Settings` de Rust, sino
  serde los dropeaba en el round-trip). IDs de cdkDropList namespaceados por
  variante y `bindDragDrop` gated a `main` para que las dos instancias no
  choquen.
- [x] **Doble-click en carpeta → vista de tarjetas** (`feat/comillas-tipograficas-en`,
  PR #60): complemento del fix "navegar sin perder foco" de arriba. Tras ese
  cambio el single-click solo expande/colapsa (mantiene el archivo en foco). El
  doble-click ahora (`browseFolder`) flushea ediciones pendientes, cierra el
  archivo del pane primario y navega la galería `app-landing` a esa carpeta.
  Excluye el árbol de notas (la galería navega el árbol principal).
- Re-importar capítulo sobrescribiendo el `.html` existente (hoy hay que borrar primero).
- Sumar más importers de notas: Obsidian (vault con `.obsidian/`), Notion (export ZIP), Bear (`.bear`), Logseq (graph), Markdown plano con frontmatter. El trait `NoteImporter` ya está armado — agregar uno nuevo no requiere tocar el wizard genérico.
- Joplin JEX format (preserva adjuntos + tags + timestamps). Hoy solo soporta el export raw MD.

## EPUB

- **Copyright editable en ambos idiomas** (ES/EN): hoy el texto de la
  página de copyright sale fijo/auto-generado. Permitir editar el cuerpo y
  que cambie según el `idioma` del libro.
- **Incisos extra de copyright tipo Reedsy**: sumar cláusulas opcionales
  (reserva de derechos, "obra de ficción / personajes ficticios",
  prohibición de reproducción, etc.) elegibles al armar la página legal,
  bilingües como el copyright.
- Lista "Otros libros del mismo autor" en EPUB (contratapa ya está embebida).
- Preview tipo Kindle (B/N, distintos tamaños — Paperwhite, Oasis, Scribe). Amazon discontinuó Kindle Previewer en Linux.
- Pesos extra de fuente (300 Light, 600 SemiBold, 900 Black). Hoy solo Regular/Bold/Italic/BoldItalic; pesos custom requieren edit manual del `theme.json`.
- Auto-migración de tema renombrado: hoy renombrar un tema deja sagas/libros con `base` dangling (warning). Implementar scan recursivo de `*.json` y rewrite del `base`.
- Colores en el tema (body color, heading color, scene-break color). Hoy el tema es solo tipografía + márgenes.
- Theme presets compartibles entre repos distintos (export/import como zip).
- Revisiones de EPUB: hoy sobreescribe siempre `Exportados/<titulo>.epub`. Sumar "guardar últimas N revisiones" (default 5) — renombrar la actual a `<titulo>-revN.epub` antes de generar la nueva.
- Diseño de la página "Sobre el autor": hoy funcional pero genérico (foto circular + bio justified). Pensar layout más editorial (dos columnas, variantes de retrato, epígrafe).
- Bio + foto del autor a nivel saga (heredados a libros nuevos) y/o `settings.json` (defaults globales del repo). Hoy solo `book.json`.
- [x] **Vista copada para diseñar temas** (`feat/theme-editor-redesign-font-cleanup`): rediseño completo del theme editor con tabs (Tipografía / Capítulos / Editoriales / Página / Fuentes), controles agrupados en `ctrl-group` cards, preview live por tab (cuerpo+inline, página standalone con `chapter_title_position`, editoriales tipo title page + TOC + dedicatoria, mock EPUB con aspect-ratio por template). Font selector unificado con `<app-select>` + itemTemplate (cada nombre renderea en su tipografía, igual que el editor toolbar). Pool de fuentes con virtual scroll y FontFace eager-load. Modal altura fija — no baila entre tabs. De yapa: italic/bold sintetizados con tunings `italic_oblique_deg` / `italic_weight` / `bold_weight` (cascade — `bold_weight` levanta italic si éste no tiene peso propio), borradas las faces explícitas de la UI (Rust mantiene fields back-compat read; al re-guardar se omiten). Cleanup detector simplificado a sólo familias — bug "face explícita marcada como no usada" muere como side-effect.

## Archivos

- Changelog screen in-app: panel/modal accesible desde el header (junto a 🐛) parseando `CHANGELOG.md` o release notes de GitHub. Útil para gente nueva post-AUR.
- Guía in-app de primer uso: tour con flechas la primera vez que se abre la app (tree explorer, idioma, RAE, gramática, sync). Persiste flag en `settings.json`.
- Botón "Abrir en terminal" dentro del modal storage-help (`xdg-open` / `konsole` / `gnome-terminal` / `wt`).
- **Sincronizar `settings.json` entre PCs**: hoy la config vive en
  `app_config_dir` local (Linux: `~/.config/twriter/`) — cada PC arranca
  con su propio tema, idioma, font recents, grammar mode, diccionario,
  rightPanelWidth, etc. Opciones a evaluar: (a) mover a
  `<root>/.twriter/settings.json` para que vaya por git/cloud junto al
  repo de novelas, (b) sumar export/import manual, (c) sync explícito
  por gist/Dropbox. La (a) es la más seamless pero mezcla preferencias
  per-PC (font recents) con per-repo (tema, idioma).
- [x] **Sync del diccionario personal** (`feat/dictionary-git-sync-union`): el
  diccionario ya viajaba por git (vivía en `saga.json`, trackeado) — lo que
  faltaba era (a) recargarlo tras pull y (b) unir sin pisar cuando dos PCs
  agregan palabras distintas. Se movió de `saga.json` a un archivo dedicado
  per-saga `<saga>/diccionario.txt` (una palabra/línea) + `<root>/.gitattributes`
  con `diccionario.txt merge=union` (una sola regla cubre todas las sagas vía
  match por basename). Git fusiona por unión automáticamente; la app deduplica
  case-insensitive al leer. Comandos Rust `get/set_saga_dictionary` (con
  migración idempotente desde el campo legacy de saga.json, que se borra al
  migrar), `git_ensure_dict_union_merge` (espejo de `git_ensure_twriter_ignored`,
  corre en `bootstrapSync`). `applyPullChanges` detecta `diccionario.txt` tocados
  y recarga el de la saga activa. `set_saga_config` migra+strip antes de escribir
  para que ningún round-trip pierda palabras. Verificado end-to-end con dos
  clones: `pull --rebase` resuelve la unión sin conflicto.

## Observabilidad / Stats

- Diff/historial visual via `git log`.
- Stats: gráfico palabras/día.
- Preview pre-push: hoy el indicador del header dice "15 archivos para subir" sin detalle. Tooltip con lista de paths (M/A/D) en hover, y/o dialog "Ver cambios pendientes" con `git status --short` + `git diff --stat`.

## Git / Sync

- [x] **Refresh post-pull (tree + editor + search index)**: tras `git_pull` / `git_pull_rebase`, los commands ahora retornan `Vec<PullPathChange>` (diff de trees pre→post HEAD). `GitService` dispara `project.loadTree()`, `chapter.reloadIfChanged()` (silencioso si el buffer no está dirty; toast warn si sí, preservando la edición) y `search.applyPathChanges()` (incremental sobre `.html` / `.md`). Resuelve el bug de "el árbol y el diccionario no se actualizaron tras pullear desde otra PC".
- [x] **Fetch silencioso al abrir + pre-push**: `GitService.bootstrapSync()` hace `git_fetch --prune` al detectar el repo git, y `syncNow()` ahora es fetch-first (fetch → refresh → pull-if-behind → commit → push). El sync también se rebootstrapea ante el evento `online`.
- [x] **Endurecer `run_git` contra cuelgues sin TTY**: `git.rs::run_git_with_timeout` setea `GIT_TERMINAL_PROMPT=0` + `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"` y aplica timeout (30s default, 60s para push/pull/fetch) vía la crate `wait-timeout`. Sobre timeout mata el child y devuelve `network: git command timed out`. Pull/rebase ya iban por `run_git` — el TODO viejo asumía un raw `Command::new` que en realidad no existía.
- **Event-driven sync** (nuevo, agregado en la misma PR): focus → fetch, blur (debounced 30s + cooldown 2min) → flushAndSync, close → flushAndSync con timeout 10s + modal "¿Cerrar igual?" si falla. Listeners de `online`/`offline` también. El poll de status de 30s se eliminó; queda el poll de 5min como red de seguridad para sesiones largas sin transiciones de foco.
- **Bug — cambio de carpetas en remoto no refresca el árbol**: si en otra
  PC se crean/renombran/mueven carpetas, hay que recargar el árbol a mano
  para verlas. El refresh post-pull (`loadTree()` sobre `PullPathChange`)
  ya cubre `.html`/`.md`, pero los cambios de estructura de carpetas no se
  reflejan. Verificar si `PullPathChange` reporta dirs y si `loadTree()`
  realmente se dispara para este caso. (Posible que ya esté resuelto —
  confirmar con repro entre dos PCs.)

## Validador RAE

- **Bulk auto-fix** desde el panel "Revisar RAE": hoy el panel es solo lista
  - click-to-jump. La acción "Aplicar todos los auto-fixables (N)"
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

## Plataformas

- Mobile (no urgente, capaz solo un exportador a EPUB para ver archivos desde gh). Tomador de notas estaría piola, pero no veo que sea posible sincronizar git en el teléfono (Capaz que sí, investigar.) Estaría re zarpado poder tomar notas sobre partes o capítulos mientras leo en la kindle y que queden resgistrados en notas del libro o algo así.
