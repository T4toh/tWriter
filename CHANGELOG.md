# Changelog

Qué cambia en cada versión de tWriter, escrito para quien la usa: qué nota el autor, no cómo está hecho por dentro.

Cada PR con un cambio visible suma su línea en **Sin publicar**. Al cortar un release, `scripts/bump-version.sh` cierra esa sección con la versión y la fecha, y `.github/workflows/release.yml` la pone en el borrador del release, arriba de las instrucciones de instalación.

## Sin publicar

## v0.22.0 — 2026-09-30

### Diálogos con raya: revisión a fondo contra el DPD

La conversión y el validador de diálogos se revisaron contra el *Diccionario panhispánico de dudas* (raya, comillas y puntos suspensivos), con un corpus de más de 200 casos como regresión.

#### El converter ya no rompe texto correcto
- Un párrafo convertido ya no aplana las «» y los ’ del resto del capítulo.
- Citas internas (`—Me dijo «Vete» y se fue.`), comillas en la narración, apóstrofos (`rock'n'roll`), pensamientos, citas con comentario, versos y comillas de seguir (`»`) quedan como están.
- Los puntos suspensivos ya no se pierden al convertir.

#### Convierte lo que antes salía mal
- La coma fuera de las comillas, que es la puntuación española: `"Hola", dijo Juan.` → `—Hola —dijo Juan.`
- Pronombre antes del verbo (`le dijo`), perífrasis (`volvió a decir`) y muchos verbos de habla más, incluidos la primera persona y el imperfecto.
- `--`, `-`, `–` y `―` pasan a raya en cualquier posición del diálogo, sin tocar rangos, números negativos ni palabras compuestas.

#### Reglas nuevas del validador
- Mayúscula o minúscula del comentario del narrador (DPD 2.3c, 2.3d y 2.3e).
- La puntuación va después de la raya de cierre (`—dijo Carlos—; lo haré`), sin raya de cierre al final del párrafo, y espacios alrededor de las rayas.
- Puntos de más (`..`, `....`, salvo después de una abreviatura), espacio doble, inciso narrativo sin cerrar.
- Retomar el parlamento con `. —` se marca con arreglo de a uno: la revisión en bloque no lo aplica sola.

#### Cada marca enseña su regla
- El popover muestra un ejemplo ✗/✓ y el link a la sección del DPD.
- «Ver todas las reglas» abre una chuleta de diálogos con raya.

#### Editor
- Ctrl+Z ya no trae el texto del capítulo anterior (y no lo guarda encima del abierto).
- Cambiar el idioma o la variante rechequea raya, repeticiones y LanguageTool en el acto.
- El idioma del libro manda sobre el del capítulo, y abrir un capítulo ya no escribe su `meta.json`.
- El validador no marca versos ni títulos, y `&nbsp;` junto a la comilla convierte bien.

#### Nombre
- «RAE» pasa a llamarse «Raya» en toda la app. La preferencia del toggle se conserva.

## Historial anterior

De v0.21.0 para atrás no hubo changelog: estos son los títulos de los PR de cada versión, reconstruidos del historial de git el 2026-09-30. No son notas escritas para el release.

### v0.21.0 — 2026-09-28

