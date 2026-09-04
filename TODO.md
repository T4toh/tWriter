# TODO

Pendientes, bugs conocidos y mejoras planificadas de tWriter. Issues concretos van a GitHub Issues; acá quedan ideas, refactors abiertos y diseño en discusión.

## Urgente

- [x] **El click en un resultado nunca lleva al resultado — el buscador es
  inútil así** (`fix/busqueda-salto-y-matcheo`, verificado a mano por el autor
  el 2026-09-03 buscando `y Ami ya está`, el ítem 1 de su lista de arreglos:
  cae en la frase entera, donde antes caía en el primer `ya` del capítulo)
  **Causa raíz, y explica el "nunca"**: la posición del match **no viaja**. El
  `SearchHit` que devuelve Rust (`search.rs:64-80`) trae `path`, `snippet` y
  `matchedTerms`, pero **ningún offset**. Del lado del front,
  `openHit` (`search-panel.ts:270-305`) llama `requestHighlight(path, undefined,
  hit.matchedTerms)` y el editor termina en `highlightFirstMatch`
  (`search-highlight.ts:43-138`), que hace lo único que puede hacer sin offset:
  recorre el DOM con un `TreeWalker` y salta al **primer text node en orden
  documental** que contenga cualquiera de los términos. O sea que no salta al
  hit: salta a la primera aparición de la palabra más común de la query, casi
  siempre arriba de todo del capítulo.
  Dos agravantes: (a) la pasada 1 busca el literal completo de la query, pero
  solo si tiene "forma rica" (mayúscula o puntuación) **y** cae entero en un
  mismo text node — con una frase partida en dos nodos falla y cae a la pasada
  2, la del primer token; (b) cuando un capítulo tiene varios hits, el grupo
  muestra N líneas pero todas mandan al mismo lugar, porque el offset que las
  distingue no existe.
  **Y no es solo el buscador**: `rae-audit-panel.openChapterAt`
  (`rae-audit-panel.ts:76-85`) **tiene** `v.offset` en la mano y lo tira —
  recorta el término y llama `requestHighlight(path, term)`, o sea entra al
  mismo camino roto teniendo el dato bueno.
  **Fix**: que el offset viaje de punta a punta — agregarlo al `SearchHit`
  (el backend ya lo conoce: es donde centra el snippet, `search.rs:333`), meterlo
  en `PendingHighlight` (`search-service.ts:61-96`) y que el editor mapee
  offset → posición PM. **La maquinaria ya existe y está probada**:
  `offsetToPm(offset, ranges)` es lo que usan `rae-extension.ts:104` y
  `grammar-extension.ts:164` para anclar sus decoraciones. El `TreeWalker` de
  `highlightFirstMatch` queda como fallback para los hits que no traen offset
  (los client-side de "Archivo actual").
  Ordenar bien esto arregla de una la mitad del ítem de matcheo en
  `## Búsqueda` y desbloquea el de revisión por libro en `## Gramática`.
  El plan de "que el offset viaje" NO se pudo seguir tal cual: el `content` que
  guarda tantivy pasa por `html_to_text`, que colapsa todo a una línea con
  espacios simples, mientras el editor vive en el espacio de `extractPlainText`,
  que mete `\n\n` entre bloques y `* * *` por cada `<hr>`. Los dos planos se
  desfasan y el offset del backend cae al lado. Alinearlos exige cambiar el
  indexado y bumpear `INDEX_VERSION` (reindex full de todo el repo) — queda como
  camino futuro.
  Lo que se hizo en su lugar: el salto elige **el mejor bloque** en vez del
  primero. `pickBestBlock` (`search-highlight.ts`) puntúa los bloques del DOM
  por cobertura de términos distintos, con el literal de `rawQuery` ganando de
  una si aparece; recién ahí `selectFirstMatchIn` busca el match adentro de ese
  bloque. El `TreeWalker` sigue, pero acotado al párrafo correcto.
  El caso del panel RAE se arregló distinto y sí exacto: `openChapterAt` ya no
  tira el offset, pero tampoco lo manda crudo (mismo desfase, agravado por los
  `<hr>`) — manda un **ancla de texto** recortada al bloque (`anchorAround`,
  ±40 chars), que es idéntica en los dos planos y el highlighter la clava.
  El salto del panel RAE también quedó verificado por el autor el 2026-09-03.
  Sigue pendiente el agravante (b), y va a ítem propio si molesta: varios hits
  del mismo capítulo siguen mandando todos al mejor bloque, no uno a cada
  aparición. Para eso hace falta o el offset real del backend o navegación
  prev/next sobre los matches.

- [x] **Editar el CSS del EPUB no se ve hasta recompilar Rust — y nada lo avisa**
  (`fix/epub-css-runtime`, verificado a mano por el autor el 2026-09-02).
  `epub_style.css` se incrustaba con
  `include_str!`, o sea en tiempo de compilación, y el watcher de
  `pnpm tauri dev` solo mira `.rs`: tocar la hoja no disparaba nada y la app
  seguía exportando con el CSS viejo adentro del binario. El ciclo era
  editás → exportás → no cambia nada → concluís que el CSS está mal → lo
  "arreglás" de nuevo.
  Se tomó la opción 3 de las tres que había acá: la hoja se mudó a
  `src-tauri/resources/epub_style.css` y se lee en runtime, como el tesauro.
  En debug la ruta sale de `CARGO_MANIFEST_DIR`, no de la copia que
  `tauri-build` deja en `target/` — si no, seguiría haciendo falta recompilar
  para que la copia se actualice. En release sale de `BaseDirectory::Resource`
  y la hoja queda inspeccionable dentro del bundle. Si no se puede leer, el
  export falla con la ruta que intentó en vez de generar un EPUB sin estilos.
  Verificado con `pnpm tauri dev` corriendo: editar la hoja y exportar de
  nuevo, sin tocar nada de Rust, alcanza para ver el cambio en el EPUB.

- [x] **No hay forma directa de volver a la raíz**
  (`feat/inicio-y-settings`, verificado a mano por el autor el 2026-09-02).
  Para llegar a la vista raíz —la que lista las sagas y donde vive la carta
  del autor— había que hacer doble click en una saga y después tocar
  "Inicio". El camino a la pantalla de más arriba pasaba por bajar primero.
  El diagnóstico original apuntaba al breadcrumb, pero el breadcrumb
  estaba bien: `crumbs()` siempre arranca con `Inicio` y ya era clickeable.
  El problema es que el landing entero —breadcrumb incluido— vive detrás de
  un `@if (!active())` en `editor.html`, así que con un capítulo abierto no
  existe; y lo único que cerraba el archivo era el doble-click en carpeta del
  árbol, que te deja en la galería de esa carpeta. Se sumó
  `NodeActionsService.irAlInicio()` (flushea, cierra capítulo y nota, y llama
  a `NavigationService.goRoot()`, que ya existía sin llamadores), un botón de
  casita primero en la fila de acciones del panel izquierdo, y el atajo
  `Cmd/Ctrl+Shift+H` porque el modo focus esconde ese panel.
  Verificado con capítulo abierto (casita) y en modo focus (atajo).

- [x] **Configuración de verdad en vez de "Configurar gramática"**
  (`feat/inicio-y-settings`, verificado a mano por el autor el 2026-09-02).
  El engranaje abría un modal que solo configuraba LanguageTool.
  Ahora es `settings-modal/` con bloques colapsables (`<details>` nativo):
  General —que estrena el toggle del panel de debug, sacado del header— y
  Gramática, con las tres secciones que ya estaban. `show()` recibe qué
  bloque desplegar, y el effect que abre el modal cuando LT se cae pide
  `gramatica` para que el remedio no quede detrás de un click. El estado
  colapsado no se persiste, por lo mismo.
  Pendiente, para cuando haya con qué llenarlo: un bloque de temas de UI.
  Verificado bajando LT y disparando un chequeo: el modal abre con Gramática
  desplegada y General cerrada.

## Editor / UX

- **Los popups scrollean con la vista** (bug, reportado por el autor el
  2026-09-03): los flotantes anclados a una posición del texto (tooltip de
  gramática/RAE, menú de sinónimos del tesauro, etc.) se posicionan una sola vez
  y quedan pegados a coordenadas del documento, así que al scrollear el editor
  el popup se va con la vista en vez de quedarse sobre la palabra —o al revés,
  queda flotando sobre texto que ya no es el suyo. Hay que reposicionar en
  `scroll`/`resize` del contenedor scrolleable (o cerrar el popup si el ancla
  sale de viewport, que es lo barato).
- Más variantes de divisor de escena (más allá del `* * *`).
- [x] **Auto-abrir modal de configuración de LanguageTool cuando el chequeo
  tira error** (`fix/lt-config-modal-y-split-hint`, verificado a mano por el
  autor el 2026-08-21). Antes el error moría en un
  `<span class="indicator error">` del footer, que no se puede clickear. Ahora
  `GrammarService` expone `configRequest` (contador) + `pedirConfig()`, y
  `app.ts` — el único que tiene el `ViewChild` del modal — lo abre desde un
  effect; así ninguna superficie que chequee gramática necesita conocer el
  shell. El disparo automático va en el `catch` de `check()`, o sea una sola
  vez para todos los callers, y **solo si el ping que ya se hacía ahí confirma
  que LT no responde**: un `500` esporádico de LT 6.8 en `es-AR` (ver el item
  del bug más abajo) no es problema de configuración y no justifica
  interrumpir. Una vez por caída — `avisoAbierto` se rearma cuando `ping()`
  vuelve a dar ok, así que no spamea el modal mientras el autor escribe con LT
  caído. Además el indicador del footer pasó a ser `<button>`
  (`.indicator-btn`) que abre el mismo modal a mano.

  **El agujero real apareció al levantar la app, y no era el que decía este
  item.** Con LT caído el `catch` de `check()` no se ejecuta nunca: el editor
  gateaba todo con `canCheckGrammar()`, que incluía `grammar.available()`, así
  que sin LT no se dispara ningún check — y de paso **el botón LT
  desaparecía de la toolbar**, sin explicación ni remedio, justo lo que la
  convención "el remedio se da adentro de la app" del CLAUDE.md prohíbe. El
  `catch` solo cubre "LT se murió con un request en vuelo", que es una ventana
  angosta. Fix: partir el computed en `grammarApplies()` (idioma + editable, sin
  disponibilidad) y `canCheckGrammar() = grammarApplies() && available()`. La
  toolbar rendea sobre el primero: si LT no responde, el botón queda **visible
  en gris** (`.lt-down`, grayscale + opacity 0.45) y clickearlo abre la config.
  El botón `AUTO` sí se esconde — togglear auto-check con LT caído no hace
  nada.
- [x] Buscar más alternativas para la gramática. **Relevado el 2026-08-20**:
  no hay motor alternativo para español (Harper es solo inglés, nlprule está
  muerto desde 2021, portar el XML de LT a Rust es el pozo que mató a
  nlprule). La conclusión no fue cambiar de motor sino **embeberlo**: LT como
  sidecar recortado, 174 MB, arranque en 1,07 s, Docker afuera. Ver la sección
  "Gramática, ortografía y tesauro" — items "LT embebido como sidecar",
  "Qué da LT realmente sobre la prosa del autor" y "Alternativas de motor
  evaluadas y descartadas".
- **Marcador huérfano post jump-to-term**: el highlight naranja de
  `requestHighlight` (search → click resultado) o de la selección nativa
  del jump queda pegado sobre el carácter (típicamente un em-dash) aún
  después de mover el cursor. Repro: search → click hit → click en otra
  parte del párrafo → el highlight persiste.

  **Relevado el 2026-08-21 y la premisa de arriba estaba mal**: no existe
  ninguna limpieza por `mouseup`/`keydown` que se esté escapando — en
  `editor.ts` no hay un solo listener de esos (los únicos `HostListener` de
  teclado son los de `Ctrl/⌘+Shift+Y`). Hay **dos** naranjas distintos y hay
  que decidir cuál es el que molesta antes de tocar código:
  1. La **decoración PM `.search-hit`** (`search-highlight-extension.ts`,
     estilo en `editor.scss:633`), que el effect de `editor.ts:675` pinta
     desde `search.highlightTerms()`. Ese computed depende de
     `search.open()` + `search.query()`, así que la marca **es viva a
     propósito** mientras el panel de búsqueda esté abierto: clickear en otra
     parte del párrafo no la borra ni debería. Si esto es lo que se ve, no es
     un bug de cleanup — es la decisión de "resaltar todas las ocurrencias
     mientras buscás", y el cambio sería de diseño.
  2. La **selección nativa** de `highlightFirstMatch`
     (`core/search-highlight.ts`), que sí se va al clickear. Sobre un em-dash
     entra por el camino de `rae-audit-panel.ts:83`, que pasa como término el
     `slice` crudo de la violación (muchas veces arranca con la raya).

  **Falta para poder arreglarlo**: saber si el panel de búsqueda estaba abierto
  o cerrado cuando la marca quedó pegada. Con el panel abierto es (1) y es
  diseño; con el panel cerrado es (2) y ahí sí hay bug. Preguntado al autor el
  2026-08-21: **no se acuerda**, la captura es vieja. Así que este item queda
  esperando que vuelva a pasar — cuando pase, anotar el estado del panel y con
  eso alcanza para cerrarlo. No arrancar a tocar `editor.ts` sin ese dato: los
  dos naranjas se pintan por caminos distintos y el fix de uno no toca al otro.
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
- **Performance en archivos grandes**: lag/scroll pesado en capítulos largos.

  **Analizado el 2026-09-02 leyendo el código, no midiendo.** Se armó un
  banco de pruebas (`3 - Banco de Pruebas` del repo de prueba: 5k / 25k /
  100k / 300k palabras) y en la M5 del autor **hasta el de 300k va liso**, o
  sea que en este hardware no hay nada que medir. Perseguir un número que no
  se reproduce es cómo se termina virtualizando de gusto. Así que el criterio
  pasa a ser: arreglar lo que es **algorítmicamente incorrecto** —eso no
  depende de la máquina, solo del tamaño del documento— y dejar el resto para
  cuando haya una queja real en hardware más lento.

  Lo que corre por tecla tipeada, relevado sobre `editor.ts`:

  - `refreshState()` (en `onTransaction` **y** `onSelectionUpdate`) llamaba a
    `computeCursorPos`, que recorría `doc.descendants()` entero para contar
    bloques. **Arreglado** en `20dc294`: `$from.index(0)` da el mismo número
    en O(1). Era O(bloques) por tecla y por movimiento de cursor.
  - **`onUpdate` hace `editor.getHTML()` en cada tecla** (`editor.ts:1836`) y
    mete el string en `pane.content`. Eso serializa el documento **entero**
    por cada carácter: en el capítulo de 300k palabras es armar 1,7 MB de
    string por tecla. Es el costo O(n) por tecla que queda, y el que
    explicaría el síntoma en una máquina lenta.

    **No se toca todavía**, a propósito. El arreglo es marcar sucio (barato) y
    debouncear la serialización, pero `content()` se lee en 16 lugares y el
    save tendría que forzar un flush antes de escribir. Es un cambio de
    contrato, no una optimización local: sin un número que muestre que hace
    falta, el riesgo de romper un save supera al beneficio. **Disparador para
    hacerlo**: que aparezca lag reportado en hardware más lento.
  - El resto de lo que corre por tecla ya está debounceado y no acumula:
    gramática 2000 ms, RAE 1500 ms, repeticiones 1500 ms, autosave 1500 ms.
    Cuando disparan son O(n), pero una vez por pausa, no por tecla.

  Del lado del árbol: `chapter_word_count` cae a leer y contar el HTML cuando
  la clave no está en `stats.json` (`stats.rs:296`), o sea que **cada
  `get_tree()` releía todos los capítulos con la clave huérfana**. Eso lo
  arregla la reconciliación de stats del item de Tree/Importer. Queda como
  costo estructural que un capítulo nunca guardado por la app se recuente en
  cada carga del árbol; si alguna vez molesta, cachear por mtime.
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

- [x] **Apartado "Apariencia" en Configuración: tema de la app y fuentes**
  (pedido el 2026-09-04, después de definir los tokens de tema)
  Hoy el tema **lo decide el sistema operativo y nada más**: `styles.scss`
  tiene `color-scheme: light dark` y un `@media (prefers-color-scheme: dark)`,
  sin override manual ni persistencia. El modal de Configuración
  (`settings-modal/`) es solo gramática — variantes regionales, nivel de
  chequeo, repeticiones — así que no hay dónde elegir nada de apariencia.
  **Lo que ya está hecho** (y es la mitad que existe):
  - Los 29 tokens de color (`--panel-bg`, `--panel-header-bg`, `--hover-bg`,
    `--input-bg`, `--muted`, `--danger`, `--mark-bg`, …) ya están definidos
    en `styles.scss` para claro y oscuro, mapeados a la paleta cálida. Antes
    resolvían al fallback oscuro hardcodeado de cada `.scss`.
  - La fuente **del editor** sí es configurable y persiste:
    `editorFontFamily` + `editorFontRecents` (dropdown en el toolbar del
    editor, con preview en la propia tipografía al hover vía
    `SystemFontsService.loadFace`), `bumpFontSize(±)`, `cycleEditorWidth()`,
    `cycleParagraphSpacing()`. Todo eso vive en botones del editor, no en
    Configuración, y no toca la UI.
  - `theme-editor/` + `themes-service` + `fonts-service` **no son** el tema
    de la app: son los temas tipográficos del **EPUB** (`body_font`,
    `page_margin`, `dropcap`, fuentes adoptadas al repo). No mezclar los dos.
  **Lo que falta**:
  1. Sección "Apariencia" en el modal de Configuración, con el mismo patrón
     de `gs-section-divider` que ya usan las de gramática.
  2. Tema como preferencia propia: `appTheme: 'system' | 'light' | 'dark'` en
     `settings-service` (persiste solo, como el resto), aplicado con un
     `data-theme` en el `<html>`. Los bloques de tokens pasan a
     `:root:not([data-theme="light"])` para el `prefers-color-scheme` y
     `:root[data-theme="dark"]` para el override, y `color-scheme` tiene que
     seguir al elegido, no al del OS, o los scrollbars y los widgets nativos
     quedan del tema contrario.
  3. Fuente de UI elegible, y **antes que eso**, que las fuentes existan: hoy
     `--font-body: 'Merriweather'`, `--font-ui: 'Lato'` y
     `--font-mono: 'Roboto Mono'` no tienen **ningún `@font-face`** ni
     `src/assets/fonts/` en el repo (CLAUDE.md dice que las TTF van ahí — no
     está hecho), así que si el usuario no las tiene instaladas la app cae al
     serif/sans del sistema y nadie se enteró nunca. Bundlearlas con
     `@font-face` + `font-display: swap` y su licencia OFL al lado.
  4. Mover (o duplicar) a esa sección lo del editor que hoy solo se toca
     desde el toolbar: fuente, tamaño, ancho y espaciado de párrafo.
  5. Que el tema de la app **no** se filtre al EPUB exportado: son dos cosas
     distintas y el EPUB tiene su propio `epub_style.css` + temas.
  Sobre tests: esto es casi todo tokens y DOM, o sea `pnpm build` +
  verificación manual del autor. Lo único puro que vale un smoke runner es el
  mapeo `'system' | 'light' | 'dark'` → atributo/`color-scheme`.
  **Hecho el 2026-09-04** (rama `feat/tema-app`), en tres pasos:
  1. Las tres familias bundleadas: cinco `.woff2` del subset latin en
     `src/assets/fonts/` (~190 kB) declaradas en `src/styles/fonts.scss`, con
     sus OFL y las entradas en `generar-licencias.mjs`. La carpeta va al
     `ignore` del glob de assets: los `url()` del scss ya las emiten con hash
     en `media/`.
  2. Bloque "Apariencia" en el modal, con la fuente de **Interfaz**
     (`--font-ui`) y la **Monoespaciada** (`--font-mono`) elegibles entre las
     instaladas en la PC, preview de cada opción en su propia tipografía al
     hover, y "Volver a las fuentes de la app". La mitad pura vive en
     `core/app-fonts.ts` con su smoke runner
     (`scripts/run-app-fonts-smoke.mjs`, 11 aserciones); elegir el default
     guarda `null` y **borra** la custom property, así el default sigue
     definido solo en `styles.scss`.
  3. `appTheme` ('system' | 'light' | 'dark') persistido, aplicado con
     `data-theme` en el `<html>`; los tokens oscuros pasaron a un mixin porque
     ahora entran por el media query (con `:not([data-theme])`) y por el
     override manual.
  **Dos cosas del plan original NO se hicieron, por decisión del autor**:
  - El serif de lectura no es un slot de Apariencia. La fuente del texto se
    elige en el toolbar del editor, que ya existía, y ahora la comparten las
    tres superficies del mismo contenido: editor de capítulos, editor de
    notas y lector de Markdown (antes cada una tenía la suya).
  - Tampoco se movió a Configuración el resto de los controles del editor
    (tamaño, ancho, espaciado): se quedan donde están.
  La ventana nativa también acompaña: el mismo effect llama `setTheme()` de la
  ventana de Tauri (`null` para 'system') con
  `core:window:allow-set-theme` en las capabilities — sin eso, la barra de
  título quedaba clara con el tema forzado a Oscuro. Verificado a mano por el
  autor el 2026-09-04: tema, fuentes y barra de título, incluido que
  `settings.json` los conserva al reiniciar.

## Gramática, ortografía y tesauro

