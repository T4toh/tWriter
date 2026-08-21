# Parches propios para LanguageTool

Reglas del español que escribimos acá y mandamos upstream a
[`languagetool-org/languagetool`](https://github.com/languagetool-org/languagetool).
Mientras un PR no esté mergeado, el parche vive acá para poder aplicarlo a mano
sobre el container y no perderlo.

Fork: `T4toh/languagetool`. Clone local: `~/Repos/Personal/languagetool`.

## Estado

| Parche | Rama del fork | PR upstream | Estado |
|---|---|---|---|
| `0001-es-DETRAS_PX-adverbio-lugar.patch` | `es-adverbio-lugar-atras-adelante` | [#12131](https://github.com/languagetool-org/languagetool/pull/12131) | abierto 2026-08-21 |
| `0002-es-tu-verbo-voseante.patch` | `es-tu-verbo-voseante` | [#12132](https://github.com/languagetool-org/languagetool/pull/12132) | abierto 2026-08-21 |
| `0003-es-mezcla-tuteo-voseo.patch` | `es-mezcla-tuteo-voseo` | [#12133](https://github.com/languagetool-org/languagetool/pull/12133) | abierto 2026-08-21 |

Las tres ramas salen de `master`, son independientes entre sí y no se pisan.

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

Después de cualquiera de los tres, reiniciar el server:

```bash
container stop twriter-languagetool && container start twriter-languagetool
```

Volver atrás: `container exec twriter-languagetool cp /tmp/grammar.xml.bak /LanguageTool/org/languagetool/rules/es/grammar.xml`
(ídem `entities.ent`) y reiniciar.

## Verificar

- Tests de LT (pide `mvn` + JDK 17+), valida el XSD y los `<example>`:
  ```bash
  cd ~/Repos/Personal/languagetool
  mvn -pl languagetool-language-modules/es -am -Dtest=SpanishPatternRuleTest -DfailIfNoTests=false test
  ```
- Falsos positivos contra la obra real, con el container levantado — correrlo
  **antes y después** de parchear y comparar, porque una regla que ya existía
  puede tener hits propios:
  ```bash
  node scripts/scan-regla-lt.mjs DETRAS_PX ~/novelas es-AR
  node scripts/scan-regla-lt.mjs AGREEMENT_PRONOUNSUBJECT_VERB ~/novelas es-AR
  node scripts/scan-regla-lt.mjs MEZCLA_TUTEO_VOSEO ~/novelas es-AR
  ```