- Regenerar 48x48 con el ícono nuevo (#156)
- Inciso de advertencia de contenido (#157)
- Sangría como el EPUB y caret ámbar con cursiva activa (#158)

### v0.20.0 — 2026-09-22

- "Crear parte" desde un libro, y lo tipeado al cambiar de capítulo (#153)
- Zoom, pan y encaje en el visor de imágenes (#154)
- Mayúsculas rancias en el panel RAE + escaneo al abrir el modal de revisión (#155)

### v0.19.0 — 2026-09-19

- Parches 0004 y 0005: guarda del participio, y los dos ya mergeados upstream (#151)
- El registro de publicaciones, legible en la tarjeta y editable a mano (#152)

### v0.18.0 — 2026-09-18

- Tests de humo con EPUB pre-armado y red bajo el toggle de reglas (#142)
- Red bajo los dos botones destructivos del popover de gramática (#143)
- Humo de punta a punta del export usando el repo demo como fixture (#144)
- Campana con el historial de avisos en la status bar (#145)
- Acomodar TODO, README y CLAUDE.md después de la tanda de notificaciones (#146)
- Estados de la novela e historial de revisiones desde el export (#147)
- Parches 0004 y 0005 de LanguageTool: dos falsos positivos medidos sobre el corpus (#148)
- Anotar los PR upstream 12195 y 12196, y el fork que había desaparecido (#149)

### v0.17.0 — 2026-09-14

- Angular 22, TypeScript 6, TipTap 3.31, Tauri 2.11.5 (#140)
- Sacar el Eager explícito de los 26 componentes y quedar en OnPush (#141)

### v0.16.0 — 2026-09-14

- CSS del EPUB para Google Play, bloque de verso único, popover con dblclick (#133)
- Descartar la app móvil para el ciclo de correcciones (#134)
- Auditoría de gramática por alcance (#135)
- Auditoría de gramática al README, fuera del TODO (#136)
- README y TODO al día con lo que hay en el código (#137)
- Formato de fecha configurable en la biblioteca (#138)
- La puntuación de la query filtra por literal (#139)

### v0.15.0 — 2026-09-13

- Convertir hardBreak en corte de párrafo (#132)

### v0.14.0 — 2026-09-12

- Menú sin borrado para saga/libro en el árbol de notas (#131)

### v0.13.0 — 2026-09-12

- Pandoc no está bundleado + epubcheck en las notas del release (#124)
- El bloque de verso no invierte la itálica del texto (#125)
- Bloque de verso en la toolbar y en el menú contextual (#126)
- Cerrar el popover de repeticiones al abrir el de gramática (#127)
- Exportar una muestra del libro con página de cierre (#128)
- Índice sin partes numeradas y con el numeral en columna (#129)
- Firma en «Sobre el autor» y siguiente destacado en «Otros libros» (#130)

### v0.12.0 — 2026-09-08

- Validar el EPUB exportado con epubcheck + header de saga en barra (#122)

### v0.11.0 — 2026-09-08

- Bloquear la rueda atrás de los modales y limpiar el editor al cambiar de carpeta (#104)
- Mover lo hecho al README y dejar TODO.md solo con pendientes (#105)
- Unificar helpers duplicados y primera pasada de limpieza del SCSS (#106)
- Una sola clase .modal-backdrop, y matcher exacto para la rueda (#107)
- Cargar extras y exportados al hidratar el árbol desde settings (#108)
- .modal-card y .modal-header globales (rescate del #109) (#110)
- Campos de formulario y shell de tarjeta, + borrar el CSS de select muerto (#111)
- Shell compartido para los dos paneles de auditoría (#112)
- Los colores de estado pasan a --err/--ok/--warn (#113)
- Últimos restos de la pasada, y cerrar el bloque en TODO.md (#114)
- Dejar pnpm lint:css en verde (#115)
- Caja compartida para los tres popovers del editor (#116)
- Fills de error al token, tintes con su par, y cerrar la pasada (#117)
- Footer de modal y etiqueta de tarjeta, la capa que el audit no vio (#118)
- Chrome compartido de los dos editores, y el último accent sin tema (#119)
- Cerrar el ítem del <br>/<hr>: no hay nada que arreglar (#120)
- Mostrar el ruleId de LT y poder matar la regla por saga (#121)

### v0.10.0 — 2026-09-04

- Dos bugs nuevos y estado de la página legal (#95)
- Tema de la app, fuentes bundleadas y apartado Apariencia (#96)
- Escribir capítulos y meta de forma atómica (tmp + rename) (#97)
- Que el índice deje de quedarse mudo en silencio (#98)
- Que el salto encuentre una frase partida por una itálica (#99)
- Salto multi-nodo verificado a mano por el autor (#100)
- Que los guards del reemplazo miren el contenido y no el reloj (#101)
- Términos compuestos que se matchean como rango (#102)
- Panel de auditoría por libro, con salto y popover al lugar (#103)

### v0.9.3 — 2026-09-03

- El click lleva al match, la nota sobrevive y el matcheo filtra (#93)
- Buscar y reemplazar en lote a través del repo, sagas y libros (#94)

### v0.9.2 — 2026-09-02

- Sin PRs en este tramo (cambios directos en main).

### v0.9.1 — 2026-09-02

- Leer epub_style.css en runtime en vez de include_str! (#87)
- Botón de inicio, y el modal de gramática pasa a ser Configuración (#88)
- Reconciliar estado local tras un rename de carpeta hecho afuera de la app (#89)
- Decir en qué paso está el export en vez de esperar mudo (#90)
- Que cada export filtre sus propios eventos de progreso (#91)
- Vista para revisar y corregir un libro entero (#92)

### v0.9.0 — 2026-09-02

- Formas derivadas per-saga — conjugación, género y pelado de flexión (#82)
- Mazo de tapas en la vista de saga y contadores por kind (#83)
- Dejar la imagen elegida dentro del repo y no confiar en el path (#84)
- Escribir la convención de idioma que el código ya sigue (#85)
- Back matter del EPUB: catálogo de publicados, perfil de autor y página legal por incisos (#86)

### v0.8.2 — 2026-08-31

- Form de bloques con plantillas guardables (#81)

### v0.8.1 — 2026-08-21

- Relevamiento de alternativas a LanguageTool + sagas numeradas (#76)
- Parches de reglas ES mandados upstream + scanner de falsos positivos (#78)
- Plantillas, creación visible y tabs "Este libro" / "Todas" (#79)
- El error de LanguageTool abre la configuración; fix del hint de split colgado (#80)

### v0.8.0 — 2026-08-20

- Marcas de gramática corridas + toggle de nivel picky (#70)
- Relevar el estado de gramática y ortografía en español (#71)
- Spec del detector de repeticiones cercanas (#72)
- Detector de repeticiones cercanas (es + en) (#73)
- Tesauro de sinónimos embebido (español + inglés) (#74)
- Modal Acerca de con licencias, y unificación de los botones de diálogo (#75)

### v0.7.3 — 2026-07-30

- Control total del tipeo — matar el corrector del OS, sugerir del diccionario propio y ubicar bien los popovers (#63)
- Scrolloff del caret — margen de respiro al tipear en los tres editores (#64)
- Un solo popover por palabra y placement del panel de select con placePopover (#65)
- Levantar LanguageTool sin saber de containers — remedio accionable adentro de la app (#66)
- Recordar en qué runtime vive LanguageTool y preguntar cuando no se sabe (#67)
- El popover deja de tirar el markup inline al aplicar un fix (#68)
- CLAUDE.md decía que hay tests de Karma y no hay (#69)

### v0.7.2 — 2026-07-20

- Soportar Docker, Podman y Apple container para LanguageTool (#62)

### v0.7.1 — 2026-07-20

- Firmar ad-hoc el bundle para no romper el instalador ARM (#61)

### v0.7.0 — 2026-07-13

- Verificar auto-update macOS en app unsigned (#59)
- Comillas tipográficas (inglés) + fixes de modal y árbol (#60)

### v0.6.0 — 2026-06-29

- Sin PRs en este tramo (cambios directos en main).

### v0.5.7 — 2026-06-27

- Build macOS DMGs para Intel y Apple Silicon (#54)
- Cross-compilar macOS Intel desde runner ARM (#55)
- Git2 sin default-features para cross-compile x86_64 macOS (#56)
- Resolver docker/pandoc por ruta, no por PATH (#57)
- V0.5.7 + docs de instalación macOS (#58)

### v0.5.6 — 2026-06-25

- Sync per-saga vía git con union merge (#51)
- Exacta por default + toggle ≈ (fuzzy/acentos) + fix snippet (#52)
- Segundo árbol de notas + navegar sin perder foco (#53)

### v0.5.2 — 2026-06-04

- Suprimir update fantasma de setEditable + baseline canónico (#49)
- Eliminar flash de scrollbars y mover indicador "guardando" al status-bar (#50)

### v0.5.1 — 2026-06-01

- Cursor fantasma, apertura al final, árbol abierto, ícono Wayland (#48)

### v0.5.0 — 2026-05-26

- Feat/theme editor redesign font cleanup (#47)

### v0.4.4 — 2026-05-26

- Sin PRs en este tramo (cambios directos en main).

### v0.4.3 — 2026-05-20

- Refrescar árbol/editor/búsqueda tras pull (#45)
- Event-driven git sync + run_git hardening (#46)

### v0.4.2 — 2026-05-19

- Vista dedicada del diccionario + validación (#42)
- Refresh árbol mtime tras save + lateral abre al tope (#43)
- Swap emojis a Lucide (#44)

### v0.4.1 — 2026-05-19

- Último editado + fixes de sync, dict y dirty fantasma (#41)

### v0.4.0 — 2026-05-18

- Operators, scope filter, stopwords ES and BM25 debug (#34)
- Edit-in-place mode in right-panel markdown reader (#35)
- Restaurar último cap + cursor + tree expand entre boots (#36)
- Scope 'Archivo actual' + agrupación por archivo (#37)
- Cache covers as blob URLs (#38)
- Enhance source classification logic for chapters and su… (#39)
- Reestructurar capítulos en partes + RAE post-split (#40)

### v0.3.7 — 2026-05-15

- Saga sin prefix orden + folder-card con chips (#33)

### v0.3.6 — 2026-05-15

- Sin PRs en este tramo (cambios directos en main).

### v0.3.5 — 2026-05-15

- Pull con auto-upstream, layout flat editor, redo, selector fuente (#28)
- UX honesta de sync + decoupling de stats volátiles (#29)
- Cerrar race StorageService.detect ↔ GitService.effect (#30)
- Párrafos vacíos no colapsan en el reader (#31)
- Selector de fuentes con OS, pool, tema y presets (#32)

### v0.3.4 — 2026-05-14

- Unblock LT checker (panic, offsets, recovery) (#27)

### v0.3.3 — 2026-05-14

- Tree DnD reorder + cross-parent moves (#26)

### v0.3.2 — 2026-05-14

- Sin PRs en este tramo (cambios directos en main).

### v0.3.1 — 2026-05-14

- Sin PRs en este tramo (cambios directos en main).

### v0.3.0 — 2026-05-14

- Wizard demo + fix RAE cerrar raya en inciso (D3/D4) + Unicode \b (#20)
- Validador inline + batch audit + Python deprecation (#21)
- Sync seamless entre PCs (auto-rebase + auto-pull + .twriter/ ignore) (#22)
- Strip EPUB defaults, centralize presentation in themes (#23)
- Polish UX + search exact-form + LT offset trace (#24)
- Subcarpetas → extras, opt-in saga-level, tree jerárquico (#25)

### v0.2.0 — 2026-05-13

- Extras + covers + image viewer + saga config + Exportados (#1)
- Panel-left footer + epílogo support + chapter creators (#2)
- ModalService custom (reemplaza prompt/confirm/alert nativos) (#3)
- Temas reutilizables + fuentes embebidas en EPUB (Sprint 10) (#4)
- Per-style faces (italic / bold / bold-italic) en theme (#5)
- Sprint 12: tema editorial + página Sobre el autor (#6)
- Posición vertical del título de capítulo en EPUB (fix Kindle + config) (#7)
- Crear tema desde plantilla (#8)
- Centralizar menú contextual en ContextMenuService (#9)
- Reordenar sprints 10 y 11 en README (#10)
- Variante per saga + auto-check auto-on + pulse LT visible (#11)
- Pickers via xdg-portal + componente <app-select> custom (#12)
- Panel debug completo + fix gramática pandoc + spacing toggle (#13)
- Notas markdown + pool global de fuentes + preview (#14)
- Panel derecho read-only para .md + presets de ancho (#15)
- Split horizontal/vertical via drag&drop del tree (#16)
- Carpetas libres en root + búsqueda full-text + importer Joplin (#17)
- Detección git/cloud/local + modal guía git (#18)
- Release polish — metadata, Docker UX, LT Premium + keyring storage (#19)

### v0.1.13 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.12 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.11 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.10 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.8 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.7 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.6 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.5 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.4 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.3 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.2 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.1 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).

### v0.1.0 — 2026-05-08

- Sin PRs en este tramo (cambios directos en main).
