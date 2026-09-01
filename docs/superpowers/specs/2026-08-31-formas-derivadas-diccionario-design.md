# Formas derivadas en el diccionario per-saga

Fecha: 2026-08-31

## Problema

`<saga>/diccionario.txt` es una lista plana de formas exactas. El filtro de TYPOS
compara `word.toLowerCase()` contra un `Set` (`editor.ts:638` y `editor.ts:1101`,
vía `SagaContextService.isInDictionary`), así que agregar una palabra silencia esa
palabra y ninguna otra. Cada forma flexionada de un término inventado hay que
tipearla a mano, una por una.

El TODO planteaba esto como "conjugaciones de verbos". El corpus dice otra cosa.

## Relevamiento de los diccionarios reales (2026-08-31)

Tres sagas con diccionario en `~/novelas`. Agrupando por prefijo de 5 caracteres
sin diacríticos, **separando por idioma** — las reglas de flexión no se mezclan
entre idiomas y el análisis tampoco:

### Meridian 2.0 · `idioma: es` · 172 entradas · 16 familias

| Categoría | Familias | Ejemplos |
|---|---|---|
| Verbos | 3 | `castear` (5 formas tipeadas a mano), `teletransportar` (10), `bardear` (2) |
| Plural es | 7 | `arcanismos`, `arcanistas`, `chapoteros`, `dracónidos`, `perjurias`, `piedritas`, `mirmidones` |
| Género | 1 | `telequinético` / `telequinética` |
| Plural irregular | 1 | `Hombrelobo` / `hombreslobo` (plural interno) |
| Typo silenciado | 1 | `encantación` / `encantanción` |
| Falsos positivos del agrupador | 3 | `Amell`/`Amellaris`, `Chispi`/`Chispita`, `Sebastian`/`Sebastien` — nombres distintos |

### Milky Way · `idioma: en` · 265 entradas · 25 familias

| Categoría | Familias | Ejemplos |
|---|---|---|
| Plural `+s` | 18 | `chobbos`, `faunts`, `credchips`, `holoblades`, `Akavians`, `hakurians`, `starrails` |
| Derivación léxica (no flexión) | 3 | `xenoarchaeologist`/`xenoarchaeology`, `underarmor`/`undersuit` |
| Nombres propios | 4 | `Kessel`/`Kessel-Bas`, `Unari`/`Unarian`, `Nappa`/`Nappan` |
| Verbos | **0** | — |

### Buenos Aires 2077 · `idioma: es` · 2 entradas · 0 familias

Tres hallazgos que definen el diseño:

1. **Los verbos son un problema exclusivamente español.** Cero verbos en 265
   entradas inglesas, y el plural inglés es `+s` mecánico sin una sola excepción
   (ni un `-es`, ni un `-ies`).
2. **Los infinitivos casi no están en el diccionario.** `teletransportar` y
   `bardear` **no figuran**; sí `teletransportó`, `teletransportaba`,
   `teletransportarme`, `bardean`, `bardeando`. Solo `Castear` está. La palabra
   se agrega tal como la marcó LanguageTool, nunca como lema — así que el flujo
   tiene que arrancar desde la forma marcada e inferir el lema hacia atrás.
3. **El diccionario ya tiene basura que un generador amplificaría.**
   `encantanción` (typo de `encantación`) está silenciada. Generar formas a ciegas
   multiplica ese error por 15, de ahí que el preview sea editable y no automático.

### Frecuencia real en el texto, no en el diccionario

Contando las formas de los tres verbos sobre los `.html` de las novelas:

| Forma | Hits | Ejemplos |
|---|---|---|
| Infinitivo + enclítico | 26 | `teletransportarse`, `bardearlo`, `bardearme`, `bardearse` |
| Presente 3ª (sg/pl) | 7 | `bardea`, `teletransporta`, `bardean` |
| Gerundio | 6 | `bardeando`, `casteando` |
| Pretérito | 3 | `teletransportó`, `teletransporté`, `teletransportaste` |
| Participio | 2 | `bardeado` |
| Imperfecto | 1 | `teletransportaba` |
| 1ª plural presente | 1 | `casteamos` |
| Futuro / condicional / subjuntivo | **0** | — |

