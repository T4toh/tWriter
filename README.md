# tWriter

App desktop para escribir novelas en español e inglés. Centraliza el flujo: editor → conversor de diálogos a estilo RAE → chequeo de gramática → exportación EPUB. Reemplaza LibreOffice + Reedsy en una sola herramienta.

Las novelas viven en un repo privado aparte (HTML + JSON). Esta app es solo el editor.

**Stack**: Tauri 2 + Angular 21 + TipTap. Backend Rust, frontend signals.

## Layout de archivos

Cada saga/libro en el repo de novelas sigue una convención canónica para
distinguir capítulos (lo que va al EPUB) de extras (manuscritos viejos, mapas,
glosarios, tapas alternativas) y notas (research — feature futura).

```
<root>/
  themes/                          # opcional, temas reutilizables (Sprint 10)
    <id>/
      theme.json                   # { body_font, body_size, heading_font, heading_size, line_height, page_margin }
      fonts/                       # .ttf/.otf/.woff/.woff2
  <saga>/
    saga.json
    cover.{jpg,png,jpeg,webp}      # opcional, tapa de la serie
    extras/                        # opcional, mapas/glosarios saga-level
      <cualquier-archivo>
    fonts/                         # opcional, override de fuentes per-saga
    notas/                         # RESERVADO (feature futura)
    <libro>/
      book.json
      cover.{jpg,png,jpeg,webp}    # opcional
      back-cover.{jpg,png,jpeg,webp} # opcional, contratapa
      extras/                      # opcional, manuscritos/refs book-level
        <cualquier-archivo>
      fonts/                       # opcional, override de fuentes per-libro
      notas/                       # RESERVADO (feature futura)
      <n>.html + <n>.meta.json     # capítulos
      <sección>?/<n>.html          # capítulos en secciones
```

Reglas:

- `cover.*` y `back-cover.*` son archivos directos en la raíz del nivel. Si no
  los tenés explícitos en `book.json`/`saga.json`, la app los autodetecta del
  filesystem.
- `extras/` es flat. Podés crear subcarpetas si querés; la app no impone
  taxonomía. Cualquier tipo de archivo entra (imagen, docx, odt, txt, md, pdf).
- `extras/`, `notas/`, `fonts/` y `themes/` quedan auto-excluidos del export
  EPUB y del walk del tree. No necesitan `.twriter-ignore`.
- Para libros standalone (sin saga padre), el layout del libro es idéntico —
  `<book>/cover.*`, `<book>/extras/`, `<book>/fonts/`, etc.
- `themes/` vive solo en la raíz del repo. Cada tema es autocontenido (su
  propio `theme.json` + carpeta `fonts/`). Sagas y libros referencian un tema
  por id en `saga.json::theme.base` / `book.json::theme.base`. Ver sección
  "Temas y tipografía" abajo.

## Estado

MVP completo. Sprints 1–12 hechos.

