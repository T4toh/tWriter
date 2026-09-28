# TODO

Pendientes, bugs conocidos y mejoras planificadas de tWriter. Issues concretos van a GitHub Issues; acá quedan ideas, refactors abiertos y diseño en discusión.

Lo que ya está hecho **no vive más acá**: las features están documentadas en
[README.md](README.md) (sección Features) y el detalle de causa raíz de cada
arreglo queda en el historial de git de este archivo (`git log -p TODO.md`).

Lo **medido y descartado** tampoco: los relevamientos cerrados (por qué no se
cambió el speller, por qué LT no va como sidecar, qué mide el corpus) viven en
[docs/decisiones-cerradas.md](docs/decisiones-cerradas.md). Van ahí para no
rehacer la medición, no para volver a discutirlos. Antes de abrir un item que
huela a "esto ya lo miramos", buscar ahí primero.

## Editor / UX

- Más variantes de divisor de escena (más allá del `* * *`).
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
     estilo en `editor.scss:558`), que el effect de `editor.ts:731` pinta
     desde `search.highlightTerms()`. Ese computed depende de
     `search.open()` + `search.query()`, así que la marca **es viva a
     propósito** mientras el panel de búsqueda esté abierto: clickear en otra
     parte del párrafo no la borra ni debería. Si esto es lo que se ve, no es
     un bug de cleanup — es la decisión de "resaltar todas las ocurrencias
     mientras buscás", y el cambio sería de diseño.
  2. La **selección nativa** de `highlightFirstMatch`
     (`core/search-highlight.ts`), que sí se va al clickear. Sobre un em-dash
     entra por el camino de `rae-audit-panel.ts:81`, que pasa como término el
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
  - **`onUpdate` hace `editor.getHTML()` en cada tecla** (`editor.ts:2128`) y
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

  Del lado del árbol: las claves huérfanas de `stats.json` tras un rename ya
  las remapea `reconciliar_stats` (ver README → Tree explorer). Queda como
  costo estructural que un capítulo nunca guardado por la app se recuente en
  cada carga del árbol (`chapter_word_count` lee y cuenta el HTML cuando no
  hay clave); si alguna vez molesta, cachear por mtime.
- **El `resize` reposiciona los popovers con el ancla vieja**: el cierre por
  scroll y el reposicionamiento ya andan (`popover-position.ts`), pero cada
  popover maneja el `resize` por su cuenta (`afterRenderEffect` + listener de
  `window`) y reejecuta `placePopover` con las coordenadas de ancla de antes.
  Si al redimensionar el texto se reacomoda, el flotante queda desfasado.
  Necesita recalcular el rect del ancla, no reusar el guardado.
- **Dos capítulos abiertos rápido y te podés quedar en el equivocado.**
  `openInPane` (`chapter-service.ts:124`) no tiene forma de saber que llegó
  tarde: si clickeás el capítulo A y enseguida el B, las dos lecturas están en
  vuelo a la vez y **gana la que resuelve última**, no la que pediste última.
  Con una lectura lenta (capítulo grande, disco en la nube) terminás con el
  árbol marcando B y el editor mostrando A. El fix es un contador de
  generación: `openInPane` se lo lleva al entrar y descarta todo si cambió al
  volver de los `await`. No medido todavía — anotado leyendo el código el
  2026-09-22, mientras se investigaba un supuesto swap de partes que al final
  **no era un bug** (el autor había cortado y pegado el texto a mano; el
  historial del repo de novelas lo muestra creciendo por autosave toda la
  noche en `4.html` y mudándose a `3.html` en dos saves normales).