El infinitivo con enclítico es el uso número uno y es justo el que explota
combinatoriamente: 9 enclíticos × (infinitivo, gerundio, imperativo) ≈ 27 formas
por verbo, varias con tilde de enclisis (`bardeándolo`, `bardeámelo`). Escribirlas
todas al archivo no es viable.

## Decisión de arquitectura: dos mecanismos, no uno

|  | español | inglés |
|---|---|---|
| **Pelar en el filtro** (no escribe nada) | enclíticos, plural `-s`/`-es`/`-ces` | plural `-s` |
| **Generar al archivo** (preview editable) | verbos (15), adjetivos de género (2) | — nada — |

La regla que separa los dos: **el generador nunca escribe un plural.** Eso es
trabajo del stripper. Es lo que mantiene el archivo del tamaño que tiene hoy
(172 y 265 entradas) y evita dos caminos para lo mismo.

Consecuencia sobre el conteo de formas verbales: el núcleo narrativo acordado eran
17, pero `bardeados` y `bardeadas` son plurales de `bardeado`/`bardeada` y los pela
el stripper. Quedan **15** para `-ar` y `-er`, y **14** para `-ir` (colisión, ver
abajo).

`bardeás` (presente voseo) **sí** se genera aunque el stripper lo cubriría de
rebote — `bardeá` + `s`. Esa cobertura es una coincidencia ortográfica del voseo,
no un plural, y depender de ella ataría las formas verbales a las reglas de plural.

## Módulo puro: `src/app/dictionary/derived-forms.ts`

Sin DOM, sin TipTap, sin ProseMirror. Se testea con
`scripts/run-derived-forms-smoke.mjs` (patrón de `run-rae-smoke.mjs`).

```ts
export type Idioma = 'es' | 'en';
export type Categoria = 'verbo' | 'adjetivo';

/** Devuelve la entrada del diccionario que cubre `word` vía flexión, o null. */
export function stripInflection(
  word: string,
  idioma: Idioma,
  lookup: DictLookup,
): string | null;

/** Formas a ofrecer para un lema. Solo español; en inglés devuelve []. */
export function generateForms(
  lema: string,
  categoria: Categoria,
  idioma: Idioma,
): string[];

/** Candidatos de lema + categoría inferidos desde una forma marcada. */
export function inferLemma(word: string, idioma: Idioma): LemmaCandidate[];

export interface LemmaCandidate {
  lema: string;
  categoria: Categoria;
}

export interface DictLookup {
  /** Grafía exacta, comparada en minúsculas. */
  has(word: string): boolean;
  /** Sin diacríticos y en minúsculas. Devuelve la forma canónica o null. */
  foldedGet(word: string): string | null;
}
```

### `stripInflection` — reglas

Se prueban en orden y la primera que devuelve un lema del diccionario gana.

**Enclíticos (solo `es`)** — lista rioplatense, sin `os` de vosotros:

```
me · te · se · lo · la · le · nos · los · las · les
```

Hasta **dos** pelados sucesivos, lo que cubre los dobles (`bardeármelo` → `-lo` →
`bardeárme` → `-me` → `bardear`) sin enumerar combinaciones.

**Plural `es`** — sobre palabras terminadas en `s`:

| Patrón | Resto | Ejemplo |
|---|---|---|
| `-s` tras vocal | `word[:-1]` | `arcanismos` → `arcanismo` |
| `-es` tras consonante | `word[:-2]` | `mirmidones` → `mirmidon` |
| `-ces` | `word[:-3] + 'z'` | `luces` → `luz` |