- **Editor**: TipTap con HTML subset (`<p>`, `<i>`, `<em>`, `<strong>`, `<u>`, `<hr>`, `<h1>`, `<blockquote>`), autosave debounced 1.5s, toolbar (B/I/U, alineación, salto de escena, RAE, gramática, ancho hoja, font size), menú contextual propio.
- **Tree explorer** del repo (Saga / Libro / Sección / Capítulo) con context menu (crear, mover, importar, exportar EPUB, configurar libro, excluir del EPUB), badge "excluido" para `.twriter-ignore`.
- **Modo focus** (F11 / Esc).
- **Selector de carpeta raíz** persistido + auto-load del último capítulo abierto.
- **Git auto-sync**: commit cada 5 min, status polling 30s, push manual desde header.
- **Importer Pandoc**: `.docx`/`.odt` → HTML subset (single chapter o bulk).
- **Wizard de importación de saga/novela** (📥 en header): trae carpeta externa al repo con detección de estructura, conversión per-carpeta opcional, metadata de saga + libros, copia de tapas y extras normalizada.
- **Extras + covers** unificados: layout canónico `extras/` por saga y libro, `cover.*` y `back-cover.*` autodetectados desde disco. Tree muestra "📁 Extras" colapsable, drag&drop de archivos del OS al saga/libro, context menu para abrir/renombrar/borrar.
- **Conversor RAE de diálogos** (D1–D5 portados de `dialogos_a_esp`): botón "RAE" con preview side-by-side antes de aplicar.
- **Gramática + ortografía** vía LanguageTool (público / Docker local / custom URL): underlines diferenciados, popover con sugerencias clickeables, atribución, diccionario per-saga.
- **Export EPUB**: builder Rust con CSS subset Reedsy, templates 6×9"/5×8"/A5, cover image, dedicatoria, copyright, TOC navegable.
- **Tema** claro/oscuro, tipografía serif que matchea el EPUB output.
- **Indicador idioma** footer (badge color por idioma) + toggle ES/EN.
- **Temas + fuentes embebidas**: temas reutilizables a nivel root (`<root>/themes/<id>/`) con tipografía + márgenes. Override per-saga y per-libro. Detección automática de bold/italic via sufijos en filename. Cero regresión cuando no hay tema configurado.
- **Per-style faces**: `body_font_italic`/`body_font_bold`/`body_font_bold_italic` en el tema apuntan a un filename stem específico para `<em>`/`<strong>` y combinaciones. Pisa el auto-pick por sufijo. Útil cuando la italic auto de la familia es muy sutil. Theme editor incluye preview real con FontFace API.
- **Tema editorial**: `editorial_body_font` + `editorial_heading_font` aíslan la tipografía de las páginas no-autor (title page, copyright, dedicatoria, TOC, sobre el autor) de la prosa. Cascada idéntica al body (theme + saga + book). Cero regresión cuando no se setean — esas páginas heredan body/heading como antes. Página "Sobre el autor" generada al final del EPUB con foto + bio configurables desde Configurar Novela.
- **Posición del título de capítulo**: `chapter_title_position` en `Theme` permite forzar `top` / `center` / `bottom` para el bloque título+prefijo de la chapter-title page. Default (campo vacío) centra vertical en readers EPUB3 estándar (Calibre/Thorium/Foliate) y suma un `@media amzn-kf8` fallback para que Kindle KF8/KFX también lo centre (sin el fallback caía a top porque Kindle ignora `vh` + `display: table` en body). Cascada theme → saga → book. Cero regresión visual fuera de Kindle.
- **Variante regional per saga**: `saga.json::variante_es` / `variante_en` overridean la variante LT global (`settings.json`). Footer renderiza la variante resuelta (ej. `es-AR` en lugar de `ES` genérico). Click en el badge abre dropdown con `es-AR` / `es-ES` / `en-US` / `en-GB` y pickear escribe en saga.json (más en `.meta.json::idioma` si cambia el lang base). LT ya soporta voseo nativo vía `language=es-AR` (variante `SpanishVoseo` desactiva el rulegroup `VOSEO` upstream — sin tocar reglas custom). Cero regresión: saga sin override sigue usando el global.
- **Auto-check de gramática auto-on**: cuando el modo es `local`/`custom` y LT responde al ping, el auto-check se activa solo. El toggle del usuario sirve para destrabarlo (queda persistido en `settings.json::grammarAutoDisabled`). En modo `public` queda apagado por ToS. Tras `dockerStart` el frontend re-pinguea para que el auto se prenda sin recargar.

## Roadmap

### Sprint 1 — Primera vista ✓

- Refactor scaffold (signals, standalone, sin `*.component.*`)
- `fs.rs` Rust: `get_tree`, `read_chapter`, `write_chapter`, `read_meta`, `write_meta`
- Editor TipTap (StarterKit + Typography + TextAlign), HTML subset
- Layout 2 paneles + tema claro/oscuro
- Autosave debounced 1.5s
- Tree colapsable, refresh, folder picker, persistencia en `settings.json`
- Toolbar (B/I/U, alineación, salto de escena, ancho)
- Menú contextual propio
- Word count en footer

### Sprint 2 — Sync con git ✓

> Cada save = commit. Cada N min = push. Sin Dropbox.

- Crate `git2` en Rust con SSH agent + fallback a `~/.ssh/id_ed25519/id_rsa/id_ecdsa`
- Comandos: `git_status`, `git_commit_all`, `git_push`, `git_pull`
- Auto-commit cada 5 min cuando hay cambios
- Status polling cada 30s
- Botón "sync ahora" (⇅) en header
- Indicador (punto de color) + summary del estado en panel izquierdo

### Sprint 3 — Importer + conversor RAE ✓

> Pasar las novelas viejas (.docx/.odt) al formato HTML. Aplicar reglas RAE in-app.