- **Abrir los `.epub` de `Exportados` adentro de la app** (resto del pedido
  del autor del 2026-09-22, "poner EPUB y esas yerbas"; el zoom del visor de
  imágenes salió en #154). **Falta decidir el alcance** antes de tocar código: un
  renderer de EPUB embebido es otra cosa que un lightbox. Hoy los `.epub`
  salen al visor del OS (ver "Abrir la carpeta del EPUB exportado" en EPUB).

## Gramática, ortografía y tesauro

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

- **Guionado para el EPUB**. rla-es trae `separacion/hyph_es.dic`, **6.207
  patrones** (Javier Bezos / CervanTeX). Sirve para justificado con separación
  en sílabas en el export. Nada que ver con el corrector, pero sale del mismo
  repo y es acotado. Cruza con el item de tipografía del EPUB.

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
  guarda el mensaje en `grammar.lastError` y el footer de `editor.html`
  (`@if (grammarError(); as err)`) lo pinta como
  indicador crudo (`LanguageTool 500 Internal Server Error: …`),
  o sea jargon de HTTP en un lugar fácil de no ver, mientras el capítulo queda
  **entero sin marcas** porque el `check` tira. Merece el trato accionable del
  CLAUDE.md: decir que el chequeo de *este* capítulo falló y ofrecer reintentar,
  en vez de tirar el status HTTP a la barra de estado.

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

  > **Actualizado el 2026-08-20 y corregido el 2026-08-21.** El 08-20 esta
  > lista se reescribió alrededor de **bundlear LT como sidecar**; el 08-21 el
  > autor lo **descartó** por el costo de mantener el pipeline de build (ver
  > "LT embebido como sidecar — DESCARTADO"). Docker se queda. Harper queda
  > **descartado** con datos, no por el idioma (ver "Alternativas de motor
  > evaluadas y descartadas"). `zspell`/`hunspell` sigue en pie con su rol
  > original: la red para seguir marcando typos cuando LT está caído, y la
  > pieza que quedaría si en 6 meses se decide tirar LT, apoyada en las
  > reglas propias en TS.

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
  - ~~`level=picky`~~ **hecho** (ver README → Gramática): toggle "Modo
    exigente", `grammarPicky` en `settings.json`, `grammar.rs::level_for`.
    Solo suma matches en inglés.
  - ~~`disabledRules`~~ **hecho** (ver README → Gramática): el popover muestra
    el `ruleId` y "Nunca más esta regla" lo persiste en
    `saga.json::reglas_lt_desactivadas`. Queda pendiente `enabledOnly`, que es
    la punta opuesta —correr SOLO un set de reglas— y no tiene caso de uso
    todavía.
    **Regla concreta ya identificada**, que hoy se apaga desde el popover: con `picky` prendido, LT marca `Shit`
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
- [ ] **La oración se parte en los puntos suspensivos** (encontrado el
  2026-09-18 midiendo el parche `0004`). Cuando a los puntos suspensivos les
  sigue un `¿` o una mayúscula, LT cierra la oración ahí: «prestame tu…
  ¿fuego?» queda como dos oraciones, el sustantivo cae en la segunda y ningún
  antipatrón llega a verlo. Son los 2 hits de `TU_TILDE` que el parche no pudo
  arreglar sobre el corpus, y el delator es que en esas mismas frases salta
  `UPPERCASE_SENTENCE_START`. El arreglo va en `segment.srx`, no en
  `grammar.xml`, así que es un parche aparte y todavía sin escribir. Detalle y
  la salida del tagger que lo prueba, en `docs/lt-patches/README.md`.

## Búsqueda

- **Varios hits del mismo capítulo mandan todos al mismo lugar**: el salto ya
  cae en el bloque correcto (`pickBestBlock` + ancla de texto), pero cuando un
  capítulo tiene N apariciones, las N líneas del grupo llevan al **mejor**
  bloque, no una a cada aparición. Para distinguirlas hace falta o el offset
  real de cada ocurrencia desde el backend, o navegación prev/next sobre los
  matches del capítulo abierto (que además sirve sin volver al panel).
- **Autocompletar términos del proyecto**: tipear `kel` y que sugiera `Kallai`,
  para atacar de raíz el "me olvido cómo se escribe" que hoy se compensa con el
  modo fuzzy. **Herramienta viable**: `@tiptap/suggestion` para el popup inline,
  alimentado por el diccionario per-saga (`<saga>/diccionario.txt`) + prefix
  query sobre el índice tantivy — offline, determinista, cero red. LanguageTool
  NO sirve: expone `/v2/check` y diccionario personal Premium, no tiene API de
  completion. Hunspell (`zspell`/`hunspell-rs`) da ortografía ES pero no
  completa nombres propios inventados, que es el caso real. Cuando se haga,
  tiene que sugerir los **términos compuestos enteros** (`Kun Lian`, no `Kun`) —
  el diccionario ya los separa al cargar, la primitiva de match por frase está
  en `dictionary/compound-terms.ts` y la búsqueda por frase es la misma vista
  desde el otro lado, hoy sin compartir.

## Tree / Importer

- Re-importar capítulo sobrescribiendo el `.html` existente (hoy hay que borrar primero).
- Sumar más importers de notas: Obsidian (vault con `.obsidian/`), Notion (export ZIP), Bear (`.bear`), Logseq (graph), Markdown plano con frontmatter. El trait `NoteImporter` ya está armado — agregar uno nuevo no requiere tocar el wizard genérico.
- Joplin JEX format (preserva adjuntos + tags + timestamps). Hoy solo soporta el export raw MD.
- **Plantillas para el back matter** (idea del autor, 2026-09-02, no para ahora).
  Hoy la página "Otros libros" y la de "Sobre el autor" tienen un solo diseño
  cableado en `epub_style.css`. La idea es ofrecer un par de variantes —tapa
  centrada contra tapa al costado, con sinopsis o sin ella, una columna o
  dos— igual que ya existen plantillas de tamaño de página para el EPUB.
  Cruza con el ítem de blurb y sinopsis: recién cuando esos campos existan hay
  material suficiente para que las variantes se diferencien en algo más que el
  espaciado.

## EPUB

- **Formatear para libro físico (interior para imprenta)** (idea del autor,
  2026-09-11). Hoy el único artefacto es el EPUB. Para KDP / IngramSpark /
  imprenta local hace falta un **PDF de interior** con cosas que el EPUB no
  tiene ni puede tener: tamaño de página fijo, **márgenes espejados** con
  medianil (gutter) según cantidad de páginas, folios y cabeceras corridas
  (título del libro en par, capítulo en impar), control de viudas/huérfanas,
  páginas en blanco para que cada capítulo arranque en impar, y fuentes
  embebidas.

  Qué hay para reusar: los templates `6x9`/`5x8`/`a5` de `page_rule_for`
  (`epub.rs:134`) ya son tamaños de trim de imprenta, y `epub_style.css` es un
  CSS paginado a medias. Camino más corto a evaluar antes de escribir nada:
  1. **Paged.js** dentro del webview de Tauri (mismo HTML de las partes +
     `@page :left/:right` para espejar) y "imprimir a PDF" desde la ventana.
     Cero binarios nuevos; el riesgo es la calidad tipográfica de Chromium/
     WebKitGTK (sin partición de palabras decente en español ni control de
     viudas real).
  2. **Typst** como sidecar detectado igual que pandoc/epubcheck: HTML → Typst
     es una conversión chica (el subset es `p`/`em`/`strong`/`hr`/`h1`/
     `blockquote`), y Typst resuelve hyphenation, viudas, folios y espejado
     nativo. Es el que da salida de imprenta de verdad.
  3. Pandoc → PDF vía LaTeX: ya se detecta pandoc, pero arrastra una TeX Live
     de 1 GB; descartado salvo que el autor ya la tenga.

  Alcance mínimo que vale: elegir trim + margen interior/exterior, exportar
  PDF, y que la tapa sea otro tema (la tapa de imprenta con lomo es un
  problema aparte que depende del conteo de páginas final). Preguntar al
  autor si el destino es KDP (tiene reglas fijas de márgenes por rango de
  páginas, se pueden codificar) antes de diseñar la UI.
- **Abrir la carpeta del EPUB exportado / abrirlo en el visor**: al terminar el
  export la app dice dónde quedó el archivo y ahí muere; el autor tiene que ir a
  buscarlo a mano. Sumar en el aviso de export exitoso dos acciones: "Mostrar en
  la carpeta" y "Abrir" (visor EPUB default del OS). `tauri-plugin-opener` ya
  está instalado y registrado (`lib.rs:114`), así que es `reveal_item_in_dir` +
  `opener::open_path`, sin dependencia nueva.
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

- **Limpiar `autor` de los `book.json` del repo de novelas**. La parte de la
  app ya está: `epub.rs` resuelve `autor.json` → `book.json` → `saga.json` y
  el campo salió del modal del libro (decidido con el autor el 2026-09-01).
  Lo que queda es de contenido: 43 `book.json` de `~/novelas` todavía
  tienen `autor` cargado (contado el 2026-09-14) y ahora es un fallback muerto. Borrarlo es un `jq`
  sobre el repo de novelas, no toca este repo; y solo tiene sentido cuando
  las dos PCs corran una versión que ya lea `autor.json`.

- **Tapa que no existe: avisar en vez de placeholder mudo.** Lo que quedó afuera
  del item de arriba: si no hay **ninguna** imagen al lado, `CoverCache.urlFor`
  tira y la UI cae al placeholder sin decir nada, y el EPUB se exporta sin
  portada en silencio (`epub.rs::embed_image` devuelve `Ok(None)`). Contra la
  convención "el remedio se da adentro de la app": tiene que mostrar el path que
  no existe y el botón "Elegir otra", y el export avisar que salió sin portada.
- Preview tipo Kindle (B/N, distintos tamaños — Paperwhite, Oasis, Scribe). Amazon discontinuó Kindle Previewer en Linux.
- Pesos extra de fuente (300 Light, 600 SemiBold, 900 Black). Hoy solo Regular/Bold/Italic/BoldItalic; pesos custom requieren edit manual del `theme.json`.
- Auto-migración de tema renombrado: hoy renombrar un tema deja sagas/libros con `base` dangling (warning). Implementar scan recursivo de `*.json` y rewrite del `base`.
- Colores en el tema (body color, heading color, scene-break color). Hoy el tema es solo tipografía + márgenes.
- Theme presets compartibles entre repos distintos (export/import como zip).
- Revisiones de EPUB: hoy sobreescribe siempre `Exportados/<titulo>.epub`. Sumar "guardar últimas N revisiones" (default 5) — renombrar la actual a `<titulo>-revN.epub` antes de generar la nueva.

## Deuda transversal

- **`shared/select.ts` lee un campo plano bajo OnPush** (quedó de la
  migración a OnPush, cerrada el 2026-09-14 — detalle en `git log -p TODO.md`).
  `disabledByForm` se muta en `setDisabledState` (Forms API) y `isDisabled()`
  lo lee desde el template;
  el componente ya era OnPush, así que si algún día un `app-select` se
  deshabilita vía `FormControl`/`ngModel` en vez de `[disabled]`, no repinta.
  Hoy no pasa: el único `ngModel` sobre `app-select` (export-modal) no toca
  disabled. Fix cuando haga falta: `signal(false)`.
- **Contraste AA de `--ok` y `--warn` en tema claro** (quedó de la auditoría
  del SCSS, cerrada el 2026-09-08 — el detalle está en `git log -p TODO.md`).
  `--ok` sobre su tinte da ~4.3:1 y `--warn` ~3.4:1, los dos por debajo del
  4.5 de AA para texto normal; bajar el alfa del tinte no alcanza porque los
  tokens ya arrancan cerca de la línea sobre el fondo pelado (4.75 y 3.69).
  La salida es oscurecer `--ok` y `--warn` en el tema claro, pero eso cambia
  TODOS sus usos y no solo los recuadros, así que es una decisión aparte. Hoy
  los afectados son los chips `.ok` y `.warn` de Configuración.
- **Loop de escaneo duplicado en los tres auditores** (`rae-audit-service`,
  `repeticiones-audit-service`, `grammar-audit-service`): `progress` + guard
  de scope + publicación incremental es casi el mismo en los tres, y no se
  unificó porque las tres firmas de `progress` difieren. Si aparece un cuarto
  auditor, ahí sí conviene el helper de loop. `yieldToEventLoop` ya está
  compartido en `core/yield-to-event-loop.ts`.
- **Criterio para cualquier pasada de duplicación futura**: se unifica lo que
  ya está duplicado y duele, no lo que podría llegar a compartirse. Dos copias
  iguales se unifican; dos copias parecidas que divergieron a propósito, no. Y
  antes de unificar una función duplicada, preguntarse si el framework ya la
  trae (`formatDate` ×4 se resolvió borrándola: era `DatePipe`).

## Documentación

- [ ] **Wiki o sitio de docs; el README quedó demasiado grande** (pedido del
  autor el 2026-09-14). Hoy `README.md` tiene ~1.000 líneas y mezcla cuatro
  cosas para cuatro lectores distintos: instalación (usuario nuevo), features
  con detalle de implementación (mantenedor), configuración avanzada de LT
  (usuario que ya usa la app) y setup de desarrollo + release (autor). Cada
  PR le suma un párrafo a Features y nadie lo lee de punta a punta.
  Lo que hace falta:
  - **Explicar el flujo** de punta a punta, que hoy no está escrito en ningún
    lado como recorrido: importar o crear → escribir → RAE → gramática y
    repeticiones → revisión por libro → export EPUB → publicar. El README
    lista features por área, no el camino que recorre una novela.
  - **Separar por lector**: instalación y primer uso; guía del flujo; referencia
    de configuración (LT, temas, layout del repo de novelas); y lo de
    desarrollo (setup, tests, release, AUR), que se puede quedar en el repo.
  - **Dónde**: GitHub Wiki es lo más barato (cero build, editable desde la web)
    pero no viaja con el repo ni se versiona con los PR. Alternativa: `docs/`
    en Markdown dentro del repo, que se puede publicar con GitHub Pages sin
    tooling (o con `mkdocs` si se quiere navegación); ya existe `docs/` con los
    specs y los patches de LT. Decidir con el autor antes de mover nada.
  - **El README queda como landing**: qué es, captura, instalación por OS, link
    a la guía. El detalle de implementación por feature (lo que hoy es la
    sección Features) va a la referencia, y CLAUDE.md sigue siendo lo que lee
    el agente, no el usuario.

## Archivos

- Changelog screen in-app: panel/modal accesible desde el header (junto a «Acerca de») parseando `CHANGELOG.md` o release notes de GitHub. Útil para gente nueva post-AUR.
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

## Observabilidad / Stats

- Diff/historial visual via `git log`.
- Stats: gráfico palabras/día.
- Preview pre-push: hoy el indicador del header dice "15 archivos para subir" sin detalle. Tooltip con lista de paths (M/A/D) en hover, y/o dialog "Ver cambios pendientes" con `git status --short` + `git diff --stat`.

## Git / Sync

- **Bug — cambio de carpetas en remoto no refresca el árbol**: si en otra
  PC se crean/renombran/mueven carpetas, hay que recargar el árbol a mano
  para verlas. El refresh post-pull (`loadTree()` sobre `PullPathChange`)
  ya cubre `.html`/`.md`, pero los cambios de estructura de carpetas no se
  reflejan. Verificar si `PullPathChange` reporta dirs y si `loadTree()`
  realmente se dispara para este caso. (Posible que ya esté resuelto —
  confirmar con repro entre dos PCs.)

## Validador RAE

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
- **Las rayas del modal de revisión cuentan capítulos, no ocurrencias**: la
  fila sigue diciendo «N capítulos» porque `ConteoCapitulos` sale de
  `convertFragmentHtml`, que devuelve 0|1 por capítulo. El botón «ver» tapa el
  agujero llevando al panel, donde el conteo real sí está, pero el número del
  modal miente.
- **El salto del panel RAE no abre el popover**: el panel de repeticiones ya
  abre el capítulo con el popover puesto sobre la aparición (`pendingPopover` +
  identificación por palabra normalizada). El panel RAE tiene el mismo salto y
  se quedó sin esa mitad: lleva al bloque y ahí hay que encontrar la violación
  a ojo.

## Plataformas

- Mobile (no urgente, capaz solo un exportador a EPUB para ver archivos desde gh). El tomador de notas para la Kindle quedó descartado el 2026-09-14 (ver `## Proofreading`): no ahorra tipeo contra Keep, y git en el teléfono ya lo resuelven GitJournal / Obsidian con plugin git / Working Copy sin código propio.
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

- [ ] **Lo publicado vs lo que hay en disco** (pedido del autor el 2026-09-14, el
  mismo día que la auditoría de gramática le encontró errores en una novela ya
  publicada). El ciclo de estados y el historial de revisiones ya están hechos
  (`estado: en curso → terminada → publicada` + `revisiones[]` sellado desde el
  export, ver README → «Estado de la novela + revisiones»); lo que sigue sin
  resolver es esto.
  El autor arregló un error y no tiene forma de saber que ese arreglo **no está
  en la edición publicada**: `publicada` es un punto del ciclo, no un punto en el
  tiempo ni una versión del contenido, y `revisiones[]` sella *cuándo* se exportó,
  no *qué* salió. Necesita poder responder «¿qué cambió desde lo que subí?» y,
  cuando corresponda, «ya resubí esto».
  Piezas que ya existen para apoyarse: el repo es git (`git-service`, `git2`), así
  que cada publicación podría guardar el commit (`book.json` →
  `publicaciones: [{fecha, commit, archivo}]`) y el diff contra ese commit da la
  lista exacta de capítulos tocados después; el export ya escribe a `Exportados/`
  con sello de fecha y hora, que es el momento natural para registrarla — el mismo
  modal donde ya vive el checkbox de «marcar revisión».
  No arrancar sin diseñarlo con el autor.

- [ ] **El ciclo de correcciones vive en un txt** (relevado con el autor el
  2026-09-14; hoy no duele lo suficiente para codear)
  Flujo actual: se lee en la Kindle, se anota en Google Keep con el título del
  capítulo, el número de parte y un pedazo de la frase, y en la compu se va
  una por una copiando la frase a la búsqueda, arreglando y tachando. Es
  incómodo pero más rápido que lo anterior, y el autor no lo siente como
  cuello de botella.
  **App móvil propia: descartada.** Anotar «Zunyon 1 + frase» a mano en Keep
  es igual de rápido que elegir capítulo y parte de un select, así que una app
  que conozca el repo no ahorra tipeo. Keep no tiene API para cuentas
  personales, solo «compartir → copiar texto». Si algún día se quiere el
  archivo en el repo directo desde el teléfono, GitJournal u Obsidian con
  plugin git (Android) y Working Copy (iOS) ya lo hacen sin código.
  **Lo único codeable es el lado tWriter**, y solo si la búsqueda una por una
  empieza a pesar: un `arreglos.md` por libro con el formato suelto de Keep tal
  cual (línea de texto = capítulo, línea numérica = parte, después pares
  frase / qué hacer separados por blanco), y un panel que lo muestre como lista
  con capítulo y parte resueltos contra el árbol, checkbox por ítem y salto al
  hit de la frase en el editor; tildar reescribe la línea en el archivo. Anclar
  por texto de la frase, no por offset: editar el capítulo desancla el offset.
  Base que ya está: el índice tantivy con `matchedTerms`, el highlight/salto del
  editor y las notas por saga.