**Plural `en`** — solo `-s`. `-es` y `-ies` **no se implementan**: cero casos en
265 entradas. Se agregan cuando aparezca uno, no antes.

### `stripInflection` — la regla de las tildes

La parte delicada. La enclisis y el plural en `-es` mueven o agregan la tilde, así
que el resto pelado no coincide en grafía exacta con la entrada del diccionario:

```
teletransportándose → -se → teletransportándo   ✗ exacto
                          → sin tildes → teletransportando   ✓
mirmidones          → -es → mirmidon            ✗ exacto
                          → sin tildes → mirmidón            ✓
```

**El índice sin tildes se consulta solo después de haber pelado algo, nunca sobre
la palabra cruda.** `mirmidon` a secas no matchea ningún patrón de flexión, así que
no llega al índice folded y sigue marcada — que es el comportamiento que se quiere.
Sin esta condición el stripper degeneraría en "el diccionario ignora los acentos".

### `stripInflection` — guardas

Sin estas tres no es un stripper, es un agujero por donde se cuelan typos:

1. El resto pelado tiene **≥ 4 caracteres**. (`perla` → `-la` → `per`, descartado.)
2. **Máximo 2 pelados** por palabra.
3. **Solo devuelve un hit si el resto ya está en el diccionario.** Nunca inventa
   cobertura.

Guarda adicional solo para enclíticos: el resto tiene que tener forma de
infinitivo, gerundio o imperativo — terminar en `r`, en `ndo`, o en vocal (con o
sin tilde). Corta pelados espurios sobre sustantivos.

### Medición de impacto sobre el corpus (2026-08-31)

Prototipo del stripper corrido sobre **todo** el texto de las novelas, con los
diccionarios reales, contando qué palabras pasarían a estar silenciadas y hoy no lo
están. Es la medición que decide si las guardas alcanzan:

| Saga | Palabras únicas en el texto | Nuevas silenciadas |
|---|---|---|
| Meridian 2.0 `es` | 13.982 | **1** — `lúmenes` → `lúmen` (4 apariciones) |
| Milky Way `en` | 11.462 | **2** — `Koziaras` → `koziara`, `naruus` → `naruu` |

Tres de 25.444, y el autor confirmó las tres como plurales legítimos de palabras
propias del mundo:

- **`lúmen`** — arcanismo inventado (magia y tecnología a la vez). Plural `-es`
  tras `n`, con la tilde donde el autor la puso.
