# Tesauro de sinónimos embebido (español + inglés)

Fecha: 2026-08-20

## Problema

El detector de repeticiones ya está en manos del autor y **solo diagnostica**: el popover
dice dónde está la repetición y nada más. La acción que falta es reemplazar la palabra ahí
mismo, sin salir del editor. Sin eso el feature se queda en "sí, ya sé que repetí".

LanguageTool no puede darlo: su API no expone ningún endpoint de sinónimos — el swagger
completo es `/v2/check`, `/v2/languages`, `/v2/words` y sus derivados de diccionario
personal. Los sinónimos del editor web de LT son un servicio propietario que no está en el
OSS.

## Solución

Tesauro MyThes bundleado, leído en Rust, consultado desde el popover de repeticiones y
desde un atajo sobre cualquier palabra del cursor. Offline, determinista, cero red, cero
daemon que el autor tenga que levantar.

### Los datos existen para los dos idiomas

Relevado el 2026-08-20 contra
`/Applications/LibreOffice.app/Contents/Resources/extensions/`:

| archivo | entradas | tamaño | encoding | licencia |
|---|---|---|---|---|
| `dict-es/th_es_v2.dat` | 21.846 | 2,8 MB | ISO-8859-1 | LGPL 2.1 |
| `dict-en/th_en_US_v2.dat` | 145.866 | 18,5 MB | UTF-8 | WordNet 2.1 (Princeton) |

Esto **corrige el TODO**, que anotaba "sin equivalente en inglés en este repo" a partir de
que rla-es es solo español. El inglés existe, viene de WordNet vía LibreOffice, y su
licencia es más permisiva que la del español (basta reproducir el aviso de copyright y el
disclaimer; permite modificar).

Formato MyThes, primera línea el encoding, después `palabra|N` y N líneas de acepción. El
español no distingue categoría gramatical:

```
nave|8
-|bajel|buque|barco|navío|nao|embarcación|galera|carabela
```

El inglés sí, y trae hiperónimos etiquetados:

```
ship|6
(noun)|vessel (generic term)|watercraft (generic term)
(verb)|transport|send|move (generic term)|displace (generic term)
(verb)|hire (generic term)|engage (generic term)|employ (generic term)
```

### Cobertura medida, no supuesta

Medido contra `~/novelas/2 - Buenos Aires 2077` (90 capítulos, 61.398 tokens de ≥5
letras, 109 hits del detector con los defaults calibrados):

- Sobre **todas** las palabras de ≥5 letras: 28,6% de las formas distintas tienen entrada.
  Número engañoso — la mayoría de los misses (`estaba`, `había`, `cuando`, `sobre`, nombres
  propios) el detector ya los excluye por stopwords o capitalización.
- Sobre las **formas que el detector realmente marca**: 14 de 20 tienen entrada, ~70%.
  Los misses son `tarde` (adverbio, no está), `rifle` y `moto` (huecos léxicos del
  tesauro), `mirarlo` (enclítico) y `eres` (conjugación).

De ahí salen las dos decisiones de normalización del punto siguiente, y el techo honesto
de la feature: **~75-80% de las repeticiones marcadas van a tener sugerencia**, el resto
degrada a "sin sinónimos".

### Por qué no lematizar

Lematizar sin re-conjugar **empeora** la sugerencia: `eres` → lema `ser` → ofrecer
`existir` deja la oración rota al insertarlo. Y re-conjugar pide generación morfológica del
español, o sea un conjugador propio o tablas — un subsistema entero para el último 20%.

Decisión: solo normalizaciones donde la re-inflexión es trivial o innecesaria.

- Forma exacta (con diacríticos).
- Sin enclíticos: `mirarlo` → `mirar`. Recupera un caso de cada seis de los medidos.
- Plural simple: `naves` → `nave`, re-pluralizando los sinónimos devueltos.

**Trampa a no pisar**: el detector normaliza *sin diacríticos* — en la lista de formas más
marcadas aparecen `perdon` y `atencion` — y las claves del tesauro **llevan acento**. El
lookup tiene que ir con la forma de superficie del texto, nunca con la clave normalizada
del detector.

## Datos vendoreados

`src-tauri/resources/tesauro/`:

- `th_es_v2.dat` — **crudo, sin modificar**, tal como viene. Es la vía limpia para la LGPL
  2.1: se shipea sin tocar, con su `COPYING` al lado y el crédito a OpenThesaurus-es
  (Marcelo Garrone). Son 2,8 MB, no hay nada que ganar podándolo.
- `th_en_us.dat` — podado por `scripts/podar-tesauro-en.mjs`, que tira las entradas
  `(generic term)`, `(related term)`, `(similar term)` y `(antonym)`. **18,5 MB → 6,3 MB
  medidos**, y mejora la calidad: los hiperónimos de WordNet son ruido para un novelista
  (`move` como sinónimo de `ship`). La licencia WordNet permite modificar con aviso, así
  que va el `WordNet_license.txt` más una nota de qué se modificó.
