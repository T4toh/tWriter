# Formas derivadas del diccionario — estado y handoff

Fecha: 2026-09-01 · Rama: `feat/formas-derivadas-diccionario`

Este documento existe para retomar desde otra PC. El ledger de la sesión que
implementó esto vive en `.superpowers/sdd/`, que está git-ignored y **no viaja**;
todo lo que hace falta saber está acá.

- **Spec**: `docs/superpowers/specs/2026-08-31-formas-derivadas-diccionario-design.md`
- **Plan**: `docs/superpowers/plans/2026-08-31-formas-derivadas-diccionario.md`
- **TODO**: el item de conjugaciones está **cerrado**. Quedó abierto uno nuevo,
  sobre las limitaciones de `inferLemma` que salieron de la review del PR.

## Qué hace

`<saga>/diccionario.txt` solo silenciaba grafías exactas, así que cada forma
flexionada de una palabra inventada había que tipearla a mano. Ahora hay **dos
mecanismos**, y la regla que los separa es que **el generador nunca escribe un
plural**:

| | español | inglés |
|---|---|---|
| **Pelar al filtrar** (no escribe nada) | enclíticos, plural `-s`/`-es`/`-ces` | plural `-s` |
| **Generar al archivo** (preview editable) | verbos (15 formas), adjetivos de género (2) | — nada — |

Sale de medir los diccionarios reales: los verbos son un problema exclusivamente
español (0 verbos en 265 entradas inglesas), los infinitivos casi nunca están en
el diccionario porque se agrega la forma que marcó LT, y futuro/condicional/
subjuntivo tienen 0 apariciones en el corpus.

## Estado

```
7 commits · 13 archivos · +1170/-8
node scripts/run-derived-forms-smoke.mjs → 94 ok, 0 fail
pnpm build → PASS
```

