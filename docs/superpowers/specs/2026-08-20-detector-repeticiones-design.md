# Detector de repeticiones cercanas

Fecha: 2026-08-20

## Problema

LanguageTool detecta **solo duplicados literales pegados** — `la nave nave`, vía
`SPANISH_WORD_REPEAT_RULE` / `ENGLISH_WORD_REPEAT_RULE`. La repetición que molesta al
escribir una novela no es esa. Medido contra el container local (LT 6.8), estos tres casos
no producen ni una marca **ni en `es-AR` ni en `en-US`, ni en `default` ni en `picky`**:

```
"Era una nave oscura, oscura como el vacío."
"El capitán oscuro miró el pasillo oscuro del casco oscuro."
"Caminó lentamente y habló lentamente y respiró lentamente."
```

Corridos los mismos casos en inglés (`The dark captain saw the dark corridor of the dark
hull.`) el resultado es idéntico: sin marcas. **No es el agujero del español** — es un
agujero de LT en los dos idiomas que el autor escribe, así que lo que se construya sirve
para las dos mitades.

## Solución

Función pura en TS que escanea el texto plano del capítulo activo con una ventana
deslizante, más la integración de decoraciones calcada del validador RAE.

### Por qué TS y no Rust

Se planteó la pregunta y se midió. Ventana deslizante sobre 59 KB / 10.008 palabras:
**1,07 ms** en Node (media de 50 corridas). Cruzar el bridge a Rust cuesta más que eso —
hay que serializar el capítulo de ida y los hits de vuelta.

La regla de división del `CLAUDE.md` manda a Rust lo que toca **muchos archivos**; esto
toca el capítulo activo, que ya está en memoria del frontend. Precedente exacto en el
repo: `validator.ts` hace esta misma clase de trabajo en TS.

**Dónde sí sería Rust**: "buscar repeticiones en el libro o la saga entera". Eso son N
archivos y va al lado de `search.rs`. Fuera de alcance acá.

### El módulo

`src/app/repeticiones/detector.ts` — sin DOM, sin `@tiptap/core`, sin ProseMirror, para
que entre en un smoke runner:

```ts
export interface OpcionesRepeticion {
  /** Distancia máxima en palabras entre apariciones para que cuenten juntas. */
  ventana: number;
  /** Apariciones dentro de la ventana necesarias para marcar. Default 3. */
  minApariciones: number;
  /** Distancia bajo la cual 2 apariciones ya alcanzan (repetición pegada). Default 5. */
  ventanaCorta: number;
  /** Largo mínimo de palabra a considerar. Default 5. */
  largoMinimo: number;
  /** Nombres propios del mundo, del diccionario per-saga. Se normalizan acá adentro. */
  ignorar: Iterable<string>;
}

export function detectRepeticiones(
  plain: string,
  lang: 'es' | 'en',
  opts: OpcionesRepeticion,
): Repeticion[]
```

Y el tipo en `core/types.ts`, al lado de `RaeViolation`:

```ts
export interface Repeticion {
  offset: number;
  length: number;
  /** Forma normalizada que disparó el match (minúsculas, sin diacríticos). */
  palabra: string;
  /** Offset de la aparición previa, para el "ir a la anterior" del popover. */
  offsetPrevio: number;
  /** Distancia en palabras contra la aparición previa. */
  distancia: number;
  /** Cuántas veces aparece la forma en este párrafo, dentro de la ventana. */
  apariciones: number;
}
```

Algoritmo: **partir el plano en párrafos** por `\n\n` (que es exactamente el separador
que ya emite `extractPlainText`, y `* * *` cae como párrafo propio), y correr cada párrafo
por separado con su offset base. Adentro del párrafo: tokenizar con `/\p{L}+/gu`,
normalizar (minúsculas + `NFD` sin diacríticos), un solo pase guardando las posiciones de
cada forma. Un pase, O(n).

### Decisiones tomadas (2026-08-20, con el autor)

Cuatro preguntas que el spec dejaba abiertas, respondidas antes de escribir código:

- **La ventana NO cruza párrafo.** Reset en cada bloque. Es el caso que molesta al leer, y
  es el recorte más grande de densidad que se consigue gratis. Se pierde la repetición
  entre el final de un párrafo y el arranque del siguiente — aceptado.
- **El umbral es 3 apariciones, con excepción por distancia corta.** Una forma se marca si
  aparece `minApariciones` (3) veces dentro de `ventana`, **o** si aparece 2 veces a
  `distancia <= ventanaCorta` (5 palabras). La excepción es la que cubre el caso 1 del
  problema (`oscura, oscura`), que son 2 apariciones pegadas. Las dos perillas van a
  settings, no hardcodeadas.
- **Se marca cada aparición del grupo salvo la primera.** La primera queda limpia; cada
  siguiente lleva su marca con `offsetPrevio` apuntando a la anterior, que es lo que le da
  destino al "ir a la anterior" del popover.
- **Inglés lleva su propia lista de dicendi, nueva, en este módulo.** `DIALOG_TAGS` es
  español-only (40 verbos × 4 conjugaciones, cero `said`) y el módulo `dialogos/tags.ts`
  es del validador RAE — no se le mete inglés. `DICENDI_EN` (~15: said, asked, replied,
  whispered, shouted, muttered, murmured, added, answered…) vive en `detector.ts`.