> **Relevamiento del 2026-08-20.** Todo lo de abajo está medido contra el
> container local (LT 6.8 OSS, `premium: false`) y contra
> [`sbosio/rla-es`](https://github.com/sbosio/rla-es) clonado, no supuesto.
> Punto de partida: el español de LT es flaco y queríamos saber cuánto y por qué.
>
> ⚠️ **CORREGIDO el 2026-08-20 (segunda vuelta).** La tabla original de esta
> cabecera decía "es: 296 reglas / en: 1.772" y **estaba mal por un error de
> método**: se contó con `grep -c "<rule "`, que cuenta **líneas** y solo
> matchea `<rule` seguido de atributos. Las reglas anidadas dentro de un
> `<rulegroup>` se escriben `<rule>` pelado y heredan el `id` del grupo — el
> grep no las ve, y son la mayoría. Conteo real por **ocurrencias**, contra
> los jars `language-es`/`language-en` 6.6 de Maven Central:
>
> | | `grammar.xml` | `style.xml` | **total reglas** | rulegroups |
> |---|---|---|---|---|
> | en | **5.551** | 547 | **6.098** | 1.041 |
> | es | **1.636** | 31 | **1.667** | 282 |
>
> El español de LT **no son 296 reglas, son 1.667**. La brecha real es 3,7×,
> no 6×. El motor es el mismo; lo que falta son reglas escritas, pero muchas
> menos de las que creíamos.
>
> **Segunda corrección: hay DOS archivos de "confusión" y se confundieron.**
> - `resource/es/confusion_sets.txt` — **5 pares**, lo consume la rule de
>   n-gramas (`SpanishConfusionProbabilityRule`), necesita el modelo de 3,1 GB.
>   El conteo viejo de 5 vs 782 era correcto **para este archivo**.
> - `rules/es/confusion_pairs.txt` — **1.036 pares**, formato
>   `forma;forma_con_tilde;POSTAG` (`acido;ácido;AQ0MS0`), lo consume
>   `ConfusionCheckFilter` con el POS tagger y **NO necesita n-gramas**:
>   funciona hoy tal cual. Se usa en 57 reglas de `grammar.xml`.
>   **`en/` no tiene este archivo** — el inglés resuelve confundibles solo por
>   n-gramas, que no corremos. O sea que en nuestro setup el español tiene
>   **mejor** cobertura de tildes/confundibles que el inglés, al revés de lo
>   que decía este relevamiento.
>
> **Pero ojo — lo importante viene abajo.** Las reglas existen y no disparan:
> ver el item "Qué da LT realmente sobre la prosa del autor", que las midió
> contra `/home/tatoh/novelas` y encontró que de las 1.667 reglas de español
> dispararon **21**, y de las 6.098 de inglés dispararon **3**.

- [x] **Detector de repeticiones cercanas** (es + en). El agujero más claro que
  encontramos, y no es del español: LT detecta **solo duplicados literales
  pegados** (`la nave nave`, `SPANISH_WORD_REPEAT_RULE` /
  `ENGLISH_WORD_REPEAT_RULE`) y nada más. Verificado que estos tres casos no
  dan ni una marca, **ni en `es-AR` ni en `en-US`, ni en `default` ni en
  `picky`**:
  ```
  "Era una nave oscura, oscura como el vacío."
  "El capitán oscuro miró el pasillo oscuro del casco oscuro."
  "Caminó lentamente y habló lentamente y respiró lentamente."
  ```
  **Va en TS, no en Rust** — la pregunta se hizo y se midió. El escaneo es una
  ventana deslizante sobre el texto plano que ya extrae `extractPlainText`:
  59 KB / 10.008 palabras tardan **1,07 ms** en Node (media de 50 corridas).
  Cruzar el bridge a Rust cuesta más que eso: hay que serializar el capítulo
  entero de ida y los hits de vuelta. La regla de división del CLAUDE.md manda
  a Rust lo que toca **muchos archivos**; esto toca el capítulo activo, que ya
  está en memoria del frontend. Precedente exacto en el repo: el validador RAE
  (`validator.ts`) hace esta misma clase de trabajo en TS.
  **Cuándo sí sería Rust**: "buscar repeticiones en el libro/saga entero" —
  eso es N archivos y va al lado de `search.rs`.
  Diseño: normalizar (minúsculas + sin diacríticos), descartar stopwords por
  idioma, marcar la palabra de contenido que reaparece dentro de una ventana
  de N palabras. Sin POS tagger — parece que hiciera falta para distinguir
  "adjetivo repetido", pero la señal útil es la palabra de contenido, así que
  no hay que sumar FreeLing ni spaCy ni ninguna dependencia. Queda función
  pura → smoke runner propio, patrón de `scripts/run-rae-smoke.mjs`.
  **Ojo con la calibración**: el prototipo con una stopword list mínima y
  ventana de 40 palabras tiró **6.095 hits** en 59 KB. Inusable así. La
  ventana, el largo mínimo de palabra y la stopword list son perillas que hay
  que tunear contra prosa real antes de mostrarle esto a alguien; el número
  crudo no es un bug del algoritmo, es que sin calibrar marca todo.

  **Implementado (`feat/detector-repeticiones`)**, spec en
  `docs/superpowers/specs/2026-08-20-detector-repeticiones-design.md`.
  `src/app/repeticiones/detector.ts` es la función pura (32 casos en
  `scripts/run-repeticiones-smoke.mjs`), `repeticiones-extension.ts` +
  `repeticiones-popover.ts` la mitad con DOM. Calibrado contra dos libros
  enteros de `Novelas/` con `scripts/densidad-repeticiones.mjs`: **0,8 hits por
  1.000 palabras en español y 0,7 en inglés**, contra ~8 con `minApariciones`
  en 2. Seis capas de exclusión (stopwords, largo mínimo, verbos dicendi,
  diccionario per-saga, capitalizado mid-oración y repetición deliberada), y
  las tres formas deliberadas — construcción hecha, frase/locución repetida,
  anáfora — tienen un flag cada una en el modal de gramática.
  **Verificado a mano por el autor el 2026-08-20** — anda. De ahí salieron tres
  arreglos: las marcas quedaban corridas tras la primera edición de cada
  capítulo (las tres flags `skipNext*Remap` se prendían juntas pero el `return`
  del bloque de gramática en `onTransaction` cortaba antes de consumir las de
  RAE y repeticiones, así que sobrevivían hasta el primer tecleo real y ahí
  suprimían el remap Y el recheck — bug latente en RAE desde antes), el popover
  decía "N veces en el párrafo" cuando la cuenta es dentro de la ventana, y
  "25 palabras antes" se leía como "apareció 25 veces". Sumado en la misma
  vuelta: al abrir el popover se resalta el grupo entero, que es lo que hace
  entendible la sugerencia.

  **Sinónimos en el popover de repetición** (pedido del autor durante la
  verificación). **Implementado sin cerrar** en la misma tanda del tesauro
  embebido de más abajo: `nave` repetida y el popover ofreciendo `bajel`,
  `buque`, `navío` de `th_es_v2.dat` vía chips clickeables. El reemplazo
  hereda las marcas del span como hace `applyRaeFix` — se sacó el bloque
  duplicado a un método compartido, `marcasParaReemplazo` en `editor.ts`,
  porque los dos call sites (RAE y repeticiones) hacían el mismo
  `marksAcross`/`marks()` copiado. Y la mitad inglesa del detector **sí**
  tiene sugerencias — la afirmación de acá arriba de que rla-es es solo
  español estaba mal (ver el item del tesauro): el popover en inglés muestra
  los chips agrupados por categoría (`sustantivo`/`verbo`). El "degradar a
  sin sugerencias" queda igual pero por lo que realmente pasa — huecos
  léxicos y conjugaciones sin lematizar, no falta de datos en inglés. Falta
  la verificación a mano del autor: `pnpm tauri dev`, click en un chip sobre
  una repetición, reemplazar una palabra pegada al borde de una cursiva y
  otra adentro (que no se pierda la itálica en ningún caso), y un capítulo en
  inglés para ver la agrupación por categoría.

- **Dashboard de estilo por novela** (idea del autor, no para ahora). Lo que hoy
  se ve capítulo por capítulo — repeticiones, violaciones RAE, matches de
  gramática, palabras por capítulo — agregado a nivel libro o saga: densidades,
  qué capítulos están peor, qué formas se repiten en todo el libro. Es el caso
  que sí justifica Rust y no TS: son N archivos, así que va al lado de
  `search.rs` (el detector de repeticiones vive en TS justamente porque toca
  solo el capítulo activo, que ya está en memoria del frontend). Ojo con el
  alcance: un dashboard que solo muestra números es un juguete; lo útil es que
  cada fila lleve al capítulo y al offset, o sea que necesita las mismas
  posiciones que ya calculan `validator.ts` y `detector.ts`, pero corridas
  server-side.

- [x] **Tesauro de sinónimos embebido** (español **e inglés**, verificado a
  mano por el autor el 2026-09-02). rla-es trae
  `sinonimos/palabras/th_es_v2.dat` — **21.846 entradas**, 2,8 MB, formato
  MyThes (`palabra|N` y N líneas `-|sinónimo|sinónimo|…`), más un `.idx` de
  361 KB con offsets que **no se bundlea** (ver más abajo). Encoding
  **ISO-8859-1**, no UTF-8 — se decodifica a mano en Rust (latin-1 mapea 1:1
  a los primeros 256 codepoints, cero crates de encoding). Ejemplo real:
  ```
  nave|8
  -|bajel|buque|barco|navío|nao|embarcación|galera|carabela
  ```
  Esto es lo que LT **no** tiene: su API no expone ningún endpoint de
  sinónimos (ver el item de capacidades más abajo). Parsear MyThes es trivial
  y acá sí conviene Rust: son ~14 MB de datos entre los dos idiomas que no
  queremos mandar por el bridge ni tener en el heap del webview — se lee el
  `.dat` entero una vez por idioma a un `String` en el heap de Rust (cacheado
  en un `OnceLock`) y por el bridge cruza solo la entrada consultada. Sin
  `.idx` ni `seek`: una pasada entera al arrancar no se nota ni con los 14 MB
  juntos.

  **Corrección al relevamiento de acá arriba**: la línea vieja decía "sin
  equivalente en inglés en este repo: rla-es es solo español, para la mitad
  inglesa habría que buscar otro MyThes aparte". **Eso es falso** — se
  encontró `th_en_US_v2.dat` en la extensión `dict-en` de LibreOffice
  (`/Applications/LibreOffice.app/Contents/Resources/extensions/`), que sale
  de WordNet 2.1 (Princeton) y no de rla-es. Crudo: 145.866 entradas, 18,5
  MB. El inglés trae categoría gramatical en todas sus acepciones (el español
  también la trae, pero solo en ~810 de las suyas, con las abreviaturas de la
  RAE: `(m.)`, `(adj.)`, `(prnl.)`, …) y trae hiperónimos etiquetados
  (`(generic term)`) que WordNet no separa de los sinónimos reales:
  ```
  ship|6
  (noun)|vessel (generic term)|watercraft (generic term)
  (verb)|transport|send|move (generic term)|displace (generic term)
  ```
  `scripts/podar-tesauro-en.mjs` pela la etiqueta y conserva la palabra
  (`vessel (generic term)` → `vessel`, reordenado al final de su acepción,
  detrás de los sinónimos reales) y descarta enteros `(related term)`,
  `(similar term)` y `(antonym)`. **Ojo con la primera versión del script**:
  tirar el `(generic term)` entero en vez de pelar la etiqueta borraba 28.000
  entradas — entre ellas la acepción de sustantivo de `ship`, que se quedaba
  sin ningún sinónimo. Con el fix, `th_en_us.dat` queda en **140.835
  entradas, 11,2 MB** (subió de 6,3 MB con el filtro viejo — el costo de no
  perder esas 28.000 entradas). El español se bundlea **crudo, sin tocar un
  byte** (obligación de la LGPL); el inglés se regenera corriendo el script
  sobre la fuente de LibreOffice, nunca se toca el `.dat` a mano.

  **Cobertura medida**, no supuesta — contra `Buenos Aires 2077` (90
  capítulos, 109 hits del detector de repeticiones con los defaults
  calibrados): de las formas que el detector **realmente marca**, 14 de 20
  tienen entrada en el tesauro (~70%). Con las normalizaciones de enclítico
  (`mirarlo` → `mirar`) y plural simple (`naves` → `nave`, re-pluralizando
  los sinónimos), sube a ~75-80%. El resto son conjugaciones (`eres`) y
  huecos léxicos puntuales (`rifle`, `moto`). **No se lematiza a propósito**:
  un lema sin re-conjugar da sugerencias que no concuerdan con la oración
  (`eres` → lema `ser` → ofrecer `existir` rompe la frase al insertarlo), y
  re-conjugar pide un conjugador de español propio — un subsistema entero
  para el último 20%.

  **Licencia**: el tesauro español tiene su propio `COPYING` en **LGPL 2.1**
  (el resto de rla-es es triple GPL3/LGPL3/MPL1.1). El inglés es WordNet
  2.1, licencia más permisiva que la LGPL (basta el aviso de copyright y el
  disclaimer, permite modificar). tWriter es MIT — bundlear LGPL se puede
  shipeando el `.dat` sin modificar con su licencia al lado, y el inglés
  modificado con `WordNet_license.txt` más una nota de qué se modificó.
  Detalle completo en `src-tauri/resources/tesauro/LICENCIAS.md`. Para el
  resto de rla-es (guionado, reglas de diálogos) conviene seguir eligiendo
  **MPL 1.1**, que es la vía limpia para distribuir en un producto MIT (la
  misma que usa LibreOffice).

  **Implementado sin cerrar** (`feat/tesauro-embebido`), spec en
  `docs/superpowers/specs/2026-08-20-tesauro-design.md`. Backend en
  `src-tauri/src/tesauro.rs` (parser MyThes, normalizaciones, caché
  `OnceLock` por idioma, comando `tesauro_lookup`, 19 tests inline).
  Frontend en `src/app/core/tesauro-service.ts` (caché de 50 consultas) y los
  chips del popover de repeticiones (ver el sub-item de más arriba), más
  dos formas de pedirlo sin estar sobre una repetición: `⌘⇧Y` (`Ctrl+Shift+Y`
  fuera de Mac) sobre la palabra del cursor, y una entrada "Sinónimos de «X»" en
  el menú contextual, que resuelve la palabra por las **coordenadas del click**
  porque WebKit no mueve el caret al hacer click derecho
  (`src/app/editor/palabra-en.ts` + `scripts/run-tesauro-smoke.mjs`, 10 casos).
  La `S` de `⌘⇧S` quedó descartada: es "Guardar como" en casi toda app de
  escritorio.

  **Veredicto del autor (2026-09-02): anda bien, y no se toca más.** La
  función hace lo que promete; lo flojo es el material de base — los `.dat`
  de MyThes dan sinónimos pobres para prosa. Mejorarlo pediría otra fuente de
  datos, y el autor decidió que no vale el tiempo. O sea que "malo" acá es la
  calidad de los sinónimos, no la implementación: no abrir de nuevo este item
  para refactorizar el parser ni la UI.

- **Guionado para el EPUB**. rla-es trae `separacion/hyph_es.dic`, **6.207
  patrones** (Javier Bezos / CervanTeX). Sirve para justificado con separación
  en sílabas en el export. Nada que ver con el corrector, pero sale del mismo
  repo y es acotado. Cruza con el item de tipografía del EPUB.

- [x] **Escribir reglas propias de LT en XML — SPIKE CERRADO, FUNCIONA**
  (2026-08-20). Era "el camino más realista si algún día se encara el español
  en serio", y resultó ser **el único que cumple todas las restricciones del
  autor**: open source, sin API, sin pagar, sin mantener un build ajeno, y le
  vuelve por el motor que ya corre.

  **Verificado de punta a punta**, no supuesto: se insertó una regla propia en
  `org/languagetool/rules/es/grammar.xml`, se reinició el server y **disparó**,
  con span correcto, sugerencia y capitalización preservada:

  ```xml
  <rulegroup id="TWRITER_TU_VOSEO" name="«tú» con verbo voseante">
      <rule>
          <pattern>
              <token regexp="yes" case_sensitive="no">tú</token>
              <token regexp="yes">sos|tenés|sabés|querés|podés|hacés|decís|venís|vas|estás|sentís|vivís</token>
          </pattern>
          <message>Con «tú» el verbo va en tuteo. Si el personaje vosea, escribí <suggestion>vos \2</suggestion>.</message>
          <short>Mezcla de tuteo y voseo</short>
          <example correction="vos tenés"><marker>Tú tenés</marker> que venir.</example>
          <example>Vos tenés que venir.</example>
      </rule>
  </rulegroup>
  ```

  Resultado medido: `Tú tenés que venir.` → marca `Tú tenés`, sugiere
  `Vos tenés`. `Y tú sabés por qué.` → marca `tú sabés`, sugiere `vos sabés`
  (el backreference `\2` y la caja se resuelven solos). Y **cero falsos
  positivos**: `Vos tenés que venir.` y `Tú tienes que venir.` no marcan nada.

  **Cómo llegan las reglas al motor — no hay mecanismo aditivo.** Se revisó
  `HTTPServer --help`: la única opción parecida es `rulesFile`, que es
  **configuración** de reglas (activar/desactivar), no reglas nuevas. Así que
  el camino es **parchear `grammar.xml`**, que es un archivo suelto de 2,1 MB
  en el filesystem (no está dentro de un jar), tanto en el container como en
  una distribución local. Consecuencia: el parche hay que re-mergearlo en cada
  upgrade de LT — pero es `git apply` de un patch chico contra un archivo de
  texto, dos veces al año, no comparable con mantener un build de Maven.
  Conviene guardar el patch versionado en este repo.

  **El camino durable es aportar upstream**: una regla mergeada en LT viaja con
  el motor y no necesita parche nunca más. Ver el item de "Aportar upstream" —
  LT es el repo que **sí** nos vuelve, porque es el motor que corremos.

- **Dónde falla realmente el español de LT** (medido el 2026-08-20, contra
  6.6). El conteo de reglas engañaba: los errores **clásicos** del español
  están todos cubiertos. Verificado que LT marca `Hubieron muchos problemas`
  (`ID_HUBO_HUBIERON`), `Vamos haber que pasa` (`HABER_AVER`), `Me di cuenta
  que` (`QUEISMO`), `sepa mas que ella` (`MAS`), `Detrás mío` (`DETRAS_PX`).
  No hay que escribir esas.

  Los agujeros reales son **rioplatenses y de documento**:
  - **`tú` + verbo voseante no se marca.** LT sí marca el cruce inverso —
    `Vos tienes razón` da `AGREEMENT_PRONOUNSUBJECT_VERB` — pero `Tú tenés que
    venir` daba **0 matches** antes de la regla de arriba. En prosa rioplatense
    el cruce inverso es el error que de verdad aparece.
  - **Consistencia de voseo a nivel documento: LT no puede, por diseño.**
    `Ven acá y dime la verdad.` es correcto como oración aislada y LT no marca
    nada — pero si el resto del capítulo es voseo, es una inconsistencia de voz
    del personaje. LT trabaja **por oración**; esto es una propiedad del
    documento. Va en TS, al lado de `detector.ts` (que es document-scoped por
    la misma razón). Es exactamente el problema de dialecto del autor, y no lo
    va a resolver nadie más.

  **División que sale de esto**: reglas de oración → XML de LT, contribuidas
  upstream. Chequeos de documento → TS propio. No compiten, se suman.

- **Consistencia de voseo a nivel documento — DESCARTADO por el autor**
  (2026-08-20), y con razón. La idea era marcar cuando un capítulo mezcla
  voseo y tuteo. **No sirve: la mezcla entre personajes es caracterización
  deliberada.** En las novelas cyberpunk los traductores del mundo le dan voz
  neutra y formal a los hispanohablantes salvo que hablen en español, así que
  un japonés habla neutro contra un argentino que vosea y putea cada dos
  palabras. En fantasía, un personaje de otro lado habla distinto justamente
  para marcar la diferencia, porque nadie va a leer diálogos en cuatro
  idiomas. Una regla de documento marcaría eso en cada escena.

  **El criterio que salió de esto, y que vale para cualquier regla futura:
  solo marcar lo que NUNCA puede ser una decisión deliberada.** Dentro de una
  oración hay un solo hablante, así que mezclar ahí es un desliz — y es donde
  el autor no chequea porque está en proceso creativo. Entre personajes es
  estilo. Toda regla nueva tiene que pasar ese filtro antes de escribirse.

- **Las reglas rioplatenses propias: escritas, probadas y CON CERO HITS en la
  obra real** (2026-08-20). Aplicando el criterio de arriba se escribieron
  tres reglas intra-oración más la de `tú` + voseo, todas verificadas contra
  LT corriendo: `TWRITER_TU_VOSEO`, `TWRITER_IMPERATIVO_MIXTO`
  (imperativo voseante + tuteante en la misma oración),
  `TWRITER_VOS_TONICO_TI` (`vos` con `ti`/`contigo`) y
  `TWRITER_VOS_TU_MISMA_ORACION`. 6/6 positivos sintéticos, 7/7 negativos.

  **Resultado sobre 260 capítulos y 384.109 palabras reales: 0 hits.**
  El autor no comete esos errores. Las reglas son correctas; el problema que
  resuelven no existe en esta obra. Pueden valer como aporte upstream para
  otros escritores rioplatenses, no para este repo.

  **Reescritas para upstream y mandadas — y con una corrección al párrafo de
  arriba** (2026-08-21). Al reescribirlas contra el código de LT (no contra el
  recuerdo) resultó que **dos de las cuatro ya tenían dónde vivir** y que el
  "0 hits" era del enfoque viejo, no del problema:

  - **`tú` + verbo voseante → PR [#12132](https://github.com/languagetool-org/languagetool/pull/12132)**,
    y no es regla nueva: `AGREEMENT_PRONOUNSUBJECT_VERB` (`grammar.xml:24789`)
    ya tiene reglas dedicadas para `tú` y para `vos` — es la que marca
    `Vos tienes razón`. La de `tú` matchea `V.[^M].[13]..|V.[^M].2P.`, o sea
    persona 1, 3 o 2ª del plural, y las formas voseantes son **persona 2 número
    `V`** (`tenés` = `VMIP2V0`), así que se caían del alternador. El aporte es
    **un token**: sumar `2[PV]`. De yapa, el mecanismo de sugerencia que ya
    estaba (`postag_replace="$12S."`) da la forma tuteante sola:
    `Tú tenés` → `tienes`, `Tú sos` → `eres`.
  - **La ambigüedad que nos había quemado la calibración la resuelve el tagger,
    gratis.** `estás` y `vas` son idénticas en tuteo, y LT las etiqueta
    `V...2S.`, que ya estaba en la `<exception>` de la regla — así que
    `Tú estás cansado` no marca sin hacer nada. Los imperativos (`Tú marchá`)
    los tapa un antipattern que también estaba. Moraleja para la próxima:
    **matchear por postag, nunca por lista de palabras**.
  - **Imperativo mixto + `vos`/`ti` + `vos`/`contigo` → PR
    [#12133](https://github.com/languagetool-org/languagetool/pull/12133)**,
    rulegroup nuevo `MEZCLA_TUTEO_VOSEO`, en la categoría `GRAMMAR` **a
    propósito**: `VOSEO` vive en `LANGUAGE_VARIANTS` (`type="locale-violation"`),
    que es justo la que un rioplatense apaga. La regla de imperativos matchea
    por postag con exclusión de lecturas de sustantivo/preposición/adjetivo/
    adverbio/determinante/pronombre/indicativo/subjuntivo, y con eso `para`,
    `mira`, `toma` y `ven` — los cuatro falsos positivos de la calibración
    vieja — quedan afuera solos.
  - **Y acá el corpus dijo otra cosa que la vez pasada: hay 1 hit real.**
    `—Apretá… al distribuidor para que entregue; si no, sácale el trabajo.`
    Voseo y tuteo en la misma oración, mismo hablante: el error que la regla
    promete. El scan de las 783.918 palabras da **exactamente ese hit y nada
    más**. O sea que el enfoque por postag encuentra lo que la lista de
    palabras no veía, y sin ruido.
  - **`dar` y `ser` hay que excluirlos**: su imperativo es idéntico en los dos
    paradigmas (`dale`, `sé`), así que la primera versión marcaba
    `Tomá esto y dale una de estas` con **sugerencia vacía**. Eso es el mismo
    error de fondo que `estás`/`vas`, pero del lado del verbo irregular.
  - **`vos` + `tú` en la misma oración: descartada, no se manda.** No pasa el
    filtro del criterio de más arriba. En fantasía el `vos` reverencial
    (`Vos, mi señor`) es deliberado y convive con un `tú` para otro personaje
    en la misma oración, y cuando además hay verbo voseante el caso ya lo
    cubren las reglas de `tú`/`vos` del grupo de concordancia.

  **Ronda de review del PR #12133** (CodeRabbit, 2026-08-21). Un solo hallazgo,
  y era **medio válido**: con `skip="-1"` la regla de imperativos cruzaba un
  `tú` explícito, que marca **cambio de interlocutor** — dos personas, cada una
  en su paradigma. `Vení conmigo y tú cállate.` marcaba y no debía. Arreglado
  con `<exception scope="next">tú</exception>` (barrera de skip, la forma que
  documenta LT para esto). **Pero el ejemplo que proponía el bot no reproducía
  nada**: `Vos vení conmigo y tú vete con Ana.` da 0 matches con o sin la
  barrera, porque `vete` no matchea la regla nunca (lo tapan las exclusiones de
  postag). Se reemplazó por uno que sí la ejercita. Moraleja que vale para
  cualquier review, humana o de bot: **el hallazgo se reproduce antes de
  aceptarlo, y el ejemplo se verifica aparte del diagnóstico** — acá el
  diagnóstico era bueno y el ejemplo malo.

  Herramienta y patches: `scripts/scan-regla-lt.mjs`, `docs/lt-patches/`.

  **Ojo con la calibración — la primera versión dio 11 hits y eran TODOS
  falsos positivos**, por dos errores que conviene no repetir:
  - `estás`, `vas`, `ves` **no son formas de voseo exclusivas**: son idénticas
    en tuteo (`tú estás` es correcto). Marcaban diálogo bien escrito.
  - `para`, `mira`, `toma`, `deja`, `ven` están en la lista de imperativos
    tuteantes pero son **preposición / sustantivo / tercera persona** casi
    siempre. `Dale esto para que se despierte` disparaba por el `para`.

  Toda lista de formas verbales para una regla de voseo tiene que contener
  **solo formas inequívocas**, y hay que correrla sobre el corpus entero antes
  de creerle.

- **Coloquialismos: el corpus dice que no hay nada que arreglar**
  (2026-08-20). El autor propuso `atrás mío` vs `detrás de mí` como ejemplo de
  lo que se le escapa. Medido sobre los 260 capítulos: la familia entera
  (`atrás/arriba/cerca/abajo/encima… + mío/tuyo/suyo/nuestro`) aparece **12
  veces**, y **11 están en diálogo** — `¿Me caí arriba tuyo?`, `quiero estar
  cerca tuyo`, `Tengo un gil atrás mío` — donde son correctas, porque así
  habla la gente. La única en narración era un falso positivo del regex
  (`que fuera suya`: subjuntivo de *ser*, no el adverbio). **Cero errores
  reales.**

  De paso, un hueco chico y contribuible: la regla `DETRAS_PX` de LT cubre
  `detrás mío`, `encima suyo`, `cerca mío` y `delante nuestro`, pero **le
  faltan `atrás mío` y `adelante tuyo`** — justo las dos más rioplatenses. Es
  agregar tres palabras a la lista de una regla que ya existe: el aporte
  upstream más barato que encontramos.

  **PR mandado: [languagetool#12131](https://github.com/languagetool-org/languagetool/pull/12131)**
  (2026-08-21). Fork `T4toh/languagetool`,
  clone en `~/Repos/Personal/languagetool`, rama `es-adverbio-lugar-atras-adelante`,
  patch versionado en `docs/lt-patches/0001-es-DETRAS_PX-adverbio-lugar.patch`.
  Resultó **una sola línea**: las 5 sub-reglas del grupo no listan los adverbios,
  usan la entidad `adverbio_lugar` de `resource/es/entities.ent:20`
  (`detrás|delante|debajo|encima|cerca`), y esa entidad **no se usa en ninguna
  otra regla** (verificado, 5 usos, todos en `DETRAS_PX`). Quedó
  `detrás|atrás|delante|adelante|debajo|abajo|encima|arriba|cerca` — se sumaron
  `arriba` y `abajo` además de los dos anotados, misma familia y mismo riesgo.
  Más un `<example>` por adverbio nuevo.
  **Verificado**: `mvn -pl languagetool-language-modules/es -am -Dtest=SpanishPatternRuleTest test`
  pasa (1.670 reglas, 0 fallas — valida el XSD y los examples), y con la entidad
  parcheada en el container los 4 positivos marcan con la sugerencia correcta
  (`atrás mío` → `atrás de mí`) y 6 negativos de riesgo no marcan
  (`Siguió adelante con el plan`, `De arriba abajo`, `Se echó para atrás`).
  **Falsos positivos sobre la obra real: cero.** El scan del corpus entero
  (578 capítulos, 783.918 palabras) pasa de **2 hits a 11**, y los 9 nuevos son
  todos la construcción de verdad, todos en diálogo (`Tengo un gil atrás mío`,
  `terminó arriba tuyo`). Herramienta reusable para la próxima regla:
  `scripts/scan-regla-lt.mjs <RULE_ID> [corpus] [idioma]`, que activa una sola
  regla vía `enabledOnly` y lista los hits con contexto.
  El container quedó **revertido** a upstream — el comando para re-aplicar el
  parche está en `docs/lt-patches/README.md`.

- **Bug de LT 6.8 encontrado de rebote: `500` esporádico en `es-AR`**
  (2026-08-21). Escaneando el corpus, 2 de 578 capítulos devuelven
  `HTTP 500` y el capítulo entero se queda **sin chequear**. No es el corpus ni
  la regla: es un `NullPointerException` adentro del desambiguador de LT,
  `DisambiguationPatternRuleReplacer.keepByDisambig` → `PatternRuleMatcher.match`,
  reportado como `Error analyzing sentence: ... with rule VerbAdjective_antipattern:5`.
  Es **flaky**: la misma oración aislada devuelve `200`, y con `language=es`
  (sin variante) tampoco explota — huele a thread-safety en el pipeline del
  server, no a un patrón puntual. Dos cosas que salen de esto: (a) para aportar
  upstream hay que reproducirlo determinísticamente (pegarle concurrente al
  mismo texto), (b) del lado nuestro el aviso es pobre: `check()`
  guarda el mensaje en `grammar.lastError` y `editor.html:377` lo pinta como
  indicador crudo en el footer (`LanguageTool 500 Internal Server Error: …`),
  o sea jargon de HTTP en un lugar fácil de no ver, mientras el capítulo queda
  **entero sin marcas** porque el `check` tira. Merece el trato accionable del
  CLAUDE.md: decir que el chequeo de *este* capítulo falló y ofrecer reintentar,
  en vez de tirar el status HTTP a la barra de estado.

- **Filtro de marcas consciente de diálogo — MEDIDO Y DESCARTADO**
  (2026-08-20). La idea era prometedora: tWriter sabe qué párrafo es diálogo
  (el validador RAE ya parsea esa estructura) y LT no, así que podría suprimir
  las categorías legítimamente coloquiales dentro de diálogo. Medido sobre 60
  capítulos (56.676 palabras de diálogo, 41.556 de narración):

  | | diálogo | narración |
  |---|---|---|
  | marcas totales | 2.076 (36,6/1.000) | 881 (21,2/1.000) |
  | Posible error ortográfico | 2.020 | 854 |
  | Diacríticos (tilde) | 23 | 3 |
  | Puntuación | 5 | 0 |
  | Confusiones | 3 | 3 |

  El 70% de las marcas cae en diálogo, pero **el 97% de todas son del
  corrector ortográfico, y un typo en diálogo sigue siendo un typo**: no se
  puede suprimir. Las categorías donde el filtro ayudaría suman ~30 marcas en
  98.000 palabras. No paga.

- **CONCLUSIÓN de la jornada del 2026-08-20 sobre gramática.** Se agotaron los
  caminos y todos miden cerca de cero **para esta obra**:
  - LT encontró **3 typos reales en 53.633 palabras**; de sus 1.667 reglas de
    español dispararon 21, varias con falsos positivos sobre nombres propios.
  - Reglas rioplatenses propias: **0 hits en 384.109 palabras**.
  - Coloquialismos: **0 errores reales** en 260 capítulos.
  - Filtro por diálogo: ~30 marcas de 2.957.
  - Cambiar de motor: no existe alternativa para español.
  - Sidecar / bundle: resuelve la entrega, no la calidad, y con costo alto.
  - LLM: descartado por el autor — quiere open source, y además planchan el
    diálogo y confunden habla coloquial con prosa mal escrita.

  **El subsistema de gramática está terminado.** No le falta trabajo: le falta
  problema. El autor escribe limpio y el 97% de lo que LT marca son nombres
  inventados, que el diccionario per-saga ya resuelve. Lo que **sí** tuvo
  señal medida este día fue el **detector de repeticiones** (0,8 hits por
  1.000 palabras en español después de calibrar, verificado a mano por el
  autor). Cualquier esfuerzo futuro rinde más ahí o en otra parte de la app,
  no en gramática.

- **Fuentes normativas del español: no hay corpus libre.** La *Nueva gramática
  de la lengua española*, la *Ortografía* y el DPD son de la RAE, con
  copyright y sin formato máquina. No existe un "manual de la lengua española"
  parseable para usar de base. Lo que sí hay como sustrato son **FreeLing**
  (morfología + parsing de dependencias, UPC, open source) y los modelos de
  spaCy en español — pero ojo: para el detector de repeticiones **no hacen
  falta**, y son la clase de dependencia que conviene no sumar sin un caso que
  la exija.

- **Aportar upstream — cuál de los dos repos conviene.** Los dos aceptan
  contribuciones, pero solo uno le vuelve a tWriter:
  - **LanguageTool** es el que **sí** nos vuelve, porque es el motor que
    corremos. El agujero está identificado y es chico de describir:
    `es/confusion_sets.txt` tiene **5 pares** (`casa;caza`, `ciento;siento`,
    `cima;sima`, `honda;onda`, `sumo;zumo` — todos seseo, inútiles para un
    autor argentino) contra 782 del inglés. Sumar pares de confusión del
    español rioplatense (`haber`/`a ver`, `hecho`/`echo`, `sino`/`si no`) es
    una contribución acotada, medible y que arregla justo lo que medimos que
    falta. Ojo: los pares necesitan datos de n-gramas para evaluarse, y los
    n-gramas de español ya se probaron y descartaron para nuestro uso (ver
    item más abajo) — hay que entender esa interacción antes de prometer algo.
  - **rla-es** (`sbosio/rla-es`) — 258 stars, 53 forks, 21 issues abiertos,
    PR #355 mergeado, último push 2025-11-26 (semi-dormido, pero con historia
    real de contribuciones). El `CONTRIBUTING.md` invita explícitamente a
    mejorar las **variantes regionales** y lista es_AR entre 23 variantes; el
    detalle está en el wiki del proyecto. Hueco concreto: los regionalismos
    es_AR (`ortografia/palabras/noRAE/l10n/es_AR/`) son **364 líneas en
    total**. Verificado que tiene `laburo`, `quilombo` y `boludo`, y que le
    faltan `bondi`, `pibe` y `hagás`. Un autor argentino es exactamente quien
    puede llenar eso.
    **Pero que quede claro**: mejorar rla-es **no mejora tWriter**, porque el
    speller de LT no usa rla-es — usa su propio `es-ES.dict` Morfologik (ver
    item de abajo). Es una contribución al mundo, no a nuestro corrector. Vale
    hacerla por eso, no esperando que vuelva.

- **Por qué NO cambiar el speller de español** (evaluado y descartado el
  2026-08-20, para no volver a discutirlo). La hipótesis era que los
  diccionarios de LibreOffice/rla-es le ganaran a LT en español. Medido: no.
  - El speller de LT ES **no es hunspell**: es `es-ES.dict`, un FSA Morfologik
    de 2,6 MB (`libs/spanish-pos-dict.jar`) con `frequency-included=true` y
    reglas de sugerencia afinadas para español — equivalencias `b v`, `y i`,
    `g j` y pares de reemplazo para seseo (`ci si`, `ce se`, `ll y`, `güe hue`).
  - **`es-AR` ya resuelve el voseo.** Sobre 12 oraciones argentinas:
    `language=es` y `es-ES` dan **8 falsos positivos** (marcan `vení`, `mirá`,
    `andate`, `fijate`, `cerrá`); **`es-AR` da 3** (`bondi`, `laburo`,
    `hagás`). Y ya estamos usando la variante correcta: `map_lang`
    (`grammar.rs:780`) mapea `es` → `variante_es`, default `es-AR`.
  - De esos 3 que quedan, rla-es solo cubriría `laburo`. Los otros dos ya los
    tapa el **diccionario per-saga** (`<saga>/diccionario.txt`, filtro de
    `TYPOS` en `editor.ts`, con `merge=union` en `.gitattributes` vía
    `git.rs:424`), que es el lugar correcto para lunfardo y nombres propios
    inventados.
  - Conclusión: un subsistema entero para caso y medio. No vale. El item de
    ortografía offline de abajo sigue en pie, pero por **disponibilidad**
    (seguir marcando typos con LT caído), nunca por precisión.

- **Qué da LT realmente sobre la prosa del autor** (medido el 2026-08-20,
  segunda vuelta). Es **el** número que faltaba: el relevamiento contaba
  reglas en el jar, no marcas sobre texto real. Muestra: 20 capítulos en
  español (**29.794 palabras**) + 20 en inglés (**23.839 palabras**),
  aleatorios con seed fija sobre `/home/tatoh/novelas`, contra LT 6.6 recortado
  (ver item del sidecar).

  | | ES default | ES picky | EN default | EN picky |
  |---|---|---|---|---|
  | matches totales | 962 | 977 | 578 | 601 |
  | **ortografía** (`MORFOLOGIK_*`) | **927 (96%)** | 927 | **575 (99,5%)** | 575 |
  | **todo lo demás** | **35** | 50 | **3** | 26 |
  | reglas distintas que dispararon | 22 | 27 | **4** | 16 |

  **De las 1.667 reglas de español dispararon 21. De las 6.098 de inglés, 3.**
  Las 21 del español:
  ```
  AGREEMENT_DET_NOUN 7 · MI_TILDE 4 · UPPERCASE_SENTENCE_START 3
  PRONOMBRE_SIN_VERBO 2 · COMMA_ADVERB 2 · ES_UNPAIRED_BRACKETS 2
  AGREEMENT_ADJ_NOUN · AGREEMENT_POSTPONED_ADJ · AGREEMENT_DET_GN
  AGREEMENT_DET_ADJ · AGREEMENT_DET_NOUN_EXCEPTIONS · LES_LAS
  COMMA_PERO · ANO · SE · DE_TILDE · EL_TILDE · ES_INITIAL_QUESTION_MARK
  SPANISH_WORD_REPEAT_RULE · ESPACIO_DESPUES_DE_PUNTO · ES_COMPOUNDS_KUNG_FU
  ```
  Y varias de esas son **falsos positivos sobre nombres propios inventados**:
  `AGREEMENT_DET_NOUN` marcando `La Jedi`, `los Tecas`, `Caballeros Esmeralda`.

  **Typos reales encontrados: 3 en 53.633 palabras** (`est`, `órtense` en
  español; `startport` por `starport` en inglés). Todo el resto de las 1.502
  marcas ortográficas son nombres propios inventados (`Yiri` 174, `Aedan` 72,
  `Bastien` 63, `Chispi` 61…), términos de worldbuilding (`arcanismo`,
  `holocron`, `biokinetic`, `holotool`, `starport`), lunfardo (`laburo`,
  `telo`, `gil`, `garcha`, `banquito`, `bionafta`, `shoppings`, `ventiluz`) y
  diálogo en francés dentro de Meridian (`Bonjour`, `Désolé`, `Oui`,
  `Précisément`, `je/ne/sais/pas`, `être`).

  **Y acá está el punto que reordena todo: eso NO es ruido, es la feature.**
  El diccionario per-saga (`<saga>/diccionario.txt`) existe justamente porque
  el diccionario del autor antes se quedaba en la PC donde escribía. Vive en
  el repo `Novelas/` con `merge=union` en `.gitattributes`, así que ahora
  viaja con las novelas. Medida su cobertura sobre la misma muestra
  (comparación case-insensitive, que es como filtra
  `saga-context-service.ts:25`):

  | | tapado por el diccionario | ruido efectivo en la app |
  |---|---|---|
  | ES | 606 de 927 (**65%**) | 321 hits = **10,8 / 1.000 palabras** |
  | EN | 537 de 575 (**93%**) | 38 hits = **1,6 / 1.000 palabras** |

  La asimetría no es del idioma: `Milky Way` tiene diccionario (265 entradas)
  y `1 - Meridian 2.0` también (161), pero **`2 - Buenos Aires 2077` y
  `Vieja República` no tienen ninguno**, y dos de las tres sagas de la muestra
  española son esas. Con diccionario, el mecanismo llega al 93%.

  **Hueco real encontrado** (chico pero cierto): el speller multipalabra de LT
  (`SpanishMultitokenSpeller` / `MultitokenSpellerFilter`, 17 reglas) devuelve
  matches de **frase**, no de palabra — se vieron `Alara sintió` y
  `Mes amies`. El filtro de `TYPOS` en `editor.ts` compara la palabra suelta
  contra el diccionario, así que estos no se pueden silenciar agregando una
  entrada. Son 2 hits en 30k palabras; anotado, no urgente.

  **Pérdida histórica de diccionario encontrada auditando esto** (2026-08-20).
  La saga `Buenos Aires 2077` tenía el campo legacy `diccionario` en
  `saga.json` con 2 palabras (`motoquero`, `Serafima`) y **se perdieron el
  2026-05-12** en el commit `16dc1c39` del repo `novelas`. El diff lo muestra
  claro: en la misma escritura cambiaron `dropcap`, `mostrar_numero_parte` y
  un override de tema — o sea un guardado de config por `set_saga_config` —
  y el array `diccionario` desapareció en ese round-trip. Causa: esa versión
  de `set_saga_config` serializaba la `SagaConfig` que venía del frontend sin
  preservar el campo, y el frontend no lo mandaba.
  **Ya está arreglado y no puede volver a pasar**: la migración a
  `diccionario.txt` entró el 2026-06-25 (`6aa9686` + `2cebf48`), seis semanas
  después de la pérdida, y hoy tanto `set_saga_config` como
  `get_saga_dictionary` absorben el campo legacy al `.txt` antes de escribir
  (`saga_config.rs:117-130` y `:205-220`). Verificado que las dos sagas que sí
  llegaron a migrar no perdieron nada: Meridian 142→161 palabras, Milky Way
  198→265, **0 perdidas en ambas**. `Vieja República` nunca tuvo diccionario
  (el autor escribió poco ahí).
  **Pendiente trivial**: restaurar esas 2 palabras al
  `2 - Buenos Aires 2077/diccionario.txt`, que hoy no existe.

  **Idea que sale de esto**: el diálogo en otro idioma (francés en Meridian)
  es una categoría distinta de un nombre propio — meter 15 palabras francesas
  al diccionario de la saga tapa el síntoma pero pierde el chequeo real de
  esas frases. Si algún día molesta, lo correcto es marcar el span como
  "otro idioma" y saltearlo, no engordar el diccionario.

- **LT embebido como sidecar — DESCARTADO por el autor (2026-08-21).** Medido y
  viable, sí, pero el costo de mantenerlo es el que mata: el sidecar no se
  puede armar sin **bajar el código de LT, Maven y toda su cadena de build** en
  CI, por cada uno de los cuatro targets, y después mantener ese pipeline vivo
  contra cada release de LT. Eso es más superficie que las ~700 líneas de
  Docker que iba a borrar. Lo intentado quedó en la rama
  `archivo/lt-sidecar-NO-MERGEAR` (no mergear, es referencia). Docker se queda.
  Lo que sigue son las mediciones, que valen igual si algún día LT publica un
  bundle armado.

  El relevamiento
  original listaba como alternativas offline `zspell` / Harper / LLM y **nunca
  consideró bundlear LT mismo**, que es la opción que cumple mejor el criterio
  del autor ("embebido o de fondo, no 'instalate un runtime'") porque el
  runtime viaja adentro. Probado de punta a punta en Linux x64 con LT 6.6
  standalone + `jlink`:

  | | |
  |---|---|
  | LT 6.6 completo (desempaquetado) | 391 MB |
  | **LT recortado a es+en** | **117 MB** |
  | **JRE `jlink` (19 módulos)** | **57 MB** |
  | **Total del sidecar** | **174 MB** |
  | Arranque en frío → server listo | **1,07 s** |
  | Primer check es-AR (carga reglas) | 1,2 s |
  | Checks siguientes | **27 ms** |
  | RSS | 661 MB con heap default (acotable con `-Xmx`) |

  Verificado que chequea de verdad en `es-AR` y `en-US` con el JRE mínimo, no
  solo que arranca. Los 19 módulos: `java.base,java.desktop,java.logging,
  java.management,java.naming,java.net.http,java.prefs,java.rmi,java.scripting,
  java.security.jgss,java.sql,java.transaction.xa,java.xml,java.xml.crypto,
  jdk.crypto.ec,jdk.unsupported,jdk.httpserver,java.instrument,jdk.zipfs`.

  **Tres trampas del recorte, para quien lo implemente:**
  1. **No se pueden borrar los `.class` de los otros idiomas.**
     `Languages.getAllLanguages()` los instancia **todos** al arrancar y
     explota con `NoClassDefFoundError: ArabicHunspellSpellerRule`. Borrar
     solo los **datos**: el reparto es 2,6 MB de clases contra 219 MB de
     datos, así que no se pierde nada. Trimear
     `META-INF/org/languagetool/language-module.properties` **no alcanza**.
  2. **Hay que restaurar `common_words.txt` de los 27 idiomas** (2,6 MB): el
     `LanguageIdentifier` los lee eager al construirse.
  3. **`grpc-netty-shaded`, `mybatis` y `lettuce` no se pueden borrar** aunque
     no se use nada premium — el arranque los toca
     (`NoClassDefFoundError: org/apache/ibatis/...`). Quedan ~21 MB de
     recorte posible ahí si alguien se pone; no vale la pena.

  Con eso `tauri.conf.json` lo trata igual que pandoc (`externalBin` por
  target). **Consecuencia querida (decisión del autor): si LT va adentro,
  Docker sale** — se borran las ~700 líneas de detección multi-runtime
  (Docker/Podman/Apple), pull, start y remedies de `grammar.rs`. No tiene
  sentido mantener dos caminos al mismo motor. **Se conserva un input de
  "URL de servidor LT"** en el modal, que si está seteado gana sobre el
  sidecar: cubre LT Premium y a quien ya tenga una imagen con n-gramas de
  inglés, sin una línea de lógica de containers.
  Pendiente si se encara: el sidecar es **por target** (`linux-x64`,
  `darwin-arm64`, `darwin-x64`, `win-x64`), así que 174 MB × N — conviene
  generarlo en CI y no commitearlo.

- **Alternativas de motor evaluadas y descartadas** (2026-08-20, para no
  volver a discutirlo):
  - **Harper** (`harper-core`, Automattic) — v2.4.0 jun-2026, activo, 10k
    stars, ~200 linters en Rust. **Sigue siendo solo inglés**, y el README
    dice explícitamente que primero hacen "truly amazing" el inglés antes de
    diversificar. Pero el clavo no es el idioma: son ~200 linters contra las
    6.098 reglas de LT en inglés, y **sobre la prosa real del autor LT tiró 3
    matches no ortográficos en 24k palabras** — no hay nada que Harper venga a
    reemplazar. Su único argumento era "así no shipeamos Java", y el español
    obliga a la JVM igual, así que sumarlo deja **dos motores para ahorrar
    cero**. Descartado.
  - **nlprule** — port en Rust de las reglas XML de LT, con soporte es/en/de.
    Suena ideal y es trampa: **última release 0.6.4 de abril 2021**, binarios
    derivados de **LT 5.2**, abandonado hace cinco años, y **sin corrector
    ortográfico** (solo reglas, no trae el FSA Morfologik). Cambiar un motor
    vivo por uno muerto y encima perder los typos. Descartado.
  - **Portar/forkear LT a Rust nosotros** — medido qué tan portable es
    `es/grammar.xml`: `postag_regexp` 3.085 usos, `regexp="yes"` 5.980,
    `<antipattern>` 2.086, `<exception>` 1.145, `<match>` 782 (síntesis de la
    corrección), `inflected=` 768, `skip=` 500, `<unify>` 109 (concordancia,
    lo más difícil), y **175 reglas con `<filter class=...>` que es Java y no
    es portable como dato**. Más `disambiguation.xml` (336 KB) para resolver
    que `bajo` es prep/adj/verbo/sustantivo. Ese es exactamente el pozo que
    nlprule cavó: ~15k líneas de Rust más un pipeline de build en Python, un
    año de una persona, y murió. Forkear el Java es peor: seguís shipeando la
    JVM y encima mantenés un fork de 6.098 reglas ajenas. Descartado.
  - **Lo que SÍ vale cherry-pickear son los datos, no el motor.**
    `rules/es/confusion_pairs.txt` son 1.036 líneas de texto plano y leerlas
    desde Rust con un lookup de POS es un fin de semana. Ídem `replace.txt`,
    `compounds.txt`, `hyphenated_words.txt`. Es el patrón que ya usa el
    tesauro: **intérprete MIT + datos LGPL shipeados sin modificar y con su
    licencia al lado** (LT es LGPL 2.1, igual que `th_es_v2.dat`).

- **Recomendación que sale de las dos mediciones** (2026-08-20). La pregunta
  real no es "qué motor es mejor" sino **si 174 MB + un proceso JVM + 661 MB
  de RAM valen ~11 marcas de concordancia cada 30.000 palabras** — porque eso
  es lo único que LT aporta y no se puede rehacer barato. Lo demás que
  dispara son tildes diacríticas (`MI_TILDE`, `EL_TILDE`, `DE_TILDE`, `SE`),
  puntuación, comillas sin cerrar y mayúscula tras punto: **todo escribible
  en TS sin POS tagger**, al lado de `validator.ts` y `detector.ts`.
  Camino propuesto, en ese orden y reversible:
  1. ~~**Shipear el sidecar**~~ — **descartado el 2026-08-21**: no se puede
     buildear sin bajar el código de LT + Maven en CI por target. Ver el item
     "LT embebido como sidecar" más arriba.
  2. **Escribir las reglas de tildes diacríticas y puntuación en TS** — son
     las que disparan de verdad y no necesitan morfología.
  3. **Apagar `EN_REPEATEDWORDS_*` y `PROFANITY*` con `disabledRules`** si se
     prende `picky`: en la muestra inglesa `picky` sumó 10 hits de
     `EN_REPEATEDWORDS_*` (que **pisan el detector de repeticiones propio**) y
     7 de `PROFANITY*` (diálogo de ficción). Confirma con datos el item de
     `disabledRules` de más abajo.
  4. **Revisar en 6 meses**: si la lista de reglas que disparan sigue siendo
     esas 21, tirar LT, quedarse con hunspell (`zspell`) + las reglas propias,
     y bajar 174 MB. La decisión queda abierta y mantenerla abierta no cuesta.

  Scripts y datos de las dos mediciones: `medir.py` / `medir2.py`,
  `res-*.json`, `tok-*.json` en el scratchpad de la sesión (no se commitean).
  **Ojo con reproducirlas**: extraer el texto plano del HTML tiene que tratar
  `<br>` como salto de línea — sin eso aparecen 29 `ESPACIO_DESPUES_DE_PUNTO`
  falsos por párrafos pegados, que en el repo real son **1**.

- **Wizard de revisión de errores** (paralelo al chequeo inline, a pedido del
  autor): botón al lado de `Auto` / `LT` en la barra de arriba que abre un
  popup y camina los matches del capítulo **uno por uno** — mostrar contexto,
  la sugerencia, y Aceptar / Ignorar / Agregar al diccionario / Siguiente.
  No reemplaza las marcas inline: se apoya en `grammarMatches()`, que ya
  tiene los `from`/`to` mapeados a posiciones PM (`GrammarMatchPos`), así que
  el wizard solo necesita ordenarlos por `from`, hacer `scrollIntoView` +
  selección en cada paso y reusar el apply de `grammar-popover.ts`. Ojo con
  dos cosas: (a) aceptar una sugerencia cambia el doc y por lo tanto invalida
  los offsets de los matches siguientes — remapear con `tr.mapping` como ya
  hace el plugin, NO re-chequear en cada paso; (b) el `Auto` puede disparar un
  `checkGrammar` a mitad del recorrido y pisar la lista — pausar el auto-check
  mientras el wizard está abierto. Decidir si incluye también violaciones RAE
  (`raeViolations()`) o solo gramática.
- **Ortografía y semántica sin depender de un servicio que el autor levante**
  (pedido del autor; prioriza **embebido o de fondo** sobre "instalate un
  runtime"). El criterio: si hay que explicarle al usuario cómo levantar un
  daemon, ya perdimos — vale para él mismo, que tiene todo para correr un
  Ollama y aun así lo considera demasiado. Ordenado por cuán realista es:

  > **Actualizado el 2026-08-20 (segunda vuelta).** Esta lista se escribió sin
  > considerar la opción que gana: **bundlear LT mismo como sidecar** (ver el
  > item "LT embebido como sidecar — MEDIDO Y VIABLE"). 174 MB, arranca en
  > 1,07 s, cero setup del usuario, y es el mismo motor que ya usamos. Harper
  > queda **descartado** con datos, no por el idioma (ver "Alternativas de
  > motor evaluadas y descartadas"). `zspell`/`hunspell` sigue en pie pero
  > cambió de rol: ya no es "la red por si LT se cae" — con LT embebido no se
  > cae — sino la pieza que quedaría **si en 6 meses se decide tirar LT** y
  > bajar los 174 MB, apoyada en las reglas propias en TS.

  - **`zspell` (Rust puro) o `hunspell-rs` + diccionarios de LibreOffice**
    (`es_AR` de la RLA, `en_US`/`en_GB`). Ortografía **solamente**, cero
    gramática, pero se linkea en `src-tauri` y funciona offline y sin
    container. Valor concreto: seguís teniendo typos marcados cuando LT está
    caído, que hoy es un agujero. Es el más barato de los tres y el que
    menos promete de más.
  - **Harper** (`harper-core`, Automattic) — checker gramatical en Rust,
    offline, lints en milisegundos. Arquitectónicamente es el calce ideal:
    es un **crate**, se linkea directo en `src-tauri`, sin container, sin
    sidecar, sin HTTP — y con eso se evapora toda la clase de bugs de la que
    salió el guard de staleness (chunking, rate limit, offsets viejos).
    **Bloqueante**: el README oficial dice "Harper currently only supports
    English". El español no existe ni de cerca. Sumarlo hoy significa dos
    motores distintos según el idioma del capítulo — decidir si esa
    complejidad vale por la mitad inglesa, o esperar.
    **DESCARTADO el 2026-08-20**, y no por el idioma: son ~200 linters contra
    6.098 reglas de LT en inglés, y sobre la prosa real del autor LT dio 3
    matches no ortográficos en 24k palabras — no hay nada que reemplazar. El
    argumento arquitectónico ("así no shipeamos Java") se cae porque el
    español obliga a la JVM igual. Detalle en "Alternativas de motor
    evaluadas y descartadas".
  - **Semántica / estilo por LLM** — es lo único que de verdad supera a LT
    en prosa literaria española (ve registro, repetición, ritmo, cosas que
    ningún motor de reglas alcanza).

    > ⚠️ **CORRECCIÓN del 2026-08-20.** Este item decía *"Descartado por
    > ahora, decisión explícita del autor"* y **eso era una tergiversación**.
    > El autor nunca lo rechazó: dijo que *capaz* levantar un Ollama era igual
    > de complicado que hacerle correr una imagen al usuario — una duda de
    > viabilidad sobre **una** implementación, no un rechazo de la idea. Queda
    > **abierto y es el candidato más fuerte** para lo que el autor identifica
    > como su molestia real: que el inglés de LT (6.098 reglas) es muy
    > superior al español (1.667), y ningún motor de reglas va a cerrar esa
    > brecha porque nadie escribió esas reglas. Un modelo no las necesita.

    **La duda original era sobre Ollama, y ese no es el único camino.** Vía
    API con la clave del autor, `secrets.rs` ya resuelve la parte difícil
    (keyring del OS, fallback `0600`, y el secreto **nunca cruza el bridge
    JS→Rust** — se carga server-side al armar el POST, exactamente como el
    apiKey de LT Premium). Rust no tiene SDK oficial de Anthropic, así que es
    HTTP directo con `reqwest`, que ya es dependencia y es como `grammar.rs`
    le pega a LT hoy: **cero dependencias nuevas**.

    **Costo medido, no estimado** (2026-08-20). Corpus real contado del HTML:
    **783.918 palabras en 578 capítulos** (Milky Way 399.720, Meridian 2.0
    225.255, Buenos Aires 2077 143.395, Vieja República 15.548). Con
    `claude-opus-5` a US$5/1M in + US$25/1M out, estimando ~1,5 tokens por
    palabra en español y una salida acotada al 15% del input (solo hallazgos,
    no reescritura):

    | | palabras | normal | Batch API (−50%) |
    |---|---|---|---|
    | capítulo promedio | 1.356 | **US$ 0,02** | US$ 0,01 |
    | saga más grande (Milky Way) | 399.720 | US$ 5,25 | US$ 2,62 |
    | **toda la obra** | **783.918** | **US$ 10,29** | **US$ 5,14** |

    Dos centavos por capítulo. Diez dólares por todo lo que el autor escribió
    en su vida. Con prompt caching sobre el system prompt + contexto de saga
    baja más, y la Batch API lo parte al medio para el caso "revisame el libro
    entero de noche".

    **Lo que hay que resolver, en orden de dificultad:**
    1. **Offsets.** El modelo no devuelve `offset`+`length` confiables. Hay
       que pedirle **structured outputs** (`output_config.format`) con el
       fragmento citado textual, y localizarlo en el doc del lado nuestro —
       el mismo problema que ya resolvió `resolve_matched_words` en
       `search.rs` para los snippets de tantivy, y `matchedTerms` para el
       jump. Hay precedente en el repo.
    2. **Privacidad.** Es prosa inédita saliendo a un servicio de terceros.
       Decisión del autor, no técnica. Vale saber que la API de Anthropic no
       entrena sobre datos de API por default y que existe zero-data-retention.
    3. **No determinismo.** Dos corridas pueden diferir. Va como acción
       explícita ("Revisar capítulo"), **nunca** reemplazando las marcas
       inline de LT ni corriendo en cada tecla.
    4. Params actuales: `thinking: {type:"adaptive"}` y
       `output_config: {effort}` — `budget_tokens` está removido y devuelve
       400 en Opus 5. Sin prefill de assistant (también 400).
- **Capacidades de LanguageTool que hoy NO usamos** (relevadas contra el
  swagger oficial + probadas contra el container local, LT 6.8 OSS):
  - [x] `level=picky` en `/v2/check` — **implementado**: toggle "Modo exigente
    (picky)" en el modal de gramática, off por default, persistido como
    `grammarPicky` en `settings.json`. El nivel se resuelve en
    `grammar.rs::level_for`. Verificado que **funciona** en el container libre:
    activa reglas extra de texto formal (`TOO_LONG_SENTENCE` aparece en `picky`
    y no en `default`). **Pero solo en inglés**: probado con muestras de
    redundancia y de oración larga en español, `picky` no agregó ni un match
    sobre `default` — el ruleset ES de LT es mucho más flaco; el texto del
    toggle lo avisa. Al cambiarlo, un effect en `editor.ts` dispara
    `checkGrammar(true)` (el `force` es necesario: el texto no cambió, así que
    el early-return por `lastCheckedPlain` se comería el recheck). El mismo
    effect cubre los cambios de variante regional, que arrastraban el mismo
    bug.
  - `disabledRules` / `enabledOnly` — el silenciado per-saga hoy solo puede
    tapar **palabras** (diccionario, filtro de `TYPOS` en `editor.ts`). Con
    `disabledRules` se podría silenciar una **regla** entera que moleste en
    prosa de ficción, persistida en `saga.json`. Requiere exponer el
    `rule.id` en el popover para que el autor sepa qué desactivar.
    **Regla concreta ya identificada**: con `picky` prendido, LT marca `Shit`
    en diálogo con `PROFANITY_XML` (categoría `STYLE`, "This word is
    considered offensive"). Verificado que es picky-only (en `default` no
    aparece) y que `disabledRules=PROFANITY_XML` la apaga limpio. No es un
    bug — el toggle está haciendo exactamente lo que promete — pero en
    ficción con personajes que putean es una regla que el autor va a querer
    apagar sin perder el resto de `picky`. Junto con `TOO_LONG_SENTENCE`,
    son las dos primeras candidatas de la lista per-saga.
  - `motherTongue` — habilita chequeos de false friends. Probado con
    `motherTongue=es` sobre texto en inglés: cero matches en las muestras,
    el archivo de false friends es-en parece muy chico. Bajo valor.
  - `data` (AnnotatedText) — mandar markup marcado en vez de texto plano.
    **No sirve acá**: nuestra fuente es un doc de ProseMirror, no un string
    con markup, y `extractPlainText` + `ranges` ya resuelve el mapeo de
    offsets de forma equivalente. Descartado.
  - **N-gramas (`langtool_languageModel`) — PROBADO Y DESCARTADO PARA ESPAÑOL.**
    La idea era detectar pares confundibles que el motor de reglas no ve
    (`haber`/`a ver`, `hecho`/`echo`). Se probó de verdad: bajado
    `ngrams-es-20150915.zip` (1.6 GB zip / 3.1 GB desplegado) a
    `~/.twriter/ngrams`, montado en un container aparte en `:8082` con
    `-e langtool_languageModel=/ngrams -v ~/.twriter/ngrams:/ngrams:ro`
    (el log confirma `languageModel=/ngrams`, el mount se ve adentro), y
    A/B contra el container normal de `:8081` con 12 oraciones de pares
    confundibles típicos del español. **Resultado: 0/12 casos donde los
    ngramas agregan un solo match.** La causa está en el propio LT, no en el
    setup: `org/languagetool/resource/<lang>/confusion_sets.txt` trae **5
    pares para español** (`casa;caza`, `ciento;siento`, `cima;sima`,
    `honda;onda`, `sumo;zumo` — todos seseo, inútiles para un autor
    argentino) contra **782 para inglés**. Ni forzando una oración con uno de
    los 5 pares reales dispara. Conclusión: 3.1 GB de disco por nada.
    **Pendiente**: el inglés es otra historia — 782 pares es donde esto
    pagaría. Cuesta 9.0 GB (`ngrams-en-20150817.zip`, ~17 GB desplegado).
    Si se decide que vale, el cambio en código es `run_args()` en
    `grammar.rs:220`, que hoy devuelve `Vec<&'static str>` hardcodeado y
    habría que pasar a `Vec<String>` para poder inyectar el path del mount.
  - **Lo que LT NO tiene** (no volver a buscarlo): no hay endpoint de
    **sinónimos** — el swagger completo son `/v2/check`, `/v2/languages`,
    `/v2/words`, `/v2/words/add`, `/v2/words/delete` y nada más; los
    sinónimos del editor web de LT son un servicio propietario que no está
    en la API. Y `/v2/words` (diccionario personal) es **Premium**: el
    container local contesta `403 AuthException` incluso con credenciales.
    Confirma la decisión ya tomada en la sección de Búsqueda: el
    diccionario per-saga (`<saga>/diccionario.txt`) es el camino.

- [x] **Agregar un verbo al diccionario y que entren todas sus conjugaciones**
  (pedido del autor, 2026-08-31; **verificado a mano por el autor el 2026-09-01**,
  PR #82). Hoy `<saga>/diccionario.txt` era una lista
  plana de formas exactas: el filtro de `editor.ts:638` compara
  `word.toLowerCase()` contra el `Set`, así que agregar `teletransportar` no
  silencia `teletransportó`, `teletransportaba`, `teletransportándose` ni las
  otras ~60 formas — hay que tipearlas una por una. Es el caso de todo verbo
  inventado del worldbuilding.
  **No fue ninguno de los dos caminos que planteaba este item** (conjugador que
  escribe todo, o wildcard de prefijo), sino un tercero que salió de medir los
  diccionarios reales en vez de suponer. Spec:
  `docs/superpowers/specs/2026-08-31-formas-derivadas-diccionario-design.md`.

  Dos mecanismos separados, con una regla que los divide: **el generador nunca
  escribe un plural**.

  | | español | inglés |
  |---|---|---|
  | **Pelar al filtrar** (no escribe nada) | enclíticos, plural `-s`/`-es`/`-ces` | plural `-s` |
  | **Generar al archivo** (preview editable) | verbos (15 formas), género de adjetivos (2) | — nada — |

  Lo que cambió respecto de la premisa del item, todo medido sobre las 439
  entradas reales y el corpus de las novelas:
  - **Los plurales eran el 93% del dolor, no los verbos.** 39 de 42 familias del
    diccionario son singular/plural. Por eso el plural se pela y no se genera.
  - **Los verbos son un problema exclusivamente español**: cero verbos en las 265
    entradas inglesas de Milky Way, y ahí el plural es `+s` mecánico sin una sola
    excepción. La nota de "un conjugador de español no ayuda al inglés" era
    correcta pero irrelevante: en inglés no hay nada que conjugar.
  - **Los infinitivos casi nunca están en el diccionario** — se agrega la forma
    que marcó LT, nunca el lema — así que el flujo infiere el lema hacia atrás
    (`inferLemma`) y arranca desde el popover, no desde el modal.
  - **Futuro, condicional y subjuntivo tienen 0 apariciones** en tres novelas: el
    núcleo se recortó a 15 formas en vez de las ~60 que estimaba este item.
  - Los irregulares **no se modelan**, como decía el item, pero el remedio no es
    corregir la línea a mano después: el preview es tildable y se destilda la
    forma que no existe antes de escribir.

  Medición de seguridad del pelador sobre el texto completo: 3 palabras nuevas
  silenciadas sobre 25.444 únicas, las tres plurales legítimos (`lúmenes`,
  `Koziaras`, `naruus`). Cero falsos positivos.

  Dos bugs de integración que solo aparecieron en la review de rama completa —
  las seis reviews por tarea los dieron por buenos porque el plan especificaba el
  código defectuoso: una sola `Intl.Collator` con `sensitivity: 'base'` servía
  para ordenar **y** para decidir identidad, así que cada verbo `-ar` perdía en
  silencio el pretérito 3ª sg y el imperativo voseo; y el modal escribía al
  `diccionario.txt` de la saga del capítulo **activo**, no de la que estaba
  editando. Un tercero lo encontró el autor probando a mano: `inferLemma` no
  contemplaba que la palabra ya fuera el infinitivo, así que `+ formas…` no
  aparecía sobre `bardear` ni `Moniquear`.

  Limitación aceptada: un nombre propio terminado en `-ar`/`-er`/`-en`/`-an`
  (`Brámar`, `Bastien`) también ofrece el botón y propone un verbo inexistente.
  No hay señal para distinguirlo sin un etiquetador morfológico, y el popover
  aparece justo sobre las palabras que LT no conoce, donde caen las dos cosas.
  Se cancela el preview. El autor lo prefiere así: el botón es el canal para
  verbos truchos o que el diccionario libre todavía no tiene, no la vía estándar
  de cargar palabras.
- **`inferLemma` no invierte los cambios ortográficos ni sirve a raíces cortas**
  (salió de la review de CodeRabbit en el PR #82, 2026-09-01; medido, no supuesto).
  Las formas que el generador emite con cambio ortográfico no vuelven a su lema:
  `tranqué` → `tranquar` (no `trancar`), `pagué` → `paguar`, `leyendo` →
  `leyendar`, `leído` → `leídar`. Y las de raíz corta no devuelven nada:
  `pagás`, `pagó`, `pagá`, `cazó`, `cacé`, `leo`, `leí`, `leé` → `[]`, porque
  `MIN_RAIZ_SUFIJO_CORTO = 4` corta cualquier sufijo de una o dos letras sobre
  raíces de 3 (`pag`, `caz`, `le`). Lo mismo deja afuera los infinitivos cortos:
  `dar`, `ser`, `ver`, `ir` → `[]`.
  **Por qué no se arregló junto con el resto**: ese piso es lo que evita que
  `Aedan` proponga el verbo `aedar`, así que bajarlo cambia un trade-off medido.
  Y en la práctica no muerde: son todos verbos españoles **reales**, que LT
  conoce, así que nunca se marcan como TYPOS ni llegan al popover. Los verbos
  inventados del worldbuilding tienen raíces largas (`barde`, `caste`,
  `moniqu`, `teletransport`) y son todos `-ear` regulares.
  Si alguna vez muerde, el arreglo es agregar reglas inversas para `-yendo`,
  `-yó`, `-yeron`, las terminaciones acentuadas y `-qué`/`-gué`/`-cé`, más una
  aserción de ida y vuelta que recorra la salida de `generateForms` en vez de la
  muestra de corpus que hay hoy.
- **Detectar mayúsculas rancias en las palabras propias del autor** (pedido del
  autor, 2026-08-31): `AEdan` por `Aedan`, `YIRIel` por `Yiriel`. Hoy **nada**
  las marca, y la causa está identificada: el filtro de TYPOS de `editor.ts:638`
  compara en minúsculas (`dict.has(word.toLowerCase())`), o sea que una vez que
  `aedan` está en el diccionario, **cualquier** variante de mayúsculas de esa
  palabra queda silenciada. LT tampoco ayuda: `MORFOLOGIK_*` es justamente lo que
  ese filtro se come.
  Fix barato, sin motor nuevo: el diccionario ya guarda la forma canónica, así
  que alcanza con marcar toda palabra del texto cuyo `toLowerCase()` matchee una
  entrada del diccionario pero cuya grafía exacta **no** sea la de la entrada.
  Función pura; la comparación ya existe del otro lado —
  `detectProblematic` en `dictionary/word-validator.ts` ya reporta
  "Duplicada (variante de mayúsculas)" **dentro** del archivo; acá es el mismo
  criterio pero texto vs. diccionario. Reusar, no escribir de cero.
  Excepciones que no son error y no hay que marcar: la palabra en ALL-CAPS
  (grito: `—¡AEDAN!`) y el arranque de oración cuando la entrada es minúscula.
  Dónde mostrarlo: sumarlo a la pasada del panel de auditoría RAE
  (`rae-audit-panel.ts`), que ya recorre el capítulo y lista violaciones con
  jump-to-term, en vez de inventar un panel nuevo.
- [ ] **Tres falsos positivos de LT con id ya identificado — 0004 y 0005 son
  bugs de regla; el tercero es una regla que cubre mal su propia construcción**
  (encontrados escribiendo el 2026-09-02)
  Los tres se reprodujeron contra el container local (LT **6.7**, `es-AR`) y los
  ids salieron de ahí, así que no hay que adivinarlos:

  **`TU_TILDE[5]` — `tu` seguido de puntos suspensivos.**
  «No te disculpes, me ha sorprendido tu… conjuro.» → marca `tu` y sugiere `tú`
  ("El pronombre personal «tú» lleva tilde"). Acá `tu` es determinante posesivo
  y su sustantivo es `conjuro`: los puntos son **pausa, no corte**. La regla
  toma el `…` como fin de sintagma y concluye que `tu` quedó suelto, o sea que
  tiene que ser el pronombre.
  Acotado con pruebas contra el container:
  - sin los puntos, `me ha sorprendido tu conjuro` → **limpio**, o sea que el
    disparador es el `…`;
  - dispara igual con `…` (U+2026) y con `...`, así que no es un problema de
    normalización de caracteres nuestro y no se arregla del lado de la app;
  - `Vi tu… casa.` y `Me gusta tu… idea.` también disparan → es el patrón, no
    esa oración.
  La forma de la excepción sería: `tu` + puntos suspensivos + sustantivo ⇒ no
  marcar. Ojo con no romper el caso legítimo (`Dame tu, dijo.` dispara y ahí
  está bien).

  **`AGREEMENT_POSTPONED_ADJ[3]` — `más seguido` como locución adverbial.**
  El caso de arriba, «Quiero pasear sin mi armadura más seguido, Chispi.» →
  sugiere `seguida` concordando con `armadura`. Probado contra el container:
  `Quiero salir más seguido.` y `Quiero pasear sin mi casco más seguido.` salen
  limpias, así que hace falta un sustantivo femenino antes — pero
  `Salgo de mi casa más seguido.` **también sale limpia**, o sea que no alcanza
  con "femenino contiguo" y el disparador real está sin caracterizar. Eso es la
  primera mitad del trabajo del parche.
  (En esa oración salta además `MORFOLOGIK_RULE_ES` por `Chispi`, que es un
  nombre del mundo y va al diccionario de la saga, no es parte de este bug.)

  **`NO_SEPARADO[5]` — el `re` intensificador rioplatense. Distinto de los dos
  de arriba: acá LT no está equivocado, está siendo normativo.**
  «los pollitos son re lindos» → sugiere `relindos`. La norma de la RAE dice que
  los prefijos van pegados, así que la sugerencia es correcta *como norma* — lo
  que no contempla es el registro: en diálogo rioplatense el `re` separado es lo
  que se escribe, y esto es diálogo.
  **Y la regla es arbitraria vista desde el texto**, esto sí es reportable
  aunque la norma le dé la razón: dispara solo cuando la forma pegada existe en
  el diccionario de LT. Probado contra el container en `es-AR`:
  - dispara: `re lindos` → `relindos`, `re lindo` → `relindo`,
    `re contento` → `recontento`, `re malo` → `remalo`;
  - no dispara: `re cansado`, `re caro`, `re fácil`, `re buenos`, `re grande`.
  O sea que la misma construcción se marca o no según si el pegado quedó
  lexicalizado, cosa que el que escribe no tiene forma de anticipar.
  **La variante no cambia nada**: `es-AR` y `es` devuelven exactamente el mismo
  match, así que la sospecha de que "falta en la variante" es correcta — la
  variante voseo no trae ninguna excepción para esto.
  **Y hay un argumento más fuerte que "es cuestión de registro"**: el `re`
  rioplatense es **productivo**, se le pega a cualquier adjetivo — re feo, re
  lindo, re caro, re choto, re piola — y las formas pegadas que LT propone no
  las dice nadie. Eso se ve en el propio diccionario de LT: `Es relindo.` y
  `Estoy recontento.` pasan **limpias** (están como entradas), mientras que
  `re feo`, `re choto`, `re piola`, `re bueno` separadas también pasan limpias
  porque el pegado no existe. O sea que la regla alcanza exactamente al puñado
  de formas que quedaron lexicalizadas, y para esas sugiere justo la grafía que
  no se usa. El resto de la misma construcción, que es la mayoría, no se marca.
  **Decisión tomada el 2026-09-02: acá no va PR.** Sería defendible sin discutir
  la norma (una regla que cubre 4 casos de una construcción abierta y sugiere la
  variante muerta), pero es la clase de discusión que termina en un hilo sobre
  qué dice la RAE, y no hay ganas. **Se apaga y listo**: es el caso testigo del
  `disabledRules` por saga del ítem de acá abajo — novela con diálogo argentino
  desactiva `NO_SEPARADO`.
  Si alguna vez cambia de idea: `node scripts/scan-regla-lt.mjs NO_SEPARADO
  ~/novelas es-AR` da los hits sobre la obra real, que es la evidencia con la
  que se armaría. Nada de esto bloquea a `0004`/`0005`, que sí son bugs de
  regla y no discuten nada.

  **La norma, para tenerla a mano** (buscada el 2026-09-02, para poder citarla
  sin discutir de memoria). En esto LT tiene razón y conviene saberlo antes de
  abrir la boca:
  - *Ortografía de la lengua española* (RAE/ASALE 2010), §5.3, «La escritura de
    palabras o expresiones con prefijo»: el prefijo va **unido a la base cuando
    esta es univerbal** (`vicedecano`, `contrarreloj`); con **guion** si la base
    es sigla, número o nombre propio (`anti-OTAN`, `sub-16`); y **separado por
    espacio cuando la base es pluriverbal**, o sea varias palabras funcionando
    como unidad (`anti pena de muerte`, `ex primer ministro`,
    `pre Segunda Guerra Mundial`).
    <https://www.rae.es/ortograf%C3%ADa-b%C3%A1sica/uni%C3%B3n-y-separaci%C3%B3n-de-palabras-y-otros-elementos-en-la-escritura/la-escritura-de-palabras-o-expresiones-con-prefijo>
  - `re-` está en el DLE **como prefijo**, con valor intensivo equivalente a
    "muy": `relindo`, `reloco`, `rebueno`, `rebién` — o sea que las formas que
    sugiere LT son exactamente las que el diccionario registra.
    <https://dle.rae.es/re->
  - La RAE lo contestó varias veces por `#RAEconsultas` en la misma línea (el
    prefijo `re-` se escribe unido, sin guion ni espacio).
  **El resquicio, si el letrado quiere jugar**: la excepción de la base
  pluriverbal. Por la misma regla, `re en serio` o `re de fiar` irían separados,
  porque ahí la base son varias palabras. O sea que la norma **ya** admite el
  `re` separado, solo que por otro motivo — y el hablante que escribe `re lindos`
  no está distinguiendo esos dos casos. (Esto es deducción de la regla citada,
  no una resolución de la RAE: verificarlo antes de usarlo como argumento.)
  El otro flanco es de uso, no de norma: cuánto aparece cada grafía en corpus
  argentino (CORPES XXI / CREA filtrando por Argentina) es un dato que se mide,
  y es distinto de opinar.

  **El camino ya está armado**: `docs/lt-patches/README.md` — fork
  `T4toh/languagetool`, patch acá mientras el PR no esté mergeado, `sed` sobre
  el `grammar.xml` del container para probarlo en vivo, y
  `node scripts/scan-regla-lt.mjs TU_TILDE ~/novelas es-AR` (ídem
  `AGREEMENT_POSTPONED_ADJ`) **antes y después** para contar los hits sobre la
  obra real. Serían los parches `0004` y `0005`, ramas independientes desde
  `master` como los otros tres.
  Ojo con la versión: el README ancla los números de línea a **LT 6.8** y el
  container que respondió es **6.7**. Verificar antes de aplicar cualquier `sed`.
  Mientras los PR no estén mergeados, estos dos son exactamente los casos que
  justifican el "ignorar esta regla" del ítem de acá abajo: `disabledRules` es
  el paliativo, el parche es el arreglo.

- [ ] **Los falsos positivos de LanguageTool no se pueden ni nombrar ni matar —
  y no queda registro de ninguno** (reportado el 2026-09-02 mientras se escribía)
  **Repro**: «Quiero pasear sin mi armadura más seguido, Chispi.» LT marca
  `seguido` y sugiere `seguida` — "Revise la concordancia de «seguido» con los
  nombres precedentes". Concuerda el participio con `armadura`, el sustantivo
  femenino más cercano, cuando `más seguido` es una **locución adverbial** (=
  más a menudo) y el sujeto es tácito, `yo`. LT no analiza sujeto: matchea un
  patrón de sustantivo + participio, así que con sujeto tácito la regla no
  tiene con qué concordar y agarra el sustantivo de al lado.
  **No es un problema de variante**: `map_lang` (`grammar.rs:780-787`) ya manda
  `es-AR` cuando el capítulo es español, así que la regla dispara igual con la
  variante rioplatense declarada. Descartado ese camino.
  **Lo que duele no es el FP puntual, es que no hay nada que hacer con él**:
  - "Ignorar" (`grammar-popover.ts:53` → `dismissGrammarMatch`,
    `editor.ts:1184-1188`) solo saca el match de la lista en memoria. No
    persiste: vuelve en el próximo chequeo, en ese párrafo y en todos los demás
    donde aparezca la misma construcción, para siempre.
  - El popover de LT **no muestra el `ruleId`**, aunque el dato viaja entero
    desde Rust (`grammar.rs:646-647` y `873`) hasta `GrammarMatch`
    (`types.ts:95-103`). El popover de RAE sí lo muestra
    (`rae-popover.ts:38`). Sin el id no se puede desactivar la regla, ni
    reportarla upstream, ni siquiera saber si dos FP distintos son la misma
    regla.
  - `/v2/check` acepta `disabledRules` (lista de ids separada por comas) y el
    request no lo manda nunca: los params son solo `text`, `language`, `level`
    (+ auth en modo custom), `grammar.rs:899-903`.
  **Fix de raíz, chico**: (a) mostrar el `ruleId` en el popover de LT, igual que
  el de RAE — es un `<span>` y desbloquea todo lo demás; (b) que "Ignorar" tenga
  una segunda opción, "esta regla nunca más", que guarde el id por saga y se
  mande como `disabledRules` en el próximo check. La lista de reglas
  desactivadas **es** el registro de FP que hoy no existe, sin llevar un txt
  aparte: cada entrada queda con el id y la oración que la disparó.
  **A decidir**: si la desactivación es por saga o global — una regla que molesta
  en una novela rioplatense probablemente moleste en todas, pero por saga es más
  conservador y ya hay dónde guardarlo (`saga.json` / config de saga, como el
  diccionario). Y si conviene además un nivel intermedio "ignorar esta
  ocurrencia" persistido por offset, que se rompe al editar el párrafo — capaz
  no vale la pena y alcanza con las dos puntas.
  Emparentado con `## Proofreading`: son la misma necesidad de "encontré algo
  mientras escribía, que quede anotado sin frenar la escritura".

- [ ] **El diccionario no soporta términos compuestos** (`Kun Lian` un reino,
  `Tres Torres` un vino) — reportado el 2026-09-02
  **Guardarlos ya funciona, usarlos no.** `validateWord` permite espacios
  internos a propósito (`word-validator.ts:17-19`) y `diccionario.txt` se lee
  por líneas (`saga_config.rs:160-162`), así que una entrada con espacio
  sobrevive el round-trip entero — y después no sirve para nada, porque **todos
  los consumidores son de a una palabra**:
  - `isInDictionary(word)` es `Set.has(word.toLowerCase())`
    (`saga-context-service.ts:113-118`), y lo llaman con **una palabra suelta**
    los dos filtros de typos de LanguageTool (`editor.ts:653-657` y
    `editor.ts:1116-1120`), que sacan la palabra del rango del match.
  - repeticiones compara token contra token: `ignorar` se normaliza a un Set y
    se chequea con `t.norm` (`detector.ts:227,242`).
  O sea que `Kun Lian` en el diccionario no filtra el typo de `Kun`, ni el de
  `Lian`, ni evita que el detector marque `Kun` como repetida.
  **El workaround de hoy es peor que el bug**: agregar las dos palabras sueltas.
  Para `Kun`/`Lian` pasa (son inventadas), pero `Tres Torres` obliga a meter
  `Tres` al diccionario — y ahí se apaga la detección de repeticiones de la
  palabra común `tres` en toda la saga, y LT deja de opinar sobre ella. Una
  entrada del mundo termina degradando la corrección del texto normal.
  **Dirección** (una pasada compartida, no un filtro nuevo por consumidor):
  separar al cargar las entradas de una palabra de las de varias; las
  compuestas se matchean **como frase sobre el texto plano** antes de tokenizar,
  y esa pasada devuelve los rangos cubiertos. Los consumidores que ya trabajan
  con offsets sobre el plano (el filtro de LT, el detector de repeticiones)
  descartan lo que caiga adentro de un rango. Un solo lugar que sepa de frases;
  el resto sigue siendo token-level como hoy.
  **A decidir**: (a) qué pasa con las formas derivadas — `stripInflection` no
  tiene sentido sobre una frase, lo más simple es que las compuestas no generen
  derivadas (o que flexione solo la última palabra, `Tres Torres`/`Tres
  Torreses` no aplica pero `Kun Lian` capaz sí en genitivos); (b) si el match de
  frase es sensible a mayúsculas — `Tres Torres` el vino vs. `tres torres` de
  piedra es exactamente la diferencia que hay que poder marcar, y el resto del
  diccionario hoy es case-insensitive (`isInDictionary` hace `toLowerCase`);
  (c) mostrar las compuestas distinto en el modal (`dictionary-modal.html`) para
  que se vea que son otra cosa, y validar que no se cuelen por accidente al
  pegar una lista.
  **Segundo caso, y este muestra que no alcanza con el diccionario tal como
  está** (encontrado escribiendo el 2026-09-02): «Amalut de las Arenas» — el
  apellido que le queda a un esclavo que se escapó de Sa'artan. LT marca
  `las Arenas` con `AGREEMENT_DET_NOUN[3]` (categoría `AGREEMENT_NOUNS`,
  "Error de concordancia") y propone `el Arenas` / `la Arenas`.
  Por qué dispara, probado contra el container: `Vino Juan de las Arenas.`
  también dispara, y `de las Dunas` / `de los Vientos` **no**. O sea que no es
  el nombre inventado: `Arenas` con mayúscula existe en el léxico de LT como
  nombre propio en singular, choca con el determinante plural `las`, y la regla
  ofrece "arreglar" la concordancia de un apellido. (En la misma oración salta
  `MORFOLOGIK_RULE_ES` por `Amalut`, que es el caso normal de diccionario y se
  resuelve solo agregándolo.)
  **Lo que este caso agrega al diseño**: el match de LT cubre `las Arenas`, un
  span que **no coincide** con la entrada del diccionario (`de las Arenas` o
  `Amalut de las Arenas`) — está **contenido** en ella. Eso confirma que la
  pasada de compuestas tiene que devolver **rangos** y que el filtro es por
  contención, no por igualdad de string.
  **Y hace falta levantar una restricción**: hoy el diccionario solo filtra
  typos. Los dos filtros del editor arrancan con
  `if (m.category !== 'TYPOS') return true` (`editor.ts:653` y `1116`), así que
  una construcción de concordancia sobre un nombre propio del mundo no se
  filtra ni aunque el término esté cargado. Adentro de un nombre propio no hay
  nada que corregir, así que descartar cualquier match contenido en un rango de
  término compuesto es seguro — pero es un cambio de criterio explícito, no un
  efecto colateral.
  **Se cruza con tres cosas ya anotadas**: el autocompletado de términos del
  proyecto (pendiente del ítem `[x]` de `## Búsqueda`) tendría que sugerir
  `Kun Lian` entero, no `Kun`; la búsqueda por frase del ítem de matcheo es la
  misma primitiva vista desde el otro lado; y los falsos positivos de LT de acá
  arriba — con la diferencia de que **este se arregla de nuestro lado**, no con
  un parche a LT: la regla no está mal, no tiene cómo saber que `de las Arenas`
  es un apellido inventado.

- [ ] **La revisión por libro cuenta pero no muestra ni lleva: repeticiones y
  rayas quedan en un número** (reportado el 2026-09-02)
  Las repeticiones **dentro del editor** están bárbaras — subrayado inline sobre
  el texto, con popover (`editor/repeticiones-extension.ts`,
  `editor/repeticiones-popover.ts`). El problema es la versión **por libro**: el
  modal de revisión (`revision-libro-modal.html`) es una grilla de casillas con
  conteos y nada más. La fila de repeticiones dice literalmente "no se arreglan
  solas: se reescriben a mano en el editor" y muestra "N en M capítulos" — pero
  no dice **cuáles** ni **dónde**, así que para arreglarlas hay que abrir
  capítulo por capítulo a buscarlas de nuevo a ojo. Rayas es peor todavía: solo
  "N capítulos", sin conteo real de ocurrencias (`resumenCapitulos`, y el
  comentario de `ConteoCapitulos` en `revision-libro-service.ts` lo dice).
  Lo que hace falta es cualquiera de las dos (o las dos): **llevar** al lugar
  para arreglarlo, o **mostrar la oración con contexto ahí mismo** en la lista,
  para poder revisarlas de corrido sin salir de la vista.
  **Precedente exacto adentro de esta misma app**: `rae-audit-panel` ya hace las
  dos cosas — `snippet()` (`rae-audit-panel.ts:64-74`) arma el contexto ±40
  caracteres marcando la violación con `‹…›`, y `openChapterAt` (línea 76) abre
  el capítulo en el lugar. Copiar esa forma, no inventar otra.
  **Lo que falta del lado del servicio**: `escanear` recorre los capítulos y
  solo acumula (`revision-libro-service.ts:153-168`, `res.repeticiones.cambios
  += det.repeticiones`); tiene que devolver las **ocurrencias** con `path` +
  `offset` + `length`, que es lo que necesitan tanto el snippet como el salto.
  Los detectores ya trabajan sobre el texto plano (`repeticiones/detector.ts`,
  `revision/deteccion.ts`), así que el offset está ahí, se está tirando al
  contar.
  **Depende del ítem de `## Urgente`**: el salto a offset tiene que funcionar
  primero, si no esta lista hereda el mismo click que no lleva a ningún lado —
  como le pasa hoy al panel RAE, que tiene el offset y termina en el
  `TreeWalker` igual.
  Ojo con el volumen: un libro entero puede dar cientos de repeticiones, así
  que la lista necesita agrupar por capítulo y colapsar (como hace el panel de
  búsqueda con `defaultOpen` para grupos de ≤10 hits).

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

- [x] **Abrir la búsqueda destruye la nota que estabas leyendo — y volver no la trae**
  (`fix/busqueda-salto-y-matcheo`, verificado a mano por el autor el 2026-09-03:
  la nota vuelve sola al cerrar la búsqueda)
  El panel derecho es un slot único (`app.html:311-331`, cadena `@else if`:
  rae-audit → search → image → font → md-reader) y encima hay dos efectos que se
  matan entre sí en `app.ts`: si el reader abre, `search.hide()` (línea 258); si
  la búsqueda abre, `markdownReader.close()` (línea 266). O sea que no es que la
  nota quede tapada: se cierra de verdad, así que al cerrar la búsqueda no hay
  nada que restaurar y hay que ir a buscar la nota de nuevo a mano.
  Duele justo en el flujo real: la lista de cosas para corregir vive en una nota,
  se busca la frase, se arregla el capítulo, y para pasar al siguiente ítem hay
  que reabrir la nota. Ver también el ítem de proofreading en `## Proofreading`,
  que es este mismo flujo visto desde más arriba.
  **Fix chico**: sacar el `markdownReader.close()` del efecto de `search.open()`
  — la cadena `@else if` ya prioriza la búsqueda, así que el reader queda oculto
  pero vivo y reaparece solo al cerrar el panel. Queda por decidir qué pasa con
  el `search.hide()` del efecto inverso: hoy clickear un hit de nota cierra la
  búsqueda (querido: querés ver la nota), pero si se mantienen los dos efectos
  destructivos el ping-pong sigue. La versión completa sería recordar el último
  target del reader y restaurarlo, pero probablemente no haga falta si nadie lo
  cierra.
  Antes de tocar: `mdReader.close()` también hace flush si está dirty
  (`app.ts:232-239`, mutex reader vs notes-editor central) — no perder eso.
  Se tomó el fix chico: fuera el `markdownReader.close()` del efecto de
  `search.open()`. El `search.hide()` del efecto inverso se queda —clickear un
  hit de nota tiene que mostrar la nota, y sin eso quedaría tapada por la
  búsqueda—, y no hay ping-pong porque ese efecto depende de `viewing()`, que no
  cambia cuando la búsqueda abre. El flush no se pierde: `close()` sigue igual,
  simplemente ya no se lo llama desde ahí.

- [x] **La búsqueda no lleva siempre al lugar correcto y matchea de más**
  (`fix/busqueda-salto-y-matcheo`, verificado a mano por el autor el 2026-09-03:
  `Aedan venía mirando` da 1 resultado donde daba 10, y `Ambos Nobles` da el
  cartel de palabras desperdigadas en vez de 3 capítulos que no tienen nada que
  ver)
  Reportado el 2026-09-02 con `Creo que se llamaba` en scope "Libro actual":
  3 resultados donde el tercero (`Barracas — 3`) solo tiene `llamaba` resaltada,
  y el primero resalta `se`, `Creo`, `que`, `llamaba` desperdigadas por párrafos
  distintos. Ignorar mayúsculas está bien; traer un doc que matchea 1 de 5
  palabras no.
  **Causa**: el builder fuzzy arma `Occur::Should` por término
  (`search.rs:948-962`), o sea OR puro — un solo término alcanza para entrar al
  ranking. El AND completo existe pero solo como clause boosteada
  (`FULL_MATCH_BOOST`), que ordena mejor pero no filtra. Encima el tokenizer no
  dropea stopwords (decisión deliberada del índice v4, para poder buscar texto
  literal), así que `que`/`se` matchean en cualquier lado. En modo exacto el
  `QueryParser` sí usa `set_conjunction_by_default()` (`search.rs:808`), así que
  esto es específico del toggle `≈`.
  **Segundo repro, mismo día, y este descarta la teoría de las stopwords**:
  `Ambos nobles` (dos palabras, ninguna vacía) en el mismo scope. Con `≈`
  prendido, **22 resultados** y varios con una sola palabra resaltada
  (`Descanso — 3` solo `nobles`, `Amigos — 5` solo `Ambos`), todos con el
  **mismo BM25 (10.77)** — que un OR de dos términos empate 22 docs al décimo
  sugiere que el clause boosteado del AND no está diferenciando nada, revisarlo
  aparte de la decisión de abajo. Con `≈` apagado, **5 resultados**: ahí el AND
  del `QueryParser` sí filtra, pero **el problema de "no me lleva" sigue igual**
  — `Descanso — 2` muestra solo `nobles` resaltada y `Amigos — 5` solo `Ambos`,
  porque el doc contiene las dos palabras pero a párrafos de distancia y el
  snippet se centra en la primera. O sea: hay **dos bugs separados**, el
  matcheo de más es del fuzzy, pero el snippet/salto que apunta a cualquier
  lado pasa en los dos modos.
  **A decidir** (ninguna es obviamente la buena):
  (a) que el fuzzy también exija todos los términos (`Occur::Must` por término,
      fuzzy adentro) y deje el OR solo como fallback si el AND da 0 hits;
  (b) piso de cobertura: exigir ≥N términos o ≥X% de los términos de la query;
  (c) proximidad — una query de varias palabras es casi siempre una frase medio
      recordada, así que los términos deberían caer cerca (phrase query con slop)
      en vez de a tres párrafos de distancia.
  La (c) es la que ataca el problema de fondo, y el repro de `Ambos nobles` con
  `≈` apagado es el argumento: el AND a nivel documento no alcanza porque lo que
  se busca casi siempre es una frase, no dos palabras sueltas en el mismo
  capítulo. Encima `resolve_matched_words` centra el snippet en la primera
  palabra que matcheó (`search.rs:333`), así que con términos desperdigados el
  snippet tampoco muestra el lugar bueno.
  **El salto en sí es otro bug y tiene ítem propio en `## Urgente`** (el offset
  del hit no viaja al editor). Son independientes: aunque la query filtre
  perfecto, el click sigue cayendo en cualquier lado. Cualquier cambio acá toca
  `matchedTerms`, que es lo que el frontend usa para resaltar (`search-panel.ts:270-305`).
  Se eligió la (a): `build_fuzzy_or_query` pasó a ser `build_fuzzy_query(idx, q,
  occur)` y el caller pide `Occur::Must`, o sea el fuzzy exige todos los términos
  igual que el modo exacto. Si el AND devuelve 0 hits hay un reintento con
  `Occur::Should` —con un typo grueso, parciales es mejor que nada—. Cayó
  `FULL_MATCH_BOOST`: era el clause que ordenaba sin filtrar, el que dejaba 22
  docs empatados en 10.77.
  La (c) no se descartó por mala sino por costo: tantivy no combina fuzzy con
  phrase query, habría que resolver cada término a sus variantes y armar la
  frase a mano sobre posiciones.
  Lo del snippet que apunta a cualquier lado —que pasaba en los dos modos— se
  arregló aparte: `make_snippet` ya no se centra en la primera aparición del
  primer término, sino en la ventana que cubre más términos distintos con el
  menor span (`best_cluster_start`).
  **Y la (c) terminó entrando igual**, que era la que atacaba el fondo y se había
  descartado por costo. Salió casi gratis reusando el cluster del snippet: el AND
  de tantivy es a nivel **documento**, así que `Aedan venía mirando` traía 10
  capítulos y sólo uno tenía la frase — los otros nueve usan las tres palabras
  por separado, y con un nombre propio que aparece 13 veces en un capítulo eso es
  medio libro. `best_cluster` (antes `best_cluster_start`) ahora devuelve también
  el **ancho** de la ventana mínima que cubre la query, y con eso se puede saber
  si las palabras están juntas o sólo comparten capítulo. El umbral es
  `SNIPPET_MAX_LEN` (240) y no un número a dedo: si no entran todas en un
  snippet, no hay forma de mostrarlas juntas.
  La cascada, de mejor a peor, y el panel avisa en los tres niveles flojos
  (`MatchLevel` + `SearchResult::scattered`):
  - `phrase`: sólo los que tienen la query tal cual. Sin cartel.
  - `nearby`: ninguno tiene la frase, pero en estos las palabras caen a menos de
    240 chars. Es el caso de la frase medio recordada, con una palabra cambiada.
  - `allWords`: las palabras están en el doc pero a párrafos de distancia ⇒ **no
    se devuelve nada**, y el cartel dice cuántos capítulos eran y a qué distancia
    mínima ("sueltas en 3 capítulos, a más de 3.526 caracteres"). Sin ese detalle
    un "sin resultados" a secas haría dudar de si el buscador anda.
  - `someWords`: el rescate OR, cuando ni todas las palabras aparecen.
  El caso que lo motivó, medido: `Ambos nobles` no existe en el repo, y los 3
  capítulos que tienen las dos palabras las tienen a 3.526, 5.028 y 5.857 chars.
  Aparte salió el matcheo de más a nivel **resalto**, que era `includes()` puro:
  buscando `y Ami ya está` marcaba la `Y` de `Yiri` y la `y` de `ayudó`.
  `esMatchDeTermino` pide borde izquierdo siempre y palabra completa para
  términos de ≤3 chars, dejando el prefijo para los largos (`golpear` →
  `golpearon`).
  Y un tercero, del mismo código y encontrado el 2026-09-03 usando la app:
  buscando `Seguid` el salto caía en `seguida` de un párrafo anterior, y el
  snippet también. El literal se buscaba con `indexOf`/`find` a secas, así que
  ganaba el primero en aparecer. No se arregló exigiendo palabra completa —el
  prefijo es justo lo que hace falta cuando la palabra completa no existe— sino
  con **preferencia**: `pickBestBlock` rankea `[literal, términos completos,
  términos con prefijo]` y el salto hace cuatro pasadas en ese orden. En Rust,
  `make_snippet` usa `find_palabra_completa` con `find` como fallback.
  Verificado a mano por el autor el 2026-09-03.


- [x] **Reemplazar en lote: implementado y verificado por el autor**
  (reportado el 2026-09-03: "estuve buscando Angelica para cambiar por
  Angélica a mano como mono")
  Diseño en `docs/superpowers/specs/2026-09-03-reemplazar-en-lote-design.md`,
  plan de implementación en `docs/superpowers/plans/2026-09-03-reemplazar-en-lote.md`.
  Vive en el panel de búsqueda, atrás del toggle `⇄` del header: reusa el
  mismo selector de scope de la búsqueda (capítulo actual, libro, saga, todo
  el repo), y agrega un campo "reemplazar por" con los toggles `Aa`
  (mayúsculas) y `ab` (palabra completa) — `≈` (fuzzy) queda deshabilitado en
  este modo, con el motivo escrito al lado: un match aproximado cambiaría
  palabras que no se pidieron. Escribir needle + replacement dispara un
  preview (`replace_preview` en Rust, debounce de 250ms) que enumera las
  ocurrencias leyendo del **disco**, no del índice tantivy — así que es
  inmune al item de arriba (el índice mudo). El preview se agrupa por
  capítulo, con checkbox tri-estado por grupo y por ocurrencia individual
  para destildar casos puntuales; aplicar corre `replace_apply`, que
  snapshotea los originales antes de escribir.
  **La pieza no obvia es el mapeo plain ↔ HTML por runs** (`src-tauri/src/replace.rs`):
  se busca sobre el texto plano, que es lo que el autor ve, pero se escribe
  sobre el HTML, y los offsets de los dos no coinciden (los tags no están en
  el plain, las entidades cambian de largo). La solución es construir el
  plain junto con una lista de **runs** — tramos que se corresponden byte a
  byte con el HTML, cortados por cada tag, cada entidad y cada cierre de
  bloque — y aplicar una única regla: **una ocurrencia solo es reemplazable
  si cae entera dentro de un run**. Esa regla sola rechaza los tres casos
  peligrosos (frase partida por una cursiva, match que abarca una entidad,
  match que cruza dos párrafos) sin código especial para ninguno, y
  garantiza que nunca se pise markup. Lo que no entra en ningún run se
  muestra en el panel como salteado, con su snippet y el motivo.
  **La red de seguridad** es un snapshot de los originales en
  `.twriter/undo/` (uno solo, se pisa con cada apply nuevo) más un botón
  Deshacer en el propio panel de búsqueda, no en un toast que desaparece.
  Deshacer se niega a pisar y ofrece "Pisarlos igual" en dos casos: si algún
  capítulo del snapshot se editó a mano **después** del reemplazo (compara
  mtimes), o si el registro del snapshot quedó incompleto y no se puede
  confiar en él (`suspect`) — son dos motivos distintos y el panel los explica
  por separado, no con un mensaje genérico.
  **Huecos conocidos y cosas deferidas** (están en el ledger de la feature,
  no son sorpresa; ninguna es bloqueante para usarlo con cuidado):
  - Un texto de reemplazo que contenga `&`, `<` o `>` queda, en lotes
    posteriores, no reemplazable como string entero (las partes de alrededor
    sí siguen siéndolo) — el escape corta run igual que cualquier entidad.
    El panel lo muestra como salteado con su motivo, así que es visible y no
    silencioso.
  - Un `<` suelto en el HTML se come el texto hasta el próximo `>` de
    cualquier parte del archivo. Es el mismo comportamiento que ya tiene la
    búsqueda (`search.rs`) y se dejó así a propósito: arreglar uno sin el
    otro los desincroniza.
  - El fold que evita pisar dos ediciones del mismo archivo no cubre
    symlinks, la insensibilidad a mayúsculas de APFS ni NFC vs NFD en
    nombres de carpeta acentuados — las tres son la misma clase de problema
    (grafías distintas para el mismo path real) y se dejaron afuera porque
    `canonicalize` toca el filesystem por cada edición y puede resolver un
    symlink de Dropbox/iCloud a otro lado.
  - `fs::write_chapter` sin tmp+rename era un riesgo de la app entera, no
    solo de esto — arreglado el 2026-09-04 (ver el item de abajo, ya cerrado).
  - Caminos sin test automatizado en `replace.rs` (hueco de cobertura, no bug
    conocido — el comportamiento es el correcto, lo que falta es el arnés):
    el TOCTOU del id de snapshot pide concurrencia real, y un test que pasa
    por casualidad es peor que ninguno; el repro del fallo al reescribir el
    manifest final no se puede forzar sin romper también la fase anterior; y
    la variante `files == 0` del filtro de salteados (todo salteado sin
    ningún escrito) queda sin ejercitar porque el disparador que sí se
    encontró —un hard link entre dos capítulos— siempre incluye una
    escritura exitosa.
  - El guard del undo por mtime tenía un hueco de resolución de 1 segundo —
    cerrado el 2026-09-04 pasándolo a hash del contenido, ver el item de más
    abajo (ya tildado). El guard de la fase 3 del apply se fue por el mismo
    camino y su test dejó de depender del filesystem.
  - Los contadores de la barra de Deshacer no bajan tras un Deshacer
    parcial (siguen mostrando el total original aunque ya se restauró parte).
  - "Archivo actual" no es el mismo scope en búsqueda que en reemplazo:
    búsqueda usa el foco (e incluye notas), reemplazo usa el pane activo.
  - Cambiar de carpeta raíz con el panel de reemplazo abierto no revalida el
    scope elegido — riesgo bajo, porque cambiar de root ya cierra los
    capítulos abiertos.
  - El chequeo de extensión del frontend (`.html`, case-insensitive) no
    coincide con el filtro de Rust (sensible a mayúsculas): un archivo
    `1.HTML` pasaría el guard del frontend y daría preview vacío.
  - Fuera de alcance por diseño, no por olvido: reemplazar dentro de notas,
    regex, deshacer granular estilo ProseMirror, historial de reemplazos, y
    tocar títulos de capítulo — ninguno se implementó.
  Verificado a mano por el autor el 2026-09-04.


- [x] **El guardado de capítulos puede truncarlos en disco lleno**
  (encontrado el 2026-09-03 revisando `replace_apply` para "reemplazar en
  lote", pero es un problema de toda la app, no de esa feature)
  `fs::write_chapter` (`src-tauri/src/fs.rs`) escribe con `fs::write` pelado:
  abre el archivo con `O_TRUNC` y recién después vuelca el contenido nuevo.
  Si el disco se llena o el proceso muere a mitad de la escritura (ENOSPC,
  corte de luz, kill -9), el capítulo queda truncado a lo que alcanzó a
  escribir — no hay ningún estado intermedio seguro. Y este es el camino que
  usa **todo** guardado de la app: el autosave del editor, el reemplazo en
  lote, el conversor RAE al aplicar, cualquier escritura de un capítulo.
  El arreglo es el patrón atómico de siempre — escribir a un `.tmp` al lado y
  `rename()` sobre el destino, que en POSIX es atómico — y **ya está en este
  mismo repo**: `stats.rs::write_stats` lo hace exactamente así (`fn
  write_stats`, comentario "Sobrescribe `.twriter/stats.json` de forma
  atómica (tmp + rename)"). Es el mismo cambio, tres líneas, aplicado a
  `write_chapter` en vez de a `write_stats`.
  Por qué no se hizo ya: se encontró y se dejó fuera a propósito durante la
  Task 3 de "reemplazar en lote" (el reemplazo en lote lo mitiga con su
  propio snapshot en `.twriter/undo/`, así que ahí el peor caso es
  recuperable), pero el autosave normal no tiene ningún snapshot — un
  capítulo truncado por un corte de luz mientras se escribe desde el editor
  se pierde sin red.
  **Hecho el 2026-09-04**: `fs::write_atomic` en `src-tauri/src/fs.rs` (tmp
  al lado + `sync_all` + `rename`, mismo patrón que `stats::write_stats`),
  usado por `write_chapter` y `write_meta` — o sea autosave, reemplazo en
  lote y RAE, que todos pasan por ahí. El tmp lleva pid + contador para que
  dos writers del mismo capítulo no intercalen bytes en un tmp compartido, y
  se borra si el rename falla. Se mantiene el rechazo de un archivo de solo
  lectura (que `fs::write` daba con EACCES y el `rename` se saltearía) y se
  le copian los permisos del destino al tmp. Efecto colateral esperado: el
  rename estrena inode, así que dos capítulos hard-linkeados ahora divergen
  en vez de escribirse juntos — el test del guard de mtime en `replace.rs`
  que usaba ese hard link como disparador pasó a un symlink. Tests:
  `fs::tests::write_atomic_*`, más los 432 de Rust en verde.


- [x] **El guard del undo por mtime no distingue una edición hecha en el
  mismo segundo que el reemplazo** (`fix/undo-guard-por-hash`, verificado a
  mano por el autor el 2026-09-04; propuesto por CodeRabbit en la review del
  PR #94)
  El undo se negaba a pisar un capítulo del snapshot si detectaba que se editó
  a mano después del reemplazo, y lo hacía comparando mtimes: `mtime_epoch`
  (`src-tauri/src/replace.rs`) trunca a **segundos**, y el campo que guardaba
  el manifest (`mtime_after_apply`) era ese mismo segundo. Si una edición
  ajena —autosave, la otra PC, un pull— caía dentro del mismo segundo que la
  escritura del reemplazo, el mtime resultante era idéntico al registrado y el
  guard no tenía con qué distinguirlos: lo trataba como "nadie lo tocó
  después" y lo pisaba igual. En discos con resolución de mtime de 1 segundo
  (HFS+, exFAT, SMB — que es donde vive de verdad esto, porque el repo de
  novelas puede estar en una carpeta de Dropbox o iCloud) la ventana entera de
  un lote chico podía caer adentro de un solo segundo.
  **Por qué el mtime no alcanzaba, y por qué detectar el filesystem tampoco**:
  la resolución del guard es la del filesystem, no la del reloj — hasta
  pasando a nanosegundos (que ya arreglaría APFS/ext4) quedaban HFS+/exFAT/SMB
  con `tv_nsec` siempre en 0. Y preguntarle al volumen qué es (`statfs`) no
  sirve: te dice que el guard es de mentira ahí, no te da resolución, y el
  repo se mueve de volumen.
  **Hecho el 2026-09-04**: el manifest guarda `hashAfterApply`, el hash del
  contenido que quedó en disco después de escribir, y el undo lo compara
  contra el contenido de hoy — coincide ⇒ nadie lo tocó ⇒ restaura; no
  coincide ⇒ se editó después, sea cual sea el mtime ⇒ `blocked` y el autor
  decide. Content-addressed, no time-addressed: dos escrituras en el mismo
  segundo dejan de ser indistinguibles porque no se le pregunta al reloj.
  Detalles que importan:
  - **FNV-1a 64 escrito a mano**, sin dependencia nueva: no hace falta un hash
    criptográfico (el "adversario" es un autosave) y a diferencia del
    `DefaultHasher` de la std es estable de por vida, que es lo que pide un
    valor que va a un archivo y lo lee otra versión de la app.
  - El hash se toma **del disco**, no del `nuevo` que había en memoria:
    `write_chapter` le agrega el `\n` final si falta.
  - `mtimeAfterApply` se sigue escribiendo y es el **fallback** para los
    snapshots que quedaron en disco de antes del campo; sin eso,
    `hashAfterApply: None` los mandaba a restaurar sin ningún guard.
  - Los sentinels de "no se pudo registrar" (`None` / `0`) siguen sin
    bloquear: el capítulo puede estar truncado por un fallo de escritura y es
    justo cuando el autor más necesita deshacer.
  **Y de arrastre, el guard de la fase 3 del apply** (el que evita pisar una
  edición ajena llegada entre el read de la fase 1 y la escritura) pasó a
  comparar **contenido** en vez de mtimes crudos: `p.html` es el
  `read_to_string` exacto de la fase 1, así que alcanza con releer el archivo
  justo antes de escribirlo. Se fueron `mtime_raw`, el campo `mtime_antes` del
  `Pendiente` y el techo documentado que ya no aplica (neto −21 líneas). Cae
  además un falso positivo que el mtime tenía **hasta en APFS**: un autosave
  que reescribía contenido idéntico movía el mtime y el capítulo se salteaba
  sin motivo, cuando el `nuevo` calculado sobre ese html seguía siendo válido.
  Y el test del symlink dejó de depender de que el volumen distinga dos
  mtimes: ahora se dispara por contenido y es determinístico en cualquier
  filesystem.
  Tests: la edición en el mismo segundo (mtime forzado al que registró el
  manifest) y el manifest viejo sin la clave, que tiene que caer al mtime;
  437 de Rust en verde. La carrera real no se reproduce con los dedos, así que
  la verificación a mano fue fabricando el estado: reemplazo en el repo de
  prueba, edición del capítulo, `os.utime` devolviendo el mtime al segundo que
  registró el apply, y Deshacer — que salió bloqueado en vez de pisar.


- [x] **El índice se puede quedar mudo y no hay forma de saberlo**
  (encontrado el 2026-09-03 persiguiendo un `golpear` que no traía
  resultados; `fix/indice-mudo`, verificado a mano por el autor el
  2026-09-04)
  **Causa raíz encontrada**: cambiar el root nunca reinicializaba el índice.
  `setRoot` solo persistía settings y `full_reindex` corría en un único lugar
  (el boot), así que tras elegir otra carpeta el buscador seguía contestando
  con los documentos del root anterior y cada save iba a parar al índice
  viejo — en silencio. `set_settings` (`settings.rs`) ahora compara el root
  contra el de disco y dispara `search::spawn_reindex`; el boot usa el mismo
  helper. Verificado en el log: `root nuevo: reindexando root=…/novelas` →
  `reindex full completo indexed=925` en ~0.9 s.
  **Segunda causa raíz, encontrada probando**: el botón "Reindexar" del panel
  —el único remedio a mano cuando el índice quedó viejo— **fallaba en
  silencio salvo la primera vez**. `init_for_root` abría el writer nuevo
  antes de soltar el viejo y tantivy toma un lock exclusivo por directorio,
  así que todo reindex posterior al del boot moría con `Failed to acquire
  Lockfile: LockBusy`. Al boot no hay índice previo, o sea que el bug quedaba
  tapado justo donde no molestaba y aparecía únicamente cuando el usuario iba
  a buscar el remedio. Test: dos `full_reindex` seguidos sobre el mismo root.
  Lo demás que se hizo:
  - `with_index` (`search.rs`) ya no se traga el no-op: cuando el índice no
    está inicializado logea un WARN con la operación y el path que descartó.
    Lo mismo `search_query_impl`, que devolvía lista vacía en silencio. El
    error del reindex ahora se ve en el panel, no sólo en el 🐛.
  - **Comando `search_index_status(path?)`**: `initialized`, `root`, `docs`,
    `lastWrite` (ms del último commit de la sesión) y, con un path, si ese doc
    está en el índice y con qué mtime contra el del disco.
  - El panel de búsqueda lo muestra: resumen `N docs indexados, último cambio
    HH:MM:SS` cuando no hay lista a la vista, y un aviso con botón
    **Reindexar** cuando el archivo abierto **no está** en el índice. El
    estado sigue al archivo activo vía effect — al principio sólo se
    refrescaba al abrir el panel y al terminar una búsqueda de backend, así
    que cambiar de capítulo (o buscar con scope "Archivo actual", que es
    client-side) dejaba el aviso mostrando lo del archivo anterior.
  **Los dos episodios originales no se reprodujeron** (el `golpear` con 4
  resultados de un solo libro, y el término que no aparecía hasta abrir el
  archivo). Lo del root explica la familia de síntomas, pero no está
  confirmado que sea lo que pasó. Si vuelve: el panel dice si el archivo está
  indexado y el log dice qué writes se descartaron.
  **Decisión aparte, sigue abierta**: reindexar el repo entero en cada
  arranque (925 docs en ~0.9 s con el repo real) es O(repo) y tira el trabajo
  incremental de la sesión anterior. Alcanzaría comparar mtimes contra el
  índice y tocar solo lo que cambió — el `mtime` ya está guardado por doc y
  `search_index_status` ya lo sabe leer.

- [x] **El salto no encuentra un match partido por una itálica**
  (`fix/salto-multinodo`, verificado a mano por el autor el 2026-09-04
  buscando `venido del Abismo` en Buenos Aires 2077; de la review de
  CodeRabbit en el PR #93, 2026-09-03)
  `selectFirstMatchIn` ahora busca sobre la **concatenación** de los text nodes
  de cada bloque en vez de recorrerlos de a uno, y mapea el offset del match de
  vuelta a un `Range` multi-nodo (`setStart` en un nodo, `setEnd` en otro). El
  mapeo salió puro (`mapRangeToNodes`) y entró al smoke runner que ya existía,
  `scripts/run-search-locate-smoke.mjs` — 48 aserciones.
  Dos cosas que cayeron de arrastre:
  - `highlightBestMatch` le pasa **los bloques** como raíces, nunca el host
    entero. Concatenar los text nodes del host pegaría el final de un párrafo
    con el principio del siguiente y generaría matches fantasma que no existen
    en el texto.
  - El flash es del bloque, no del padre del text node. Con el match adentro de
    un `<em>` el padre es la itálica, y flashear tres palabras en bastardilla no
    dice dónde está el párrafo.
  El fallback de "scrollear y flashear el bloque ganador sin seleccionar" sigue
  ahí como red, pero ya no es el camino esperable para una frase con itálicas.

## Tree / Importer

- [x] **Renombrar una carpeta fuera de la app deja estado local huérfano**
  (`fix/estado-local-huerfano`, verificado a mano por el autor el
  2026-09-02: 10 claves huérfanas de 19 pasaron a 0 al abrir el repo).
  Encontrado el 2026-08-20 numerando las sagas a mano (`Milky Way` →
  `3 - Milky Way`, `Vieja República` → `4 - Vieja República`). El rename por
  git es limpio para el contenido — 1.256 renames, 0 cambios de contenido —
  pero archivos locales quedaban apuntando a los paths viejos, y ninguno
  viaja por git porque `.twriter/` está gitignoreado.

  - `stats.json` (keyeado por path relativo, 294 de 533 claves huérfanas en
    el incidente): `stats::reconciliar_stats()` corre al armar el árbol y
    remapea. Criterio: mismo largo de path y difiere en **exactamente un
    segmento de carpeta**, con el nombre del archivo igual — si no,
    `Libro/1.html` y `Libro/2.html` pasarían por rename. Solo remapea con un
    candidato único que todavía no tenga stat propio.

    **No se apoya en git**, y es a propósito: `storage.rs` clasifica roots en
    Dropbox, pCloud, Nextcloud, OneDrive, Drive, iCloud, Mega y Local, donde
    no hay repo del que leer los `R100`, y el bug pasa igual. Tampoco depende
    de cuántos commits atrás quedó el rename.

    Las claves que no matchean con nada **no se borran**: un checkout de otra
    rama hace desaparecer capítulos, y borrarlas ahí sería tirar histórico
    real para ahorrar kilobytes. Costo cuando está sano: N `is_file()`; el
    walk se paga solo si hay huérfanas. 7 tests en `stats.rs`.

  - `treeExpanded` de `settings.json` (paths absolutos, 16 huérfanos
    acumulados): `persistExpanded()` filtra contra el árbol vivo. El filtro
    va al persistir y no al hidratar para no tocar el timing del restore de
    sesión.

  - `search-index`: **no hacía falta nada**. El item decía que había que
    borrarlo para que reindexe, pero `full_reindex` arranca con
    `delete_all_documents()` (`search.rs:601`), o sea que se sana solo. Lo que
    sí puede quedar sucio son los hits stale **entre** reindexados completos,
    porque los updates incrementales van por path: si molesta, es otro item.

  **Ojo con el síntoma**: el item original decía que se pierden palabras y
  última-edición, y eso estaba mal medido. `palabras` se auto-repara —
  `palabras_for_chapter` cae a leer el HTML y contar (`stats.rs:296`), así que
  nunca se ve un 0— y `ultima_edicion` hoy **no la lee nadie**: se escribe en
  cada save y ningún lector la consume. Lo que el arreglo evita de verdad es
  que cada `get_tree()` relea y recuente todos los capítulos con clave
  huérfana. Por eso se verifica sobre `stats.json`, no sobre la UI.

  **Nota para quien lo toque en Mac**: el fix del typo `Notas/Buenos AIres
  2077` → `Notas/Buenos Aires 2077` es un rename **solo de caja**, y APFS es
  case-insensitive por default. Git puede no aplicarlo en el checkout; hay
  que verificar y hacer el `git mv` a mano si quedó con el nombre viejo.

- [x] **CAUSA RAÍZ del filesystem desparejo: "Nueva saga" crea sin número.**
  **Arreglado** en `7a5267f` (`fix(tree): crear sagas numeradas para que el
  filesystem quede ordenado`). Verificado el 2026-08-21: los tres call sites de
  `createDirectory` pasan `true` (`app.ts:656`,
  `node-actions-service.ts:515` y `:540`), no queda ninguno en `false`.
  **De dónde venía**: los dos call sites de "Nueva saga / novela" pasaban
  `numbered: false`, mientras libros y secciones pasaban `true` y
  `create_book_impl` numeraba **siempre**. Ahí nació el desparejo: `Milky Way` y
  `Vieja República` salieron por la app sin prefijo, `1 - Meridian 2.0` y
  `2 - Buenos Aires 2077` los numeró el autor a mano. Renombrar a mano dejaba el
  árbol coherente pero no sano: la saga siguiente volvía a salir sin número.

  **El fix fue `false` → `true` en esos dos lugares**, sin nada más: la
  maquinaria ya estaba. `next_dir_num` (`create.rs:398`) toma el máximo prefijo
  + 1 y las carpetas sin número (`fonts`, `themes`, `Notas`) aportan 0, así que
  la próxima saga sale `5 - Nombre`; y `displayName` (`tree.ts:663`) ya esconde
  el prefijo **solo para `kind === 'saga'`**, o sea que la UI no cambió en nada.
  Contrapartida asumida: reordenar una saga pasa a ser un rename, con el costo
  de estado local huérfano del item de arriba — pero eso ya era cierto para
  libros y secciones, así que es consistente con el diseño existente y no un
  problema nuevo.

- [x] **Bug — cartel de split colgado** (`fix/lt-config-modal-y-split-hint`,
  verificado a mano por el autor el 2026-08-21: se apaga al soltar afuera, al
  soltar sobre el árbol y al cancelar con Escape, y el split sigue abriendo
  normal al soltar en el centro). El overlay "Soltar acá para abrir en split" quedaba pintado después de
  soltar. La causa no era que faltara el handler — `tree.html` ya tenía
  `(dragend)="onNodeDragEnd()"` en los dos nodos arrastrables — sino **dónde
  vive**: en el elemento arrastrado. Si Angular re-renderiza el árbol durante
  el drag (refresh, pintar la nota activa, expandir una carpeta), ese elemento
  se destruye con su listener y el `dragend` nunca llega, así que
  `paneSplit.draggingNode()` queda seteado y el hint no se apaga nunca.

  **Un listener en `window` NO alcanza** — lo marcó CodeRabbit en la review y
  tenía razón. `dragend` se despacha en el nodo origen: si sigue conectado, el
  event path incluye a los ancestros y `window` lo ve; si el framework lo
  **desconectó**, el path de un nodo suelto es el nodo y nada más, así que
  `window` no se entera (y Firefox históricamente no despacha nada en ese
  caso). O sea que el listener en `window` arregla "el listener murió con el
  elemento" pero no "el elemento murió", que es justo el caso del bug. Fix real
  en `core/drag-cleanup.ts` (puro, 21 aserciones en
  `scripts/run-drag-cleanup-smoke.mjs`): dos caminos independientes, `dragend`
  para el caso rápido y un **watchdog de `dragover`** para el resto. Mientras un
  drag está vivo el navegador despacha `dragover` cada ~350 ms; si dejan de
  llegar por 1200 ms, terminó — y eso no depende de que el nodo exista. Cubre
  además Escape y soltar fuera de la ventana.

  **Ojo con "mejorarlo" sumando `drop` a ese listener**: en captura sobre
  `window` correría ANTES del `onCenterDrop` del shell, que lee
  `draggingNode()` para saber qué abrir — rompería el split entero. Hay una
  aserción del smoke runner clavando que `drop` no se escucha.
- [x] **Panel de notas con tabs: "Este libro" / "Todas"**
  (`feat/notas-plantillas-y-creacion`): escribiendo (no editando) el laburo era
  encontrar la ficha del personaje. Las fichas están duplicadas por libro **a
  propósito** — son acumulativas y muestran al personaje por época, hay cuatro
  `Aedan.md` — así que el trabajo no era navegar sino acertar cuál de las cuatro.
  El panel de notas ahora tiene dos tabs adentro (el árbol principal no se
  toca). `Este libro` es una lista plana, sin expandir nada, con las notas de
  `Notas/<saga>/<libro>/` más el `notas/` que el libro tenga en el árbol de
  novelas, y abajo separadas las `.md` sueltas de la saga (`Personajes`,
  `Idiomas`, `Detalles`). `Todas` es el árbol de siempre. El vínculo saga ↔
  carpeta de notas se **adivina** (`calzaSaga`): se le saca el prefijo numérico
  al nombre de la saga y se busca en el root o un nivel abajo una carpeta que
  calce exacto o por prefijo — así `1 - Meridian 2.0` encuentra `Notas/Meridian`
  y las otras tres sagas calzan exacto. Cero configuración; si algún día no
  adivina, ahí se suma el campo en `saga.json`. Todo en `tree/notas-del-libro.ts`
  (puro, 28 aserciones en `scripts/run-notas-del-libro-smoke.mjs`). Ojo con el
  contexto: abrir una nota en el centro **cierra el capítulo**, así que el libro
  no puede leerse de `chapter.active()` solo — `ChapterService.openInPane`
  registra `nav.ultimoCapitulo` y de ahí sale el contexto cuando no hay capítulo
  abierto. El `+` del panel, con la tab `Este libro` activa, crea en la carpeta
  del libro (aunque no exista todavía: `create_note` hace `create_dir_all`), que
  es donde va una ficha nueva. Al crear, si la nota no entra en la lista del
  libro se salta a `Todas` sola, para no volver al problema de la nota
  invisible.

  Dos bugs que aparecieron recién contra los datos reales, no contra el fixture:
  (1) el **nodo raíz del árbol viene con `kind: 'saga'`** (se llama como la
  carpeta root), así que buscar la saga con `find` agarraba la raíz y
  `notasDelLibro` devolvía `null` para **todos** los capítulos — la tab mostraba
  el cartel de "abrí un capítulo" con un capítulo abierto. Ahora se toma la saga
  más profunda de la cadena y se descarta la raíz; el fixture del smoke runner
  arma la raíz como `saga` para que no vuelva a taparse. (2) aplanar las
  carpetas temáticas de la saga daba **95 filas** en Meridian (`Lugares ›
  Viridis › Brickwell`…), peor que el árbol que la lista venía a evitar: la
  sección de saga quedó en sus `.md` sueltas (`Personajes`, `Idiomas`,
  `Detalles`…) y las carpetas temáticas viven solo en `Todas`.

  Para depurar esto sirvió volcar el árbol real con el builder de Rust
  (`get_tree`) a JSON y correr la función pura contra ese volcado desde node —
  16/16 libros resuelven, ningún null. Vale repetir la técnica: el fixture
  escrito a mano miente sobre las formas que produce `fs.rs`.
  **Verificado a mano por el autor el 2026-08-21.**
- [x] **Crear notas sin perder de vista la nota nueva**
  (`feat/notas-plantillas-y-creacion`): la queja era "la creás arriba y te
  aparece abajo" — el "Nueva nota…" vive en el menú del árbol de capítulos y el
  resultado cae en el panel Notas, que puede estar colapsado o con la fila
  fuera del viewport. Cuatro piezas: (1) `createNoteIn` pasó de `modal.prompt`
  a `modal.selectPrompt` (el mismo modal que ya usaba "Crear tema desde
  plantilla") con selector de **plantilla** y el destino relativo al root
  impreso en el mensaje; (2) plantillas en `shared/note-templates.ts` — `Vacía`,
  `Personaje` (`## Raza`/`## Características`/`## Objetos`/`## Magia`) y `Mundo`
  (`## General`/`## Lugares`/`## Personajes`), copiadas de las notas que el
  autor ya escribe a mano en `Novelas/Notas/Meridian/<libro>/`, con smoke runner
  propio; las listas sueltas siguen sin plantilla porque son texto libre;
  (3) `create_note` toma un `body: Option<String>` — si viene la plantilla se
  escribe eso en vez del `# <name>`, una sola escritura y un solo commit;
  (4) el panel Notas se descolapsa al crear y `tree.ts` scrollea a `.row.active`
  (`block: 'nearest'`) cuando cambia el path activo, lo que además arregla que
  el árbol principal perdiera de vista el capítulo abierto. Botón `+` en el
  header "Notas" que crea donde estás parado (carpeta de la nota abierta →
  carpeta navegada → `<root>/Notas`; un capítulo no cuenta como destino).
  **Verificado a mano por el autor el 2026-08-21.** Sobre las plantillas dejó
  dicho que no le aportan nada — las probó y le resultan lo mismo que crear la
  nota vacía —, pero quedan porque el default del selector es `Vacía` y no
  imponen nada. No invertir más en esa dirección (fichas con campos,
  frontmatter, plantillas configurables) sin que él lo pida.
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
- [x] **El creador de notas es inútil como está — hacerlo un form de verdad**
  (pedido del autor, 2026-08-31). **Esto revierte a propósito el "no invertir
  más en esa dirección (fichas con campos, frontmatter, plantillas
  configurables) sin que él lo pida" del item de plantillas de arriba: lo
  pidió.** Hoy `createNoteIn` (`shared/node-actions-service.ts:737`) es un
  `modal.selectPrompt` con un solo input (nombre) y tres plantillas
  (`Vacía`/`Personaje`/`Mundo`) que solo insertan headings `##` vacíos — por eso
  da lo mismo que crear la nota vacía y tipear a mano.
  Lo que se pide: un **form** que cree "más o menos todo" desde ahí, con más
  plantillas prehechas — `Conjuro`, `Personaje`, `Lista`, y las que salgan de
  mirar `Novelas/Notas/` (no inventarlas: copiar la forma de las que el autor ya
  escribe, igual que se hizo con `Personaje` y `Mundo`).
  Piezas: (1) crecer `NOTE_TEMPLATES` en `shared/note-templates.ts` — sigue
  siendo data pura y ya tiene su `run-note-templates-smoke.mjs`, agregar
  plantilla no debería costar más que una entrada en el array; (2) que cada
  sección de la plantilla pueda ser un **campo del modal** (`Raza:`, `Escuela:`,
  `Coste:`) y no solo un heading vacío, así la nota nace con contenido en vez de
  con un esqueleto; eso pide un modal con campos dinámicos — el
  `modal.selectPrompt` actual tiene un input fijo. Mantener `Vacía` como default
  y no imponer nada a las listas sueltas, que siguen siendo texto libre.
  Antes de codear: confirmar con el autor qué campos lleva cada plantilla nueva
  (`Conjuro` sobre todo), porque adivinarlos es exactamente el error que llevó a
  que las tres actuales no sirvieran.
  **Estado**: implementado en `feat/form-de-notas-con-plantillas` — spec en
  `docs/superpowers/specs/2026-08-31-form-de-notas-con-plantillas-design.md`,
  plan en `docs/superpowers/plans/2026-08-31-form-de-notas-con-plantillas.md`.
  Bloques editables (título/subtítulo/lista/párrafo) con ↑/↓, 6 plantillas de
  fábrica sacadas del corpus real, plantillas propias en `<root>/Plantillas/*.md`
  (la del autor le gana a la de fábrica con el mismo nombre). El drag de bloques
  queda como pulido posterior.
  **Verificado a mano por el autor el 2026-08-31** (PR #81), con dos cosas que
  salieron de esa prueba y se arreglaron en el momento: el destino quedaba fijo
  al abrir el modal —equivocarse de carpeta obligaba a cancelar y empezar de
  nuevo—, así que ahora hay un selector "Se crea en" con las carpetas del árbol
  que pueden alojar una nota; y la fila de configuración no alineaba porque el
  input de nombre no compartía alto ni tipografía con `app-select`.
  Queda anotado para cuando entre el drag: el `track $index` de las dos listas
  del template hay que revisarlo ahí, que es cuando reordenar puede perder el
  foco. La normalización de las 114 notas existentes **ya se hizo** (2026-08-31),
  con los formatos que salieron de este form.
- Re-importar capítulo sobrescribiendo el `.html` existente (hoy hay que borrar primero).
- Sumar más importers de notas: Obsidian (vault con `.obsidian/`), Notion (export ZIP), Bear (`.bear`), Logseq (graph), Markdown plano con frontmatter. El trait `NoteImporter` ya está armado — agregar uno nuevo no requiere tocar el wizard genérico.
- Joplin JEX format (preserva adjuntos + tags + timestamps). Hoy solo soporta el export raw MD.
- [x] **La vista de la saga muestra una tapa sola — que se vea que hay varios libros**
  (pedido del autor, 2026-09-01). En `landing/saga-header.html` el `.cover-slot`
  pinta **una** imagen: la tapa propia de la saga, o —si no tiene— la del primer
  libro con el tag "heredada" (`coverFromBook`). El contador de al lado dice
  "4 libros" pero visualmente parece una novela suelta. La `saga-card` de la
  galería sí apila hasta `MAX_THUMBS = 6` en fila, así que la inconsistencia
  está solo en el header.
  **Hecho en `feat/saga-header-deck-de-tapas`, verificado a mano por el autor el
  2026-09-01**: mazo de hasta 3 tapas (`MAX_DECK`), las de atrás con `translateY`
  + rotación alternada + `brightness` bajando; el tag "heredada" quedó igual —
  solo aparece cuando el frente es prestado, que es la condición que ya tenía.
  De paso, dos contadores que decían un kind pero contaban todos los hijos:
  `saga-header.ts` "N libros" ahora filtra `kind === 'book'` (sumaba la carpeta
  `notas` y los `.md` sueltos) y `book-card.ts::itemCount` excluye `note`/`notes`,
  mismo criterio que `landing.ts::items`.
- [x] **El "N cap." de la tarjeta de libro miente cuando el libro está partido**
  (visto el 2026-09-01 arreglando los contadores del mazo de tapas). `book-card`
  cuenta hijos directos (`itemCount()`, hoy ya sin notas), pero `fs.rs::
  list_sections_or_chapters` devuelve **`Section` por cada carpeta de parte** y
  solo mete `chapter` para los `.html` sueltos en la raíz del libro. O sea: un
  libro con 3 partes de 8 capítulos cada una dice "3 cap." en vez de 24, y uno
  mixto (partes + capítulos sueltos) suma peras con manzanas.
  **Hecho en el mismo PR** (lo levantó también la review de CodeRabbit, que
  coincidió con este item): `itemCount` pasó a `chapterCount` y suma los nietos
  `chapter` de cada `section` más los capítulos directos. Filtrar por `chapter`
  deja afuera las notas sin nombrarlas, así que el filtro de `note`/`notes` se
  cayó. Las secciones con `excluded: true` suman 0 — Rust las manda con
  `children: []` y además no van al EPUB, que es lo correcto acá.

- [x] **El export no dice que está trabajando** (`feat/export-progreso`,
  verificado a mano por el autor el 2026-09-02). Generar un EPUB tarda un par
  de segundos y en ese rato la app no mostraba nada hasta el toast final: no
  se sabía si estaba trabajando o si el click no había agarrado.

  **El item exageraba**: la tarjeta del libro ya tenía spinner propio
  (`book-card.ts::exporting`). El que no mostraba **nada** era el otro camino,
  exportar desde el menú contextual (`node-actions-service.ts:333`).

  `export_impl` recibe un callback de progreso, igual que
  `search::full_reindex`, así el impl sigue sin tipos de Tauri y los tests no
  necesitan `AppHandle`. `export_book` lo traduce a `epub-export-progress`.
  Fases: leyendo capítulos, embebiendo tapas e imágenes, escribiendo capítulos
  (con `hecho`/`total`) y armando índice. Del lado del frontend `ToastService`
  estrena `progreso()` (sin auto-dismiss) + `update()`, y el cierre va en
  `finally` para que valga también cuando el export falla.

  El `+1` del contador no es cosmético: el backend avisa **antes** de escribir
  cada capítulo, así que `hecho` es 0-based y sin él el primero se lee
  "0 de 12". `textoDeFase` vive aparte en `core/export-progreso.ts` con smoke
  runner, según el criterio del CLAUDE.md.

  **Lo que no se hizo**: barra de progreso, panel dedicado, y pasar la fase al
  tooltip de la tarjeta — con el toast en pantalla mostrando el mismo texto,
  el tooltip era duplicación que además pedía hover.

  Nota del autor al verificarlo: en su M5 el cartel se ve **un segundo**. La
  feature apunta a máquinas más lentas; acá el export ya es casi instantáneo.

- **Plantillas para el back matter** (idea del autor, 2026-09-02, no para ahora).
  Hoy la página "Otros libros" y la de "Sobre el autor" tienen un solo diseño
  cableado en `epub_style.css`. La idea es ofrecer un par de variantes —tapa
  centrada contra tapa al costado, con sinopsis o sin ella, una columna o
  dos— igual que ya existen plantillas de tamaño de página para el EPUB.
  Cruza con el ítem de blurb y sinopsis: recién cuando esos campos existan hay
  material suficiente para que las variantes se diferencien en algo más que el
  espaciado.

- **Chequeo de sintaxis para `epub_style.css`** (2026-09-02). La hoja del EPUB
  queda **fuera** de stylelint a propósito: se lee en hardware de tinta
  electrónica y tiene sus propias reglas —`float` en vez de flexbox, nada de
  `object-fit`, nada de anchos porcentuales—, así que un estándar pensado para
  navegadores no aplica. Esa decisión se mantiene.
  Lo que sí falta es otra cosa: verificar que la hoja sea **sintácticamente
  válida**. En un EPUB una propiedad mal escrita no falla ni avisa: simplemente
  no hace nada, y te enterás cuando ves la página rara en el Kindle. Es el modo
  de falla más caro que tiene este archivo, porque el ciclo de descubrimiento
  es exportar, pasar el archivo al lector y mirar.
  **Ojo con la solución obvia**: un parser de CSS no alcanza. `colr: red` es
  sintaxis válida —una declaración con un nombre de propiedad inexistente— y
  cualquier parser la acepta. Un test de Rust que parsee la hoja atraparía
  llaves sin cerrar, pero no el typo, que es el caso real.
  Lo que sirve es un chequeo con base de datos de propiedades: `property-no-unknown`
  de stylelint. O sea una **segunda config de stylelint** apuntada solo a esta
  hoja, con cero reglas de estilo y solo las de corrección (propiedad
  desconocida, declaración duplicada, bloque vacío, valor inválido). Nada que
  opine sobre `float` ni sobre flexbox: esas son decisiones tomadas. Cero
  dependencias nuevas — es el mismo stylelint que ya está instalado.

## EPUB

- **Abrir la carpeta del EPUB exportado / abrirlo en el visor**: al terminar el
  export la app dice dónde quedó el archivo y ahí muere; el autor tiene que ir a
  buscarlo a mano. Sumar en el aviso de export exitoso dos acciones: "Mostrar en
  la carpeta" y "Abrir" (visor EPUB default del OS). `tauri-plugin-opener` ya
  está instalado y registrado (`lib.rs:123`), así que es `reveal_item_in_dir` +
  `opener::open_path`, sin dependencia nueva.
- [x] **Copyright editable en ambos idiomas** (ES/EN): hoy el texto de la
  página de copyright sale fijo/auto-generado. Permitir editar el cuerpo y
  que cambie según el `idioma` del libro.
- [x] **Incisos extra de copyright tipo Reedsy** (`epub.rs::texto_inciso_default`
  + fieldset "Página legal" del modal de config del libro): sumar cláusulas opcionales
  (reserva de derechos, "obra de ficción / personajes ficticios",
  prohibición de reproducción, etc.) elegibles al armar la página legal,
  bilingües como el copyright. Quedaron tres claves — `reserva`, `ficcion`,
  `ia` — cada una con default ES/EN editable. El inciso `ficcion` ("Cualquier
  parecido con personas reales... es enteramente coincidencia") arranca en
  **true por su cuenta** desde 2026-09-03: antes heredaba el valor de
  `derechos_reservados`, así que apagar la reserva se llevaba puesto el aviso
  de ficción sin que nadie lo pidiera.
- [x] **Nota de uso de IA en la página legal** (pedido del autor, 2026-09-01): inciso
  opcional que declare que la IA se usó **solo para generar imágenes** — el texto
  lo escribe el autor. Va como una cláusula más del item de arriba (bilingüe
  ES/EN, elegible al armar la página legal), no como texto fijo: hay libros sin
  imágenes generadas. Redacción tipo "Las imágenes de esta obra fueron generadas
  con inteligencia artificial. El texto es obra exclusiva del autor." / "The
  images in this work were generated with artificial intelligence. The text is
  the sole work of the author."
- [x] **Back matter del EPUB: catálogo, perfil de autor y página legal**
  (spec en `docs/superpowers/specs/2026-09-01-back-matter-epub-design.md`).
  Sección "Otros libros" que se arma escaneando el root (`catalogo.rs`: un
  libro está publicado si su `book.json` tiene `link`), perfil global en
  `autor.json` con bio ES/EN, foto, web y QR (`autor.rs`), incisos de la
  página legal elegibles y editables, y todas las páginas editoriales en el
  índice con `class="toc-editorial"`. De yapa, las imágenes ahora se
  reescalan antes de embeberse (crate `image`): la tapa iba a resolución de
  imprenta adentro del EPUB. **Verificado a mano por el autor el 2026-09-02**, en Kindle y en Apple Books.
- [x] **XHTML inválido en el EPUB: `<br>` sin autocerrar rompe Apple Books**
  (el autor lo pisó probando un export, 2026-09-01). Apple Books usa un parser
  estricto y aborta apenas encuentra el primer `<br>` sin `/`
  (`Opening and ending tag mismatch: br line 11...`); Thorium es tolerante y
  lo dejaba pasar, por eso no se había notado. Medido sobre el repo real: 200
  capítulos con `<br>` sin cerrar y 1 con `<hr>` sin cerrar — el `<br>` es un
  salto de línea real adentro de un diálogo, no se puede sacar. Fix en
  `close_void_elements()` (`epub.rs`), aplicado en `load_part()` a la salida:
  autocierra `<br>`/`<hr>` sueltos a `<br/>`/`<hr/>` sin tocar atributos,
  texto ni tags que ya venían autocerrados. Arregla los 200 archivos de una
  sola vez, en el export, sin escribir nada en el repo del autor.

  **Pendiente real: el editor sigue escribiendo `<br>` sin cerrar en los
  `.html` nuevos.** El fix de arriba es un parche a la salida, no una cura —
  los archivos fuente le siguen quedando en HTML no-XHTML (importa si algún
  día se lee ese HTML con un parser estricto en vez de con el export actual).
  Falta encontrar qué nodo de TipTap serializa el `<br>` (`hardBreak`,
  probablemente con su serialización default) y hacer que autocierre al
  guardar el capítulo.
- **Blurb y sinopsis por libro** (pedido del autor, 2026-09-01). Dos textos
  distintos y con usos distintos: el **blurb** es el gancho de contratapa; la
  **sinopsis** es el resumen largo, el que va en la ficha de la tienda. Hoy no
  existe ninguno de los dos.

  **Formato, medido sobre el blurb real de La Caballera Esmeralda** (no
  supuesto): son **tres párrafos cortos separados por línea en blanco**, ~50
  palabras en total, texto plano sin cursivas ni nada inline. El ritmo vive en
  los cortes — el último párrafo es de dos oraciones y pega justamente porque
  está solo. O sea que el campo **tiene que preservar los saltos de párrafo**;
  colapsarlos a un string de una línea arruina el texto.

  Eso ya tiene convención en el repo y no hace falta inventar nada: `sobre_el_autor`
  guarda texto plano y `build_about_author_xhtml` convierte cada línea no vacía
  en un `<p>`. El blurb usa la misma, y el textarea del modal se comporta igual
  que el de la bio.

  Dónde aparece, por orden de utilidad: la contratapa generada, la tarjeta del
  libro en el landing, y la lista de "Otros libros" del back matter — pero ahí
  **tres párrafos son demasiado**, así que o va solo el primero o no va ninguno;
  decidirlo mirando la página armada, no de antemano. La sinopsis probablemente
  no vaya al EPUB, pero es lo que el autor copia y pega al publicar, así que
  tener dónde escribirla ya justifica el campo.

  **Son bilingües** (confirmado por el autor, 2026-09-01), así que blurb y
  sinopsis van como mapa por idioma —`{"es": "...", "en": "..."}`— igual que
  `bio` en `autor.json`, y no como string suelto. El que se emite lo elige el
  `idioma` del libro, con caída al otro idioma si falta, que es exactamente lo
  que ya hace `AutorConfig::bio_en`: reusar esa función en vez de escribir la
  misma resolución por tercera vez.

- **Sacar el autor del libro: hoy vive en tres lugares** (pedido del autor,
  2026-09-01). Después del back matter, el nombre del autor está en `book.json`
  (`autor`), en `saga.json` (`autor`) y en `autor.json` (`nombre`), que es el
  perfil global que agregó `autor.rs`. Tres fuentes para un dato que en un repo
  de novelas es uno solo: el que escribe. La resolución debería ser
  `autor.json` primero y los otros dos solo como respaldo para repos que
  todavía no tengan perfil global. **Decidido con el autor el 2026-09-01**: el
  campo sale del modal del libro, no se queda como override — con `autor.json`
  existiendo es duplicación, y el override por novela se agrega después si
  hace falta, apoyado en el mecanismo nuevo y no en el viejo. Ojo con el orden de trabajo: `epub.rs` usa `cfg.autor` en
  cuatro lugares (portadilla, copyright, metadata OPF, y un fallback que lo
  completa desde la saga en `epub.rs:1794`), así que primero va la resolución
  con fallback y recién después se limpian los `book.json` en disco —
  al revés, los libros salen sin autor en el EPUB. Los 21 `book.json` de
  `~/novelas` tienen el campo cargado, así que la migración toca todos.

- [x] **Las rutas de imagen se guardan absolutas y no sobreviven el cambio de PC**
  (encontrado el 2026-09-01 verificando el mazo de tapas: en esta Mac los 4
  libros de Meridian 2.0 mostraban placeholder). `book-config-modal.ts:216`
  `pickCover()` — igual `pickBackCover()` y `pickAuthorPhoto()` — guarda tal cual
  lo que devuelve el file dialog, o sea una ruta absoluta, incluso cuando el
  archivo está **dentro de la carpeta del libro**. Los `book.json` viejos quedaron
  con `/home/tatoh/Downloads/...` de la PC Linux; auditado sobre `~/novelas`:
  35 relativas (`cover.png`) OK, 4 absolutas rotas, y las 4 tenían un `cover.png`
  al lado. Con git sync entre PCs como feature central esto se rompe solo.
  **Lo peor es en el EPUB**: `epub.rs::embed_image` (línea 932) devuelve
  `Ok(None)` si el path no existe, así que el libro se exporta **sin portada y
  sin un solo aviso**. Y el auto-discovery de `find_cover_in` (línea 1540) no
  salva, porque solo corre cuando `tapa` está **vacío**, no cuando apunta a un
  path muerto — teniendo el `cover.png` ahí al lado en la misma carpeta.
  **Hecho en `fix/tapas-al-repo`** (falta verificación a mano):
  1. **Al elegir**: `book_config.rs::adopt_image` + comando
     `adopt_config_image`. Si la imagen cae bajo la carpeta del libro/saga se
     guarda relativa sin copiar; si viene de afuera se copia como
     `cover|back-cover|author.<ext>` y se guarda el nombre. Enganchado en los 4
     pickers de imagen (`book-config-modal.ts` ×3, `saga-config-modal.ts` ×1).
     Mismo criterio que ya tenía la normalización del import wizard
     (`import_wizard.rs:615`), que es por qué los libros importados sí quedaron
     con `cover.png` relativo.
  2. **Al leer y al exportar**: `image_field_unusable()` reemplaza al chequeo de
     "field vacío" en los 6 lugares que autodescubrían (`get_book_config` ×3,
     `saga_config.rs`, `epub.rs` ×2). Ahora un path muerto también dispara el
     `find_cover_in`, así que los `book.json` viejos con la ruta de Linux
     resuelven al `cover.png` de al lado sin tocar el repo de contenido.
  3. **Al reemplazar**: la elegida pasa a ser LA tapa — barre las otras
     extensiones del mismo stem, así no queda un `cover.png` viejo al lado del
     `cover.jpg` nuevo.
  **Verificado a mano por el autor el 2026-09-01**: cambió las 4 tapas de
  Meridian 2.0 desde Canva vía Downloads; los `book.json` quedaron con
  `tapa: "cover.png"` y las imágenes adentro de cada carpeta de libro.
  **Reescalar la tapa al copiar — DESCARTADO por el autor (2026-09-01).** Copiar
  al repo mete PNGs de 5–6 MB en git y las versiones viejas quedan en la historia
  (ese commit fueron ~23 MB). Propuse bajar a ~1600px al adoptar la imagen y lo
  descartó: es la misma tapa que se embebe en el EPUB y tiene que ir en calidad
  buena. No volver a proponerlo.
- **Tapa que no existe: avisar en vez de placeholder mudo.** Lo que quedó afuera
  del item de arriba: si no hay **ninguna** imagen al lado, `CoverCache.urlFor`
  tira y la UI cae al placeholder sin decir nada, y el EPUB se exporta sin
  portada en silencio (`epub.rs::embed_image` devuelve `Ok(None)`). Contra la
  convención "el remedio se da adentro de la app": tiene que mostrar el path que
  no existe y el botón "Elegir otra", y el export avisar que salió sin portada.
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
- **En el modal "Acerca de", cuando se retome** (ideas del autor al construirlo, no
  para ahora): el chequeo de versión nueva — hoy vive en el `UpdateBanner` y el
  plugin `updater`, así que sería exponer el "buscar actualizaciones" a mano desde
  ahí — y el toggle de idioma de la interfaz de la app, que hoy es español fijo y
  no tiene infraestructura de i18n de ningún tipo (los strings están hardcodeados
  en los templates, así que eso es un item propio y grande, no un agregado al
  modal).
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

- **Tests que colisionan entre sí en paralelo** (medido el 2026-09-01, no
  supuesto). Cuatro módulos tienen su propio helper `tempdir()` a mano que
  arma el nombre con `SystemTime::now().as_nanos()` y nada más: `git.rs:703`,
  `theme.rs:912`, `epub.rs:3114` y `stats.rs:202`. Dos tests que arrancan en el
  mismo nanosegundo se pisan el directorio, y `cargo test` en paralelo falla de
  forma intermitente — visto en `git::tests::pull_rebase_sets_upstream_when_missing`.
  Además cada corrida deja un directorio colgado en `/tmp` para siempre, porque
  nadie limpia al final.
  El arreglo es **borrar código, no agregarlo**: `tempfile` ya es
  dev-dependency y ya lo usan cinco módulos. `tempfile::tempdir()` es a prueba
  de colisiones por construcción (`O_EXCL` con reintento) y se borra sola al
  dropear el guard. La rama `feat/epub-back-matter` ya convirtió las dos copias
  que había agregado (`autor.rs`, `catalogo.rs`); quedan estas cuatro. Ojo al
  convertir: hay que retener el `TempDir` mientras el test use paths adentro,
  o se borra el directorio a mitad y el test falla peor que ahora.

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

- [x] **Bulk auto-fix, y una vista para revisar el libro entero**
  (`feat/revision-libro`, verificado a mano por el autor el 2026-09-02).
  El item pedía solo el bulk auto-fix del panel "Revisar RAE"; el pedido del
  autor lo amplió a una vista con **una acción por tipo** —explícitamente NO
  una lista unificada de hallazgos— a nivel libro, fuera del editor.

  Spec en `docs/superpowers/specs/2026-09-02-revision-libro-design.md`, plan en
  `docs/superpowers/plans/2026-09-02-revision-libro.md`.

  **Qué es**: botón en la tarjeta del libro → modal que escanea el libro con
  los cuatro detectores (rayas RAE, comillas tipográficas, arreglos RAE,
  repeticiones), muestra qué encontró cada uno, y aplica los tildados.
  Repeticiones va sin checkbox: no son auto-fixables. El panel lateral
  "Revisar RAE" y las entradas del menú contextual quedan como estaban.

  **Lo que resolvió el riesgo que dejó esto afuera de v1**: los offsets de
  `validateRae` son sobre texto plano y el archivo es HTML.
  `planoConMapa` (`dialogos/plano-con-mapa.ts`) construye el plano **y** el
  índice HTML de cada carácter en la misma pasada — incluido el doble-decode
  de entidades de `htmlToPlain`, que se replica y **no se corrige** porque es
  el comportamiento que vieron todas las violaciones calculadas hasta hoy.
  `aplicarFixesHtml` (`dialogos/aplicar-fixes.ts`) aplica en orden descendente
  y **saltea** todo fix cuyo rango HTML contenga un tag: antes de comerse un
  `</em>` en veinte capítulos, no lo aplica y lo reporta.

  **Decisiones de idioma, que fueron lo más delicado**: la cadena es
  `book.json` → `.meta.json` del capítulo → `detectLang` del contenido, en ese
  orden, resuelta en `resolverIdiomaEfectivo` (`revision/deteccion.ts`). El
  libro manda porque las novelas del autor son de un idioma con citas sueltas
  en otro: un capítulo sin idioma en su meta y con una cita en inglés se
  clasificaba como inglés y recibía comillas tipográficas inglesas. Un idioma
  en blanco cuenta como ausente (`??` no atrapa `""`). El gate diverge a
  propósito del `canApplyRae` del editor: allá hay un humano mirando un diff,
  acá se escribe un libro entero desatendido.

  **`pending-conversion` salió del bucket de arreglos RAE** y quedó solo en
  rayas: su `autoFix` ES la conversión del converter, así que tildando solo
  "arreglos RAE" el diálogo se convertía igual, y el escaneo contaba el mismo
  cambio en dos filas.

  **Sabido y no resuelto**: aplicar rayas sobre un capítulo con diálogo real
  también aplana comillas tipográficas de citas no dialogadas del mismo
  capítulo. `convert()` normaliza comillas en una sola pasada sobre todo el
  HTML y el guard solo decide si conviene invocarlo. Mismo comportamiento que
  el botón "RAE" del toolbar, pero acá es desatendido.

  **Diferido**: el conteo de arreglos RAE se calcula sobre el HTML original y
  aplicar lo calcula sobre el ya transformado (el encadenamiento es correcto,
  el número no es una predicción exacta); `rae-audit-service.ts:50` cuenta los
  auto-fixables incluyendo `pending-conversion`, así que su número no coincide
  con el del modal; y `quotes-fix-service::fixScope` no informa cuántos
  capítulos escribió si falla a mitad de camino.

- **El ancla de D1 no tolera markup inline de apertura** (limitación del
  converter, no del popover): la regla D1 ancla el diálogo con `^(\s*)"`, o sea
  que la comilla de apertura tiene que ser el primer carácter no-espacio del
  texto del párrafo. Si el párrafo arranca con un tag —`<em>"Vení"</em>, dijo
  ella.`, típico de un `.docx` importado donde el diálogo va en cursiva— el tag
  corre la comilla y la regla no dispara. Como el ancla es del converter, **el
  agujero es el mismo por los dos caminos**: ni el popover inline
  ("Aplicar RAE al párrafo") ni el botón "RAE" del toolbar (capítulo entero)
  convierten ese párrafo. Hoy el popover al menos avisa con un toast en vez de
  quedarse mudo; el botón del toolbar lo saltea en silencio. Arreglo de fondo:
  que el converter tolere tags inline antes de la comilla de apertura —
  reconocer el prefijo de markup y anclar sobre el texto, no sobre el string
  crudo.
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

- [x] **Levantar LanguageTool sin saber de containers** — spec en
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
  status. **Verificado a mano en macOS** el 2026-07-30 (`container system stop`
  → mensaje del daemon caído, el botón haciendo las dos capas, el chip copiando
  el comando pelado, el container detenido con el daemon arriba, y la lista de
  instalación sin runtime).
- [x] **`detect_installed` elige runtime sin saber cuál es dueño del container**:
  con el daemon caído, `detect_engine()` devuelve `None` y `detect_installed()`
  (`grammar.rs:265-269`) toma el **primer** runtime instalado por orden de
  `Runtime::ALL` (Docker, Podman, Apple), que no tiene nada que ver con cuál
  de ellos tiene levantado el container `twriter-languagetool`. Antes esto
  solo afectaba un mensaje; ahora la app **ejecuta** el remedio
  (`languagetool_docker_start`), así que en una máquina con `docker` y
  `container` instalados y los dos daemons caídos, un click arranca Docker,
  baja ~300MB de imagen y crea un **segundo** container ahí mientras el real
  duerme en Apple `container`. **Fix propuesto**: persistir en settings el
  último runtime que `detect_engine()` vio con el container corriendo o
  existente, y que `detect_installed` lo prefiera sobre el orden fijo de
  `Runtime::ALL` cuando esté presente y siga instalado. Quedó fuera de alcance
  de la ronda final de `feat/languagetool-setup-seamless` porque pide tocar el
  modelo de settings, no solo `grammar.rs`.
  **Estado**: implementado en `fix/lt-runtime-recordado` — spec en
  `docs/superpowers/specs/2026-07-30-lt-runtime-recordado-design.md`.
  `pick_runtime(installed, remembered)` es la única fuente de la decisión
  (pura, testeada en matriz), el runtime se recuerda en el campo
  `languagetoolRuntime` de `settings.json` cuando la app ve el container
  corriendo o existente, y `set_settings` lo protege del round-trip del
  frontend vía `merge_backend_owned` (el front no conoce el campo). Cuando hay
  varios runtimes instalados, ninguno respondiendo y nada recordado, el status
  devuelve `runtime_choices` y la UI ofrece un botón por candidato en vez de
  adivinar. Un daemon vivo gana la ambigüedad (`resolve_start_runtime`): sin
  eso, una máquina con Docker levantado y Apple container instalado quedaba en
  un callejón sin salida — el status decía "container detenido" y el botón
  devolvía "ninguno está respondiendo", una pregunta que esa rama de la UI no
  ofrece cómo contestar.
  **Verificado a mano** en macOS (M5, Darwin 25.6, 2026-07-30) con la app en
  dev y el container corriendo en Apple `container`: el autor confirmó que se
  recuerda `"languagetoolRuntime": "apple"`, que el campo sobrevive a un
  `set_settings` disparado desde el frontend (cambiar el tamaño de fuente del
  editor — el test de regresión de `merge_backend_owned`), y que con el daemon
  caído la UI nombra Apple container y el botón levanta las dos capas. La rama
  de ambigüedad **no se probó a mano**: esta Mac tiene un solo runtime
  instalado, así que `pick_runtime` siempre devuelve `Chosen` y esa rama no se
  puede disparar sin stubear un binario. Queda cubierta solo por los tests de
  Rust.

  Diferido, anotado acá para no perderlo: el status puede describir el
  container de un runtime mientras `start` opera sobre otro (recordado con
  daemon caído + otro vivo sin container) — el comportamiento final es
  correcto, lo falso es el diagnóstico; el arreglo bueno es unificar la
  decisión entre `status`/`start`/`stop`. Tampoco hay forma in-app de corregir
  un runtime recordado equivocado: una vez que el pick es `Chosen`, los botones
  de elección no vuelven a aparecer.
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
- [x] **Verificar auto-update en macOS (app ad-hoc, sin notarizar)**: los builds
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

  **Verificado a mano** en macOS (M5, Darwin 25.6, 2026-07-31) con el release
  `v0.7.3`: el autor aceptó el banner de update sobre una instalación vieja y la
  app se reemplazó y arrancó limpia. **Gatekeeper no puso el `.app` bajado en
  cuarentena y no hizo falta ningún workaround** — ni `xattr` ni click derecho →
  Abrir. O sea que la firma ad-hoc alcanza para el auto-update y no hace falta
  el Developer ID ($99/año) para este flujo. La fricción del ad-hoc sigue siendo
  solo la del **primer** arranque tras bajar el `.dmg` a mano, que ya está
  documentada en las notas del release.
- Mobile (no urgente, capaz solo un exportador a EPUB para ver archivos desde gh). Tomador de notas estaría piola, pero no veo que sea posible sincronizar git en el teléfono (Capaz que sí, investigar.) Estaría re zarpado poder tomar notas sobre partes o capítulos mientras leo en la kindle y que queden resgistrados en notas del libro o algo así.
- [ ] **Publicar en Homebrew (cask) para macOS**
  Hoy la instalación en Mac es bajar el `.dmg` a mano del release y comerse el
  primer arranque con Gatekeeper. En Arch ya está resuelto vía AUR
  (`packaging/aur/PKGBUILD` + `publish.sh`); falta el equivalente Mac.
  Las piezas ya están: el job `build-macos` de `.github/workflows/release.yml`
  publica `.dmg` para `aarch64-apple-darwin` y `x86_64-apple-darwin` en el
  release del tag, que es exactamente lo que un cask necesita — URL estable por
  versión + `sha256` por arch (`on_arm` / `on_intel`).
  **Tap propio** (`T4toh/homebrew-twriter`), no homebrew-cask oficial: el repo
  central pide notoriedad (estrellas/forks) y la app no está notarizada, solo
  firmada ad-hoc (`signingIdentity: "-"`). En un tap propio eso no bloquea, pero
  el cask conviene que declare el trámite de cuarentena para que
  `brew install --cask` no termine en el "está dañada" que ya nos comimos.
  **Trabajo**: un `Casks/twriter.rb` con `version`, `sha256 arm/intel`, `app
  "tWriter.app"`, `zap` de `~/Library/Application Support/tWriter`, y un paso en
  el workflow de release que reescriba versión + hashes y commitee al tap
  (espejo de `packaging/aur/publish.sh`). Ojo con el updater de Tauri: si la app
  se auto-actualiza, el cask queda desfasado respecto del `.app` instalado
  — o se documenta que en Mac gana el updater, o el cask lleva
  `auto_updates true` para que `brew upgrade` no pelee.

## Proofreading

- [ ] **El ciclo de correcciones vive en un txt y es un garrón** (para pensar
  fuerte un día, todavía no hay diseño)
  Flujo actual: se lee en la Kindle, se anotan las frases a cambiar en un `.txt`
  suelto, y después hay que ir una por una copiando la frase a la búsqueda,
  encontrar el capítulo, arreglar, y acordarse de tachar la línea del txt. Nada
  de eso lo sabe la app: no hay estado de "pendiente / arreglado", no hay link
  entre la anotación y el lugar del texto, y el ida y vuelta entre la nota y el
  panel de búsqueda encima se pelea con el slot único del panel derecho (ver el
  ítem de la nota que se cierra al buscar, en `## Búsqueda`).
  **Esto va en una app aparte, no adentro de tWriter**: la lectura pasa en la
  Kindle y las anotaciones se toman en el celular o la tablet, lejos de la
  compu. El punto de captura no es el escritorio, así que lo que hace falta es
  algo para anotar en el teléfono y después poder buscar fácil, y tWriter queda
  del otro lado como consumidor de esas anotaciones. Emparentado con el bullet
  de Mobile al final de `## Plataformas` (tomar notas desde la Kindle/teléfono y
  que queden registradas contra el libro) — probablemente sean la misma app.
  **Lo no resuelto del lado móvil**: cómo llega la anotación de la tablet al
  repo. Sincronizar git desde el teléfono es la duda vieja de ese bullet; las
  alternativas son un formato de intercambio tonto (un archivo por sesión de
  lectura que se copia a mano) o un backend, que es muchísimo más app.
  **Direcciones posibles del lado tWriter**, sin elegir todavía:
  (a) marcar desde adentro de la app — una marca de revisión sobre la selección
      en el editor, tipo comentario/anotación anclada al texto, con estado y
      una lista lateral para recorrerlas;
  (b) importar la lista de correcciones — que la app resuelva cada línea a un
      hit de búsqueda, con checkbox y salto directo. Es la que respeta cómo se
      anota hoy y la que conecta con la app móvil;
  (c) las dos: (b) es la que sirve mañana, (a) es más prolija pero solo cubre lo
      que se detecta con la app abierta.
  Ojo con anclar: si la marca guarda un offset, editar el capítulo la desancla.
  Anclar por texto de la frase (como hace la búsqueda) es más frágil pero
  sobrevive a las ediciones de alrededor. Decidir esto es la mitad del diseño.
  Lo que ya está y sirve de base: el índice tantivy con `matchedTerms`, el
  highlight/salto del editor, y las notas por saga (una lista de correcciones
  es una nota con estado).
