# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**tWriter** es una app desktop (Tauri 2 + Angular 21, TypeScript 5.9) para escribir novelas en español e inglés con un solo flujo: editor → conversor de diálogos a estilo RAE → chequeo de gramática → exportación EPUB. Reemplaza el flujo viejo del autor (LibreOffice → `dialogos_a_esp` [DEPRECADO, ver abajo] → Quillbot → Reedsy).

> **Nota**: el repo Python [`dialogos_a_esp`](https://github.com/T4toh/dialogos_a_esp) está **deprecado** — tenía bugs (colapsaba párrafos al convertir, perdía verbos dicendi acentuados por `\b` ASCII-only) que se arrastraron al port TS y se fueron arreglando acá. El port en `src/app/dialogos/converter.ts` + `validator.ts` ya divergió de la fuente Python; usar este repo como única fuente de verdad de las reglas RAE.

**Repo separado de contenido**: `~/Repos/Personal/Novelas/` (privado) guarda las novelas como HTML + JSON metadata. Este repo (`tWriter`) es solo la app — cero contenido.

**Plan de diseño completo**: `~/.claude/plans/te-doy-un-poco-federated-snowglobe.md` (referencia obligada para entender decisiones de arquitectura, modelo de datos, sprints).

## Stack y arquitectura

```
Frontend (Angular 21)        Backend (Rust / Tauri 2)
─────────────────────        ────────────────────────
src/app/                     src-tauri/src/
  editor/  TipTap wrapper      main.rs    entry
  tree/    project explorer    lib.rs     commands registry
  dialogos/  port TS D1-D5     fs.rs      tree, read/write capítulos
  grammar/   LanguageTool      git.rs     auto-commit + status (git2)
  export/    EPUB UI           epub.rs    builder XHTML zip
  core/      services          pandoc.rs  sidecar import .docx/.odt
                               storage.rs detección git/cloud/local
                               secrets.rs apiKey al keyring del OS
                               tesauro.rs sinónimos MyThes es+en
```

**Detección de storage backend** (`storage.rs`): al elegir/cargar root,
`detect_storage_backend` clasifica como `Git` (vía `Repository::discover`),
`Dropbox`/`PCloud`/`Nextcloud`/`OneDrive`/`GoogleDrive`/`ICloud`/`Sync`/`Mega`
(match por componente del path), o `Local`. La UI esconde los controles
git cuando no aplican y muestra un badge identificando el servicio.

**Secretos sensibles** (`secrets.rs`): el apiKey de LT Premium va al
keyring del OS vía el crate `keyring` (Secret Service en Linux, Keychain
en macOS, Credential Manager en Windows). Fallback a `secrets-fallback.json`
en `app_config_dir` con permisos `0600` si ningún backend responde. El
valor **nunca cruza el bridge JS → Rust** — el backend lo carga server-side
cuando arma el POST a LanguageTool. `GrammarConfig::Debug` enmascara el
campo con `***`.

**Regla de división**: cualquier operación que toque muchos archivos a la vez (búsqueda, EPUB build, git, walk del árbol) vive en Rust. Angular solo renderiza el capítulo activo y la metadata. Esto da performance nativa donde importa.

**Comunicación Angular ↔ Rust**: vía `invoke()` de `@tauri-apps/api/core` llamando comandos `#[tauri::command]`. Los servicios en `src/app/core/` envuelven los invokes y exponen signals.

## Modelo de datos

Cada capítulo en el repo `Novelas/` es:

- `<saga>/<libro>/<sección>?/<n>.html` — XHTML subset (`<p>`, `<i>`, `<em>`, `<strong>`, `<hr class="scene-break"/>`, `<h1 class="chapter-title">`, `<span class="dropcap">`, `<blockquote>`)
- `<saga>/<libro>/<sección>?/<n>.meta.json` — `{orden, titulo, palabras, ultima_edicion, status, idioma}`
- `<saga>/<libro>/book.json` — título, idioma, autor, orden, ISBN, tapa, fonts override
- `<saga>/saga.json` — nombre, idioma default, autor

El editor TipTap se configura para producir/aceptar **solo este subset HTML**. Cualquier feature nueva del editor debe respetar la lista.

## Comandos

```bash
pnpm install          # primera vez
pnpm tauri dev        # dev mode (frontend en :1420 + backend Rust)
pnpm start            # solo Angular en :1420 (sin backend, raro)
pnpm build            # build Angular producción
pnpm tauri build      # build app empaquetada (Linux/AppImage/.deb)
cargo test --manifest-path src-tauri/Cargo.toml   # tests Rust
node scripts/run-<algo>-smoke.mjs                 # tests del frontend (ver abajo)
node scripts/run-tesauro-smoke.mjs                # casos de palabraEn() bajo el cursor
```

Primera build de Rust tarda ~5 min. Después es incremental.

**No hay runner de tests para el frontend.** `angular.json` no define target
`test` y `package.json` no trae karma/jasmine/vitest/jsdom, así que `ng test`
**no corre nada**. Los `.spec.ts` que hay en `src/app/` están dormidos: declaran
`describe`/`it`/`expect` a mano y nadie los ejecuta. Lo que sí corre son los
smoke runners de `scripts/`, que compilan los TS necesarios con `tsc` a un
tmpdir e importan el JS resultante — y por eso solo sirven para **funciones
puras**: nada que toque el DOM, `@tiptap/core` o el schema de ProseMirror se
puede cargar desde node.

Al sumar código nuevo al frontend, partirlo en una mitad pura (con su smoke
runner nuevo, patrón de `scripts/run-rae-smoke.mjs`) y una mitad con DOM que se
valida con `pnpm build` + verificación manual del autor. El comentario de
cabecera de `src/app/core/search-highlight.spec.ts` deja sentado ese criterio.

## Convenciones (heredadas de la-cueva-de-tatoh)

- **Standalone components only**, sin NgModules.
- **Signals** para estado (`signal()`, `computed()`, `input()`, `output()`).
- **Modern templates**: `@if`, `@for`, `@switch`. Nada de `*ngIf`/`*ngFor`.
- **File naming**: `tree.ts` no `tree.component.ts`. `chapter-service.ts` no `chapter.service.ts`.
- **Class naming**: `Tree`, `Editor`, `ChapterService`. Sin sufijo `Component`.
- **Sin `public`** explícito en miembros de clase (es default).
- **Return types explícitos** en métodos.
- **`inject()`** para DI dentro de funciones/constructores, no constructor params.
- **Idioma de los identificadores** (medido sobre el código, no aspiracional).
  Spanish para UI, comments y **sustantivos de dominio**; inglés para verbos y
  mecánica de framework. La frontera es el dato: `saga`, `libro`, `capitulo`,
  `parte`, `seccion`, `nota`, `plantilla`, `titulo`, `tapa`, `finalizada` son
  nombres de campos de los JSON y de carpetas en disco, así que se quedan en
  español; lo que los rodea va en inglés. De ahí que los nombres mixtos sean
  correctos y no haya que "arreglarlos": `loadSagaFinalizada`,
  `createCapituloHere`, `setRepeticionesExcepciones`, `sagaDirName`.
  **Excepción conocida, no la ensanches**: las tapas están al revés — el campo
  del JSON es `tapa` pero en TS todo es inglés (`CoverCache`, `coverDataUrl`,
  `pickCover`, `covers`, `thumbs`). Alinear eso es un rename mecánico de
  `landing/` + `core/cover-cache.ts` pendiente; hasta que se haga, en esa zona
  seguir el inglés de alrededor en vez de mezclar.
- **El remedio se da adentro de la app.** Si la app puede detectar un problema de
  entorno (daemon caído, runtime ausente, sidecar faltante, credencial vencida),
  tiene que decir **qué** pasó y dar el remedio **accionable** ahí mismo: un botón
  si lo puede ejecutar ella, o el comando exacto en un chip copiable si necesita
  sudo o una app de GUI ajena. Nunca un mensaje genérico, y nunca el comando
  embebido en prosa entre backticks — que no se puede copiar sin arrastrar la
  explicación. Que el autor sepa resolverlo a mano no cuenta: si la app detectó el
  problema, ya tiene la información, y tirarla es hacerle perder tiempo a quien la
  use. Cuando el diagnóstico no es accionable, decir eso también en vez de
  inventar un comando que puede fallar (ej: no adivinar `apt` vs `dnf` — dar el
  link).

El scaffold inicial usa nombres `app.component.*` — refactorizar a convenciones al tocar esos archivos.

## Reuso desde otros repos del usuario

- **Reglas de diálogos** (~~`dialogos_a_esp/src/rules.py` y `converter.py`~~ **DEPRECADO**): la fuente original Python está deprecada — el repo Python tenía bugs (`\b` ASCII-only no matchea acentos, párrafos colapsados en la conversión, verbos dicendi acentuados invisibles) que se arrastraron al port TS y se fueron arreglando. Las reglas RAE vivas viven en `src/app/dialogos/converter.ts` + `rules-dedicated.ts` + `validator.ts`. No volver al Python como referencia.
- **CSS y fuentes para EPUB**: extraídos de un EPUB de Reedsy. El de referencia es `~/Dropbox/Novelas/Buenos Aires 2077/1 - La Ciudad de las Luces/La Ciudad de las Luces Rev.2.epub`. Su `OEBPS/style.css` se recorta a un subset y vive en `src/styles/reedsy-subset.scss`. Las TTF (Merriweather, Lato, Roboto Mono) van a `src/assets/fonts/`.
- **NO reusar componentes** de la-cueva-de-tatoh — la UI de tWriter es bespoke (3 paneles, modo focus, tipografía serif).

## Sidecars y servicios externos

- **Pandoc**: bundleado como `external bin` en `src-tauri/binaries/pandoc-<target>`, declarado en `tauri.conf.json`. Usado solo al importar `.docx`/`.odt`.
- **LanguageTool**: NO sidecar. Corre como Docker container del usuario (`localhost:8081`). La feature de gramática se habilita solo si se detecta el endpoint.
- **CSS del EPUB**: `src-tauri/resources/epub_style.css` es un `resource`, no
  un `include_str!`. Se lee en runtime (`epub.rs::css_template`): en debug
  desde `CARGO_MANIFEST_DIR`, en release vía `BaseDirectory::Resource`.
  Con `pnpm tauri dev`, editarla y volver a exportar alcanza — no hay que
  recompilar Rust. En release la hoja se copia al bundle en tiempo de
  empaquetado, así que ahí sí hay que rehacer el `tauri build`. Lintea con
  `pnpm lint:css:epub`.
- **Tesauro de sinónimos**: `src-tauri/resources/tesauro/` shipea dos `.dat`
  MyThes de terceros, declarados como `resources` en `tauri.conf.json` (van
  al bundle, no son sidecar). `th_es_v2.dat` (español, LGPL 2.1, de
  OpenThesaurus-es vía `rla-es`) va **sin modificar** — es la condición de la
  licencia — con su `COPYING` al lado. `th_en_us.dat` (inglés, WordNet 2.1
  vía LibreOffice, licencia permisiva que sí deja modificar con aviso) sale
  de `dict-en/th_en_US_v2.dat` podado por `scripts/podar-tesauro-en.mjs`, que
  pela las etiquetas `(generic term)` y descarta enteros `(related term)`/
  `(similar term)`/`(antonym)`; el script corre una vez y su salida se
  commitea, nunca en build time. Detalle de licencias en
  `src-tauri/resources/tesauro/LICENCIAS.md`.

## Git auto-sync

El repo `Novelas/` se sincroniza desde dentro de la app: `git2` (libgit2)
para status + commit, binario `git` del sistema para push/pull (más robusto
contra SSH/agent quirks). Default: auto-commit cada 5 min, status polling
cada 30 s, auto-pull cuando `behind > 0`, auto-rebase + retry cuando
`git push` es rechazado por non-FF. `.twriter/` (índice tantivy local) se
destrackea automáticamente vía `git_ensure_twriter_ignored` para que no
genere conflictos entre PCs. Errores del CLI git se categorizan en
`auth`/`network`/`conflict`/`rejected`/`unknown` y
`git-service.ts::friendlyError` los mapea a strings en español para la UI
(nada de git jargon visible al usuario).

## Roadmap

- **Sprint 1** ✓ tree explorer + editor TipTap + autosave + folder picker + menú contextual
- **Sprint 2** ✓ integración git (auto-commit + push) con `git2`, status polling 30s, auto-commit 5 min
- **Sprint 3** ✓ importer Pandoc shell-out, port TS de D1–D5, UI de conversión con diff
- **Sprint 4** ✓ EPUB builder en Rust con `zip` + `uuid`, CSS subset Reedsy, manifest+spine+nav
- **Sprint 5** ✓ LanguageTool, templates 6×9"/5×8"/A5, polish
- **Sprint 6** ✓ reestructurar capítulo plano en folder con partes (`split_chapter.rs` + modal con preview de bloques + strip auto de título/labels + bulk libro entero), insertar parte intermedia con shift (`insert_part_after`), "Aplicar RAE a partes" post-split

## Verificación end-to-end (al completar MVP)

1. Importar `~/Dropbox/Novelas/Meridian/1 - Noche Eterna/Parte 1/` (.docx) → aparece como libro con 23 capítulos.
2. Editar cap 1, agregar itálica, cerrar y reabrir → cambios persisten en disco.
3. Click "Aplicar RAE" sobre cap en español → diff produce salida válida según [DPD raya](https://www.rae.es/dpd/raya) (la comparación contra `dialogos_a_esp` ya no aplica, el repo Python está deprecado y el port TS lo supera).
4. Export EPUB del libro completo → calibre/Thorium lo abre, comparar visualmente con `Noche Eterna Parte 1 Rev.3 EPUB.epub`.