- **Quinta capa: nombres propios por heurística.** Token capitalizado que no arranca
  oración = nombre propio, se ignora, esté o no en `diccionario.txt`. ~10 líneas, y tapa el
  agujero que quedaba abierto: el autor no tiene todos los nombres de su mundo cargados en
  el diccionario. Falso negativo conocido: una repetición legítima donde las dos
  apariciones caen al principio de oración.

### Las cinco capas de exclusión — acá se gana o se pierde

El prototipo crudo, con una stopword list mínima y `ventana: 40`, tiró **6.095 hits en
59 KB**. Inusable. El algoritmo no está mal; lo que falta son los filtros. Son cinco y
ninguno es opcional:

1. **Stopwords por idioma.** Listas propias en el módulo (`es` y `en`), no una dependencia.
   Sin esto `que`, `de`, `la` copan la salida.
2. **Largo mínimo.** Arranque en 5 caracteres. Corta el resto del ruido funcional
   (`sobre`, `desde`) sin tocar palabras de contenido. De paso tapa `said` gratis.
3. **Verbos dicendi.** En diálogo, `dijo` repetido cada tres párrafos es la forma normal
   del español narrativo, no un defecto. Para español la lista ya existe y se importa tal
   cual: `DIALOG_TAGS` en `src/app/dialogos/tags.ts` — módulo puro sin DOM. Para inglés se
   escribe `DICENDI_EN` en `detector.ts` (ver decisiones arriba).
4. **El diccionario per-saga.** Crítico y es la capa que no existiría en ninguna otra app:
   `<saga>/diccionario.txt` tiene los nombres propios inventados del mundo. Que `Kallai`
   aparezca cinco veces en una escena es **normal**, no un defecto, y marcarlo haría el
   feature inservible en la práctica. Se pasa `sagaCtx.dictionary()` como `opts.ignorar` —
   la misma fuente que ya filtra los `TYPOS` de LT en `editor.ts`.
   **Ojo con la normalización**: `dictionary()` devuelve las palabras en minúscula pero
   **con** diacríticos (`isInDictionary` solo hace `toLowerCase`). El detector normaliza
   `opts.ignorar` con su propia función antes de comparar, en vez de confiar en que llegue
   normalizado — sino `Kallái` no matchea nunca.
5. **Capitalizado mid-oración = nombre propio.** La red de seguridad para los nombres que
   todavía no están en `diccionario.txt`. Se decide con el token anterior: si no es fin de
   oración (`.`, `?`, `!`, `…`, raya de diálogo, arranque de párrafo), la mayúscula es
   nombre propio y no compite.

Incluso con las cinco, `ventana` / `minApariciones` / `ventanaCorta` son perillas de gusto,
no valores correctos. Ver la sección de calibración.

### Limitación aceptada: match exacto, sin lematizar

Se comparan formas normalizadas exactas. `oscura` no matchea con `oscuro`, ni `corrió` con
`correr`. Los tres casos del problema son de forma idéntica, así que quedan cubiertos, pero
las variantes de género/número y las conjugaciones se escapan.

No se suma un stemmer ni FreeLing ni spaCy. `// ponytail:` en el código marcando el techo:
match exacto normalizado, y el upgrade path es un stemmer liviano de español si la
calibración muestra que los casos perdidos importan.

### Integración

