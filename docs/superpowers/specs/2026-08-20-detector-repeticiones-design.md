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
  /** Distancia máxima en palabras entre dos apariciones para que cuente. */
  ventana: number;
  /** Largo mínimo de palabra a considerar. */
  largoMinimo: number;
  /** Nombres propios del mundo, del diccionario per-saga. Normalizados. */
  ignorar: ReadonlySet<string>;
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
  /** Distancia en palabras entre las dos apariciones. */
  distancia: number;
}
```

Algoritmo: tokenizar con `/\p{L}+/gu`, normalizar (minúsculas + `NFD` sin diacríticos),
recorrer una vez guardando la última posición de cada forma en un `Map`, y emitir cuando
la reaparición cae dentro de `ventana`. Un solo pase, O(n).

### Las tres capas de exclusión — acá se gana o se pierde

El prototipo crudo, con una stopword list mínima y `ventana: 40`, tiró **6.095 hits en
59 KB**. Inusable. El algoritmo no está mal; lo que falta son los filtros. Son cuatro y
ninguno es opcional:

1. **Stopwords por idioma.** Listas propias en el módulo (`es` y `en`), no una dependencia.
   Sin esto `que`, `de`, `la` copan la salida.
2. **Largo mínimo.** Arranque en 5 caracteres. Corta el resto del ruido funcional
   (`sobre`, `desde`) sin tocar palabras de contenido.
3. **Verbos dicendi.** En diálogo, `dijo` repetido cada tres párrafos es la forma normal
   del español narrativo, no un defecto. La lista ya existe y es reusable tal cual:
   `DIALOG_TAGS` en `src/app/dialogos/tags.ts` — ~40 verbos con sus conjugaciones, módulo
   puro sin DOM. Se importa, no se reescribe.
4. **El diccionario per-saga.** Crítico y es la capa que no existiría en ninguna otra app:
   `<saga>/diccionario.txt` tiene los nombres propios inventados del mundo. Que `Kallai`
   aparezca cinco veces en una escena es **normal**, no un defecto, y marcarlo haría el
   feature inservible en la práctica. Se pasa `sagaCtx.dictionary()` como `opts.ignorar` —
   la misma fuente que ya filtra los `TYPOS` de LT en `editor.ts`.

Incluso con las cuatro, la `ventana` es una perilla de gusto, no un valor correcto. Ver la
sección de calibración.

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
- Categoría de decoración nueva, con su propio color junto a las que ya hay (typo,
  grammar, style, misc, RAE).
- Reusa `offsetToPm` y el remapeo por `tr.mapping` que ya existen. Nada nuevo de posiciones.
- Popover: la palabra, "repetida N palabras antes", y dos acciones — **ir a la anterior** e
  **ignorar** (misma semántica que `dismissGrammarMatch`). **Sin sinónimos**: el tesauro es
  otro item del TODO y otro PR; este feature dice *dónde*, no *con qué reemplazar*.
- Toggle propio, `repeticionesAutoDisabled` en settings, calcado de `raeAutoDisabled`.

### Precedencia con las marcas que ya existen

`editor.ts:1240` ya resuelve el solapamiento RAE vs gramática. Las repeticiones entran
**último**: si un offset ya tiene marca de gramática o de RAE, gana la que estaba. Una
repetición es una sugerencia de estilo, nunca un error — no debe tapar un typo.

## Calibración (parte del trabajo, no un detalle posterior)

No se puede elegir `ventana` de memoria. El plan:

1. Correr el detector sobre capítulos reales de `~/Repos/Personal/Novelas/`, en español y
   en inglés.
2. Reportar densidad — hits por 1.000 palabras — para `ventana` en 20 / 30 / 40 / 60.
3. El autor mira una muestra de hits y dice cuáles son señal y cuáles ruido.
4. Se fija el default con eso, y la `ventana` queda expuesta como "sensibilidad" en
   settings porque es gusto, no corrección.

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
- Diálogo con `dijo` repetido → cero hits (vía `DIALOG_TAGS`).
- Stopwords repetidas (`que`, `de`, `la`) → cero hits.
- Palabra corta bajo `largoMinimo` → cero hits.
- Misma palabra más allá de la `ventana` → cero hits.

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
