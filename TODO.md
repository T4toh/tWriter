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

## Gramática, ortografía y tesauro

> **Relevamiento del 2026-08-20.** Todo lo de abajo está medido contra el
> container local (LT 6.8 OSS, `premium: false`) y contra
> [`sbosio/rla-es`](https://github.com/sbosio/rla-es) clonado, no supuesto.
> Punto de partida: el español de LT es flaco y queríamos saber cuánto y por qué.
>
> **El número que resume todo**, contado dentro del container:
>
> | | `grammar.xml` | reglas `<rule>` | pares en `confusion_sets.txt` |
> |---|---|---|---|
> | en | 142.323 líneas | **1.772** | **782** |
> | es | 36.419 líneas | **296** | **5** |
>
> Seis veces menos reglas y 156 veces menos pares de confusión. El motor es el
> mismo — lo que falta son las reglas escritas.

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
  y acá sí conviene Rust: son ~3 MB de datos que no queremos mandar por el
  bridge ni tener en el heap del webview — se lee el `.dat` entero una vez
  por idioma a un `String` en el heap de Rust (cacheado en un `OnceLock`) y
  por el bridge cruza solo la entrada consultada. Sin `.idx` ni `seek`: con
  9 MB entre los dos idiomas una pasada entera al arrancar no se nota.

  **Corrección al relevamiento de acá arriba**: la línea vieja decía "sin
  equivalente en inglés en este repo: rla-es es solo español, para la mitad
  inglesa habría que buscar otro MyThes aparte". **Eso es falso** — se
  encontró `th_en_US_v2.dat` en la extensión `dict-en` de LibreOffice
  (`/Applications/LibreOffice.app/Contents/Resources/extensions/`), que sale
  de WordNet 2.1 (Princeton) y no de rla-es. Crudo: 145.866 entradas, 18,5
  MB. El inglés sí distingue categoría gramatical y trae hiperónimos
  etiquetados (`(generic term)`) que WordNet no separa de los sinónimos
  reales:
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
  `OnceLock` por idioma, comando `tesauro_lookup`, 10 tests inline).
  Frontend en `src/app/core/tesauro-service.ts` (caché de 50 consultas) y los
  chips del popover de repeticiones (ver el sub-item de más arriba), más
  `Ctrl+Shift+S` sobre la palabra bajo el cursor (`src/app/editor/palabra-en.ts`
  + `scripts/run-tesauro-smoke.mjs`, 10 casos) para abrir el mismo popover en
  modo tesauro sin estar sobre una repetición. **Falta la verificación a mano
  del autor** con la app levantada — no se marca `[x]` hasta entonces.

- **Guionado para el EPUB**. rla-es trae `separacion/hyph_es.dic`, **6.207
  patrones** (Javier Bezos / CervanTeX). Sirve para justificado con separación
  en sílabas en el export. Nada que ver con el corrector, pero sale del mismo
  repo y es acotado. Cruza con el item de tipografía del EPUB.

- **Escribir reglas propias de LT en XML** — el camino más realista si algún
  día se encara el español en serio, y **no requiere construir un motor**. Las
  296 reglas de español son patrones XML en
  `/LanguageTool/org/languagetool/rules/es/grammar.xml`, y está verificado que
  es un **archivo suelto en el filesystem del container, NO adentro de un
  jar** — o sea que un bind-mount lo puede sobrescribir sin recompilar.
  **Pendiente de spike**: confirmar que el server levanta el override montado
  (que el archivo exista y sea montable no prueba que lo lea desde ahí).
  Alternativa sin container en el medio: sumar reglas al validador que ya
  existe (`converter.ts` + `rules-dedicated.ts` + `validator.ts`), que es el
  precedente probado del repo para reglas del español.

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
  - **Semántica / estilo por LLM** — es lo único que de verdad supera a LT
    en prosa literaria española (ve registro, repetición, ritmo, cosas que
    ningún motor de reglas alcanza). **Descartado por ahora, decisión
    explícita del autor**: levantar un Ollama es demasiada carga operativa
    para el usuario final. Si algún día entra, entra **embebido** (modelo
    chico bundleado o llama.cpp linkeado), nunca como "instalate esto
    aparte". Ojo con dos cosas cuando se retome: no devuelve offsets
    estables — hay que mapear por diff en vez de por `offset`+`length` — y
    va como feature aparte, jamás reemplazando el inline.
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
