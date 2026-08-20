# Tesauros de terceros bundleados en tWriter

tWriter es MIT. Estos datos NO lo son — cada uno mantiene su licencia.

## `th_es_v2.dat` — español

OpenThesaurus-es, versión para LibreOffice / Apache OpenOffice.
Autor: Marcelo Garrone. Snapshot generado el 2012-01-11.
Distribuido bajo **GNU LGPL 2.1** (`COPYING-LGPL-2.1.txt`).

**Se shipea sin ninguna modificación**, byte por byte como viene en la
extensión `dict-es` de LibreOffice. Encoding ISO-8859-1.

## `th_en_us.dat` — inglés

Derivado del tesauro `th_en_US_v2.dat` de la extensión `dict-en` de
LibreOffice, generado a partir de **WordNet 2.1**, Copyright 2005 by
Princeton University. Licencia completa en `WordNet_license.txt`.

**Modificado**: `scripts/podar-tesauro-en.mjs` eliminó los sinónimos
etiquetados `(generic term)`, `(related term)`, `(similar term)` y
`(antonym)`, recalculó la cantidad de acepciones de cada entrada y descartó
las entradas que quedaron sin ninguna. El resto del contenido y el formato
MyThes están intactos. Encoding UTF-8.
