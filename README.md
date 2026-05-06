# tWriter

App desktop para escribir novelas en español e inglés. Centraliza el flujo: editor → conversor de diálogos a estilo RAE → chequeo de gramática → exportación EPUB. Reemplaza LibreOffice + Reedsy en una sola herramienta.

Las novelas viven en un repo privado aparte (HTML + JSON). Esta app es solo el editor.

**Stack**: Tauri 2 + Angular 21 + TipTap. Backend Rust, frontend signals.

## Estado

Editor mínimo de escritura funcionando:

- Tree explorer del repo de novelas (Saga / Libro / Sección / Capítulo, colapsable)
- Selector de carpeta raíz, persistido entre sesiones
- Editor TipTap con HTML subset controlado (`<p>`, `<i>`, `<u>`, `<strong>`, `<hr>`, `<h1>`, `<blockquote>`)
- Toolbar mínimo: negrita, itálica, subrayado, alineación (izq/cen/der), salto de escena, ancho de hoja (página/ancho/lleno)
- Menú contextual propio (click derecho): editar, cortar/copiar/pegar, pegar como texto plano, formato sobre selección
- Autosave a disco debounced 1.5s, con `.meta.json` por capítulo (orden, palabras, última edición, idioma)
- Word count en footer
- Tema claro y oscuro, tipografía serif para edición (matchea output EPUB)

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

### Sprint 5 — Estilos EPUB

> Replicar look Reedsy lo más fiel posible.

- Centrado vertical+horizontal robusto en title/copyright/dedication/chapter-title (varios readers tienen issues con flex / vh)
- Posicionamiento del copyright al final de página
- Page-break-before/after consistentes
- Validación contra Reedsy en distintos readers (calibre, foliate, Thorium)
- Comparar visualmente con `Buenos Aires 2077/.../La Ciudad de las Luces Rev.2.epub`

### Sprint 6 — Gramática + templates + polish

> Reemplazar Quillbot. Templates de página. UX final.

- Cliente LanguageTool (detecta `localhost:8081`, opcional)
- Underline rojo in-line con sugerencias al click
- Templates de formato (6×9", 5×8", A5) en `book.json`
- Modo focus (atajo `F11`)
- Indicador de idioma en footer

### Diferido (Fase 3+)

- MOBI export
- Notas/research sidebar derecho
- Drag & drop reorder de capítulos
- Diff/historial visual via git log
- Stats: gráfico palabras/día
- Editor split (dos capítulos lado a lado)
- Pantalla de debug (logs Rust + estado de signals + stderr de git)
- Fonts embebidas en EPUB (Merriweather, Lato, Roboto Mono)
- Dropcaps automáticos en primera letra de cada capítulo
- Página "About the author" en EPUB
- Flag `epilogo` en `meta.json` para separar epílogos del TOC principal
- Preview EPUB tipo Kindle (B/N, distintos tamaños de pantalla — Paperwhite, Oasis, Scribe). Amazon discontinuó Kindle Previewer en Linux.
- Mobile (Capacitor)

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
