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

## Próximo

1. Auto-commit + push del repo de novelas (reemplaza Dropbox)
2. Importer `.docx`/`.odt` → HTML (Pandoc sidecar) + port TS de las reglas RAE de [`dialogos_a_esp`](https://github.com/T4toh/dialogos_a_esp)
3. Export EPUB (replica el subset CSS/fonts de Reedsy)
4. Cliente LanguageTool para gramática (self-host en Docker)
5. Templates de página (6×9", 5×8", A5)

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
