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
ng test               # Karma tests (Angular)
cargo test --manifest-path src-tauri/Cargo.toml   # tests Rust
```

Primera build de Rust tarda ~5 min. Después es incremental.

## Convenciones (heredadas de la-cueva-de-tatoh)

- **Standalone components only**, sin NgModules.
- **Signals** para estado (`signal()`, `computed()`, `input()`, `output()`).
- **Modern templates**: `@if`, `@for`, `@switch`. Nada de `*ngIf`/`*ngFor`.
- **File naming**: `tree.ts` no `tree.component.ts`. `chapter-service.ts` no `chapter.service.ts`.
- **Class naming**: `Tree`, `Editor`, `ChapterService`. Sin sufijo `Component`.
- **Sin `public`** explícito en miembros de clase (es default).
- **Return types explícitos** en métodos.
- **`inject()`** para DI dentro de funciones/constructores, no constructor params.
- Spanish para UI, comments y nombres de variables de dominio.

El scaffold inicial usa nombres `app.component.*` — refactorizar a convenciones al tocar esos archivos.

## Reuso desde otros repos del usuario

- **Reglas de diálogos** (~~`dialogos_a_esp/src/rules.py` y `converter.py`~~ **DEPRECADO**): la fuente original Python está deprecada — el repo Python tenía bugs (`\b` ASCII-only no matchea acentos, párrafos colapsados en la conversión, verbos dicendi acentuados invisibles) que se arrastraron al port TS y se fueron arreglando. Las reglas RAE vivas viven en `src/app/dialogos/converter.ts` + `rules-dedicated.ts` + `validator.ts`. No volver al Python como referencia.
- **CSS y fuentes para EPUB**: extraídos de un EPUB de Reedsy. El de referencia es `~/Dropbox/Novelas/Buenos Aires 2077/1 - La Ciudad de las Luces/La Ciudad de las Luces Rev.2.epub`. Su `OEBPS/style.css` se recorta a un subset y vive en `src/styles/reedsy-subset.scss`. Las TTF (Merriweather, Lato, Roboto Mono) van a `src/assets/fonts/`.
- **NO reusar componentes** de la-cueva-de-tatoh — la UI de tWriter es bespoke (3 paneles, modo focus, tipografía serif).

## Sidecars y servicios externos

- **Pandoc**: bundleado como `external bin` en `src-tauri/binaries/pandoc-<target>`, declarado en `tauri.conf.json`. Usado solo al importar `.docx`/`.odt`.
- **LanguageTool**: NO sidecar. Corre como Docker container del usuario (`localhost:8081`). La feature de gramática se habilita solo si se detecta el endpoint.

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
- **Sprint 5**: LanguageTool, templates 6×9"/5×8"/A5, polish

## Verificación end-to-end (al completar MVP)

1. Importar `~/Dropbox/Novelas/Meridian/1 - Noche Eterna/Parte 1/` (.docx) → aparece como libro con 23 capítulos.
2. Editar cap 1, agregar itálica, cerrar y reabrir → cambios persisten en disco.
3. Click "Aplicar RAE" sobre cap en español → diff produce salida válida según [DPD raya](https://www.rae.es/dpd/raya) (la comparación contra `dialogos_a_esp` ya no aplica, el repo Python está deprecado y el port TS lo supera).
4. Export EPUB del libro completo → calibre/Thorium lo abre, comparar visualmente con `Noche Eterna Parte 1 Rev.3 EPUB.epub`.
