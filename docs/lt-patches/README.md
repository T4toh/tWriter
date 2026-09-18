# Parches propios para LanguageTool

Reglas del español que escribimos acá y mandamos upstream a
[`languagetool-org/languagetool`](https://github.com/languagetool-org/languagetool).
El parche vive acá para poder aplicarlo a mano sobre el container y no perderlo.
**Mergeado upstream no quiere decir que esté en el container**: la imagen que
usamos es `erikvl87/languagetool:latest`, hoy LT 6.8 con `buildDate 2026-06-15`,
o sea anterior a los merges — los tres primeros siguen haciendo falta a mano
hasta que salga la release que los incluya.

Fork: `T4toh/languagetool`. Clone local: `~/Repos/Personal/languagetool`.
**El fork se borró después de que mergearan los tres primeros PR**, y sin fork no
hay dónde pushear la rama ni desde dónde abrir el PR. Si vuelve a pasar,
`gh repo fork languagetool-org/languagetool --clone=false` lo rehace y las ramas
que ya estén commiteadas en el clone se pushean tal cual: no hace falta rebasar
—`0004` y `0005` salieron de un `master` local de agosto y GitHub los dio
`MERGEABLE` igual—, porque los parches tocan zonas que nadie más movió.

## Estado

| Parche | Rama del fork | PR upstream | Estado |
|---|---|---|---|
| `0001-es-DETRAS_PX-adverbio-lugar.patch` | `es-adverbio-lugar-atras-adelante` | [#12131](https://github.com/languagetool-org/languagetool/pull/12131) | **mergeado** 2026-08-31 |
| `0002-es-tu-verbo-voseante.patch` | `es-tu-verbo-voseante` | [#12132](https://github.com/languagetool-org/languagetool/pull/12132) | **mergeado** 2026-08-31 |
| `0003-es-mezcla-tuteo-voseo.patch` | `es-mezcla-tuteo-voseo` | [#12133](https://github.com/languagetool-org/languagetool/pull/12133) | **mergeado** 2026-08-31 |
| `0004-es-tu-tilde-puntos-suspensivos.patch` | `es-tu-tilde-puntos-suspensivos` | [#12195](https://github.com/languagetool-org/languagetool/pull/12195) | abierto 2026-09-18 |
| `0005-es-mas-seguido-adverbio.patch` | `es-mas-seguido-adverbio` | [#12196](https://github.com/languagetool-org/languagetool/pull/12196) | abierto 2026-09-18 |

`0005` son **dos commits** (el `.patch` es un mbox con los dos, `git am` los
aplica de una): el antipatrón, y el acote del `skip` que salió de la review.

Las ramas salen de `master`, son independientes entre sí y no se pisan.

Las dos ramas de `0004` y `0005` se rebasaron sobre `upstream/master` el
2026-09-18 y se force-pushearon (`--force-with-lease`), así que los PR quedaron
en 0 commits atrás. Ojo con el clone: está hecho con `--single-branch`, o sea
que `remote.origin.fetch` solo mapea `master` y el `--force-with-lease` falla
con «stale info» porque no hay ref de seguimiento con qué comparar. Se arregla
una vez con `git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`
y un `git fetch origin`.

## Aplicar sobre el clone del fork

```bash
git -C ~/Repos/Personal/languagetool am ~/Repos/Personal/tWriter/docs/lt-patches/0001-es-DETRAS_PX-adverbio-lugar.patch
```

## Aplicar sobre el container (se pierde si el container se recrea)

`grammar.xml` y `entities.ent` son archivos sueltos en el filesystem del
container, no están dentro de un jar, así que se pueden editar y el server los
lee al reiniciar. **Hacer backup antes**, es la única forma de volver atrás:

```bash
container exec twriter-languagetool cp /LanguageTool/org/languagetool/rules/es/grammar.xml /tmp/grammar.xml.bak
container exec twriter-languagetool cp /LanguageTool/org/languagetool/resource/es/entities.ent /tmp/entities.ent.bak
```

`0001` (`DETRAS_PX`) es una línea de `entities.ent`:

```bash
container exec twriter-languagetool sed -i '20s|.*|<!ENTITY adverbio_lugar "detr\&#225;s\|atr\&#225;s\|delante\|adelante\|debajo\|abajo\|encima\|arriba\|cerca">|' /LanguageTool/org/languagetool/resource/es/entities.ent
```

`0002` (`tú` + verbo voseante) es una línea de `grammar.xml` — ojo que el número
de línea es el de LT 6.8, verificar con
`grep -n 'V.\[^M\].\[13\]..|V.\[^M\].2P.'`:

```bash
container exec twriter-languagetool sed -i '24945s|2P\." postag_regexp|2[PV]." postag_regexp|' /LanguageTool/org/languagetool/rules/es/grammar.xml
```

`0003` (`MEZCLA_TUTEO_VOSEO`) es un rulegroup entero: se extrae del clone y se
inserta antes del `</category>` de `GRAMMAR` (línea 20121 en LT 6.8). `container
exec` no acepta stdin, así que el archivo viaja en base64:

```bash
B64=$(base64 -i /tmp/frag.xml | tr -d '\n')   # frag.xml = el rulegroup solo
container exec twriter-languagetool sh -c "echo $B64 | base64 -d > /tmp/frag.xml"
container exec twriter-languagetool sed -i '20121r /tmp/frag.xml' /LanguageTool/org/languagetool/rules/es/grammar.xml
```

`0004` (`TU_TILDE` con puntos suspensivos) es un token nuevo dentro de un
antipatrón, o sea una línea suelta después de la 9579 de `grammar.xml` en LT 6.8
(verificar con `grep -n 'R.|LOC_ADV|_QM_OPEN'`, es la cuarta coincidencia):

```bash
printf '                    <token min="0" max="3" regexp="yes">\xe2\x80\xa6|\\.</token>\n' > /tmp/frag-tu.xml
B64=$(base64 -i /tmp/frag-tu.xml | tr -d '\n')
container exec twriter-languagetool sh -c "echo $B64 | base64 -d > /tmp/frag-tu.xml"
container exec twriter-languagetool sed -i '9579r /tmp/frag-tu.xml' /LanguageTool/org/languagetool/rules/es/grammar.xml
```

`0005` (`más seguido` adverbial) es un antipatrón entero del rulegroup
`AGREEMENT_POSTPONED_ADJ`, que va antes de su primer `<rule>` (línea 23539 en LT
6.8, justo después del antipatrón de `por ciento`). Mismo viaje en base64 que
`0003`, con el bloque `<antipattern>…</antipattern>` del parche en `/tmp/frag.xml`:

```bash
container exec twriter-languagetool sed -i '23539r /tmp/frag.xml' /LanguageTool/org/languagetool/rules/es/grammar.xml
```

Ojo con el orden si se aplican los dos: `0005` toca una línea más abajo que
`0004`, así que va primero, o el número de `0005` se corre en uno.

Después de cualquiera de ellos, reiniciar el server:

```bash
container stop twriter-languagetool && container start twriter-languagetool
```

Volver atrás: `container exec twriter-languagetool cp /tmp/grammar.xml.bak /LanguageTool/org/languagetool/rules/es/grammar.xml`
(ídem `entities.ent`) y reiniciar.

## Verificar

- Tests de LT (pide `mvn` + JDK 17+), valida el XSD y los `<example>`:
  ```bash
  cd ~/Repos/Personal/languagetool
  mvn -pl languagetool-language-modules/es -am -Dtest=SpanishPatternRuleTest -Dsurefire.failIfNoSpecifiedTests=false test
  ```
  El flag es `-Dsurefire.failIfNoSpecifiedTests=false`, no `-DfailIfNoTests`:
  `-am` arrastra `languagetool-core`, que no tiene ningún test con ese nombre, y
  surefire corta el build ahí antes de llegar al módulo `es`.
- Falsos positivos contra la obra real, con el container levantado — correrlo
  **antes y después** de parchear y comparar, porque una regla que ya existía
  puede tener hits propios:
  ```bash
  node scripts/scan-regla-lt.mjs DETRAS_PX ~/novelas es-AR
  node scripts/scan-regla-lt.mjs AGREEMENT_PRONOUNSUBJECT_VERB ~/novelas es-AR
  node scripts/scan-regla-lt.mjs MEZCLA_TUTEO_VOSEO ~/novelas es-AR
  node scripts/scan-regla-lt.mjs TU_TILDE ~/novelas es-AR
  node scripts/scan-regla-lt.mjs AGREEMENT_POSTPONED_ADJ ~/novelas es-AR
  ```
  Medido el 2026-09-18 sobre `~/novelas` (592 archivos, 810k palabras), con el
  container en LT 6.8: `TU_TILDE` 22 hits → 2 con `0004`, `AGREEMENT_POSTPONED_ADJ`
  24 → 21 con `0005`, y **ningún hit nuevo** en ninguna de las dos (`comm -13`
  entre el antes y el después da vacío). Los 22 de `TU_TILDE` eran todos el mismo
  falso positivo; los 2 que sobreviven no son de la regla, ver abajo.

## Lo que queda afuera de `0004`: la oración se parte en los puntos suspensivos

Los 2 hits de `TU_TILDE` que sobreviven al parche —«Ya está, tu… T…» y
«prestame tu… ¿fuego?»— no los puede arreglar ninguna regla. Cuando a los
puntos suspensivos les sigue un `¿` o una mayúscula, LT **cierra la oración
ahí**, así que el sustantivo queda en la oración siguiente y ningún antipatrón
llega a verlo. Se comprueba con el tagger:

```bash
container exec twriter-languagetool sh -c 'echo "Dame tu… ¿fuego?" > /tmp/t.txt && java -jar /LanguageTool/languagetool-commandline.jar -l es --taggeronly /tmp/t.txt'
# <S> Dame[…] tu[tu/DP2CSS]…[</S>…/_PUNCT]
# <S> ¿[¿/_PUNCT_CONT]fuego[fuego/NCMS000]?[</S>?/_PUNCT]
```

El síntoma delator es que en esas mismas frases salta además
`UPPERCASE_SENTENCE_START`. El arreglo sería en la segmentación (el SRX de
`segment.srx`), no en `grammar.xml`, y es un parche aparte que todavía no está
escrito.

## Lo que enseñó la review de `0005`: `skip="-1"` se come la oración entera

CodeRabbit marcó que el `skip="-1"` del antipatrón barre hasta el final de la
oración analizada, así que un verbo de la principal alcanza para tapar un caso
adjetival de la subordinada. Es cierto, aunque **el ejemplo que dio no
reproduce**: `Creo que la serie más seguido fue esa.` sale limpia con y sin el
parche. El que sí rompía es `Dice que la película más seguido de la tele fue
esa.`, que se marcaba antes y salía limpia después.

El acote es un `<exception scope="next">` sobre el tramo salteado, o sea que el
verbo tiene que estar en la misma oración:

```xml
<token postag="V.*" postag_regexp="yes" skip="-1"><exception scope="next" regexp="yes">que|quien|…|,|;|:</exception></token>
```

Los usos adverbiales no se tocan, porque el verbo que necesitan está en su
propia cláusula: `Quiero que vengas más seguido.` sigue limpia matcheando
`vengas`. Y sobre el corpus no cambia **nada**: 21 hits antes y después, el
mismo conjunto exacto.

Vale como regla general para los parches que vengan: un `skip="-1"` sin acotar
es cómodo para que el antipatrón matchee, y por eso mismo tapa de más. Medir
sobre el corpus no lo detecta —acá el corpus dio idéntico— porque el caso que
se pierde es justo el que la obra no tiene.
