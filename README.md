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
  themes/                          # opcional, temas reutilizables
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
  por id en `saga.json::theme.base` / `book.json::theme.base`.

## Features

### Editor

- TipTap con HTML subset: `<p>`, `<i>`, `<em>`, `<strong>`, `<u>`, `<hr>`, `<h1>`, `<blockquote>`.
- Autosave debounced 1.5s.
- Toolbar: B/I/U, alineación, salto de escena, RAE, gramática, ancho hoja, font size.
- Menú contextual propio.
- Modo focus (F11 / Esc): oculta tree, deja toolbar y footer.
- Indicador de idioma en footer (badge color) + toggle ES/EN.
- Diálogos custom (prompt/confirm/alert) coherentes con el resto de los modales — sin headers feos de WebKit.
- `<app-select>` Angular standalone reemplaza los `<select>` nativos en todos los modales (no más widget del DE distinto por distro). Typeahead automático cuando hay >10 opciones.
- File pickers nativos vía `rfd` 0.15 con feature `xdg-portal` — en KDE/Wayland abre el portal del sistema en vez del diálogo GTK 3 foreign del plugin-dialog.
- **Split view**: arrastrá un capítulo o nota del árbol al panel central para abrir un segundo editor. Combos: chapter+chapter (comparar/escribir en paralelo) o chapter+note (nota como referencia mientras escribís). Cada pane tiene su propio autosave, idioma, gramática y RAE. Botón ⬍/⬌ cambia entre split horizontal (lado a lado) y vertical (apilado). Botón × cierra el pane secundario y vuelve a single-pane. Estado no persistido entre sesiones (cada vez arranca single).

### Notas (Markdown)

- Editor separado para `.md` con TipTap + `tiptap-markdown` (no toca el flow de capítulos HTML).
- Toolbar: B/I/S/code inline + H1/H2/H3 + listas bullet/numerada + blockquote + code block + hr. Sin RAE, LT ni idioma.
- Convivencia con capítulos: mutex de un solo editor a la vez. El icono y footer marcan claramente "Nota".
- `.md` aparecen en cualquier ubicación del árbol (saga, libro, sección, root); las carpetas `<saga>/notas/` y `<book>/notas/` se renderizan como 📒 expandibles.
- `notas/` y los `.md` quedan auto-excluidos del export EPUB y de la vista de tarjetas (la vista de tarjetas es para contenido del libro).
- "Nueva nota…" desde context menu de saga/libro/carpeta `notas/` (autocrea el dir si no existe).
- `.md` que viven en `extras/` también abren en este editor (no en `xdg-open`).
- **Reader en panel derecho**: Shift+click sobre `.md` (en `notas/` o `extras/`) o context menu "Abrir en panel derecho" abre la nota como render read-only al costado, sin desplazar al capítulo del centro. Botón ✏️ promueve la nota al editor del centro para editar; 🗙 cierra. Mutex con image viewer y font preview.
- **Ancho del panel derecho**: botón en el header del reader cicla 4 presets (compacto 280px / normal 380px / ancho 560px / pantalla — oculta el centro). Persiste en `settings.json::rightPanelWidth`.

### Tree explorer

- Jerarquía Saga / Libro / Sección / Capítulo + Notas + carpetas `notas/`.
- Context menu: crear, mover, renombrar, importar, exportar EPUB, configurar libro, excluir del EPUB. Para notas: abrir, renombrar, borrar.
- Reorder de capítulos via context menu (↑ subir / ↓ bajar).
- Archivos no-chapter visibles en el tree con íconos por tipo (🖼 imagen, 📄 documento, 📝 texto, 📦 otro). Notas con 📝 y badge `.md`.
- Template inicial precargado (saga/libro/capítulo dummy) al crear sagas/libros nuevos.
- Badge "excluido" para `.twriter-ignore`.
- Selector de carpeta raíz persistido + auto-load del último capítulo abierto.

### Conversor RAE

