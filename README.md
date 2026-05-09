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

- Organizar archivos para abrir el paso al feature de Notas (Más que nada manejar mejor los extras/diccionarios a la altura de saga o novela según corresponda)
- Botones giran cuando está en loading. Deberían girar los íconos o tener un loading apropiado.
- Implementar Markdown (Lectura y escritura, para las notas)
- Más variantes de divisor de escena (más allá del `* * *`)
- Divisor automático de partes (reglas confusas, lo hago a mano)
- Drag & drop reorder de capítulos
- Editor split (dos capítulos lado a lado)
- Notas/research sidebar derecho
- Reemplazar `window.prompt()` (crear saga, etc.) por modal propio consistente con el resto de la UI (`BookConfigModal` style). (Este está dos veoces, creo)
- Auto-abrir el modal de configuración de LanguageTool cuando el chequeo tira error (hoy falla silencioso o solo loggea).

#### Tree / Importer

- Mostrar archivos no-chapter en el tree (PNG, txt, md — quedan en disco pero invisibles)
- Re-importar capítulo sobrescribiendo el `.html` existente (hoy hay que borrar primero)
- Editar diccionario per-saga desde UI (hoy se agregan palabras desde el popover, borrar requiere editar `saga.json` a mano)
- Template de saga/libro/cap precargado en instalación nueva (sin novelas en disco) para probar features sin tener que importar nada — capítulo dummy con texto en ES y EN, diálogos sin convertir, errores ortográficos a propósito, scene break, dropcap.
- Importar notas de Joplin (o cualquier .md depende de implementar .mds)

#### EPUB

- Fonts embebidas en EPUB (Merriweather, Lato, Roboto Mono o cualquiera)
- Página "About the author" en EPUB
- Contratapa y otros libros en EPUB
- Flag `epilogo` en `meta.json` para separar epílogos del TOC principal
- Preview EPUB tipo Kindle (B/N, distintos tamaños de pantalla — Paperwhite, Oasis, Scribe). Amazon discontinuó Kindle Previewer en Linux.
- Temas para las sagas así se configuran una sola vez. (Tema sería fuente para el cuerpo, fuente para los títulos y sus respectivos tamaños. Depende de haber implementado la instalación de fuentes)

#### Bundle / Distribución (Linux nativo)

> Grupo relacionado: todo toca `tauri.conf.json`, `Cargo.toml` o el AppRun hook de linuxdeploy. Atacar junto en un sprint de packaging.

- File picker via xdg-desktop-portal (hoy usa GTK 3 vía `tauri-plugin-dialog`/`rfd`, se ve foreign en KDE/Wayland). Requiere reemplazar `open()` por comandos Rust con `rfd { features = ["xdg-portal", "tokio"] }`. Fix unifica también el picker de tapas en wizard.
- Metadata + branding del bundle: ícono propio en `.deb`/`.msi`/`.exe` (hoy fallback genérico), description real (hoy "A Tauri App" en `Cargo.toml`), `bundle.copyright`, `bundle.publisher`, `bundle.shortDescription`/`longDescription` en `tauri.conf.json`, `bundle.category` ("Productivity"). Esto fixea el `.desktop` (Comment + Categories) que hoy queda vacío.
- Sizes de ícono adicionales en `.deb` (hoy solo 32, 128, 256@2 — algunos launchers buscan 48/64).
- Tema GTK del window decoration / dialogs nativos respetando sistema (hoy linuxdeploy AppRun fuerza `GTK_THEME=Adwaita:light/dark` leyendo gsettings de GNOME — en KDE/Plasma queda Adwaita default en vez de Breeze). Workaround: env var `APPIMAGE_GTK_THEME=Breeze:dark` o patchear el AppRun hook en CI.
- Mejorar la instalación de docker y poner algo más copado para mostar que está instalando la imagen y eso (Una barrita o algo que gire)

#### Observabilidad / Stats

- Diff/historial visual via git log
- Stats: gráfico palabras/día
- Pantalla de debug (logs Rust + estado de signals + stderr de git)

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
