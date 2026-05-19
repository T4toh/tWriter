# TODO

Pendientes, bugs conocidos y mejoras planificadas de tWriter. Issues concretos van a GitHub Issues; acá quedan ideas, refactors abiertos y diseño en discusión.

## Editor / UX

- Más variantes de divisor de escena (más allá del `* * *`).
- Auto-abrir modal de configuración de LanguageTool cuando el chequeo tira error (hoy falla silencioso o solo loggea).
- Buscar más alternativas para la gramática.
- **Marcador huérfano post jump-to-term**: el highlight naranja de
  `requestHighlight` (search → click resultado) o de la selección nativa
  del jump queda pegado sobre el carácter (típicamente un em-dash) aún
  después de mover el cursor. Repro: search → click hit → click en otra
  parte del párrafo → el highlight persiste. La limpieza por mouseup /
  keydown se está escapando para algún path (chapter editor, no notes
  reader). Revisar el cleanup en `editor.ts` que monta el `TreeWalker`.

## Tree / Importer

- Re-importar capítulo sobrescribiendo el `.html` existente (hoy hay que borrar primero).
- Sumar más importers de notas: Obsidian (vault con `.obsidian/`), Notion (export ZIP), Bear (`.bear`), Logseq (graph), Markdown plano con frontmatter. El trait `NoteImporter` ya está armado — agregar uno nuevo no requiere tocar el wizard genérico.
- Joplin JEX format (preserva adjuntos + tags + timestamps). Hoy solo soporta el export raw MD.

## EPUB

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

## Archivos

- Changelog screen in-app: panel/modal accesible desde el header (junto a 🐛) parseando `CHANGELOG.md` o release notes de GitHub. Útil para gente nueva post-AUR.
- Guía in-app de primer uso: tour con flechas la primera vez que se abre la app (tree explorer, idioma, RAE, gramática, sync). Persiste flag en `settings.json`.
- Botón "Abrir en terminal" dentro del modal storage-help (`xdg-open` / `konsole` / `gnome-terminal` / `wt`).
- **Sincronizar `settings.json` entre PCs**: hoy la config vive en
  `app_config_dir` local (Linux: `~/.config/twriter/`) — cada PC arranca
  con su propio tema, idioma, font recents, grammar mode, diccionario,
  rightPanelWidth, etc. Opciones a evaluar: (a) mover a
  `<root>/.twriter/settings.json` para que vaya por git/cloud junto al
  repo de novelas, (b) sumar export/import manual, (c) sync explícito
  por gist/Dropbox. La (a) es la más seamless pero mezcla preferencias
  per-PC (font recents) con per-repo (tema, idioma).

## Observabilidad / Stats

- Diff/historial visual via `git log`.
- Stats: gráfico palabras/día.
- Preview pre-push: hoy el indicador del header dice "15 archivos para subir" sin detalle. Tooltip con lista de paths (M/A/D) en hover, y/o dialog "Ver cambios pendientes" con `git status --short` + `git diff --stat`.

## Git / Sync

- [x] **Refresh post-pull (tree + editor + search index)**: tras `git_pull` / `git_pull_rebase`, los commands ahora retornan `Vec<PullPathChange>` (diff de trees pre→post HEAD). `GitService` dispara `project.loadTree()`, `chapter.reloadIfChanged()` (silencioso si el buffer no está dirty; toast warn si sí, preservando la edición) y `search.applyPathChanges()` (incremental sobre `.html` / `.md`). Resuelve el bug de "el árbol y el diccionario no se actualizaron tras pullear desde otra PC".
- **Fetch silencioso al abrir + pre-push**: que la app traiga refs remotos al cargar el root y antes de cada auto-push, en vez de depender del recovery por non-FF rejection. Espejo de `git_pull_impl` con `["fetch", "--prune"]` + hook en el effect de `GitService` después de `git_ensure_twriter_ignored` y al inicio de `syncNow()`. Filosofía: "no te hagas el lindo" — fallar silencioso si no hay agent SSH, el editor sigue offline-funcional.
- **Endurecer `run_git` contra cuelgues sin TTY** (independiente, valioso por sí mismo): sumar `GIT_TERMINAL_PROMPT=0` + `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"` al `Command` en `git.rs:179-193`. Garantiza que ningún git op cuelgue forever si la app abre sin `SSH_AUTH_SOCK` o sin key cargada. También refactorizar `git_pull_impl` a usar `run_git` (hoy lanza `Command::new("git")` crudo y se le escapa el endurecimiento).

## Validador RAE

- **Bulk auto-fix** desde el panel "Revisar RAE": hoy el panel es solo lista
  - click-to-jump. La acción "Aplicar todos los auto-fixables (N)"
    (replacements char/typo agrupados por archivo en orden descendente de
    offset, un `write_chapter` por archivo) quedó fuera de v1 — el riesgo es
    pisar inline markup (`<em>`/`<strong>`) al reconstruir HTML desde plain
    text. Implementar con patch quirúrgico HTML-aware: encontrar el rango en
    el HTML que corresponde al span del fix y reemplazar solo eso, sin tocar
    el resto del párrafo.
- **Fix de `pending-conversion` desde popover inline**: hoy aplica el
  replacement del converter como plain text sobre el rango del párrafo, lo
  que strip-ea inline markup en ese párrafo. Para párrafos con markup, usar
  el botón "RAE" del toolbar (modal de capítulo entero) que sí preserva
  markup vía el path `<p>…</p>` del converter. Solución: serializar el slice
  ProseMirror del párrafo a HTML antes de invocar `convert()`, y replazar el
  rango con el HTML resultante en vez de `insertContent` plano.
- **Jump-to-exact-offset desde el batch**: el click en una violación del
  panel usa el patrón `requestHighlight` de search (busca el término en el
  capítulo y scrollea al primer match). Funciona para violaciones con
  término único, pero para snippets repetidos (ej. `—dijo` que aparece 30
  veces) salta al primer match, no al específico de la violación.
  Implementar `consumePendingRaeJump(path)` que devuelva offset+length y el
  editor mapee al `pmPos` correcto al render.
- **Atribución D1-D5 en `pending-conversion`**: hoy el ruleId es genérico
  `pending-conversion`. Para fine-grain (saber qué regla del converter
  mordió en cada violación), instrumentar `convert()` con hooks que reporten
  qué subpattern matcheó por párrafo.
- **Salvaguardas adicionales**: `dash-orphan` puede dar falso positivo en
  diálogos donde el verbo dicendi aparece dentro de una cita interna larga
  (`—Me dijo «si pudieras venir, dijo...»`). Refinar: solo flaggear si el
  verbo está en el nivel "narrativo" del párrafo, no dentro de `« »`.
- **Tests con fixtures reales**: cuando `/home/tatoh/Repos/novelas/` tenga
  los capítulos viejos de Meridian 2.0 pulleados, sumar `validator.spec.ts`
  cases con párrafos textuales de esos archivos (incluyendo el caso "todo
  colapsado en un párrafo" detectado en exploración) para regresión.

## Plataformas

- Mobile (no urgente, capaz solo un exportador a EPUB para ver archivos desde gh). Tomador de notas estaría piola, pero no veo que sea posible sincronizar git en el teléfono (Capaz que sí, investigar.) Estaría re zarpado poder tomar notas sobre partes o capítulos mientras leo en la kindle y que queden resgistrados en notas del libro o algo así.