- Port TS de reglas D1–D5 desde [`dialogos_a_esp`](https://github.com/T4toh/dialogos_a_esp).
- Botón "RAE" en toolbar (solo cuando `idioma === 'es'`).
- Preview side-by-side antes de aplicar.

### Gramática + ortografía (LanguageTool)

- 3 modos: público (`api.languagetool.org`), local (Docker), custom URL.
- Underlines diferenciados: orto (rojo sólido), gramática (rojo wavy), estilo (amarillo wavy).
- Popover con sugerencias clickeables + atribución LT.
- Rate-limit client-side (18 req/min, 70KB/min) + chunking >20KB transparente.
- Auto-check auto-on en modo local/custom tras ping ok. Toggle persistido (`settings.json::grammarAutoDisabled`). Público queda off por ToS.
- Variantes regionales (es-AR, es-ES, en-US, en-GB…) globales + override per-saga (`saga.json::variante_es`/`variante_en`). Click en badge del footer abre dropdown.
- Diccionario per-saga: "+ diccionario" en popover de TYPOS filtra matches.
- Botones para levantar/detener Docker desde GUI.

### Importer

- Pandoc CLI shell-out (`.docx`/`.odt` → HTML subset). Single chapter o bulk.
- Wizard de importación de saga/novela (📥 en header): trae carpeta externa al repo con detección heurística de estructura, decisión per-carpeta sobre conversión, metadata de saga + libros, normalización de tapas y extras, progress bar con eventos.

### Extras + covers

- Layout canónico: `<saga>/extras/`, `<book>/extras/`, `cover.*`, `back-cover.*`.
- Auto-discovery de covers desde disco (las novelas viejas no se rompen).
- Drag&drop de archivos del OS al saga/libro.
- Context menu por extra: abrir, renombrar, borrar.
- `back-cover` embebida al final del EPUB si está presente.

### Export EPUB

- Builder Rust con `zip` + `uuid`. Estructura EPUB 3.
- CSS subset estilo Reedsy embebido.
- Templates 6×9" / 5×8" / A5 inyectados como `@page`.
- Cover image, dedicatoria, copyright, TOC navegable.
- Página "Sobre el autor" generada al final con foto + bio configurables (auto-detect de `author.*`/`autor.*` desde disco).

### Temas + fuentes embebidas

- Temas reutilizables a nivel root (`<root>/themes/<id>/`) con tipografía + márgenes.
- **Pool global de fuentes** en `<root>/fonts/`. Sección "Fuentes" en el árbol al nivel root — un solo lugar para subir y mantener todas las fuentes del repo. Los temas resuelven por nombre de familia; no hay copias per-tema ni per-saga.
- **Marca de uso**: cada fuente del pool tiene flag visual — 🔤 si algún tema/saga/libro la referencia, 🔇 + itálica desaturada si no la usa nadie. Tooltip indica el estado.
- **Botones de mantenimiento** en el header de Fuentes:
  - **⇲ Consolidar**: mueve fuentes dispersas (legacy `<theme>/fonts/`, `<saga>/fonts/`, `<book>/fonts/`) al pool global. Dedupa por nombre+tamaño (borra dupes), avisa colisiones de nombre con tamaño distinto, limpia carpetas `fonts/` vacías.
  - **🧹 Limpiar no usadas**: borra del disco las fuentes sin uso conocido (confirm modal con count).
- Override per-saga/per-libro: `saga.json::theme = { base, overrides }`, mismo shape en `book.json`. Fonts overrides locales aún se pueden poner en `<saga>/fonts/` o `<book>/fonts/` y tienen prioridad sobre el pool global (search order: book → saga → root → legacy `<theme>/fonts/`).
- Detección automática de bold/italic via sufijos en filename (`-Regular`, `-Bold`, `-Italic`, `-BoldItalic`, case-insensitive).
- **Per-style faces explícitas**: `body_font_italic`/`body_font_bold`/`body_font_bold_italic` apuntan a un filename stem específico para `<em>`/`<strong>`. Pisa el auto-pick. Útil cuando la italic auto es muy sutil.
- **Tema editorial**: `editorial_body_font` + `editorial_heading_font` aíslan tipografía de páginas no-autor (title page, copyright, dedicatoria, TOC, sobre el autor) de la prosa.
- **Posición del título de capítulo**: `chapter_title_position` (`top`/`center`/`bottom`) con fallback `@media amzn-kf8` para que Kindle también centre.
- **Preview de fuente en panel derecho**: click en una fuente del pool abre el viewer (FontFace API): hero `Aa Bb Cc` a 96px + alfabeto + signos ES + escala 14/20/32/48 + párrafo Lorem ipsum. Mutex con el image viewer (un panel a la vez). Esc o × cierra.
- Theme editor con preview real via `FontFace` API; lee fuentes del pool global (no tiene UI propia de upload).
- Modal de config de novela: el option "Heredar de saga" muestra el id/nombre del tema que la saga tiene actualmente seteado (carga `saga.json` del padre via `find_saga_dir`).
- Cero regresión: sin tema configurado, CSS byte-idéntico al de pre-temas.

### Debug / observabilidad

- Panel 🐛 toggleable en header (35vh fixed bottom, monospace).
- Log timestamped (HH:MM:SS.mmm) con niveles info / warn / error, source y mensaje + details opcionales.
- **Bridge Rust → frontend** vía `tracing` crate. `EmitLayer` custom forwardea cada `tracing::info!/warn!/error!` al evento Tauri `debug-log`. El listener Angular (`RustLogBridge`) lo empuja al mismo `DebugService`. Targets cubiertos: `fs`, `git`, `epub`, `import`, `import-wizard`, `grammar`, `theme`, `create`, `reorder`, `dialog`, `boot`. Filtro por env: `RUST_LOG=twriter_lib=info,warn,error` por default.
- Services frontend instrumentados: `ChapterService`, `UpdaterService`, `GrammarService`, `ThemesService`, `ProjectService`, `ImportWizardService`. App component captura `chapter/project/git.error()` vía effects.
- **Filtros**: 3 toggles de nivel (info/warn/error) + input de búsqueda por source.
- **Copiar**: botón en header serializa entradas filtradas a clipboard como texto plano (útil para bug reports).
- **Snapshot**: botón 📸 dumpea el estado actual (settings, project tree counts, capítulo activo, git status, grammar mode) como entrada `[snapshot]` con JSON pretty.
- **Persistencia sessionStorage**: log + visible + filtros sobreviven F5 (no entre sesiones).
- Max 200 entries (drop oldest).

### Git auto-sync

- `git2` crate (libgit2) — sin shellear `git`. SSH agent + fallback a `~/.ssh/id_ed25519/id_rsa/id_ecdsa`.
- Auto-commit cada 5 min cuando hay cambios.
- Status polling 30s.
- Botón "sync ahora" (⇅) en header.

### Distribución

- CI: `.github/workflows/release.yml`. Trigger: `git push --tags v*.*.*`. Linux job buildea `.deb`, Windows job buildea `.msi` + `.exe`. Ambos firmados ed25519.
- **Linux Arch / CachyOS**: PKGBUILD `twriter-bin` local en `packaging/aur/`. Pull el `.deb` del release, instala vía pacman. Update: `./packaging/aur/rebuild.sh <version>`.
- **Linux Debian / Ubuntu**: descargar `.deb`, `sudo apt install ./twriter_*.deb`. Sin auto-update.
- **Windows**: descargar `.msi` o `.exe`. Auto-update Tauri-native vía banner in-app contra `releases/latest/download/latest.json`.
- **macOS**: diferido hasta que arregle la pantalla del MacBook Pro.

#### Cortar release

Setup inicial (una sola vez):

```bash
pnpm tauri signer generate -w ~/.tauri/twriter.key --password "<password>"
```

Privada en `~/.tauri/twriter.key` — nunca commitear. Pública ya embebida en `tauri.conf.json::plugins.updater.pubkey`. En GitHub repo settings → Secrets:

- `TAURI_SIGNING_PRIVATE_KEY` ← contenido de `~/.tauri/twriter.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ← password elegida

Después cada release:

```bash
./scripts/bump-version.sh 0.2.0
git add -A && git commit -m "chore: bump v0.2.0"
git tag v0.2.0
git push && git push --tags
```

CI buildea + sube a draft release. Revisás changelog y publicás manual. En Arch (instalación local):

```bash
./packaging/aur/rebuild.sh 0.2.0
```

#### Publicar a AUR

> **Estado actual**: el PKGBUILD vive en `packaging/aur/` para uso personal (instalación local via `rebuild.sh`). No publicado todavía en AUR — esta sección es la receta cuando lo haga.

Setup inicial (una sola vez):

1. Crear cuenta en <https://aur.archlinux.org>.
2. Subir la clave SSH pública en _My Account → SSH Public Key_.
3. Instalar utilidades de packaging:

   ```bash
   sudo pacman -S pacman-contrib base-devel
   ```

4. Clonar el repo vacío del paquete:

   ```bash
   git clone ssh://aur@aur.archlinux.org/twriter-bin.git aur-twriter-bin
   cd aur-twriter-bin
   ```

5. Copiar archivos de packaging desde tWriter:

   ```bash
   cp ~/Repos/Personal/tWriter/packaging/aur/PKGBUILD .
   cp ~/Repos/Personal/tWriter/packaging/aur/twriter-bin.install .
   ```

6. Reemplazar `sha256sums=('SKIP')` por el hash real (AUR rechaza `SKIP`):

   ```bash
   updpkgsums
   ```

7. Generar `.SRCINFO` (AUR lo requiere para indexar metadata):

   ```bash
   makepkg --printsrcinfo > .SRCINFO
   ```

8. Verificar que builda y se instala limpio:

   ```bash
   makepkg -si
   ```

9. Commit + push al AUR:

   ```bash
   git add PKGBUILD .SRCINFO twriter-bin.install
   git commit -m "initial release: 0.1.12-1"
   git push origin master
   ```

Cada release nueva (después del setup inicial):

```bash
cd aur-twriter-bin
sed -i -E "s/^pkgver=.*/pkgver=0.2.0/" PKGBUILD
sed -i -E "s/^pkgrel=.*/pkgrel=1/" PKGBUILD
updpkgsums
makepkg --printsrcinfo > .SRCINFO
makepkg -si                                  # smoke test local
git add PKGBUILD .SRCINFO
git commit -m "upgpkg: twriter-bin 0.2.0-1"
git push origin master
```

Bumpear `pkgrel` (no `pkgver`) si cambia el PKGBUILD pero no la versión de tWriter.

Una vez publicado, los usuarios pueden instalar con cualquier AUR helper:

```bash
yay -S twriter-bin
# o
paru -S twriter-bin
```

## TODO

### Editor / UX

- Más variantes de divisor de escena (más allá del `* * *`).
- Divisor automático de partes (reglas confusas, hoy lo hace a mano).
- Drag & drop reorder de capítulos (hoy solo via context menu ↑/↓).
- Sidebar derecho de research / vista global de notas con búsqueda (el reader de `.md` en el panel derecho ya existe; falta el panel agregador con búsqueda full-text).
- Auto-abrir modal de configuración de LanguageTool cuando el chequeo tira error (hoy falla silencioso o solo loggea).
- Buscar más alternativas para la gramática.

### Tree / Importer

- Re-importar capítulo sobrescribiendo el `.html` existente (hoy hay que borrar primero).
- Borrar entradas individuales del diccionario per-saga desde UI (hoy se editan en bloque vía textarea del modal de configuración; agregar funciona desde el popover de typos).
- Importer dedicado de Joplin (parsea metadata propia + adjuntos). Para `.md` simples sin metadata, copialos directo a `<saga>/notas/` o `<book>/notas/` y aparecen en el árbol.

### EPUB

- Lista "Otros libros del mismo autor" en EPUB (contratapa ya está embebida).
- Preview tipo Kindle (B/N, distintos tamaños — Paperwhite, Oasis, Scribe). Amazon discontinuó Kindle Previewer en Linux.
- Pesos extra de fuente (300 Light, 600 SemiBold, 900 Black). Hoy solo Regular/Bold/Italic/BoldItalic; pesos custom requieren edit manual del `theme.json`.
- Auto-migración de tema renombrado: hoy renombrar un tema deja sagas/libros con `base` dangling (warning). Implementar scan recursivo de `*.json` y rewrite del `base`.
- Colores en el tema (body color, heading color, scene-break color). Hoy el tema es solo tipografía + márgenes.
- Theme presets compartibles entre repos distintos (export/import como zip).
- Revisiones de EPUB: hoy sobreescribe siempre `Exportados/<titulo>.epub`. Sumar "guardar últimas N revisiones" (default 5) — renombrar la actual a `<titulo>-revN.epub` antes de generar la nueva.
- Diseño de la página "Sobre el autor": hoy funcional pero genérico (foto circular + bio justified). Pensar layout más editorial (dos columnas, variantes de retrato, epígrafe).
- Bio + foto del autor a nivel saga (heredados a libros nuevos) y/o `settings.json` (defaults globales del repo). Hoy solo `book.json`.
- Vista copada para diseñar temas (Con preview de todo. Título, copyright, capítulo y una página.)

### Bundle / Distribución (Linux nativo)

> Todo toca `tauri.conf.json`, `Cargo.toml` o el AppRun hook de linuxdeploy. Atacar junto en un sprint de packaging.

- Metadata + branding del bundle: ícono propio en `.deb`/`.msi`/`.exe` (hoy fallback genérico), description real (hoy "A Tauri App"), `bundle.copyright`, `bundle.publisher`, `bundle.shortDescription`/`longDescription`, `bundle.category` ("Productivity"). Fixea el `.desktop` (Comment + Categories) que hoy queda vacío. Como side-effect, el título del file picker via xdg-portal en KDE deja de mostrar el ícono default de Plasma — Plasma resuelve el ícono via `StartupWMClass` del `.desktop` y `bundle.identifier`.
- Sizes de ícono adicionales en `.deb` (hoy solo 32/128/256@2 — algunos launchers buscan 48/64).
- Tema GTK del window decoration / dialogs respetando sistema (hoy AppRun fuerza `GTK_THEME=Adwaita:light/dark` leyendo gsettings de GNOME — en KDE queda Adwaita default). Workaround: env var `APPIMAGE_GTK_THEME=Breeze:dark` o patchear AppRun hook en CI.
- Mejor UX de instalación de Docker para LT (barrita o spinner que muestre que está pulleando la imagen).

### Archivos

- Soportar servicios de nube como Dropbox y pCloud — sería lo mismo, pero sin git. UI más limpia.

### Observabilidad / Stats

- Diff/historial visual via `git log`.
- Stats: gráfico palabras/día.
- Preview pre-push: hoy el indicador del header dice "15 archivos para subir" sin detalle. Tooltip con lista de paths (M/A/D) en hover, y/o dialog "Ver cambios pendientes" con `git status --short` + `git diff --stat`.

### Plataformas

- Mobile (no urgente, capaz solo un exportador a EPUB para ver archivos desde gh).

## Gramática (LanguageTool)

Por defecto tWriter usa el API público gratis de LanguageTool (`api.languagetool.org`).
Limitado a 20 req/min, 75KB/min, 20KB/req — y el texto se envía a servidores LT.
Por eso el modo público:

- Solo permite chequeo on-demand (sin auto-recheck mientras escribís — el ToS lo prohíbe).
- Banner naranja avisa la primera vez que activás la feature en una sesión.

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

## Instalación

Releases en <https://github.com/T4toh/tWriter/releases>.

### Arch / CachyOS

**Opción A: AUR** (cuando esté publicado, ver "Publicar a AUR" arriba):

```bash
yay -S twriter-bin     # o paru, pikaur, etc
```

**Opción B: PKGBUILD local** (uso actual del autor):

```bash
git clone https://github.com/T4toh/tWriter
cd tWriter
./packaging/aur/rebuild.sh
```

Requiere `pacman-contrib` (`updpkgsums`) y `base-devel`. Para actualizar:

```bash
git pull
./packaging/aur/rebuild.sh <version>     # e.g. 0.2.0
```

### Debian / Ubuntu

Descargar el `.deb` del último release e instalar:

```bash
wget https://github.com/T4toh/tWriter/releases/latest/download/twriter_*_amd64.deb
sudo apt install ./twriter_*_amd64.deb
```

Sin auto-update — recheckear releases manualmente.

### Windows

Descargar de releases:

- `.msi` (instalador limpio, recomendado para uso normal), **o**
- `.exe` (NSIS, instalador alternativo)

Auto-update Tauri-native: la app chequea `releases/latest/download/latest.json` y muestra banner in-app cuando hay versión nueva. Aceptar el banner descarga e instala sin pasar por el browser.

### macOS

Diferido hasta que el autor arregle la pantalla del MacBook Pro. Mientras tanto, build manual desde fuente — ver "Setup de desarrollo" abajo.

### Dependencias opcionales

- **Pandoc** (para importar `.docx`/`.odt`): `sudo pacman -S pandoc` / `sudo apt install pandoc` / [pandoc.org](https://pandoc.org/installing.html) en Windows. Sin Pandoc, el importer queda inhabilitado pero el resto de la app funciona.
- **Docker** (para LanguageTool local): ver sección "Gramática" arriba. Sin Docker, la app usa el API público de LT por default.

## Setup de desarrollo

Instrucciones para **Arch / CachyOS** desde cero. En otros distros adaptar los gestores de paquetes.

### 1. Toolchain Rust

Usar `rustup` (toolchain manager oficial), no el paquete `rust` de Arch.

```bash
sudo pacman -S rustup
rustup default stable
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
