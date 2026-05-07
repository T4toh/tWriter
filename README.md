# tWriter

App desktop para escribir novelas en español e inglés. Centraliza el flujo: editor → conversor de diálogos a estilo RAE → chequeo de gramática → exportación EPUB. Reemplaza LibreOffice + Reedsy en una sola herramienta.

Las novelas viven en un repo privado aparte (HTML + JSON). Esta app es solo el editor.

**Stack**: Tauri 2 + Angular 21 + TipTap. Backend Rust, frontend signals.

## Estado

MVP completo. Sprints 1–7 hechos.

- **Editor**: TipTap con HTML subset (`<p>`, `<i>`, `<em>`, `<strong>`, `<u>`, `<hr>`, `<h1>`, `<blockquote>`), autosave debounced 1.5s, toolbar (B/I/U, alineación, salto de escena, RAE, gramática, ancho hoja, font size), menú contextual propio.
- **Tree explorer** del repo (Saga / Libro / Sección / Capítulo) con context menu (crear, mover, importar, exportar EPUB, configurar libro, excluir del EPUB), badge "excluido" para `.twriter-ignore`.
- **Modo focus** (F11 / Esc).
- **Selector de carpeta raíz** persistido + auto-load del último capítulo abierto.
- **Git auto-sync**: commit cada 5 min, status polling 30s, push manual desde header.
- **Importer Pandoc**: `.docx`/`.odt` → HTML subset (single chapter o bulk).
- **Wizard de importación de saga/novela** (📥 en header): trae carpeta externa al repo con detección de estructura, conversión per-carpeta opcional, metadata de saga + libros, copia de tapas y extras normalizada.
- **Conversor RAE de diálogos** (D1–D5 portados de `dialogos_a_esp`): botón "RAE" con preview side-by-side antes de aplicar.
- **Gramática + ortografía** vía LanguageTool (público / Docker local / custom URL): underlines diferenciados, popover con sugerencias clickeables, atribución, diccionario per-saga.
- **Export EPUB**: builder Rust con CSS subset Reedsy, templates 6×9"/5×8"/A5, cover image, dedicatoria, copyright, TOC navegable.
- **Tema** claro/oscuro, tipografía serif que matchea el EPUB output.
- **Indicador idioma** footer (badge color por idioma) + toggle ES/EN.

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

### Distribución (pendiente)

- **Linux**: AppImage con auto-update (mismo flujo que `dialogos_a_esp` — `tauri-plugin-updater` + bundle `.AppImage` en releases de GitHub).
- **Windows**: build `.msi` o `.exe` en la máquina Waldorf cuando esté disponible.
- **macOS**: diferido hasta que arregle la pantalla del MacBook Pro.

### Diferido (Fase 3+)

- Más variantes de divisor de escena (más allá del `* * *`)
- Re-importar capítulo sobrescribiendo el `.html` existente (hoy hay que borrar primero)
- Editar diccionario per-saga desde UI (hoy se agregan palabras desde el popover, borrar requiere editar `saga.json` a mano)
- Mostrar archivos no-chapter en el tree (PNG, txt, md — quedan en disco pero invisibles)
- Divisor automático de partes (reglas confusas, lo hago a mano)
- File picker via xdg-desktop-portal (hoy usa GTK 3 vía `tauri-plugin-dialog`/`rfd`, se ve foreign en KDE/Wayland). Requiere reemplazar `open()` por comandos Rust con `rfd { features = ["xdg-portal", "tokio"] }`.
- Notas/research sidebar derecho
- Drag & drop reorder de capítulos
- Diff/historial visual via git log
- Stats: gráfico palabras/día
- Editor split (dos capítulos lado a lado)
- Pantalla de debug (logs Rust + estado de signals + stderr de git)
- Fonts embebidas en EPUB (Merriweather, Lato, Roboto Mono)
- Página "About the author" en EPUB
- Flag `epilogo` en `meta.json` para separar epílogos del TOC principal
- Preview EPUB tipo Kindle (B/N, distintos tamaños de pantalla — Paperwhite, Oasis, Scribe). Amazon discontinuó Kindle Previewer en Linux.
- Mobile

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

## Desarrollo

```bash
pnpm install
pnpm tauri dev      # frontend :1420 + backend Rust
pnpm build          # solo Angular
pnpm tauri build    # paquete (.AppImage / .deb)
```

Primera build de Rust ~5 min. Después es incremental.

Linux (Arch / CachyOS) requiere `webkit2gtk-4.1`, `librsvg`, `libayatana-appindicator`.

## Licencia

MIT
