# Changelog

Los cambios de tWriter que se notan al usarlo, escritos para quien la usa y no con el detalle de cómo está hecha por dentro.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones siguen [Semantic Versioning](https://semver.org/lang/es/): **patch** si solo hay `Fixed` o `Security`, **minor** si hay algo en `Added`, `Changed`, `Deprecated` o `Removed`, y **major** si rompe compatibilidad (desde 1.0, un `Removed` pide major).

Cada PR con un cambio visible suma su línea en `[Unreleased]`, bajo su tipo. Al cortar un release, `scripts/bump-version.sh` la cierra con la versión y la fecha (y rechaza un número más chico de lo que pide el contenido), y `.github/workflows/release.yml` la pone en el borrador del release.

De 0.21.0 para atrás no hubo changelog: esas entradas son los títulos de los PR de cada versión, clasificados por su prefijo y reconstruidos del historial de git el 2026-09-30.

## [Unreleased]

### Changed

- Los popovers de gramática, raya y repeticiones usan los mismos botones: mismo alto, sin etiquetas partidas en dos renglones, «Ignorar» siempre al final y, si no entran en una fila, bajan a la siguiente.

### Fixed

- Abrir dos capítulos seguidos rápido deja abierto el último que se clickeó, no el que terminó de cargar último.
- Saltar desde el panel «Revisar raya» abre el popover sobre la violación, como ya pasaba en gramática y repeticiones.
- La fila «Rayas» de «Revisar» cuenta los diálogos por convertir, no los capítulos.
- Al redimensionar la ventana, el popover abierto acompaña al texto en vez de quedar donde estaba la palabra antes.
- En la búsqueda «Archivo actual», cada línea del resultado lleva a su párrafo y no todas al mismo.
- Pasar de un capítulo a una nota (o al revés), o cerrar el panel dividido, ya no pierde lo último que se tipeó antes del autoguardado.
- El chip «Publicada» de la tarjeta del libro va en verde cuando lo publicado está al día y en gris cuando hay ediciones posteriores. Se entera al editar un capítulo, sin esperar a exportar, y ya no cambia solo por exportar ni por tocar las notas del libro.
- El chequeo de raya ya no marca como «raya huérfana» un verbo de habla que está adentro de una cita «…» o “…” en el diálogo (`—Me escribió: «No vengas. Dijo mamá que no.»`).
- Tampoco la marca cuando habla el personaje y no hay narrador: un verbo en minúscula después de los puntos suspensivos (`solo… decía.`), el «dicen» impersonal (`Dicen pelotudeces en el pueblo.`) o un verbo seguido de «nuestros» (`Interrumpieron nuestros planes.`).

## [0.23.0] - 2026-10-01

### Added

- «Acerca de» muestra las novedades de la última versión, con las anteriores a un click.

### Fixed

- «Revisar» de la novela cuenta también lo que se corrige a mano (avisos de raya sin arreglo automático y mayúsculas rancias), con su «ver»: antes decía «sin cambios» aunque quedaran errores.
- El chequeo de raya ya no confunde una orden del personaje («—Se nota, mago. Repite tu historia.») con un verbo de habla al que le falta la raya.
- La pestaña Licencias de «Acerca de» ya no repite `zip` y `reqwest` con una versión que no es la que usa tWriter.

## [0.22.0] - 2026-09-30

### Added

- Reglas nuevas del validador de raya, cada una con su sección del DPD: mayúscula o minúscula del comentario del narrador (2.3c, 2.3d y 2.3e), la puntuación después de la raya de cierre (`—dijo Carlos—; lo haré`), sin raya de cierre al final del párrafo, espacios alrededor de las rayas, puntos de más (`..`, `....`, salvo después de una abreviatura), espacio doble e inciso narrativo sin cerrar.
- Retomar el parlamento con `. —` se marca con un arreglo de a uno: la revisión en bloque no lo aplica sola.
- Cada marca de raya muestra un ejemplo ✗/✓ y el link a la sección del DPD. «Ver todas las reglas» abre una chuleta de diálogos con raya.
- La conversión reconoce la coma fuera de las comillas, que es la puntuación española (`"Hola", dijo Juan.` → `—Hola —dijo Juan.`), el pronombre antes del verbo (`le dijo`), perífrasis (`volvió a decir`) y muchos verbos de habla más, incluidos la primera persona y el imperfecto.
- `--`, `-`, `–` y `―` pasan a raya en cualquier posición del diálogo, sin tocar rangos, números negativos ni palabras compuestas.

### Changed

- La conversión y el validador de diálogos se revisaron contra el *Diccionario panhispánico de dudas* (raya, comillas y puntos suspensivos), con un corpus de más de 200 casos como regresión.
- «RAE» pasa a llamarse «Raya» en toda la app. La preferencia del toggle se conserva.
- El idioma del libro manda sobre el del capítulo, y abrir un capítulo ya no escribe su `meta.json`.

### Fixed

- El converter ya no rompe texto correcto: un párrafo convertido ya no aplana las «» y los ’ del resto del capítulo, y citas internas (`—Me dijo «Vete» y se fue.`), comillas en la narración, apóstrofos (`rock'n'roll`), pensamientos, citas con comentario, versos y comillas de seguir (`»`) quedan como están.
- Los puntos suspensivos ya no se pierden al convertir.
- Ctrl+Z ya no trae el texto del capítulo anterior, ni lo guarda encima del abierto.
- Cambiar el idioma o la variante rechequea raya, repeticiones y LanguageTool en el acto.
- El validador no marca versos ni títulos, y `&nbsp;` junto a la comilla convierte bien.
- Un arreglo de raya ya no pisa lo que se tipeó adentro de la marca.

## [0.21.0] - 2026-09-28

### Added

- Inciso de advertencia de contenido (#157)
- Sangría como el EPUB y caret ámbar con cursiva activa (#158)

### Fixed

- Regenerar 48x48 con el ícono nuevo (#156)

## [0.20.0] - 2026-09-22

### Added

- Zoom, pan y encaje en el visor de imágenes (#154)
- Mayúsculas rancias en el panel RAE + escaneo al abrir el modal de revisión (#155)

### Fixed

- "Crear parte" desde un libro, y lo tipeado al cambiar de capítulo (#153)

## [0.19.0] - 2026-09-19

### Fixed

- Parches 0004 y 0005: guarda del participio, y los dos ya mergeados upstream (#151)
- El registro de publicaciones, legible en la tarjeta y editable a mano (#152)

## [0.18.0] - 2026-09-18

### Added

- Red bajo los dos botones destructivos del popover de gramática (#143)
- Campana con el historial de avisos en la status bar (#145)
- Estados de la novela e historial de revisiones desde el export (#147)

### Fixed

- Parches 0004 y 0005 de LanguageTool: dos falsos positivos medidos sobre el corpus (#148)

## [0.17.0] - 2026-09-14

### Changed

- Sacar el Eager explícito de los 26 componentes y quedar en OnPush (#141)

## [0.16.0] - 2026-09-14

### Added

- Auditoría de gramática por alcance (#135)
- Formato de fecha configurable en la biblioteca (#138)
- La puntuación de la query filtra por literal (#139)

### Fixed

- CSS del EPUB para Google Play, bloque de verso único, popover con dblclick (#133)

## [0.15.0] - 2026-09-13

### Fixed

- Convertir hardBreak en corte de párrafo (#132)

## [0.14.0] - 2026-09-12

### Fixed

- Menú sin borrado para saga/libro en el árbol de notas (#131)

## [0.13.0] - 2026-09-12

### Added

- Bloque de verso en la toolbar y en el menú contextual (#126)
- Exportar una muestra del libro con página de cierre (#128)
- Índice sin partes numeradas y con el numeral en columna (#129)
- Firma en «Sobre el autor» y siguiente destacado en «Otros libros» (#130)

### Fixed

- El bloque de verso no invierte la itálica del texto (#125)
- Cerrar el popover de repeticiones al abrir el de gramática (#127)

## [0.12.0] - 2026-09-08

### Added

- Validar el EPUB exportado con epubcheck + header de saga en barra (#122)

## [0.11.0] - 2026-09-08

### Added

- Mostrar el ruleId de LT y poder matar la regla por saga (#121)

### Changed

- Unificar helpers duplicados y primera pasada de limpieza del SCSS (#106)
- Una sola clase .modal-backdrop, y matcher exacto para la rueda (#107)
- .modal-card y .modal-header globales (rescate del #109) (#110)
- Campos de formulario y shell de tarjeta, + borrar el CSS de select muerto (#111)
- Shell compartido para los dos paneles de auditoría (#112)
- Los colores de estado pasan a --err/--ok/--warn (#113)
- Últimos restos de la pasada, y cerrar el bloque en TODO.md (#114)
- Caja compartida para los tres popovers del editor (#116)
- Fills de error al token, tintes con su par, y cerrar la pasada (#117)
- Footer de modal y etiqueta de tarjeta, la capa que el audit no vio (#118)
- Chrome compartido de los dos editores, y el último accent sin tema (#119)

### Fixed

- Bloquear la rueda atrás de los modales y limpiar el editor al cambiar de carpeta (#104)
- Cargar extras y exportados al hidratar el árbol desde settings (#108)

## [0.10.0] - 2026-09-04

### Added

- Tema de la app, fuentes bundleadas y apartado Apariencia (#96)
- Términos compuestos que se matchean como rango (#102)
- Panel de auditoría por libro, con salto y popover al lugar (#103)

### Fixed

- Escribir capítulos y meta de forma atómica (tmp + rename) (#97)
- Que el índice deje de quedarse mudo en silencio (#98)
- Que el salto encuentre una frase partida por una itálica (#99)
- Que los guards del reemplazo miren el contenido y no el reloj (#101)

## [0.9.3] - 2026-09-03

### Added

- Buscar y reemplazar en lote a través del repo, sagas y libros (#94)

### Fixed

- El click lleva al match, la nota sobrevive y el matcheo filtra (#93)

## [0.9.2] - 2026-09-02

_Sin cambios visibles registrados._

## [0.9.1] - 2026-09-02

### Added

- Botón de inicio, y el modal de gramática pasa a ser Configuración (#88)
- Decir en qué paso está el export en vez de esperar mudo (#90)
- Vista para revisar y corregir un libro entero (#92)

### Fixed

- Leer epub_style.css en runtime en vez de include_str! (#87)
- Reconciliar estado local tras un rename de carpeta hecho afuera de la app (#89)
- Que cada export filtre sus propios eventos de progreso (#91)

## [0.9.0] - 2026-09-02

### Added

- Formas derivadas per-saga — conjugación, género y pelado de flexión (#82)
- Mazo de tapas en la vista de saga y contadores por kind (#83)
- Back matter del EPUB: catálogo de publicados, perfil de autor y página legal por incisos (#86)

### Fixed

- Dejar la imagen elegida dentro del repo y no confiar en el path (#84)

## [0.8.2] - 2026-08-31

### Added

- Form de bloques con plantillas guardables (#81)

## [0.8.1] - 2026-08-21

### Added

- Relevamiento de alternativas a LanguageTool + sagas numeradas (#76)
- Plantillas, creación visible y tabs "Este libro" / "Todas" (#79)

### Fixed

- El error de LanguageTool abre la configuración; fix del hint de split colgado (#80)

## [0.8.0] - 2026-08-20

### Added

- Detector de repeticiones cercanas (es + en) (#73)
- Tesauro de sinónimos embebido (español + inglés) (#74)
- Modal Acerca de con licencias, y unificación de los botones de diálogo (#75)

### Fixed

- Marcas de gramática corridas + toggle de nivel picky (#70)

## [0.7.3] - 2026-07-30

### Added

- Control total del tipeo — matar el corrector del OS, sugerir del diccionario propio y ubicar bien los popovers (#63)
- Scrolloff del caret — margen de respiro al tipear en los tres editores (#64)
- Levantar LanguageTool sin saber de containers — remedio accionable adentro de la app (#66)

### Fixed

- Un solo popover por palabra y placement del panel de select con placePopover (#65)
- Recordar en qué runtime vive LanguageTool y preguntar cuando no se sabe (#67)
- El popover deja de tirar el markup inline al aplicar un fix (#68)

## [0.7.2] - 2026-07-20

### Added

- Soportar Docker, Podman y Apple container para LanguageTool (#62)

## [0.7.1] - 2026-07-20

### Fixed

- Firmar ad-hoc el bundle para no romper el instalador ARM (#61)

## [0.7.0] - 2026-07-13

### Added

- Comillas tipográficas (inglés) + fixes de modal y árbol (#60)

## [0.6.0] - 2026-06-29

_Sin cambios visibles registrados._

## [0.5.7] - 2026-06-27

### Fixed

- Git2 sin default-features para cross-compile x86_64 macOS (#56)
- Resolver docker/pandoc por ruta, no por PATH (#57)

## [0.5.6] - 2026-06-25

### Added

- Sync per-saga vía git con union merge (#51)
- Exacta por default + toggle ≈ (fuzzy/acentos) + fix snippet (#52)
- Segundo árbol de notas + navegar sin perder foco (#53)

## [0.5.2] - 2026-06-04

### Fixed

- Suprimir update fantasma de setEditable + baseline canónico (#49)
- Eliminar flash de scrollbars y mover indicador "guardando" al status-bar (#50)

## [0.5.1] - 2026-06-01

### Fixed

- Cursor fantasma, apertura al final, árbol abierto, ícono Wayland (#48)

## [0.5.0] - 2026-05-26

### Changed

- Feat/theme editor redesign font cleanup (#47)

## [0.4.4] - 2026-05-26

_Sin cambios visibles registrados._

## [0.4.3] - 2026-05-20

### Added

- Event-driven git sync + run_git hardening (#46)

### Fixed

- Refrescar árbol/editor/búsqueda tras pull (#45)

## [0.4.2] - 2026-05-19

### Added

- Vista dedicada del diccionario + validación (#42)
- Swap emojis a Lucide (#44)

### Fixed

- Refresh árbol mtime tras save + lateral abre al tope (#43)

## [0.4.1] - 2026-05-19

### Added

- Último editado + fixes de sync, dict y dirty fantasma (#41)

## [0.4.0] - 2026-05-18

### Added

- Operators, scope filter, stopwords ES and BM25 debug (#34)
- Edit-in-place mode in right-panel markdown reader (#35)
- Restaurar último cap + cursor + tree expand entre boots (#36)
- Scope 'Archivo actual' + agrupación por archivo (#37)
- Enhance source classification logic for chapters and su… (#39)
- Reestructurar capítulos en partes + RAE post-split (#40)

### Changed

- Cache covers as blob URLs (#38)

## [0.3.7] - 2026-05-15

### Added

- Saga sin prefix orden + folder-card con chips (#33)

## [0.3.6] - 2026-05-15

_Sin cambios visibles registrados._

## [0.3.5] - 2026-05-15

### Added

- Selector de fuentes con OS, pool, tema y presets (#32)

### Fixed

- Pull con auto-upstream, layout flat editor, redo, selector fuente (#28)
- UX honesta de sync + decoupling de stats volátiles (#29)
- Cerrar race StorageService.detect ↔ GitService.effect (#30)
- Párrafos vacíos no colapsan en el reader (#31)

## [0.3.4] - 2026-05-14

### Fixed

- Unblock LT checker (panic, offsets, recovery) (#27)

## [0.3.3] - 2026-05-14

### Added

- Tree DnD reorder + cross-parent moves (#26)

## [0.3.2] - 2026-05-14

_Sin cambios visibles registrados._

## [0.3.1] - 2026-05-14

_Sin cambios visibles registrados._

## [0.3.0] - 2026-05-14

### Added

- Wizard demo + fix RAE cerrar raya en inciso (D3/D4) + Unicode \b (#20)
- Validador inline + batch audit + Python deprecation (#21)
- Sync seamless entre PCs (auto-rebase + auto-pull + .twriter/ ignore) (#22)
- Polish UX + search exact-form + LT offset trace (#24)
- Subcarpetas → extras, opt-in saga-level, tree jerárquico (#25)

### Changed

- Strip EPUB defaults, centralize presentation in themes (#23)

## [0.2.0] - 2026-05-13

### Added

- Extras + covers + image viewer + saga config + Exportados (#1)
- Panel-left footer + epílogo support + chapter creators (#2)
- ModalService custom (reemplaza prompt/confirm/alert nativos) (#3)
- Temas reutilizables + fuentes embebidas en EPUB (Sprint 10) (#4)
- Per-style faces (italic / bold / bold-italic) en theme (#5)
- Sprint 12: tema editorial + página Sobre el autor (#6)
- Posición vertical del título de capítulo en EPUB (fix Kindle + config) (#7)
- Crear tema desde plantilla (#8)
- Centralizar menú contextual en ContextMenuService (#9)
- Variante per saga + auto-check auto-on + pulse LT visible (#11)
- Pickers via xdg-portal + componente <app-select> custom (#12)
- Panel debug completo + fix gramática pandoc + spacing toggle (#13)
- Notas markdown + pool global de fuentes + preview (#14)
- Panel derecho read-only para .md + presets de ancho (#15)
- Split horizontal/vertical via drag&drop del tree (#16)
- Carpetas libres en root + búsqueda full-text + importer Joplin (#17)
- Detección git/cloud/local + modal guía git (#18)
- Release polish — metadata, Docker UX, LT Premium + keyring storage (#19)

## [0.1.13] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.12] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.11] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.10] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.8] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.7] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.6] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.5] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.4] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.3] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.2] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.1] - 2026-05-08

_Sin cambios visibles registrados._

## [0.1.0] - 2026-05-08

_Sin cambios visibles registrados._

[unreleased]: https://github.com/T4toh/tWriter/compare/v0.23.0...HEAD
[0.23.0]: https://github.com/T4toh/tWriter/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/T4toh/tWriter/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/T4toh/tWriter/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/T4toh/tWriter/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/T4toh/tWriter/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/T4toh/tWriter/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/T4toh/tWriter/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/T4toh/tWriter/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/T4toh/tWriter/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/T4toh/tWriter/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/T4toh/tWriter/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/T4toh/tWriter/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/T4toh/tWriter/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/T4toh/tWriter/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/T4toh/tWriter/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/T4toh/tWriter/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/T4toh/tWriter/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/T4toh/tWriter/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/T4toh/tWriter/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/T4toh/tWriter/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/T4toh/tWriter/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/T4toh/tWriter/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/T4toh/tWriter/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/T4toh/tWriter/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/T4toh/tWriter/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/T4toh/tWriter/compare/v0.5.7...v0.6.0
[0.5.7]: https://github.com/T4toh/tWriter/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/T4toh/tWriter/compare/v0.5.2...v0.5.6
[0.5.2]: https://github.com/T4toh/tWriter/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/T4toh/tWriter/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/T4toh/tWriter/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/T4toh/tWriter/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/T4toh/tWriter/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/T4toh/tWriter/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/T4toh/tWriter/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/T4toh/tWriter/compare/v0.3.7...v0.4.0
[0.3.7]: https://github.com/T4toh/tWriter/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/T4toh/tWriter/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/T4toh/tWriter/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/T4toh/tWriter/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/T4toh/tWriter/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/T4toh/tWriter/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/T4toh/tWriter/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/T4toh/tWriter/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/T4toh/tWriter/compare/v0.1.13...v0.2.0
[0.1.13]: https://github.com/T4toh/tWriter/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/T4toh/tWriter/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/T4toh/tWriter/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/T4toh/tWriter/compare/v0.1.8...v0.1.10
[0.1.8]: https://github.com/T4toh/tWriter/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/T4toh/tWriter/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/T4toh/tWriter/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/T4toh/tWriter/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/T4toh/tWriter/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/T4toh/tWriter/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/T4toh/tWriter/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/T4toh/tWriter/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/T4toh/tWriter/releases/tag/v0.1.0