| Fase | Estado |
|---|---|
| Tasks 1-6 (código) | ✅ implementadas, cada una con review de spec + calidad, todas limpias |
| Review final de rama | ✅ corrida — encontró 2 Critical y 4 Important |
| Ola de arreglos | ✅ `ac4a67e`, los 6 hallazgos ADDRESSED |
| Re-review acotada | ✅ cero breakage nuevo, recomienda merge |
| **Task 7 — verificación manual** | ✅ **hecha por el autor el 2026-09-01**, los 12 pasos |
| Review de CodeRabbit (PR #82) | ✅ triada, 3 arreglados / 3 descartados / 2 al TODO |
| Item del TODO | ✅ cerrado |

### Los commits

```
ac4a67e fix(diccionario): defectos de integración de las formas derivadas
556d07c feat(diccionario): «+ formas…» en el popover de LanguageTool
1372eac feat(diccionario): panel de formas derivadas con preview editable
85631bf feat(diccionario): el filtro de typos pela flexión
4fbea54 feat(diccionario): inferir el lema desde la forma marcada
1750aa8 feat(diccionario): generador de conjugación y género
54d23a0 feat(diccionario): pelado de flexión con regla por idioma de saga
```

## Verificación manual pendiente (Task 7)

Requiere LanguageTool arriba: `scripts/start-languagetool.sh` (Docker, `:8081`).
Después `pnpm tauri dev`.

Sobre **Meridian 2.0** (`idioma: es`):

1. Escribir `teletransportarían` en un capítulo. LT la marca.
2. Click en la marca → el popover muestra `Ignorar`, `+ diccionario` y `+ formas…`.
3. `+ formas…` → **el lema va a salir mal a propósito**: `-ían` infiere `-er`/`-ir`,
   así que propone `teletransportarer`. Corregirlo a mano a `teletransportar` → la
   lista pasa a 15 formas. Este paso prueba que el campo de lema editable cumple su
   función y no es decorativo.
4. Destildar dos formas → el botón tiene que decir `Agregar 13` → confirmar.
5. Las marcas de LT sobre las otras formas del capítulo desaparecen **sin recargar
   el capítulo**.
6. **Verificar que `teletransportó` y `teletransportá` SÍ quedaron en el
   diccionario.** Es la prueba del Critical 1 (ver abajo): antes del arreglo se
   perdían en silencio.
7. Escribir `teletransportándolo` → **no** queda marcada (pelado de enclítico + tilde).
8. Abrir el modal del diccionario y confirmar que las formas están, ordenadas, y
   que **no** hay plurales de participio (`teletransportados`) — esos los pela el
   filtro, no se escriben.

Cruzando sagas — **prueba del Critical 2**:

9. Con un capítulo de **Meridian** abierto, ir al landing y abrir el diccionario de
   **Milky Way**. Agregar algo con `+ formas…`. Tiene que escribirse en Milky Way,
   **no** en Meridian.
10. **Sin ningún capítulo abierto**, abrir un diccionario desde el landing: el botón
    `+ formas…` tiene que aparecer igual.
11. En Milky Way (`idioma: en`), marcar una palabra inventada → `+ formas…`
    **no** debe aparecer (en inglés no hay nada que generar).
12. Escribir `holoblades` en Milky Way → no queda marcada (plural `+s` pelado).

Si algo falla, anotar el paso y el síntoma.

## Lo que la review final atrapó, y por qué importa

Las seis reviews por tarea dieron limpio y aun así había dos Critical. No fue
negligencia: **el plan especificaba el código defectuoso**, así que cada reviewer
lo comparó contra su brief y coincidía. Solo mirando las seis tareas juntas
aparecen. Vale tenerlo presente para el próximo plan.

**Critical 1 — colisión de tildes.** `word-validator.ts` tenía **una sola**
`Intl.Collator` con `sensitivity: 'base'` sirviendo dos trabajos incompatibles:
ordenar alfabéticamente (donde ignorar tildes es correcto en español) y decidir
identidad (donde es incorrecto, porque la pertenencia real del diccionario es
`toLowerCase()` y sí distingue tildes). Como `generateForms` emite pares mínimos
a propósito (`bardeo`/`bardeó`, `bardea`/`bardeá`), el segundo de cada par se
descartaba en silencio: cada verbo `-ar` perdía el pretérito 3ª sg y el imperativo
voseo, el botón mentía el conteo, y al reabrir el panel los mostraba como «ya
está» y deshabilitados — sin ninguna forma de agregarlos nunca.
*Arreglo*: separar las dos. `compareWords`/`sortWords` conservan la collator base;
`existsCaseInsensitive` compara en minúsculas con tildes. Arregla de paso un bug
preexistente: hoy tampoco se podía agregar `bardeó` a mano si estaba `bardeo`.

**Critical 2 — el modal escribía a la saga equivocada.** El modal llamaba a
`SagaContextService.addManyToDictionary`, que escribe a la saga del **capítulo
activo**, mientras el modal edita una saga cualquiera. Con un capítulo de Meridian
abierto, agregar desde el diccionario de Milky Way escribía en Meridian con toast
de éxito. Y sin capítulo abierto `sagaPath()` es null, así que el botón no
aparecía nunca desde el landing.
*Arreglo*: el modal escribe por `DictionaryService.addManyWords`, que usa
`editing.path`; el idioma del gate sale de la saga editada vía `get_saga_config`.

Los Important eran: el panel tomaba solo el primer candidato de `inferLemma` (así
que `bardea`/`castea`/`teletransporta` — el caso dominante — abría vacío); el
panel se renderizaba **detrás** del modal (z-index 60 contra 200); el modal no
gateaba con `inferLemma` y generaba 15 conjugaciones de un verbo inexistente para
un nombre propio como `Krilar`; e `inferLemma` aceptaba `-amos`/`-ábamos` que el
generador nunca emite.

## Decisiones tomadas durante la implementación

1. **`ábamos`/`amos` salen de `REGLAS`** en vez de agrandar el generador. El núcleo
   de 15 formas tiene justificación explícita en el spec (costo asimétrico), así que
   agrandarlo es decisión de diseño del autor. Quedó una nota fechada en el spec.
   *Si se quiere revertir*: agregar las filas al generador y devolver los sufijos.
2. **El spec se corrigió con nota fechada**, no se reescribió — registrar ahí un
   defecto encontrado al implementar es lo correcto, el spec tiene que quedar cierto.
3. **`src/assets/licencias.json` queda sucio en cada build.** Es drift
   **preexistente**, ajeno a esta rama: el commit `5a227ab chore: bump v0.8.2` no
   regeneró el archivo, que quedó en `0.8.0`, y el prebuild lo corrige cada vez.
   No se commiteó acá para no colar un cambio ajeno en una rama de feature.
   **Pendiente de arreglar aparte.**

## Hallazgos parkeados (reales, no bloquean)

- La aserción de propiedad que verifica «todo sufijo de `REGLAS` es una forma que
  `generateForms` emite» es una **muestra de 29 palabras, no un loop sobre
  `REGLAS`**, así que no atajaría un sufijo agregado en el futuro. El invariante se
  verificó a mano y se cumple hoy para los 24 sufijos. *Follow-up: convertirla en loop.*
- `SagaContextService.addManyToDictionary` (camino del editor) agrega sin
  `sortWords`, mientras el modal ordena. **No es regresión de esta rama**:
  `addToDictionary`, que ya existía, también agrega sin ordenar.
- `addManyWords` devolviendo `{ok: true, added: 0}` tostea «0 formas agregadas».
  Cosmético e inalcanzable: el panel filtra las `yaEsta` antes de emitir.
- `MIN_RAIZ_SUFIJO_CORTO = 4` deja afuera verbos españoles cortos reales (`comer`,
  `vivir`). Inocuo: son palabras que LT conoce, nunca se marcan como TYPOS y nunca
  llegan al popover.
- **Limitación aceptada, no bug**: un nombre propio largo terminado en `-en`/`-an`
  (`Bastien`) igual propone un verbo (`bastier`). No hay forma de distinguirlo sin
  un etiquetador morfológico, y el popover aparece justo sobre palabras que LT no
  conoce, donde caen las dos cosas. El preview editable es el remedio: se cancela.
  Hay un `check` que pinea ese comportamiento para que nadie lo «arregle» rompiendo
  `bardean`.

## Para retomar en otra PC

```bash
git fetch origin && git checkout feat/formas-derivadas-diccionario && git pull
pnpm install
scripts/start-languagetool.sh          # Docker, :8081
node scripts/run-derived-forms-smoke.mjs   # tiene que dar 94 ok, 0 fail
pnpm tauri dev
```

Después, correr la verificación manual de arriba. Si pasa: marcar el item de
conjugaciones en `TODO.md` con `[x]`, anotando que la solución no fue ninguno de
los dos caminos que planteaba el item (conjugador vs. wildcard) sino un tercero —
generador para lo que no se puede pelar, pelado en el filtro para lo que sí.


## Review de CodeRabbit en el PR #82 (2026-09-01)

Ocho comentarios. Triados contra el código, no aceptados en bloque:

**Arreglados** (commit `209a405`):
- **Carrera al cambiar de saga** (Major, y el único de verdad importante).
  `dictWords.set(next)` sin guarda después del `await`: si el autor cambia de
  saga con el invoke en vuelo, la lista de la saga anterior queda instalada
  sobre la nueva y una escritura posterior la persiste encima. Era
  **preexistente** — `addToDictionary` ya lo hacía — y `addManyToDictionary` copió
  el patrón. Guardado en los tres lugares, incluido `persist()` de
  `DictionaryService`.
- **`formasPara` no se limpiaba al cerrar el modal**: al reabrirlo para otra saga
  el panel aparecía solo con la palabra vieja. (El mecanismo que describía
  CodeRabbit era otro y estaba mal: `close()` sí resetea el idioma, así que el
  panel no queda montado. El bug real es al reabrir.)
- Una frase del spec que decía que `bardear` no termina en `-ar`.

**Descartados, con razón**:
- **`tsc` vs `tsc.cmd` en Windows**: ningún workflow de CI corre los smoke
  runners (verificado), el patrón es idéntico en los seis que ya existían, y el
  autor trabaja en Linux. No lo introduce este PR.
- **Línea vacía antes de un comentario SCSS**: stylelint no está configurado en
  el repo, no hay linter que lo marque nunca.
- **Renombrar `canDeriveForms`/`addToDictWithForms` a español**: el contrato
  entero de ese popover ya es inglés (`addToDict`, `canAddToDict`,
  `dictSuggestions`, `apply`, `dismiss`). Renombrar solo lo nuevo dejaría el
  archivo más inconsistente, no menos.

**Al TODO, no arreglados**: `inferLemma` no invierte los cambios ortográficos
(`tranqué` → `tranquar`) ni sirve a raíces de 3 letras (`pagás`, `leo` → `[]`).
Verificado que es más amplio de lo que decía CodeRabbit, y también que no muerde:
son verbos españoles reales que LT conoce y que nunca llegan al popover. Bajar el
piso de raíz corta reintroduciría `Aedan` → `aedar`.
