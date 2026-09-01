# TODO

Pendientes, bugs conocidos y mejoras planificadas de tWriter. Issues concretos van a GitHub Issues; acá quedan ideas, refactors abiertos y diseño en discusión.

## Editor / UX

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

- **Tesauro de sinónimos embebido** (español **e inglés**). rla-es trae
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
  escritorio. **Falta la verificación a mano del autor** con la app levantada —
  no se marca `[x]` hasta entonces.

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

- **Renombrar una carpeta fuera de la app deja estado local huérfano.**
  Encontrado el 2026-08-20 numerando las sagas a mano (`Milky Way` →
  `3 - Milky Way`, `Vieja República` → `4 - Vieja República`). El rename por
  git es limpio para el contenido — 1.256 renames, 0 cambios de contenido —
  pero **dos archivos locales quedan apuntando a los paths viejos**, y ninguno
  viaja por git porque `.twriter/` está gitignoreado:
  - `.twriter/stats.json` está **keyeado por path relativo**
    (`Milky Way/1 - Deployment/4 - Work/3.html`). En el rename quedaron 294 de
    533 claves huérfanas → se pierden palabras y última-edición de esos
    capítulos. Hay que reescribir el prefijo de las claves.
  - `.twriter/search-index` indexa por path → hay que borrarlo para que
    reindexe.
  - `settings.json` (`app_config_dir`) guarda **paths absolutos** en
    `treeExpanded` (115 entradas) y `lastSession.chapterPath`. Si el capítulo
    abierto estaba en la saga renombrada, la sesión no se restaura.

  **Esto va contra el principio del CLAUDE.md** ("el remedio se da adentro de
  la app"): la app puede detectar el problema y no lo hace. Al abrir el root
  ya camina el árbol, así que tiene todo para notar que una clave de
  `stats.json` no corresponde a ningún archivo en disco. Arreglo propuesto,
  de menor a mayor:
  1. **Barato y suficiente**: al cargar `stats.json`, descartar las claves
     cuyo archivo no existe. Se pierde el histórico de esos capítulos pero
     el archivo no crece con basura para siempre. Una línea de filtro.
  2. **Lo correcto**: detectar el rename. Git ya sabe que fue un rename
     (`R100`); `git.rs` puede pedirle a libgit2 los renames entre HEAD y el
     commit anterior y remapear las claves de `stats.json` en consecuencia.
     Cubre también el caso de que el rename lo haya hecho la otra PC y llegue
     por pull — que es el caso que más duele, porque ahí el autor no hizo nada
     y las estadísticas se evaporan igual.
  3. Purgar de `treeExpanded` los paths que ya no existen (hoy hay 16
     huérfanos acumulados de reorganizaciones viejas, inocuos pero sucios).

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

## EPUB

- **Copyright editable en ambos idiomas** (ES/EN): hoy el texto de la
  página de copyright sale fijo/auto-generado. Permitir editar el cuerpo y
  que cambie según el `idioma` del libro.
- **Incisos extra de copyright tipo Reedsy**: sumar cláusulas opcionales
  (reserva de derechos, "obra de ficción / personajes ficticios",
  prohibición de reproducción, etc.) elegibles al armar la página legal,
  bilingües como el copyright.
- **Nota de uso de IA en la página legal** (pedido del autor, 2026-09-01): inciso
  opcional que declare que la IA se usó **solo para generar imágenes** — el texto
  lo escribe el autor. Va como una cláusula más del item de arriba (bilingüe
  ES/EN, elegible al armar la página legal), no como texto fijo: hay libros sin
  imágenes generadas. Redacción tipo "Las imágenes de esta obra fueron generadas
  con inteligencia artificial. El texto es obra exclusiva del autor." / "The
  images in this work were generated with artificial intelligence. The text is
  the sole work of the author."
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
- [x] **Fix de `pending-conversion` desde popover inline**: hoy aplica el
  replacement del converter como plain text sobre el rango del párrafo, lo
  que strip-ea inline markup en ese párrafo. Para párrafos con markup, usar
  el botón "RAE" del toolbar (modal de capítulo entero) que sí preserva
  markup vía el path `<p>…</p>` del converter. Solución: serializar el slice
  ProseMirror del párrafo a HTML antes de invocar `convert()`, y replazar el
  rango con el HTML resultante en vez de `insertContent` plano.

  **Estado**: implementado en `fix/rae-popover-markup` — spec en
  `docs/superpowers/specs/2026-07-30-rae-popover-markup-design.md`.
  `applyRaeParagraph` serializa el rango con `serializeRange`
  (`getHTMLFromFragment` de `@tiptap/core`), lo pasa por `convertFragmentHtml` y
  reinserta HTML con `insertContentAt` — es el rango y no el nodo, porque un
  bloque con `<br>` cuenta como varios párrafos para el validador. De yapa,
  `applyRaeFix` (los fixes puntuales, que tenían el mismo antipatrón con blast
  radius más chico) pasó a una transacción que hereda con `marksAcross` las
  marcas vivas en el span `fixFrom..fixTo`. Tests:
  `scripts/run-rae-apply-smoke.mjs` (7 casos) + `pnpm build`; la parte con DOM
  no es automatizable en este repo (no hay runner con DOM).

  El review final encontró tres cosas que el spec no había visto, arregladas en
  la misma PR. (a) Con markup abriendo el párrafo el ancla de D1 no dispara,
  pero la normalización `“” → ""` sí cambia el string: la transacción se
  disparaba igual, degradaba las comillas tipográficas y no ponía la raya — el
  caso típico de un `.docx` importado con el diálogo en cursiva. Ahora
  `convertFragmentHtml` compara contra el input normalizado (mismo guard que
  `pushPendingConversion`) y devuelve `null`. (b) Ese `null` era un no-op mudo;
  ahora cierra el popover y avisa por toast. (c) `insertContentAt` con un
  **string** toma la rama `isOnlyTextContent` de TipTap y hace
  `tr.insertText(string)`, así que un `&nbsp;` entraba literal al documento y se
  acumulaba en cada aplicación: se parsea a `Fragment` antes de insertar. De
  paso se corrigió la herencia de marcas — `resolve(from).marks()` toma el lado
  equivocado del borde, y el `insertContent` viejo ya usaba `marksAcross`, o sea
  que el primer intento regresaba en el borde izquierdo de una cursiva.

  **Verificado a mano** en macOS (M5, Darwin 25.6, 2026-07-30) con la app en
  dev: el autor probó los seis puntos del checklist — itálica en el medio del
  diálogo sobreviviendo a la conversión, párrafo con markup de apertura cerrando
  con el toast y sin tocar las comillas, mismo resultado por el botón "RAE" del
  toolbar, hard breaks con un solo segmento reemplazado, fix puntual en el borde
  izquierdo de una cursiva quedando en cursiva, y espacio duro sin `&nbsp;`
  literal — y da el comportamiento por bueno.
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
