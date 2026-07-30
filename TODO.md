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
- **Bug — artefacto de glifo en algunas letras**: al renderizar el texto del
  editor, algunas letras salen con un trazo espurio pegado al principio del
  glifo (visto en una `N` mayúscula, fuente serif del editor). Ver captura.
  Probable problema de hinting/subpixel de la fuente en la webview (macOS) o
  de la variante sintetizada (italic oblique / bold synthesis) aplicándose
  donde no corresponde. Verificar primero si pasa con la fuente en otro
  tamaño/zoom y en otro OS antes de tocar el theme.
- [x] **Scroll a la línea nueva al tipear** (`feat/caret-scrolloff`, PR #64):
  cuando el cursor pasaba a una línea nueva al final del viewport, la vista
  quedaba pegada al borde inferior — se escribía a ciegas. Ojo con
  no pisar la restauración de posición al abrir capítulo (`editor.ts:430-469`
  setea `scrollTop = 0` y usa `focus(undefined, { scrollIntoView: false })` a
  propósito).

  **Implementado (`feat/caret-scrolloff`)**: spec en
  `docs/superpowers/specs/2026-07-29-caret-scrolloff-design.md`. La causa no era
  que la vista no siguiera al caret: ProseMirror ya scrollea al tipear
  (`readDOMChange` cierra sus transacciones con `tr.scrollIntoView()`), pero
  `scrollRectIntoView` usa los defaults `scrollThreshold = 0` /
  `scrollMargin = 5px`, y mide el *padding box* de `.editor-host` — o sea que
  el `padding: 2.5rem` del host no aporta respiro y el caret queda a 5px del
  borde visual. Fix: `caret-scrolloff.ts` (módulo puro) calcula insets de 2
  líneas desde el `line-height` computado de `view.dom`, y las tres superficies
  tipeables (capítulos, notas y el modo edit del markdown-reader) los pasan por
  `editorProps` vía la `buildEditorProps()` compartida de `editor-props.ts` (que
  también centraliza los atributos anti-corrector que antes estaban duplicados
  entre componentes), reaplicados al instanciar y — en capítulos y notas, que
  tienen tamaño de fuente configurable — en un effect sobre `editorFontSize`
  (el respiro escala con la fuente, 12–28px; el markdown-reader tiene
  `font-size` fijo en el SCSS, sin señal que reaplicar). El inset vertical es
  compartido entre `threshold` y `margin` a propósito: el scroll avanza de a
  una línea, sin saltos. En el eje horizontal, `threshold` queda en 0 y
  `margin` en 5 — el default histórico de ProseMirror, necesario porque un
  `pre` de code block en notas sí scrollea horizontal. No se tocaron los dos
  paths de scroll manual: la restauración al abrir y el salto de búsqueda
  (`scrollIntoView({block:'center'})` nativo). Tests:
  `scripts/run-caret-scrolloff-smoke.mjs` (19 casos) + `pnpm build`.
  **Verificado a mano** en macOS (M5, Darwin 25.5, 2026-07-29) con la app en
  dev: el autor probó el checklist completo — tipeo contra el borde inferior y
  flecha arriba contra el superior, escalado al cambiar el tamaño de fuente sin
  que la vista salte, reapertura de capítulo arrancando arriba, salto de
  búsqueda centrando el match, línea larga dentro de un `pre` de code block en
  notas, y el modo edit del markdown-reader — y da el comportamiento por bueno.
- [x] **Control total del tipeo — matar el corrector del OS + sugerencias del
  diccionario propio + ubicar bien el popup** (`feat/control-total-tipeo`,
  PR #63): spec en
  `docs/superpowers/specs/2026-07-29-control-total-tipeo-design.md`. (a) macOS
  reescribe el texto dentro de la webview (autocorrección + sustituciones) y
  arruina el voseo, en el editor y en los inputs comunes: `spellcheck`/
  `autocorrect`/`autocapitalize` off heredados desde `<html>` + explícitos en
  los `editorProps` de los tres editores TipTap (capítulo, notas y markdown
  reader), más `macos_text.rs` apagando las
  sustituciones nativas (`registerDefaults` + setters de `NSTextCheckingClient`
  sobre la `WKWebView`, gateados por `respondsToSelector:`). Typography de
  TipTap queda como única fuente de comillas y rayas. (b) el diccionario
  per-saga hoy solo silencia falsos positivos de LT y nunca sugiere: sumar
  `dictionary/suggest.ts` (Levenshtein con umbral por longitud, acentos
  plegados) y mostrar hasta 3 candidatos con chip "tu diccionario" en el
  popover de gramática. (c) el popup de gramática/RAE sale siempre hacia abajo
  con constantes mágicas (`editor.ts:1163-1190`) y se corta contra el borde
  inferior: `popover-position.ts` con flip arriba/abajo, clamp de X, `maxHeight`
  + scroll interno cuando no entra en ningún lado, medición real del popover
  (`afterRenderEffect` + `visibility:hidden`), recálculo en `resize` y cierre
  en scroll del `.editor-host`.

  **Implementado (`feat/control-total-tipeo`):** las tres
  componentes del spec. Verificado por código: `pnpm build` sin errores;
  `suggestFromDictionary: 12/12 ok`, `placePopover: 9/9 ok`; `cargo check`
  limpio. En macOS/Darwin 25.5: de los 6 setters de `WKWebView` que la app
  intenta, existen solo 3 (`setAutomaticQuoteSubstitutionEnabled:`,
  `setAutomaticDashSubstitutionEnabled:`, `setAutomaticTextReplacementEnabled:`);
  faltan `setAutomaticSpellingCorrectionEnabled:`, `setContinuousSpellCheckingEnabled:`
  y `setSmartInsertDeleteEnabled:` (son API de `NSTextView` legacy). La
  autocorrección/spell-check del OS dependen exclusivamente de
  `NSUserDefaults` registrados. Ver selector por selector con
  `RUST_LOG=twriter_lib=debug,boot=debug pnpm tauri dev` (el resumen sale por
  default bajo target `boot`). Tests de funciones puras: patrón `tsc` a tmpdir.
  **Verificado a mano** en macOS (M5, Darwin 25.5, 2026-07-29) con la app en
  dev y LanguageTool en `:8081`: el autor probó el flujo completo y da el
  comportamiento por bueno. Queda una nota de layout, no un bug: los
  candidatos del diccionario salen como los primeros chips de una fila que
  envuelve (`.reps` es `display: flex; flex-wrap: wrap`), no como una sección
  separada arriba; el chip "tu diccionario" alcanza para diferenciarlos, así
  que se deja así. Deuda cobrada en `fix/popover-collision-select-placement` (spec en
  `docs/superpowers/specs/2026-07-30-popover-collision-select-placement-design.md`):
  (a) la palabra con las dos decoraciones abría los dos popovers porque los dos
  listeners de click vivían en el **mismo** nodo (`.editor-host`) — el
  `stopPropagation()` que ya tenían corta el bubbling, no al listener hermano, y
  `stopImmediatePropagation()` habría dejado la prioridad atada al orden de
  registro. Ahora hay un handler único con la prioridad escrita, así que lo que
  cambia no es solo cuántos popovers se abren sino **cuál** de los dos gana:
  **gana RAE**, que es regla propia y determinista y cuyo popover ofrece el fix
  del conversor — excepto cuando la violación es `pending-conversion`
  (`validator.ts::pushPendingConversion` decora el párrafo entero, no la
  palabra puntual, así que tapaba gramática en casi todo un capítulo con
  diálogo entre comillas sin convertir); ahí gana gramática, porque el fix de
  esa violación ya está a mano vía "Aplicar RAE" al capítulo completo.
  (b) `shared/select.ts` usa `placePopover`: mide el panel ya renderizado en un
  `afterRenderEffect` (antes `measurePanel()` corría antes de `open.set(true)`,
  con el contenido detrás de un `@if`, así que medía 0 y de ahí el `320`
  hardcodeado). De yapa gana el clamp horizontal que no tenía — un select con
  opciones largas cerca del borde derecho se salía de la pantalla — y el
  `maxHeight` con scroll interno en vez de cortarse. Se fueron el
  `transform: translateY(-100%)` y el keyframe `sel-fade-up`.
  (c) De yapa, salido de la verificación a mano: el `.grammar-pop-backdrop`
  (`position: fixed; inset: 0; z-index: 999`) tapaba el editor entero mientras
  un popover estaba abierto, así que el primer click sobre **otro** error se lo
  comía el backdrop para cerrar y hacía falta un segundo click para abrir el
  siguiente. Preexistente, no lo introdujo esta PR. El cierre por click afuera
  pasó a un listener en `document` (mismo patrón que `shared/select.ts::onDocClick`),
  que no intercepta el texto: los clicks de adentro de un popover no llegan ahí
  porque sus roots hacen `stopPropagation()`, y los que abren un popover nuevo
  tampoco porque `onHostClick` corta la propagación al abrir.
  **Verificado a mano** en macOS (M5, Darwin 25.6, 2026-07-30) con la app en dev
  y LanguageTool en `:8081`: el autor probó los diez puntos del checklist — un
  solo popover por palabra, `pending-conversion` cediéndole a gramática con el
  "+ diccionario" alcanzable (el caso que motivó la excepción), nunca dos
  popovers, cambio de un error al siguiente en un click tras el fix del
  backdrop, aplicar fixes desde los dos popovers, y los tres del select (borde
  derecho sin salirse, borde inferior abriendo hacia arriba, ventana chica
  scrolleando adentro sin scrollbar espurio) — y da el comportamiento por bueno.
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
  atacar de raíz el "me olvido cómo se escribe". **Herramienta viable**:
  `@tiptap/suggestion` para el popup inline, alimentado por el diccionario
  per-saga (`<saga>/diccionario.txt`) + prefix query sobre el índice tantivy
  — offline, determinista, cero red. LanguageTool NO sirve para esto: expone
  `/v2/check` y diccionario personal Premium, no tiene API de completion.
  Hunspell (`zspell`/`hunspell-rs`) daría corrección ortográfica ES pero no
  completa nombres propios inventados, que es el caso real.

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

- **Levantar LanguageTool sin saber de containers** — spec en
  `docs/superpowers/specs/2026-07-30-languagetool-setup-seamless-design.md`.
  **Bug de raíz**: `languagetool_docker_status` (`grammar.rs:643-667`) colapsa el
  estado del daemon dentro de los flags del container (`if e.daemon_ok() { … }
  else { (false, false) }`), así que "el daemon está caído" queda
  indistinguible de "no hay container" y la UI dice **"Container detenido (no
  existe todavía)"** — las dos afirmaciones falsas. Descubierto el 2026-07-30:
  el autor reinició la Mac por primera vez desde que la compró, el apiserver de
  Apple `container` no estaba registrado en launchd (`container system status`
  → `apiserver is not running and not registered with launchd`), y sin
  apiserver `container ls` falla con `XPC connection error`, así que el backend
  no veía el container que sí existía. Lo irónico: `daemon_down_message`
  (`grammar.rs:269-287`) ya produce el texto correcto ("Corré `container system
  start`") pero solo se devuelve desde el path de arranque, no desde el status
  que corre solo al abrir la ventana — y trae el comando embebido en la prosa,
  imposible de copiar. **Plan**: (a) `Remedy { message, command, can_run }` con
  el comando separado de la prosa, y `daemon_running` + `remedy` en
  `LtDockerStatus`; (b) `daemon_start_cmd` por runtime y OS — `container system
  start`, `podman machine start`, `colima start` o abrir Docker Desktop en
  Mac/Windows con polling de 60s porque el daemon tarda ~30s en aceptar
  conexiones, y `None` en Linux donde hace falta sudo; (c) **un** botón que hace
  las dos capas (daemon + container), con una fase nueva al frente del stepper —
  el usuario no tiene que aprender que son dos capas; (d)
  `shared/copy-command.ts` (chip `<code>` + "copiado ✓") reusado por la rama del
  daemon caído y por la lista de instalación, que reemplaza el blob de prosa de
  `no_runtime_message` por opciones con comando copiable (los `brew` en macOS;
  solo URL en Linux/Windows, porque el comando depende de la distro y un comando
  que falla es peor que un link). Tests: `daemon_remedy` y `daemon_start_cmd`
  son puras `(Runtime, OS)` y van a los tests de `grammar.rs`.
  **Estado**: implementado en `feat/languagetool-setup-seamless` — `Remedy` +
  `daemon_plan(Runtime, Os, colima)` puro como fuente única del diagnóstico,
  `daemon_running`/`remedy`/`install_options` en `LtDockerStatus`, la fase
  `daemon` al frente del arranque con polling de 60s para Docker Desktop, y
  `shared/copy-command.ts`. Los tests de Rust cubren la matriz runtime × OS ×
  colima, las invariantes (`can_run` ⟺ hay argv, nunca `command: Some("")`,
  nunca el comando embebido en el `message`) y el contrato serializado del
  status. **Falta la verificación manual** del checklist del spec (`container
  system stop` → mensaje correcto, el botón haciendo las dos capas, el chip
  copiando el comando pelado, la lista de instalación sin runtime) — hasta
  entonces este item no se marca.
- [x] **Soporte multi-runtime de containers para LanguageTool** (`grammar.rs`):
  antes todo asumía el CLI `docker`. Ahora una abstracción `Runtime`/`Engine`
  autodetecta Docker, Podman o Apple `container` (prioridad: el que ya tenga el
  container de LT levantado → Docker → Podman → Apple). Absorbe las diferencias
  de CLI: Apple no soporta `--restart` (se omite), usa `ls --format json` en vez
  de Go templates `{{.Names}}` (se parsea `configuration.id`), daemon check vía
  `container system status`, pull vía `container image pull`. El mapeo `-p
  8081:8010` a `localhost` funciona en los tres (verificado en vivo con Apple
  container: pull arm64 nativo → run → `localhost:8081` responde → check ES ok).
  Mensajes de error OS/runtime-aware (adiós `systemctl` en Mac). El status expone
  `runtime` y la UI lo muestra ("corriendo … vía Apple container"). Tests en
  `grammar.rs` (args con/sin `--restart`, parseo JSON de Apple). Docs README +
  release notes con instrucciones para los tres.
- [x] **Fix instalador macOS ARM "dañado"** (`signingIdentity: "-"` en
  `tauri.conf.json`): el `.app` aarch64 salía solo con la firma que el
  *linker* de Apple Silicon pega al binario (`adhoc,linker-signed`,
  `Sealed Resources=none`) porque sin `signingIdentity` Tauri saltea
  `codesign`. Esa firma está rota a nivel bundle → en Macs ARM Gatekeeper
  reporta la app como **"dañada, mover a la papelera"** y ni el click
  derecho → Abrir la rescata. Con `signingIdentity: "-"` Tauri corre
  `codesign --force -s -` (firma binario + bundle, sella recursos) → firma
  ad-hoc válida (`codesign --verify --strict` pasa, sobrevive a
  `com.apple.quarantine`). No necesita keychain/identidad en CI. Reproducido
  y verificado local en M5 (baseline roto → fix ok). Sigue sin notarizar
  (requiere Apple Developer ID), así que el workaround `xattr`/click-derecho
  se mantiene, pero ahora funciona de verdad.
- **Verificar auto-update en macOS (app ad-hoc, sin notarizar)**: los builds
  macOS (`aarch64` + `x64`, desde v0.5.7) salen firmados ad-hoc pero sin
  notarizar. El updater Tauri
  descarga el `.app.tar.gz` firmado con minisign y reemplaza la app in-place,
  pero falta confirmar end-to-end que el flujo funcione en macOS sin Developer
  ID: Gatekeeper puede poner en cuarentena el `.app` recién bajado y bloquear
  el relaunch (volviendo a pedir click derecho → Abrir), o el reemplazo fallar
  por permisos. Repro: instalar una versión vieja, publicar una nueva, aceptar
  el banner de update y ver si arranca limpio. Si rompe: documentar el
  workaround (`xattr -dr com.apple.quarantine` post-update) y/o evaluar firma +
  notarización (Apple Developer ID, $99/año) para que el auto-update sea
  seamless. Ver `tauri.conf.json::plugins.updater` y el job `build-macos` en
  `.github/workflows/release.yml`.
- Mobile (no urgente, capaz solo un exportador a EPUB para ver archivos desde gh). Tomador de notas estaría piola, pero no veo que sea posible sincronizar git en el teléfono (Capaz que sí, investigar.) Estaría re zarpado poder tomar notas sobre partes o capítulos mientras leo en la kindle y que queden resgistrados en notas del libro o algo así.
