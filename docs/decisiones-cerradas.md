# Decisiones cerradas

Relevamientos, mediciones y descartes que **ya no son pendientes**: quedan acá
para no volver a abrirlos ni rehacer la medición. Lo que sigue pendiente vive en
[TODO.md](../TODO.md); lo que está hecho, en [README.md](../README.md).

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
    (`grammar.rs:786`) mapea `es` → `variante_es`, default `es-AR`.
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
  `saga-context-service.ts:34`):

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
  Las 2 palabras ya están restauradas en `2 - Buenos Aires 2077/diccionario.txt`
  (verificado el 2026-09-14 contra el repo `novelas`).

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
     7 de `PROFANITY*` (diálogo de ficción). Los dos se pueden apagar hoy
     desde el popover ("Nunca más esta regla"), pero uno por uno: esto sería
     apagarlos de entrada al prender `picky`.
  4. **Revisar en 6 meses**: si la lista de reglas que disparan sigue siendo
     esas 21, tirar LT, quedarse con hunspell (`zspell`) + las reglas propias,
     y bajar 174 MB. La decisión queda abierta y mantenerla abierta no cuesta.

  Scripts y datos de las dos mediciones: `medir.py` / `medir2.py`,
  `res-*.json`, `tok-*.json` en el scratchpad de la sesión (no se commitean).
  **Ojo con reproducirlas**: extraer el texto plano del HTML tiene que tratar
  `<br>` como salto de línea — sin eso aparecen 29 `ESPACIO_DESPUES_DE_PUNTO`
  falsos por párrafos pegados, que en el repo real son **1**.

## EPUB

- **`<br>` y `<hr>` sin cerrar, y el `<hr>` sin clase: NO hay nada que
  arreglar. Verificado el 2026-09-08.** Este ítem estuvo listado como pendiente
  con dos afirmaciones y las dos son falsas hoy; queda acá con la evidencia para
  no volver a abrirlo.
  - **El EPUB es XHTML válido.** `aeac7eb` (2026-09-01) agregó
    `close_void_elements()` porque Apple Books usa un parser estricto y abortaba
    el renderizado en el primer `<br>` sin cerrar (Thorium lo perdonaba, por eso
    pasó inadvertido). Comprobado desempaquetando el EPUB exportado del repo de
    prueba y grepeando void elements sin cerrar en todo el XHTML, el OPF y el
    NCX: cero.
  - **El `<hr>` sin `class="scene-break"` se ve igual que el que la tiene.**
    `insertSceneBreak()` (`editor.ts:1013`) usa el `horizontalRule` default de
    TipTap, que emite `<hr>` pelado, mientras los importados traen la clase — o
    sea que en el mismo EPUB conviven `<hr/>` y `<hr class="scene-break"/>`.
    Pero `epub_style.css:375` es `hr, .scene-break { border: none; text-align:
    center; … }` y `:337` es `.chapter-content hr + p, .chapter-content
    .scene-break + p { text-indent: 0 }`: **los dos selectores listan las dos
    formas a propósito**, así que el estilo es idéntico. No hay diferencia
    visible.
  - Lo único cierto que queda es que los `.html` fuente en disco no son XHTML
    (`<br>`, `<hr>` sin autocerrar) y que el editor no escribe la clase que el
    subset de CLAUDE.md documenta. Ninguna de las dos tiene efecto: los lee el
    export, que normaliza. Arreglarlo implicaría tocar la serialización de
    TipTap y además reescribir los 200+ capítulos del repo real para dejarlos
    consistentes — una migración de contenido por cero beneficio observable.
    **No vale.**

## Deuda transversal

- **Configurar las notificaciones: MEDIDO, casi nada que gobernar**
  (inventario del 2026-09-18, para no rehacerlo). Lo que pedía este item era
  una sección en Configuración para elegir por tipo si el aviso se muestra,
  cómo y cuánto dura. El conteo de los 115 `toast.*()` dice que eso gobernaría
  muy poco: **61 son `error`** (no se silencian nunca), 21 `success`, 18
  `warn`, 13 `info` y 2 `progreso`; 62 de los 115 viven en
  `node-actions-service` (24), `tree` (22) y `chapter-service` (16), o sea
  confirmaciones de una acción que el autor acaba de hacer. **Ningún call site
  pasa duración custom**, así que "cuánto duran" no tiene nada que configurar.
  Y no existe toast de git ni de "LanguageTool caído": eso son banners e
  indicadores del header, otro mecanismo.
  Lo que el autor sí necesitaba era **ver lo que se perdió**, no apagarlo
  ("a veces pasa que se te van y no sabés qué pasó") — eso se resolvió con la
  campana del historial. Si algún día se quiere config de verdad, lo único con
  sentido son tres toggles: confirmaciones de éxito del árbol, banner de
  update, y una duración global. La matriz por tipo × canal está descartada.