- **`Koziara`** — nombre propio usado como expresión ("vale más que dos de esos
  koziaras"), así que el plural aparece en el texto.
- **`naruu`** — animal de un planeta de la saga; el plural es `+s` a secas, que es
  justo la única regla que se implementa en inglés.

O sea **cero falsos positivos y tres verdaderos positivos**: las tres son palabras
que hoy hay que agregar a mano y que la feature cubre sola. Ninguna palabra común
(`perlas`, `casas`, `manos`, `luces`, `dientes`, `sombras`, `piedras`) pela, porque
la guarda de "el resto ya tiene que estar en el diccionario" las corta a todas.

La medición se hizo sin las formas verbales generadas, que todavía no existen. Con
ellas los enclíticos suman cobertura, pero el riesgo medido no cambia: la guarda es
la misma.

### `generateForms` — verbos (`es`)

Tabla por terminación. `raíz` = lema menos los dos últimos caracteres.

| # | Forma | `-ar` (`bardear`) | `-er` (`comer`) | `-ir` (`vivir`) |
|---|---|---|---|---|
| 1 | Infinitivo | `raíz+ar` | `raíz+er` | `raíz+ir` |
| 2 | Gerundio | `raíz+ando` | `raíz+iendo` | `raíz+iendo` |
| 3 | Participio m. | `raíz+ado` | `raíz+ido` | `raíz+ido` |
| 4 | Participio f. | `raíz+ada` | `raíz+ida` | `raíz+ida` |
| 5 | Presente 1ª sg | `raíz+o` | `raíz+o` | `raíz+o` |
| 6 | Presente 2ª voseo | `raíz+ás` | `raíz+és` | `raíz+ís` |
| 7 | Presente 3ª sg | `raíz+a` | `raíz+e` | `raíz+e` |
| 8 | Presente 3ª pl | `raíz+an` | `raíz+en` | `raíz+en` |
| 9 | Pretérito 1ª sg | `raíz+é` | `raíz+í` | `raíz+í` |
| 10 | Pretérito 2ª sg | `raíz+aste` | `raíz+iste` | `raíz+iste` |
| 11 | Pretérito 3ª sg | `raíz+ó` | `raíz+ió` | `raíz+ió` |
| 12 | Pretérito 3ª pl | `raíz+aron` | `raíz+ieron` | `raíz+ieron` |
| 13 | Imperfecto 3ª sg | `raíz+aba` | `raíz+ía` | `raíz+ía` |
| 14 | Imperfecto 3ª pl | `raíz+aban` | `raíz+ían` | `raíz+ían` |
| 15 | Imperativo voseo | `raíz+á` | `raíz+é` | `raíz+í` |

En `-ir` las filas 9 y 15 colisionan (`viví`): la lista se deduplica y quedan 14.

**Dos ajustes ortográficos** que no son "modelar irregulares" sino mecánica de
escritura del español, y sin los cuales el generador escribe formas que no existen:

- `-car` → `-qué`, `-gar` → `-gué`, `-zar` → `-cé` en el pretérito 1ª sg
  (`trancar` → `tranqué`, no `trancé`).
- Raíz terminada en vocal para `-er`/`-ir`, dos casos que hay que distinguir o el
  generador escribe formas que no existen:
  - `i` **átona** entre vocales pasa a `y`: `iendo`→`yendo`, `ió`→`yó`,
    `ieron`→`yeron` (`leer` → `leyendo`, `leyó`, `leyeron`).
  - `i` **tónica** lleva tilde, no pasa a `y`: `ido`→`ído`, `ida`→`ída`,
    `iste`→`íste` (`leer` → `leído`, `leída`, `leíste` — nunca `leido` ni `leyste`).

Lo que **no** se modela: irregularidades de raíz (diptongación, pretéritos fuertes,
participios irregulares). El preview editable lo cubre — se destildan las formas
que no existen. En el corpus los tres verbos inventados son regulares en `-ear`.

### `generateForms` — adjetivos (`es`)

Solo lemas terminados en `-o`: `telequinético` → `telequinético`,
`telequinética`. **Dos** formas, no cuatro; los plurales los pela el stripper.

Adjetivos invariables en género (terminados en `-e`, `-ista`, o consonante) no
generan nada — la entrada sola alcanza.

### `generateForms` — inglés

Devuelve lista vacía. No hay verbos que conjugar ni género que flexionar, y el
plural lo pela el stripper.

### `inferLemma` — tabla de sufijos

Se prueba por sufijo más largo primero. Primer match gana.

| Sufijo | Lema propuesto | Categoría |
|---|---|---|
| `ando` | `-ar` | verbo |
| `iendo` | `-er`, `-ir` (dos candidatos) | verbo |
| `ado` `ada` | `-ar` | verbo |
| `ido` `ida` | `-er`, `-ir` | verbo |
| `ábamos` `aban` `aba` `aste` `aron` `amos` `ás` `ó` `é` `á` `an` | `-ar` | verbo |
| `ían` `ía` `iste` `ieron` `ió` `és` `ís` `í` `en` | `-er`, `-ir` | verbo |
| `o` `a` (sin match previo) | el lema tal cual | adjetivo |

**Stop-list**: palabras terminadas en `ción`, `sión`, `miento`, `dad`, `dades` son
sustantivos y devuelven cero candidatos. Sin esto `teletransportación` — que está
en el diccionario de Meridian — se ofrecería como verbo.

**Ambigüedad `-o`/`-a`**: `teletransporto` (presente 1ª sg) y `telequinético`
(adjetivo) tienen la misma forma. Se propone **adjetivo**, que es lo más frecuente
con esa terminación en el corpus, y el radio del preview permite cambiarlo.

**Caso de las formas generadas**: los verbos y adjetivos son palabras comunes, así
que el campo de lema se prellena en minúsculas aunque la palabra marcada venga
capitalizada por inicio de oración (`Castear` en el diccionario de Meridian es
justamente eso). El autor puede corregirlo en el campo.

Para `idioma: en`, `inferLemma` devuelve `[]`.

## Cableado: un solo punto de entrada

`SagaContextService.isInDictionary()` (`core/saga-context-service.ts:99`) es hoy:

```ts
isInDictionary(word: string): boolean {
  return this.dictionary().has(word.toLowerCase());
}
```

Ahí adentro va el `stripInflection` **después** del miss exacto, y solo ahí.

`editor.ts:638` (el effect de re-filtrado en vivo cuando cambia el diccionario)
hace hoy `dict.has(word.toLowerCase())` a mano, salteándose el service. Pasa a
llamar `isInDictionary()`. El effect ya lee `sagaCtx.dictionary()` para su
reactividad, así que no pierde el disparo.

Con ese cambio los dos sitios de filtrado (`editor.ts:638` y `editor.ts:1101`)
quedan cubiertos por una sola guarda en vez de dos paralelas que después divergen.

`SagaContextService` suma un `computed` con el índice sin diacríticos
(`Map<folded, canónica>`) al lado del `dictionary` que ya existe, y el `idioma`
sale de `config()`, que ya está cargado.

## Frontend

### Popover de LanguageTool

`editor/grammar-popover.ts:51` tiene el footer con `Ignorar` y `+ diccionario`. Se
suma una tercera acción **`+ formas…`** que emite un output nuevo
`addToDictWithForms`.

Visible solo cuando `canAddToDict()` **y** la saga es `es` **y** `inferLemma`
devolvió al menos un candidato. En inglés y en las palabras sin forma derivable, el
popover queda exactamente como hoy: `+ diccionario` sigue siendo un click, sin
modal, sin cambio de comportamiento.

### `derived-forms-panel` (componente nuevo, standalone)

| Elemento | Comportamiento |
|---|---|
| Input **Lema** | Prellenado con el candidato de `inferLemma`, editable. Al cambiar, regenera la lista. |
| Radio **Categoría** | `verbo` / `adjetivo`. Prellenado con el candidato. Al cambiar, regenera. |
| Checkboxes de formas | Todas tildadas por default. Destildar excluye. |
| Botón `Agregar N` | N = tildadas. Persiste vía el camino que ya existe. |
| Botón `Cancelar` | No escribe nada. |

Las formas que ya están en el diccionario se muestran tildadas y deshabilitadas,
con la nota "ya está" — no se re-agregan ni cuentan para N.

Se abre desde el popover y desde el modal del diccionario
(`dictionary/dictionary-modal.ts`), con el mismo componente en los dos lados.

### Persistencia

Una sola escritura por confirmación, no una por forma. `SagaContextService` suma
`addManyToDictionary(words: string[])`, hermano del `addToDictionary` de
`saga-context-service.ts:115`: valida cada palabra con `validateWord`, descarta las
que ya están con `existsCaseInsensitive`, y hace **un** `set_saga_dictionary`.

Reusa `validateWord` / `existsCaseInsensitive` de `dictionary/word-validator.ts`.
No se escribe validación nueva.

## Errores

| Situación | Qué pasa |
|---|---|
| No hay saga activa | El panel no se abre; el popover no muestra `+ formas…`. |
| `set_saga_dictionary` falla | Toast con el motivo, el panel queda abierto con las tildes puestas para reintentar. Nada a medias: la escritura es una sola. |
| El lema tipeado no termina en `-ar`/`-er`/`-ir` con categoría `verbo` | La lista queda vacía y el botón dice `Agregar 0`, deshabilitado. Sin toast: el estado se ve. |
| Todas las formas ya están en el diccionario | Botón deshabilitado, nota "todas las formas ya están". |

## Testing

`scripts/run-derived-forms-smoke.mjs` — casos sacados de los diccionarios y del
texto reales, no inventados:

**Pela**

```
bardearlo            → bardear        [es]
bardeármelo          → bardear        [es, dos pelados]
teletransportándose  → teletransportando  [es, tilde de enclisis]
bardeámelo           → bardeá         [es]
arcanismos           → arcanismo      [es, -s tras vocal]
mirmidones           → mirmidón       [es, -es + tilde]
bardeados            → bardeado       [es, plural de participio]
telequinéticas       → telequinética  [es, plural de forma generada]
chobbos              → chobbo         [en]
faunts               → faunt          [en]
xenoarchaeologists   → xenoarchaeologist  [en]
```

**No pela** (el resto no está en el diccionario, o no hay patrón que aplique)

```
perla         [-la deja «per», menos de 4 caracteres]
casas         [«casa» no está en el diccionario de la saga]
mirmidon      [sin tilde y sin flexión: no llega al índice folded]
encantanción  [typo, ningún patrón aplica]
Aedan         [nombre propio, sin flexión]
```

**Genera**

```
bardear          → 15 formas exactas (tabla -ar)
castear          → 15
teletransportar  → 15
comer            → 15 (tabla -er)
vivir            → 14 (colisión viví)
trancar          → pretérito 1ª sg = tranqué, no «trancé»
leer             → leyendo, leyó, leyeron  [i átona → y]
                 → leído, leída, leíste    [i tónica → tilde, NO leido/leyste]
telequinético    → 2 (telequinético, telequinética)
arcanista        → 0 (invariable en género)
cualquier lema en [en] → 0
```

**Infiere**

```
teletransportó       → teletransportar / verbo
bardean              → bardear / verbo
casteando            → castear / verbo
teletransportaste    → teletransportar / verbo
teletransportación   → sin candidatos (stop-list -ción)
telequinético        → telequinético / adjetivo
chobbos              → sin candidatos (idioma en)
```

Angular no tiene runner de tests en este repo (ver CLAUDE.md), así que la mitad con
DOM — el `derived-forms-panel` y el botón del popover — se valida con `pnpm build`
más verificación manual del autor.

Rust no se toca: `set_saga_dictionary` ya acepta la lista completa.

## Fuera de alcance

- **`Hombrelobo` / `hombreslobo`**: plural interno, no lo acierta ninguna regla de
  sufijo. Se sigue agregando a mano y está bien.
- **Inglés `-es` / `-ies` y verbos ingleses**: cero casos en 265 entradas.
- **Futuro, condicional y subjuntivo**: cero apariciones en el corpus. El costo es
  asimétrico — una forma que falta cuesta un click cuando LT la marca; una forma de
  más silencia un typo para siempre.
- **Tuteo** (`bardeas`, `bardeabas`): el autor escribe rioplatense.
- **Enclíticos en inglés**: no existen.
- **`encantanción` en el diccionario de Meridian**: es un typo silenciado que hay
  que sacar, pero es un `removeWord` suelto, no parte de esta feature.
- **Mayúsculas rancias** (`AEdan`, `YIRIel`): el item hermano del TODO toca la
  misma función `isInDictionary`, porque la comparación en minúsculas es la causa
  de los dos problemas. Va en su propio spec. Al implementar este, dejar
  `isInDictionary` con la forma canónica a mano — el stripper ya la necesita para
  el índice folded — así el otro item no tiene que rehacer el cableado.