Copia exacta de la forma de `checkRae()` (`editor.ts:1131`), que es **sincrónico** — no
hay `await`, así que no aplica la clase de bug de staleness que arreglamos en el chequeo de
LT (PR #70). Piezas:

- `checkRepeticiones(force = false)` en `editor.ts`: `extractPlainText` → `detectRepeticiones`
  → `mapRepeticionesToPm` → signal + decoraciones, con `lastRepPlain` para el early-return.
- Categoría de decoración nueva: `.repeticion`, **violeta `#8257e6` en
  `text-decoration: underline wavy`** (con `text-decoration-skip-ink: none`).
  Dos razones para no usar `border-bottom`: el hue y la forma. La paleta del editor es
  cálida entera (`--accent` sepia `#5a3a1a`) y los cuatro colores de marca ya están
  tomados — rojo `#d23030` (grammar typo, RAE char, RAE structure), naranja `#d27a1f`
  (RAE pending), ámbar `#c89020` (grammar style, RAE typo), amarillo `#ffd500`
  (`search-hit`). Violeta es lo primero que no choca, y no es verde, que en una marca
  leería "está bien". Y **todas** las marcas de hoy pintan `border-bottom`
  (`editor.scss:593-635`; los comentarios dicen "wavy" pero ninguna lo es), así que el
  canal `text-decoration` está libre entero: una repetición nunca compite por el mismo
  píxel que un typo. Un solo hex sin `prefers-color-scheme`, como el resto de las marcas
  — `editor.scss` no tiene bloques de tema y `#8257e6` se lee en crema y en marrón oscuro.
- Reusa `offsetToPm` y el remapeo por `tr.mapping` que ya existen. Nada nuevo de posiciones.
- Popover: la palabra, "repetida N palabras antes" y la cuenta (`apariciones`), más dos
  acciones — **ir a la anterior** e **ignorar**. `ignorar` es **de sesión, no persistente**:
  `dismissGrammarMatch` (`editor.ts:1052`) solo filtra la lista en memoria y vuelve a
  aparecer en el próximo check. Misma semántica acá; lo persistente es el diccionario, y
  para eso está el diccionario. **Sin sinónimos**: el tesauro es otro item del TODO y otro
  PR; este feature dice *dónde*, no *con qué reemplazar*.
- Toggle propio en la barra de arriba, etiqueta **`Repeticiones`**, al lado de `Auto` /
  `LT` / `RAE`. Persistido como `repeticionesAutoDisabled` en settings, calcado de
  `raeAutoDisabled` (`settings-service.ts:139` + `settings.rs:106`).

### Precedencia con las marcas que ya existen

`editor.ts:1240` ya resuelve el solapamiento RAE vs gramática. Las repeticiones entran
**último**: si un offset ya tiene marca de gramática o de RAE, gana la que estaba. Una
repetición es una sugerencia de estilo, nunca un error — no debe tapar un typo.

Ojo que el canal separado (`text-decoration` vs `border-bottom`) hace que las dos marcas
**puedan** convivir en el mismo span sin pisarse visualmente. Aun así la repetición se
suprime: el conflicto que importa no es el pixel, es el click — un solo popover por
offset, y `onHostClick` (`editor.ts:1247`) ya resuelve la prioridad para dos categorías.
Si la calibración muestra que perder repeticiones bajo un typo molesta, la vía es
renderizar las dos y sumar la tercera rama al handler, no cambiar el color.

## Calibración (parte del trabajo, no un detalle posterior)

No se puede elegir `ventana` de memoria. El plan:

1. `scripts/densidad-repeticiones.mjs` — corre el detector sobre capítulos reales de
   `~/Repos/Personal/Novelas/`, en español y en inglés. Script de reporte, no un test:
   escupe la tabla y una muestra de hits con su contexto.
2. Reportar densidad — hits por 1.000 palabras — para la grilla `ventana` 20/30/40/60 ×
   `minApariciones` 2/3, con `ventanaCorta: 5` fijo.
3. El autor mira una muestra de hits y dice cuáles son señal y cuáles ruido.
4. Se fijan los defaults con eso, y las tres perillas quedan expuestas como
   "sensibilidad" en settings porque son gusto, no corrección.

Sin el paso 3 esto no se mergea. Un detector que marca 6.095 veces en un capítulo es peor
que no tener detector.

## Lo que no cambia

- LanguageTool: ni un parámetro nuevo, ni una llamada más. Esto es 100% local.
- El validador RAE y su popover.
- La semántica del diccionario per-saga: se **lee**, no se escribe.
- El chequeo de gramática y su guard de staleness.

## Testing

`scripts/run-repeticiones-smoke.mjs`, patrón de `run-rae-smoke.mjs` — compila el TS con
`tsc` a un tmpdir e importa el JS. Sirve porque `detector.ts` es puro por construcción.

Casos positivos: los tres del problema, en español y en inglés.

Casos negativos, que son los que de verdad importan porque son los que hacen inservible al
feature si fallan:

- Nombre propio de la saga repetido cinco veces → **cero hits** (vía `opts.ignorar`).
- El mismo nombre pero con diacríticos (`Kallái`) y el diccionario sin normalizar → cero
  hits. Es el test que falla si el detector confía en que `ignorar` llega normalizado.
- Nombre propio **ausente** del diccionario, repetido mid-oración → cero hits (capa 5).
- Diálogo con `dijo` repetido → cero hits (vía `DIALOG_TAGS`).
- Lo mismo en inglés con `whispered` → cero hits (vía `DICENDI_EN`).
- Stopwords repetidas (`que`, `de`, `la`) → cero hits.
- Palabra corta bajo `largoMinimo` → cero hits.
- Misma palabra más allá de la `ventana` → cero hits.
- Dos apariciones dentro de `ventana` pero más allá de `ventanaCorta`, con
  `minApariciones: 3` → cero hits. Es el test del umbral.
- Misma palabra a los dos lados de un `\n\n` → cero hits. Es el test del reset por
  párrafo.

La mitad con DOM (decoraciones, popover, precedencia) se valida con `pnpm build` +
verificación a mano del autor, como manda el `CLAUDE.md`.

## Verificación a mano (la hace el autor)

1. Abrir un capítulo en español con repeticiones conocidas → aparecen marcadas, y la
   densidad es tolerable a la lectura.
2. Un capítulo con nombres propios del mundo muy repetidos → no se marcan.
3. Click en una marca → el popover dice la distancia y "ir a la anterior" salta bien.
4. Apagar el toggle → las marcas desaparecen y no vuelven.
5. Un capítulo en inglés → mismo comportamiento.
6. Una repetición encima de un typo de LT → gana el typo.
7. Bajar `minApariciones` a 2 en settings → aparecen más marcas, sin reabrir el capítulo.