- Pandoc CLI shell-out (no sidecar, requiere `pandoc` instalado)
- Comando `import_chapter(path)` → genera `.html` + `.meta.json`
- UI: botón "Importar a HTML" en overlay del editor para `.odt`/`.docx`
- Port TS de reglas D1–D5 desde [`dialogos_a_esp`](https://github.com/T4toh/dialogos_a_esp) en `src/app/dialogos/`
- Botón "RAE" en toolbar del editor (sólo cuando `idioma === 'es'`)
- Modal con diff side-by-side antes de aceptar
- Limpieza de HTML pandoc → subset permitido (p, em, strong, i, b, u, blockquote, hr, h1-h3, br)

### Sprint 4 — Export EPUB ✓

> Reemplazar Reedsy. Mismo look, sin subir a la web.

- Rust `epub.rs` builder con `zip` + `uuid` crates
- CSS subset estilo Reedsy embebido (`epub_style.css`)
- Estructura EPUB 3: mimetype + container.xml + content.opf + nav.xhtml + chapters
- Lee `book.json` (titulo/autor/idioma) o infiere desde nombre del dir
- TOC navegable usando títulos de capítulo (sección)
- UI: "Exportar a EPUB" en menú contextual del libro → guarda en `<book>/exports/<titulo>.epub`

Diferido a iteraciones futuras: cover image, fonts embebidas, dropcaps automático, ISBN.

### Sprint 5 — Estilos EPUB ✓

> Replicar look Reedsy lo más fiel posible.

- Centrado vertical+horizontal robusto en title/copyright/dedication/chapter-title (varios readers tienen issues con flex / vh)
- Posicionamiento del copyright al final de página
- Page-break-before/after consistentes
- Validación contra Reedsy en distintos readers (calibre, foliate, Thorium)
- Comparar visualmente con `Buenos Aires 2077/.../La Ciudad de las Luces Rev.2.epub`

### Sprint 6 — Gramática + templates + polish ✓

> Reemplazar Quillbot. Templates de página. UX final.

- Cliente LanguageTool con tres modos: público (`api.languagetool.org`), local (Docker), custom URL
- Detección de orto (rojo sólido), gramática (rojo wavy), estilo (amarillo wavy)
- Popover con sugerencias clickeables, atribución LT visible
- Rate-limit client-side (18 req/min, 70KB/min) + chunking >20KB transparente
- Auto-recheck debounced solo en modo local (ToS público lo prohíbe)
- Variantes regionales configurables (es-AR default, en-US default; configurable a es-MX/CL/CO/PE/VE/genérico, en-GB/CA/AU)
- Auto-detect de idioma (`language=auto` + `preferredVariants`) cuando el cap no tiene idioma seteado
- Diccionario per-saga (`saga.json::diccionario`): botón "+ diccionario" en popover de TYPOS, filtra matches en cliente
- Botones para levantar/detener LanguageTool Docker desde la GUI (`languagetool_docker_status/start/stop`)
- Templates 6×9" / 5×8" / A5 en `book.json`, inyectados como `@page` al EPUB
- Modo focus con `F11` (Esc para salir): oculta el tree, deja toolbar y footer
- Indicador idioma footer con badge de color (rojo ES, azul EN)
- Carpetas excluibles del export EPUB con `.twriter-ignore` (visibles en tree con badge "excluido")

### Sprint 7 — Importer Wizard ✓

> Reemplazar el flujo manual de copiar carpetas + importar uno a uno. Traer una saga/novela completa al repo en un flujo guiado.

- Botón 📥 en el header del panel-left abre el wizard
- 7 steps para saga (6 para novela suelta): tipo → source → saga-config → estructura → metadata → resumen → progreso → completo
- Detección heurística de saga vs book vs section vs chapter desde la carpeta source
- Step `saga-config` con autor + idioma default que se heredan a cada book
- Estructura editable y expandible: drill-down hasta archivos individuales con checkbox + nombre target editable
- Decisión per-carpeta sobre conversión: `convert_chapters` toggle por book/section. Si ON corre pandoc + `clean_html`. Si OFF copia `.docx`/`.odt` tal cual (caso "Originales" como respaldo).
- Metadata por book: titulo, subtítulo, autor, idioma, orden en serie, ISBN, tapa con file picker
- Normalización al importar:
  - Tapa absoluta → copia a `<book_dir>/cover.<ext>` y rescribe `tapa` a relativo
  - Extras (PNG/txt/md/etc) → carpeta `extras/` por book/section
- Progress bar con eventos `import-progress` desde Rust (archivo actual + done/total)
- ImportSummary final: counts de dirs creados, caps convertidos, caps copiados, extras + lista de errores

### Sprint 8 — Extras + covers homogéneos ✓

> Manejo uniforme de archivos no-capítulo (extras + covers) a nivel saga y
> libro, preparando terreno para la feature de Notas.

- Layout canónico: `<saga>/cover.*`, `<saga>/extras/`, `<book>/cover.*`,
  `<book>/back-cover.*`, `<book>/extras/`. `notas/` reservado.
- Auto-discovery de `cover.*` y `back-cover.*` desde disco si no están seteados
  en `book.json`/`saga.json`. Las novelas viejas no se rompen; la tapa aparece
  sola si seguías la convención implícita.
- `back-cover` (contratapa) en `BookConfig` + input file en el modal
  Configurar Novela. Embebida al final del EPUB si está presente.
- Backend Rust `extras.rs`: comandos `list_extras`, `add_extra`, `remove_extra`,
  `rename_extra`, `has_extras` + tipo `ExtraEntry` con clasificación
  (image/document/text/other).
- Tree explorer: sección "📁 Extras" colapsable bajo cada saga y libro, badge
  "extra" por archivo, ícono según tipo, click abre con sistema.
- Crear extra desde la app con dos UX: drag&drop de archivos del OS sobre el
  nodo saga/libro (vía `tauri://drag-drop` event) o context menu "Agregar
  extra…" con file picker.
- Context menu sobre cada extra: Abrir, Renombrar, Borrar.
- `SKIP_DIRS` Rust agrega `extras` y `notas` para que NO aparezcan como
  capítulos accidentales en el tree ni en el export EPUB.
- Wizard de importación: extras a nivel saga (`<saga>/extras/`), no solo libro;
  normaliza también `back-cover.*` igual que cover.

### Sprint 9 — Diálogos custom ✓

> Reemplazar los `window.prompt`/`confirm`/`alert` nativos del WebKit (feos,
> con header "JavaScript - <http://localhost:1420/>" sin tema) por un sistema
> de modales propio coherente con `BookConfigModal` & co.

- `ModalService` promise-based en `src/app/shared/modal-service.ts`:
  `modal.prompt()`, `modal.confirm()`, `modal.alert()`. Drop-in para los
  globals nativos. Solo una instancia activa a la vez.
- `ModalHost` root-level (`src/app/shared/modal-host.ts/html/scss`) montado
  una sola vez en `app.html`. Renderiza el shape adecuado según `kind`
  (prompt / confirm / alert).
- 14 prompts + 5 confirms migrados (header, tree, landing). Los 2 `alert()`
  se convirtieron a `toast.error()` (errores transitorios encajan mejor en
  toast que en modal).
- F2 (rename) con input pre-lleno + select-all, validación inline (no
  vacío, sin `/` ni `\`), Esc cancela, Enter confirma.
- Confirms destructivos pintan OK rojo (`btn-danger`): borrar capítulo,
  borrar carpeta, borrar extra, bulk delete .docx/.odt.
- Animaciones CSS-only: backdrop fade-in 120ms + card slide-up 160ms con
  40ms de stagger. Salida invertida (card primero, backdrop después).
  Respeta `prefers-reduced-motion`.
- Pickers nativos OS (cover, carpeta raíz, extras, import source) **se
  mantienen nativos** — la migración a xdg-portal queda en sprint de
  packaging.

### Sprint 10 — Temas + fuentes embebidas ✓

> Reemplazar `font-family: serif`/`sans-serif` genéricos del EPUB con
> tipografía custom. Temas reutilizables a nivel root del repo, override
> per-saga y per-libro.

- **Temas reutilizables** en `<root>/themes/<id>/`. Cada tema autocontenido:
  `theme.json` (body_font, body_size, heading_font, heading_size, line_height,
  page_margin) + carpeta `fonts/` con archivos `.ttf/.otf/.woff/.woff2`.
- **Referencia + overrides**: `saga.json::theme = { base: "<id>", overrides: {…} }`.
  Mismo shape en `book.json`. El base aporta defaults; los overrides pisan
  campo a campo. Saga aporta default a sus libros; book sobreescribe.
  Standalone book usa solo `book.json`.
- **Fonts override per-saga/per-libro**: `<saga>/fonts/` y `<book>/fonts/`
  pisan los archivos del tema base. Útil para una novela que necesita una
  variante específica sin tocar el tema compartido.
- **Detección de bold/italic** desde el nombre del archivo:
  `Merriweather-Regular.ttf`, `-Bold.ttf`, `-Italic.ttf`, `-BoldItalic.ttf`
  se agrupan en una familia `Merriweather` con cuatro `@font-face`
  (cruz weight × style). `<strong>` y `<em>` del HTML usan el face real.
  Sufijos soportados (case-insensitive, separador `-` o `_`): `Regular`,
  `Bold`, `Italic`, `BoldItalic`, `Roman`, `Oblique`. Sin sufijo reconocido
  → familia = stem completo, single face (faux-bold/italic del lector).
- **Per-style faces explícitas** (override del auto-pick): `body_font_italic`,
  `body_font_bold`, `body_font_bold_italic` apuntan a un filename stem
  específico. Útil cuando la italic auto de la familia es muy sutil — elegís
  un face más pronunciado (e.g. `IBMPlexSans-MediumItalic` en vez del
  `-Italic` regular). Override en cascada: book > saga > tema base. CSS
  emite reglas dedicadas para `em`/`strong` con la familia explícita y
  fallback a la familia base. El theme editor incluye preview real con
  `FontFace` API.
- **EPUB embed**: las fuentes referenciadas por el tema resuelto se copian a
  `OEBPS/fonts/<filename>` y entran al manifest OPF con media-type EPUB-3
  (`font/ttf`, `font/otf`, `font/woff`, `font/woff2`). El CSS del EPUB suma
  `@font-face` por archivo + reglas de tema (body family/size/line-height,
  heading family/size/weight, `@page` margin override).
- **Cero regresión**: tema sin configurar (sin `theme.base` en saga y book)
  produce un CSS byte-idéntico al de antes. Libros existentes siguen
  exportando exactamente igual sin tocar nada.
- **UI**:
  - Botón 🎨 en el toolbar del tree para crear un tema nuevo.
  - Sección "🎨 Temas" en la raíz del tree, lista los temas, click → abre
    editor, context menu con renombrar / duplicar / borrar.
  - Sección "🔤 Fuentes" colapsable bajo cada saga y libro (paralelo a
    "📁 Extras"), con drag&drop OS y context menu.
  - Modal "Editor de tema" con 6 inputs + grilla de fuentes propias del tema.
  - Modales "Configurar Saga" y "Configurar Novela" suman bloque "Tema":
    select de tema base + 6 inputs de override con placeholders mostrando el
    valor heredado.
- **Drag&drop inteligente**: archivos arrastrados a un tema van a su `fonts/`.
  Arrastrados a una saga/libro: si todos son fuentes (`.ttf/.otf/.woff/.woff2`)
  van al `fonts/` de ese scope; sino van al `extras/` como antes.

### Sprint 11 — Per-style faces (italic / bold / bold-italic) ✓

> Pisar el auto-pick por sufijo de filename con un face específico por estilo.
> Caso real: la italic de IBM Plex Sans (Italic.ttf) apenas se distingue del
> Regular en Kindle. Mapear `<em>` a `IBMPlexSans-MediumItalic` da una italic
> mucho más pronunciada.

- 3 fields nuevos en `Theme`: `body_font_italic`, `body_font_bold`,
  `body_font_bold_italic`. Cada uno apunta a un filename stem (no a una
  familia). Filename stem = nombre del archivo sin extensión.
- `locate_face_by_stem` busca el archivo en `<book>/fonts/` →
  `<saga>/fonts/` → `<root>/themes/<id>/fonts/`. Primer match gana.
- Embed: el face explícito se suma a los FontEmbed con weight/style
  forzados al slot (italic=normal+italic, bold=bold+normal,
  bolditalic=bold+italic). Family CSS = sanitized stem (no la familia base).
  Dedup por filename para no embebrir el mismo archivo dos veces si auto-pick
  ya lo tomó.
- CSS emite reglas dedicadas con fallback chain:

  ```css
  em,
  i {
    font-family: '<face>', '<body>', serif;
    font-style: italic;
  }
  strong,
  b {
    font-family: '<face>', '<body>', serif;
    font-weight: bold;
  }
  strong em,
  em strong,
  ... {
    font-family: '<face>', '<body>', serif;
    font-weight: bold;
    font-style: italic;
  }
  ```

  Solo cuando el slot está set. Sin slot configurado → CSS idéntico al de Sprint 10.

- Override en cascada: `book.theme.overrides` > `saga.theme.overrides` > tema base.
- Theme editor modal: 3 dropdowns con stems disponibles + bloque de preview
  que carga las fuentes via `convertFileSrc` + `FontFace` API. Re-renderiza
  on cambio de selección. Sample HTML con `<em>`/`<strong>`/combinación
  visible antes de exportar.
- Saga + Book config modals: 3 selects override per-saga/per-libro con
  placeholder mostrando el valor heredado.
- Modal CSS fix: `min-width: 0` en flex children + `width: 100%` /
  `max-width: 100%` / `box-sizing: border-box` en inputs/selects.
  `text-overflow: ellipsis` en select para clipping limpio cuando los stems
  son largos. Aplica a theme-editor / saga-config / book-config.

### Sprint 12 — Tema editorial + Sobre el autor ✓

> Aislar la tipografía de las páginas editoriales (title page, copyright,
> dedicatoria, TOC, sobre el autor) de la prosa del autor. Sumar la página
> "Sobre el autor" al EPUB con foto + bio configurables.

- 2 fields nuevos en `Theme`: `editorial_body_font` + `editorial_heading_font`.
  Cascada idéntica a body/heading (theme base → saga override → book override).
- CSS subset: nuevas reglas dedicadas que pisan el body/heading default cuando
  los slots editoriales están seteados:
  - `body.title-body, body.copyright-body, body.dedication-body, body.nav-body, body.about-author-body { font-family: <editorial_body>, serif; }`
  - `p.title-page-title, nav h1, nav ol.toc > li.toc-part > a, h1.about-author-title { font-family: <editorial_heading>, sans-serif; }`
- **Cero regresión**: si no setés `editorial_*_font`, esas páginas siguen
  heredando body/heading como antes — el CSS no emite las reglas nuevas.
- Auto-pick de bold/italic igual que body_font: `EditorialBody-Italic.ttf` se
  detecta por sufijo. Sin slot per-style explícito (overkill — el copyright en
  italic ya queda fino).
- Search dirs y embedding: el resolver itera `editorial_body_font`/
  `editorial_heading_font` igual que las families base, busca archivos en
  book/saga/theme fonts/ y los embebe en el EPUB.
- 2 fields nuevos en `BookConfig`: `sobre_el_autor` (plain text, una línea =
  un `<p>`) y `foto_autor` (path relativo o absoluto, copiado al EPUB).
- **Página "Sobre el autor"** generada al final del libro (después del último
  capítulo / epílogo, antes de la contratapa) si `sobre_el_autor` está set.
  Incluye `<h1 class="about-author-title">` (texto "Sobre el autor" / "About
  the author" según `idioma`), foto centrada con border-radius 50% si está,
  bio con un `<p>` por línea no vacía.
- **Auto-detect** de la foto del autor desde disco: stems `author.*` o
  `autor.*` con extensiones jpg/jpeg/png/webp. Mismo patrón que cover/back-cover.
- UI:
  - Theme editor: 2 inputs nuevos en sub-sección "Páginas editoriales" con
    datalist de families disponibles.
  - Saga config + Book config: 2 inputs de override con placeholder mostrando
    el valor heredado (igual que body_font/heading_font hoy).
  - Book config: bloque "Sobre el autor" con textarea de bio + file picker
    de foto del autor (mismo patrón que cover/back-cover).

### Distribución ✓

CI: `.github/workflows/release.yml`. Trigger: `git push --tags v*.*.*`. Linux job
buildea `.deb`, Windows job buildea `.msi` + `.exe`. Ambos firmados ed25519.

- **Linux Arch / CachyOS**: PKGBUILD `twriter-bin` local en `packaging/aur/`. Pull
  el `.deb` del release y lo instala vía pacman. No publicado en AUR (uso
  personal). Para update: `./packaging/aur/rebuild.sh` después de cada release.
- **Linux Debian / Ubuntu**: descargar `.deb` del release, `sudo apt install ./twriter_*.deb`. Sin auto-update.
- **Windows**: descargar `.msi` o `.exe` del release. Auto-update Tauri-native
  vía banner in-app contra `releases/latest/download/latest.json`.
- **macOS**: diferido hasta que arregle la pantalla del MacBook Pro.

#### Setup inicial (una sola vez)

Generar keypair de firma:

```bash
pnpm tauri signer generate -w ~/.tauri/twriter.key --password "<password>"
```

- Privada queda en `~/.tauri/twriter.key` — nunca commitear.
- Pública en `~/.tauri/twriter.key.pub` → ya está embebida en `tauri.conf.json::plugins.updater.pubkey`.
- En GitHub repo settings → Secrets, crear:
  - `TAURI_SIGNING_PRIVATE_KEY` ← contenido de `~/.tauri/twriter.key`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ← password elegida.

#### Cortar release

```bash
./scripts/bump-version.sh 0.2.0
git add -A && git commit -m "chore: bump v0.2.0"
git tag v0.2.0
git push && git push --tags
```

CI buildea + sube a draft release. Revisás changelog y publicás manual desde
GitHub UI. Después en local:

```bash
./packaging/aur/rebuild.sh 0.2.0   # bumpea pkgver, sha256sum, makepkg -si
```

App instalada vía pacman. Para próximas updates, `./rebuild.sh <version>`.

### Diferido (Fase 3+)

#### Editor / UX

- Implementar Markdown (Lectura y escritura, para las notas)
- Más variantes de divisor de escena (más allá del `* * *`)
- Divisor automático de partes (reglas confusas, lo hago a mano)
- Drag & drop reorder de capítulos
- Editor split (dos capítulos lado a lado)
- Notas/research sidebar derecho
- Auto-abrir el modal de configuración de LanguageTool cuando el chequeo tira error (hoy falla silencioso o solo loggea).
- Mover los controles de archivos (sync ⇅, pull ⤓, refresh ↻, file picker 📁) del header del tree a un footer del tree. El header arriba queda solo con título/path + acciones de creación/import. Los controles "de proyecto" abajo, separados del flujo de creación.
- Buscar más alternativas para la gramática. (Futuro)
- **Context menu centralizado**: hoy el click derecho dispara controles random según el componente — cada lugar maneja su propio `contextmenu` listener y abre menúes desconectados (a veces el del browser, a veces el custom, a veces nada). Capturar el evento `contextmenu` a nivel root y rutear a un único `ContextMenuService` que decida qué mostrar según el target (capítulo, libro, saga, tema, fuente, extra, etc.). Beneficios: zero menúes nativos sueltos, comportamiento uniforme, un solo lugar donde agregar/quitar acciones.

#### Tree / Importer

- Mostrar archivos no-chapter en el tree (PNG, txt, md — quedan en disco pero invisibles)
- Re-importar capítulo sobrescribiendo el `.html` existente (hoy hay que borrar primero)
- Editar diccionario per-saga desde UI (hoy se agregan palabras desde el popover, borrar requiere editar `saga.json` a mano)
- Template de saga/libro/cap precargado en instalación nueva (sin novelas en disco) para probar features sin tener que importar nada — capítulo dummy con texto en ES y EN, diálogos sin convertir, errores ortográficos a propósito, scene break, dropcap.
- Importar notas de Joplin (o cualquier .md depende de implementar .mds)

#### EPUB

- Contratapa y otros libros en EPUB
- Preview EPUB tipo Kindle (B/N, distintos tamaños de pantalla — Paperwhite, Oasis, Scribe). Amazon discontinuó Kindle Previewer en Linux.
- Pesos extra de fuente (300 Light, 600 SemiBold, 900 Black). Hoy solo se detectan Regular/Bold/Italic/BoldItalic; pesos custom requieren edit manual del theme.json.
- Auto-migración de tema renombrado: hoy renombrar un tema deja sagas/libros con `base` dangling (mostramos warning). Implementar scan recursivo de `*.json` y rewrite del `base`.
- Colores en el tema (body color, heading color, scene-break color). Hoy el tema es solo tipografía + márgenes.
- Theme presets compartibles entre repos distintos (export/import como zip). Hoy un repo = sus temas; copiá la carpeta `themes/<id>/` manualmente.
- Revisiones de EPUB: hoy el export sobreescribe siempre `Exportados/<titulo>.epub`. Agregar input "guardar últimas N revisiones" (default 5) en `BookConfig` o settings global. Cuando se exporta, renombrar la versión actual a `<titulo>-revN.epub` antes de generar la nueva. Borrar las que excedan N. Permite volver a una compilación anterior si rompiste algo.
- Diseño de la página "Sobre el autor": hoy es funcional pero genérica (foto circular centrada + bio justified). Pensar layout más editorial — quizás dos columnas (foto chica izquierda + bio derecha), variantes de retrato (cuadrado / completo / corner), opción de incluir un epígrafe/quote. Cerrar cuando haya idea visual clara.
- Bio + foto del autor a nivel saga (y opcionalmente global de repo): hoy `sobre_el_autor` y `foto_autor` viven en `book.json`. Sumar campos análogos en `saga.json` (heredados a libros nuevos) y/o en `settings.json` (defaults globales del repo). Permite cruzar libros de referencia / bibliografía / "otros libros del autor" en una misma fuente sin repetir cada vez.

#### Bundle / Distribución (Linux nativo)

> Grupo relacionado: todo toca `tauri.conf.json`, `Cargo.toml` o el AppRun hook de linuxdeploy. Atacar junto en un sprint de packaging.

- File picker via xdg-desktop-portal (hoy usa GTK 3 vía `tauri-plugin-dialog`/`rfd`, se ve foreign en KDE/Wayland). Requiere reemplazar `open()` por comandos Rust con `rfd { features = ["xdg-portal", "tokio"] }`. Fix unifica también el picker de tapas en wizard.
- Metadata + branding del bundle: ícono propio en `.deb`/`.msi`/`.exe` (hoy fallback genérico), description real (hoy "A Tauri App" en `Cargo.toml`), `bundle.copyright`, `bundle.publisher`, `bundle.shortDescription`/`longDescription` en `tauri.conf.json`, `bundle.category` ("Productivity"). Esto fixea el `.desktop` (Comment + Categories) que hoy queda vacío.
- Sizes de ícono adicionales en `.deb` (hoy solo 32, 128, 256@2 — algunos launchers buscan 48/64).
- Tema GTK del window decoration / dialogs nativos respetando sistema (hoy linuxdeploy AppRun fuerza `GTK_THEME=Adwaita:light/dark` leyendo gsettings de GNOME — en KDE/Plasma queda Adwaita default en vez de Breeze). Workaround: env var `APPIMAGE_GTK_THEME=Breeze:dark` o patchear el AppRun hook en CI.
- Mejorar la instalación de docker y poner algo más copado para mostar que está instalando la imagen y eso (Una barrita o algo que gire)

#### Archivos

- Soportar servicios de nube como dropbox y pCloud, sería lo mismo, pero sin git. Un poco más limpia la ui

#### Observabilidad / Stats

- Diff/historial visual via git log
- Stats: gráfico palabras/día
- Pantalla de debug (logs Rust + estado de signals + stderr de git)
- Preview pre-push: hoy el indicador del header dice "15 archivos para subir" pero sin detalle de cuáles. Sumar tooltip con la lista de paths (status: M/A/D) en el hover del indicador, y/o dialog "Ver cambios pendientes" antes del push manual con diff resumido por archivo (capítulos editados, libros nuevos, metadata tocada). Mismo dato que `git status --short` + opcionalmente `git diff --stat`. Útil para entender qué se va al remoto sin abrir terminal.

#### Plataformas

- Mobile (No sé si es importante, capaz un exportador a epub estaría bueno porque puedo ver los archivos en gh)

## Gramática (LanguageTool)

Por defecto tWriter usa el API público gratis de LanguageTool (`api.languagetool.org`).
Limitado a 20 req/min, 75KB/min, 20KB/req — y el texto se envía a servidores LT.
Por eso el modo público:

- Solo permite chequeo on-demand (sin auto-recheck mientras escribís — el ToS lo prohíbe)
- Banner naranja avisa la primera vez que activás la feature en una sesión

Para uso intensivo y privacidad total, levantar LT local con Docker:

```bash
./scripts/start-languagetool.sh   # primera vez tarda ~30s en cargar modelos
```

En tWriter abrir el ⚙ del header → "Local (Docker)" → "Probar conexión" → "Aplicar".

Para detenerlo:

```bash
./scripts/stop-languagetool.sh
```

Resource: ~2GB RAM corriendo. La imagen `erikvl87/languagetool` incluye hunspell para
ortografía en español/inglés — no necesitás un diccionario aparte.

## Cómo instalar (desarrollo)

Setup inicial en **Arch / CachyOS** desde cero.

### 1. Toolchain Rust

Usar `rustup` (toolchain manager oficial), no el paquete `rust` de Arch. Permite cambiar entre stable/nightly y matchea la doc de Tauri.

```bash
sudo pacman -S rustup
rustup default stable
```

Verificar:

```bash
rustc --version
cargo --version
```

### 2. Node.js + pnpm

```bash
sudo pacman -S nodejs pnpm
```

### 3. System libs (Tauri 2 + WebKit)

```bash
sudo pacman -S --needed \
  webkit2gtk-4.1 \
  librsvg \
  libayatana-appindicator \
  base-devel \
  openssl \
  gtk3 \
  file
```

`base-devel` trae `gcc`, `make`, `pkg-config` (necesarios para compilar crates nativas como `git2`).

### 4. Pandoc (importer .docx/.odt)

```bash
sudo pacman -S pandoc
```

### 5. Docker (opcional, para LanguageTool local)

```bash
sudo pacman -S docker
sudo systemctl start docker        # arrancar on-demand, no enable
sudo usermod -aG docker $USER     # logout/login para que tome efecto
```

Sin Docker la app igual anda — usa el API público de LanguageTool por default.

### 6. Clonar e instalar

```bash
git clone <repo-url> tWriter
cd tWriter
pnpm install
pnpm tauri dev
```

Primera build de Rust ~5 min (compila `git2`, `webkit`, `zip`, etc.). Después es incremental.

## Desarrollo

```bash
pnpm tauri dev      # frontend :1420 + backend Rust
pnpm build          # solo Angular
pnpm tauri build    # paquete (.AppImage / .deb)
ng test             # Karma tests (Angular)
cargo test --manifest-path src-tauri/Cargo.toml   # tests Rust
```

En **Arch / CachyOS** (system libs con secciones ELF `.relr.dyn`) el `strip` que linuxdeploy embebe falla. Workaround para `tauri build`:

```bash
NO_STRIP=true pnpm tauri build
```

CI (Ubuntu 22.04) no necesita este flag — system libs ahí son ELF clásico.

## Licencia

MIT
