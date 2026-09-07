# TODO

Pendientes, bugs conocidos y mejoras planificadas de tWriter. Issues concretos van a GitHub Issues; acá quedan ideas, refactors abiertos y diseño en discusión.

Lo que ya está hecho **no vive más acá**: las features están documentadas en
[README.md](README.md) (sección Features) y el detalle de causa raíz de cada
arreglo queda en el historial de git de este archivo (`git log -p TODO.md`).

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
- **El `resize` reposiciona los popovers con el ancla vieja**: el cierre por
  scroll y el reposicionamiento ya andan (`popover-position.ts`), pero cada
  popover maneja el `resize` por su cuenta (`afterRenderEffect` + listener de
  `window`) y reejecuta `placePopover` con las coordenadas de ancla de antes.
  Si al redimensionar el texto se reacomoda, el flotante queda desfasado.
  Necesita recalcular el rect del ancla, no reusar el guardado.

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
- [ ] **Formato de fecha configurable** (pedido del autor el 2026-09-04)
  Hoy `shared/fecha-corta-pipe.ts` está fijo en `es-AR` con día/mes/año de dos
  dígitos (`04/09/26`). Debería salir de Ajustes.
  **Por qué no se usa el locale del sistema, que fue lo primero que se probó**:
  la máquina del autor tiene `LANG=en_GB.UTF-8` y `LC_TIME=es_AR.UTF-8` — el
  idioma en inglés y las fechas en argentino. `Intl` mira `navigator.language`,
  que sale de `LANG` y no de `LC_TIME` (eso es de la libc, el motor JS no lo
  consulta), así que "seguir al sistema" daba formato británico justo en el dato
  donde el sistema decía otra cosa. Le pasó con otras apps y con addons de KDE.
  **Alcance real**, según el autor: hay dos familias que importan, día-mes-año
  y la japonesa/ISO invertida año-mes-día. No hace falta un selector de locales:
  alcanza con un par de opciones y una muestra al lado de cada una.
  Cuando se haga, el campo va en `Settings` **de los dos lados** — la interfaz
  TS y el `struct` de Rust — o serde lo descarta al guardar y la preferencia se
  pierde al reiniciar, sin ningún error (ver la convención en CLAUDE.md).
- **El editor sigue escribiendo `<br>` sin cerrar en los `.html` nuevos**. El
  `close_void_elements()` del export es un parche a la salida, no una cura: los
  archivos fuente quedan en HTML no-XHTML, lo que importa si algún día se leen
  con un parser estricto en vez de con el export actual. Falta encontrar qué
  nodo de TipTap serializa el `<br>` (`hardBreak`, probablemente con su
  serialización default) y hacer que autocierre al guardar el capítulo.

## Deuda transversal

- [ ] **Pasada de generalidades: hay bocha de código repetido, CSS y esas
  yerbas** (pedido del autor el 2026-09-04, después de encontrar el chip de
  botón duplicado entre `book-card` y `saga-header` con medidas distintas)
  No es un refactor grande de una sentada: es una auditoría que liste lo que
  está duplicado, con criterio de qué se unifica y qué no, y después se va
  comiendo de a pedazos. **Lo ya detectado, para no volver a buscarlo**:
  - `findNodeByPath` estaba copiada **cinco** veces (`app.ts`, `tree.ts`,
    `search-panel.ts`, `rae-audit-panel.ts`, `node-actions-service.ts`). Se
    creó `core/tree-utils.ts` y se migraron los dos archivos que la PR del
    panel de repeticiones ya tocaba. **Faltan `app.ts`, `tree.ts` y
    `search-panel.ts`** — mecánico y sin riesgo.
  - `.card-btn` estaba duplicado en `book-card.scss` y `saga-header.scss` con
    medidas distintas (26/16 contra 22/14), que es lo que los hacía ver
    disparejos. Subido a `src/styles.scss`, al lado de `.btn` — que ya se había
    subido por lo mismo, con su comentario explicando el criterio. Queda por
    ver si el patrón aguanta o si conviene un componente `<app-card-btn>`.
  - `yieldToEventLoop` está en `rae-audit-service` y en
    `repeticiones-audit-service`, y el loop de escaneo con `progress` + guard de
    scope + publicación incremental es casi el mismo en los dos. Si aparece un
    tercer auditor, sale un helper.
  - `formatDate` estaba copiada **cuatro** veces (`book-card`, `saga-card`,
    `folder-card`, `landing`), semánticamente idéntica y escrita con llaves
    distintas. **Resuelta borrándola**, no unificándola: era una
    reimplementación a mano de `DatePipe`, que ya trae `shortDate`. Los cuatro
    templates usan el pipe. De paso salió que la app **no registraba locale**,
    así que `LOCALE_ID` era `en-US` y cualquier pipe de fecha o número formateaba
    al revés (`9/5/26` en vez de `5/9/26`); ahora `app.config.ts` registra es-AR.
    Es el mejor ejemplo de la sección: antes de unificar una función duplicada,
    preguntarse si el framework ya la trae.
  - `auditSnippet`/`auditAnchor` ya se unificaron en `core/audit-snippet.ts` —
    ese es el ejemplo de cómo debería quedar el resto: módulo puro, con smoke
    runner, y el comentario del porqué en un solo lugar.
  **Qué mirar cuando se haga**: los `.scss` de componente que redefinen lo que
  ya existe como token o como clase global (`--surface-2`, `.btn`, `.card-btn`);
  los `@media (prefers-color-scheme: dark)` sueltos, que se saltean el override
  manual de tema y dejan el componente en la paleta contraria cuando el autor
  fuerza «Claro» con el OS en oscuro (el chip de la saga tenía exactamente ese
  bug); y los helpers de path/árbol repetidos por componente.
  **Criterio para no pasarse de rosca**: se unifica lo que ya está duplicado y
  duele, no lo que podría llegar a compartirse. Dos copias iguales se unifican;
  dos copias parecidas que divergieron a propósito, no.

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

- **Event-driven sync** (nuevo, agregado en la misma PR): focus → fetch, blur (debounced 30s + cooldown 2min) → flushAndSync, close → flushAndSync con timeout 10s + modal "¿Cerrar igual?" si falla. Listeners de `online`/`offline` también. El poll de status de 30s se eliminó; queda el poll de 5min como red de seguridad para sesiones largas sin transiciones de foco.
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