- Los `.idx` originales **no van**. Al podar el inglés los offsets dejan de servir, y
  regenerarlos es complejidad que el punto siguiente no necesita.

El script de poda corre una vez y su salida se commitea. Nada de bajar datos en build time:
mete red en el build y no ahorra un byte en el artefacto final.

**Costo aceptado explícitamente por el autor**: ~9 MB más en el bundle, en cada artefacto
del updater (`createUpdaterArtifacts: true`) y en el repo. Barato contra los ~300 MB de
imagen que ya baja LanguageTool.

## Backend — `src-tauri/src/tesauro.rs`

```rust
#[tauri::command]
fn tesauro_lookup(palabra: String, idioma: String) -> Vec<Acepcion>

struct Acepcion { categoria: Option<String>, sinonimos: Vec<String> }
```

Al primer lookup de cada idioma: leer el `.dat` entero a un `String` — decodificando
ISO-8859-1 en el español — y armar un `HashMap<clave, (inicio, fin)>` de una pasada. El
archivo queda en el heap de Rust, el índice son solo las claves, y por el bridge cruza
únicamente la entrada consultada. Cacheado en un `OnceLock` por idioma.

Sin `seek`, sin índice binario, sin `.idx`: son 9 MB y una pasada. El costo es memoria del
proceso Rust (~10 MB por el inglés), no del heap del webview, que es lo que importaba
evitar.

La normalización (minúsculas, enclíticos, plural, re-pluralización de los sinónimos) vive
**toda acá**, en un solo lugar, para que la cubra `cargo test`. Sin entrada devuelve `[]`,
nunca error — "no hay sinónimos" no es una falla.

`categoria` es `None` para el español, porque el dato no la trae, y `Some("noun")` /
`Some("verb")` para el inglés.

## Frontend

- **`core/tesauro-service.ts`** — envuelve el invoke y cachea las últimas ~50 consultas en
  un `Map`. Sin signals: es request/response puro, no estado observable.
- **`repeticiones-popover.ts`** — suma chips de sinónimos clickeables. Agrupados con
  encabezado de categoría cuando el idioma la trae (inglés), lista sola cuando no
  (español). El click emite un `output` `reemplazar(sinonimo)`.
- **El reemplazo** sigue el patrón de `applyRaeFix`: un `tr.replaceWith` con las marcas de
  `marksAcross`, **no** `marks()` — la palabra puede caer en el borde de un `<em>` y ahí
  `marks()` devuelve las marcas del texto de afuera y se pierde la cursiva. Después, la baja
  de la marca y el recheck que ya hace RAE. Los helpers `serializeRange`/`parseFragmentHtml`
  de `rae-apply.ts` no entran: son para reemplazar un párrafo entero por HTML.
- **Bajo demanda** — un atajo sobre la palabra del cursor abre el mismo popover en modo
  tesauro, sin la línea de "ya apareció N palabras más arriba". El atajo concreto se elige
  revisando colisiones con los que ya existen en el editor.
- **Idioma** — el del capítulo (`meta.json`), el mismo que ya consume el detector.

## Degradación

- Sin entrada en el tesauro: el popover dice "sin sinónimos para «X»" y el resto del
  popover (distancia, ir a la anterior, ignorar) sigue funcionando igual.
- El popover nunca promete lo que no hay: no muestra la sección de sinónimos vacía ni un
  spinner colgado si el invoke falla.

## Fuera de alcance

- Lematización y conjugación de los sinónimos (ver "Por qué no lematizar").
- Panel lateral de tesauro con búsqueda libre e historial. El flujo es "estoy escribiendo y
  quiero otra palabra", y el popover ya lo cubre.
- Antónimos. Están en los datos del inglés y se descartan al podar; si algún día se quieren,
  es otro item.
- Sinónimos en el popover de gramática o de RAE. Solo repeticiones y bajo demanda.
- Speller offline con los `.aff`/`.dic` que están en la misma carpeta de LibreOffice. Es el
  siguiente item natural y reusa esta plomería de datos y licencias, pero no entra acá.

## Testing

- **`cargo test`** — parser MyThes y normalización, con un fixture chico en un
  `#[cfg(test)] mod tests` dentro de `tesauro.rs`, que es el patrón del repo (`grammar.rs`,
  `split_chapter.rs`, `create.rs`), más un test contra los datos reales vendoreados. Cubre: acepción única sin categoría (español), varias acepciones con
  categoría (inglés), enclítico, plural con re-pluralización, palabra ausente devolviendo
  vacío, y decodificación de una entrada acentuada del `.dat` ISO-8859-1.
- **`pnpm build`** — la mitad con DOM (popover, extensión, atajo) no tiene runner: el
  `CLAUDE.md` fija que se valida con build más verificación manual del autor.
- **Verificación manual del autor** — el item del `TODO.md` no se marca hasta que él lo
  pruebe con la app levantada.
