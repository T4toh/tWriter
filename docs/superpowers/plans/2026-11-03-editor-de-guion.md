# Editor de guion — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los `.md` de una carpeta marcada con `.twriter-guion` abran en un editor de texto plano con resaltado del formato de escenas del juego, corrector LanguageTool sobre lo hablado, diccionario propio y tesauro, guardando el archivo byte a byte.

**Architecture:** Rust marca en el árbol qué `.md` son de guion (post-pass sobre `TreeNode` buscando `.twriter-guion`) y apaga git declarando `Local` esa raíz. El frontend reusa `NoteService` (panes, autosave, `read_note`/`write_note`) y monta un componente nuevo `GuionEditor` en vez de `NotesEditor` cuando el `NoteTarget` trae `guion`. El editor es TipTap con StarterKit recortado a documento + texto + undo, un nodo `linea` por línea y dos plugins: resaltado por regex (función pura) y la decoración de gramática que ya existe. La gramática reusa `GrammarService`, `mapMatchesToPm`, `GrammarPopover` y el diccionario de `SagaContextService` apuntado a la carpeta marcada.

**Tech Stack:** Angular 22 (standalone, signals), TipTap 3 / ProseMirror (`@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/pm`), Rust / Tauri 2, smoke runners con `tsc` + node.

**Spec:** `docs/superpowers/specs/2026-11-03-editor-de-guion-design.md`

## Global Constraints

- Sin dependencia nueva de npm ni de cargo.
- El archivo guardado difiere del abierto solo en lo que el autor tocó; única excepción: `\r\n` sale como `\n`, y `write_note` garantiza el `\n` final.
- Nada nuevo en `settings.json`.
- Convenciones de CLAUDE.md: standalone, signals, `@if`/`@for`, `inject()`, return types explícitos, sin `public`, nombres `guion-editor.ts` / clase `GuionEditor`, sustantivos de dominio en español.
- Botones del `.btn` global / `.tb-btn` del chrome de editor; colores por tokens del tema, nunca cableados.
- `z-index` de popovers del editor: 180 (`.editor-pop`), nunca arriba de un modal.
- Línea en `CHANGELOG.md → [Unreleased] → Added`, en inglés, para quien usa la app.
- Funciones puras con smoke runner en `scripts/`; lo que toca DOM se valida con `pnpm build` y a mano.

## Review Focus

1. Archivo con `\r\n` (escrito en Windows): abre igual y se guarda con `\n`, sin `\r` sueltos. → test en Task 1.
2. Archivo sin `\n` final, o con dos líneas vacías al final: el round-trip no agrega ni saca líneas vacías del medio; el `\n` final lo pone `write_note`. → test en Task 1.
3. Sangría con tabs en vez de espacios: se conserva tal cual (no se convierte a espacios). → test en Task 1.
4. Comentario `<!-- -->` de varias líneas con una `[si: x]` o un `NOMBRE:` adentro: se pinta todo como comentario y no va a LT. → tests en Task 1 y Task 2.
5. Una marca de LT que cruza de un tramo al otro (dos renglones distintos): se descarta, no corre el subrayado a otra línea. → test en Task 2.

---

### Task 1: Líneas y resaltado (puro) + smoke runner

**Files:**
- Create: `src/app/guion/lineas.ts`
- Create: `src/app/guion/resaltar.ts`
- Create: `scripts/run-guion-smoke.mjs`
- Modify: `CLAUDE.md` (lista de smoke runners, una línea)

**Interfaces:**
- Produces:
  - `partirLineas(texto: string): string[]` — normaliza `\r\n` → `\n`, parte por `\n`, saca **un** `\n` final si lo hay (así `"a\nb\n"` → `['a','b']` y `"a\n\n"` → `['a','']`).
  - `unirLineas(lineas: string[]): string` — `join('\n')`, sin `\n` final (lo agrega `write_note`).
  - `type ClaseGuion = 'titulo' | 'lugar' | 'nombre' | 'gesto' | 'narracion' | 'instruccion' | 'opcion' | 'tirada' | 'resultado' | 'comentario' | 'texto'`
  - `interface Span { desde: number; hasta: number; clase: ClaseGuion }` — offsets dentro de la línea, `hasta` exclusivo.
  - `resaltar(linea: string, enComentario: boolean): { spans: Span[]; enComentario: boolean }` — la sangría inicial no lleva span; los tramos de prosa llevan `clase: 'texto'` explícita (Task 2 los usa). Reglas sobre la línea sin la sangría:
    - `# …` → `titulo` entero. `## …` → `lugar` entero.
    - `NOMBRE (gesto): resto` / `NOMBRE: resto` → `nombre` sobre el nombre, `gesto` sobre `(gesto)` incluidos los paréntesis, `texto` sobre `resto` sin el espacio inicial. Nombre = `^[A-ZÁÉÍÓÚÜÑ0-9_]+` seguido de ` (` o `:`. Solo el **primer** `:` separa.
    - `> resto` → `narracion` sobre el `>` y `texto` sobre `resto`.
    - `[fondo: x]`, `[entra: X]`, `[sale: X]`, `[recordar: x]`, `[si: x]`, `[si no]` (línea entera, con blancos alrededor) → `instruccion` entero; en `[entra:`/`[sale:` además `nombre` sobre el nombre.
    - `- [Habilidad CD n] resto` → `opcion` sobre `-`, `tirada` sobre `[…]`, `texto` sobre `resto`.
    - `- éxito:` / `- falla:` (línea entera, también `exito` sin tilde) → `resultado` entero.
    - `- resto` → `opcion` sobre `-`, `texto` sobre `resto`.
    - `<!--` abre comentario: desde ahí hasta `-->` (en la misma línea o en otra) todo es `comentario`; `enComentario` de salida dice si quedó abierto. Adentro de un comentario no se reconoce nada más.
    - Cualquier otra línea → `texto` entero (continuación del que habla). Línea vacía → sin spans.

- [ ] **Step 1: Escribir el smoke runner con las aserciones, que falla porque los módulos no existen**

`scripts/run-guion-smoke.mjs`, patrón de `scripts/run-raya-smoke.mjs` (compila con `tsc` a un tmpdir, `require` del JS). Compila `src/app/guion/lineas.ts` y `src/app/guion/resaltar.ts`. Fixture inline (no leer `~/Repos/rpg-copado`): las líneas 1–60 de `game/historia/prologo/01-llegada.md` copiadas como template string. Aserciones mínimas:

```js
// lineas
eq(partirLineas('a\r\nb\r\n'), ['a', 'b']);                 // Review Focus 1
eq(partirLineas('a\nb'), ['a', 'b']);                        // sin \n final
eq(partirLineas('a\n\n\n'), ['a', '', '']);                  // Review Focus 2: saca UNA sola
eq(unirLineas(['a', '', 'b']), 'a\n\nb');
eq(unirLineas(partirLineas('\t- éxito:\n  > x')), '\t- éxito:\n  > x'); // Review Focus 3
eq(unirLineas(partirLineas(FIXTURE)), FIXTURE.replace(/\n$/, ''));      // round-trip canónico

// resaltar
eq(clases('HERMANO (sonriendo): Al fin.'), ['nombre', 'gesto', 'texto']);
eq(texto('HERMANO (sonriendo): Al fin.', 'nombre'), 'HERMANO');
eq(texto('HERMANO (sonriendo): Al fin.', 'texto'), 'Al fin.');
eq(clases('MARINERO: ¡Tierra a la vista!'), ['nombre', 'texto']);
eq(clases('COMPANERA1: hola'), ['nombre', 'texto']);
eq(clases('NIÑA: hola'), ['nombre', 'texto']);
eq(texto('VIAJERO: Dijo: que sí', 'texto'), 'Dijo: que sí');            // solo el primer ':'
eq(clases('Hola: chau'), ['texto']);                                     // minúscula no es nombre
eq(clases('> El sol pega sobre el agua.'), ['narracion', 'texto']);
eq(clases('## Prólogo · En el barco'), ['lugar']);
eq(clases('# Prólogo: la llegada'), ['titulo']);
eq(clases('[fondo: barco]'), ['instruccion']);
eq(clases('[entra: VIAJERO]'), ['instruccion', 'nombre']);
eq(clases('[si no]'), ['instruccion']);
eq(clases('  [recordar: le_creiste_al_viajero]'), ['instruccion']);      // con sangría
eq(clases('- Preguntarle qué pasó.'), ['opcion', 'texto']);
eq(clases('- [Perspicacia CD 12] Mirarlo bien: ¿está asustado?'), ['opcion', 'tirada', 'texto']);
eq(clases('  - éxito:'), ['resultado']);
eq(clases('  - falla:'), ['resultado']);
eq(clases('No se puede vivir en un lugar como este.'), ['texto']);
eq(clases(''), []);
// comentarios (Review Focus 4)
eq(resaltar('<!-- Ejemplo -->', false).enComentario, false);
eq(clases('<!-- Ejemplo -->'), ['comentario']);
const abierto = resaltar('<!--', false);
eq(abierto.enComentario, true);
eq(clases('[si: algo]', true), ['comentario']);
eq(clases('HERMANO: x', true), ['comentario']);
const cierre = resaltar('fin -->', true);
eq(cierre.enComentario, false); eq(cierre.spans.map(s => s.clase), ['comentario']);
// la fixture entera corre sin tirar y el estado de comentario vuelve a false
```

`clases(linea, enComentario=false)` = `resaltar(...).spans.map(s => s.clase)`; `texto(linea, clase)` = slice del primer span con esa clase.

- [ ] **Step 2: Correrlo y ver que falla**

Run: `node scripts/run-guion-smoke.mjs`
Expected: falla en `tsc` (archivos inexistentes).

- [ ] **Step 3: Implementar `lineas.ts` y `resaltar.ts`**

Sin imports de Angular ni DOM. En `resaltar`, un solo lugar decide la sangría (`/^[ \t]*/`) y las regex corren sobre el resto, sumando el offset al armar los spans.

- [ ] **Step 4: Correr el smoke y ver que pasa**

Run: `node scripts/run-guion-smoke.mjs`
Expected: `ok` y exit 0.

- [ ] **Step 5: Sumar la línea del runner a CLAUDE.md (bloque de comandos) y commitear**

```bash
git add src/app/guion/lineas.ts src/app/guion/resaltar.ts scripts/run-guion-smoke.mjs CLAUDE.md
git commit -m "feat(guion): líneas y resaltado del formato de escenas (puro)"
```

---

### Task 2: Texto para corregir (puro)

**Files:**
- Create: `src/app/guion/texto-para-corregir.ts`
- Modify: `scripts/run-guion-smoke.mjs`

**Interfaces:**
- Consumes: `resaltar` de Task 1.
- Produces:
  - `interface Tramo { linea: number; desde: number; hasta: number; plainStart: number; plainEnd: number }` — `desde`/`hasta` dentro de la línea, `plainStart`/`plainEnd` dentro de `plain`.
  - `textoParaCorregir(lineas: string[]): { plain: string; tramos: Tramo[] }` — un tramo por cada span `texto` de `resaltar` recorriendo las líneas con el estado de comentario; `plain` = tramos unidos con `'\n\n'`. Los nombres, gestos, instrucciones, títulos, tiradas, resultados y comentarios nunca entran.

- [ ] **Step 1: Sumar aserciones al smoke runner**

```js
const r = textoParaCorregir(['HERMANO (serio): ¿Qué pasa?', '[fondo: x]', '> Narra.', '<!--', 'HERMANO: adentro', '-->', '- [Perspicacia CD 12] Mirarlo bien.']);
eq(r.plain, '¿Qué pasa?\n\nNarra.\n\nMirarlo bien.');                   // Review Focus 4
eq(r.tramos.map(t => t.linea), [0, 2, 6]);
eq(r.tramos[0], { linea: 0, desde: 17, hasta: 27, plainStart: 0, plainEnd: 10 });
eq(r.plain.slice(r.tramos[2].plainStart, r.tramos[2].plainEnd), 'Mirarlo bien.');
eq(textoParaCorregir(['', '[si no]']).plain, '');
// Review Focus 5: un match que cruza '\n\n' lo descarta mapMatchesToPm (tiene '\n'); acá se fija que
// entre dos tramos SIEMPRE hay '\n\n' y nunca un espacio.
eq(textoParaCorregir(['A: uno', 'dos']).plain, 'uno\n\ndos');
```

- [ ] **Step 2: Correr y ver que falla** — Run: `node scripts/run-guion-smoke.mjs`. Expected: falla en `tsc` (módulo inexistente).

- [ ] **Step 3: Implementar `textoParaCorregir`** en `src/app/guion/texto-para-corregir.ts`.

- [ ] **Step 4: Correr y ver que pasa** — Run: `node scripts/run-guion-smoke.mjs`. Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/app/guion/texto-para-corregir.ts scripts/run-guion-smoke.mjs
git commit -m "feat(guion): tramos de prosa que van a LanguageTool (puro)"
```

---

### Task 3: Marca `.twriter-guion` en Rust (árbol, comando, storage)

**Files:**
- Modify: `src-tauri/src/fs.rs` (`TreeNode`, `get_tree`, constantes, nuevo post-pass y comando, tests)
- Modify: `src-tauri/src/search.rs:863` (`ROOT_SKIP_FILES`)
- Modify: `src-tauri/src/storage.rs` (`detect_backend`, tests)
- Modify: `src-tauri/src/lib.rs:56,194` (registro del comando)

**Interfaces:**
- Produces:
  - `TreeNode.guion: Option<String>` con `#[serde(skip_serializing_if = "Option::is_none")]`: path de la carpeta marcada más cercana. Lo llevan la carpeta marcada (su propio path) y todo nodo `Note` debajo, a cualquier profundidad. Las carpetas intermedias no.
  - `pub const GUION_MARKER: &str = ".twriter-guion"`.
  - `fn marcar_guion(node: &mut TreeNode, heredado: Option<&str>)` — post-pass recursivo llamado en `get_tree` sobre el nodo raíz antes de devolverlo (la raíz también puede estar marcada).
  - `#[tauri::command] pub fn set_directory_guion(path: String, guion: bool) -> Result<(), String>` — gemelo de `set_directory_excluded` con `GUION_MARKER`.
  - `detect_backend`: si `path.join(GUION_MARKER).is_file()` devuelve `StorageBackend::Local` **antes** de mirar git.

- [ ] **Step 1: Escribir los tests, que fallan por compilación**

En `fs.rs` (módulo `tests`, tempdir a mano como `saga_config.rs:267`):

```rust
#[test]
fn marca_guion_baja_a_las_notas_y_no_a_las_carpetas_del_medio() {
    // root/.twriter-guion, root/a.md, root/sub/b.md, root/sub/c.txt
    let tree = get_tree(root.to_string_lossy().into_owned()).unwrap();
    assert_eq!(tree.guion.as_deref(), Some(root_str));
    let a = tree.children.iter().find(|n| n.name == "a").unwrap();
    assert_eq!(a.guion.as_deref(), Some(root_str));
    let sub = tree.children.iter().find(|n| n.name == "sub").unwrap();
    assert!(sub.guion.is_none());
    let b = sub.children.iter().find(|n| n.name == "b").unwrap();
    assert_eq!(b.guion.as_deref(), Some(root_str));
}

#[test]
fn sin_marca_no_hay_guion() { /* mismo árbol sin el marker: todos None */ }

#[test]
fn set_directory_guion_crea_y_borra_el_marker() {
    set_directory_guion(dir_str.clone(), true).unwrap();
    assert!(dir.join(GUION_MARKER).is_file());
    set_directory_guion(dir_str, false).unwrap();
    assert!(!dir.join(GUION_MARKER).exists());
}
```

En `storage.rs`:

```rust
#[test]
fn raiz_de_guion_es_local_aunque_sea_repo_git() {
    // tempdir con `git2::Repository::init` + archivo .twriter-guion
    assert_eq!(detect_backend(&dir), StorageBackend::Local);
}
```

- [ ] **Step 2: Correr y ver que falla** — Run: `cargo test --manifest-path src-tauri/Cargo.toml guion`. Expected: error de compilación (campo/función inexistentes).

- [ ] **Step 3: Implementar**

`TreeNode.guion` (y `guion: None` en cada constructor literal de `fs.rs`, que son varios; `cargo check` los lista). `marcar_guion` recorre: si el nodo es carpeta y tiene el marker → `heredado = Some(path)` y `node.guion = Some(path)`; si es `Note` y hay heredado → `node.guion = heredado`; recursa en `children`. Sumar `GUION_MARKER` a `ROOT_SKIP_FILES` de `fs.rs` y `search.rs`. Registrar `set_directory_guion` en `lib.rs` al lado de `set_directory_excluded`.

- [ ] **Step 4: Correr y ver que pasa** — Run: `cargo test --manifest-path src-tauri/Cargo.toml`. Expected: todo verde.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fs.rs src-tauri/src/search.rs src-tauri/src/storage.rs src-tauri/src/lib.rs
git commit -m "feat(guion): marca .twriter-guion en el árbol y raíz sin git"
```

---

### Task 4: Plomería TS: abrir como guion, menús, badge, diccionario de carpeta

**Files:**
- Modify: `src/app/core/types.ts:3-13` (`guion?: string` en `TreeNode`)
- Modify: `src/app/core/note-service.ts:12-15` (`NoteTarget.guion?: string`)
- Modify: `src/app/tree/tree.ts:837-863` (`select`, `openNoteInEditor`)
- Modify: `src/app/tree/tree.html:296-326` (badge «guion» en la carpeta marcada)
- Modify: `src/app/search-panel/search-panel.ts:461-498`
- Modify: `src/app/app.ts:359-381` (`restoreLastSession`)
- Modify: `src/app/shared/node-actions-service.ts` (`buildNodeMenu` note/folder, `buildEmptyMenu`, `openDictionary`, nuevos `marcarGuion`/`quitarGuion`)
- Modify: `src/app/core/dictionary-service.ts:46-48` (`openFor` acepta carpeta de guion)
**Interfaces:**
- Consumes: `TreeNode.guion` (Task 3).
- Produces:
  - `NoteTarget { path; name; guion?: string }` — `guion` = carpeta marcada. Todo caller que abre una nota desde un `TreeNode` pasa `guion: node.guion`.
  - En `NodeActionsService`: `marcarGuion(path: string): Promise<void>` y `quitarGuion(path: string): Promise<void>` → `invoke('set_directory_guion', { path, guion })`, luego `project.loadTree()`; si `path === settings.root()` además `storage.refresh()` (para que el backend pase a `Local` o vuelva a `Git`).
  - `DictionaryService.openFor(node)` acepta `node.kind === 'saga' || node.guion === node.path`; si `get_saga_config` falla y es guion, `idioma.set(idiomaFlexionDe('es'))`.

- [ ] **Step 1: `types.ts` y `note-service.ts`**: agregar los campos. Sin lógica nueva en `NoteService`.

- [ ] **Step 2: Ruteo de apertura**

- `tree.ts select()`: si `node.kind === 'note' && node.guion` → `nav.setBrowsing(parent)`, `note.open({ path, name, guion: node.guion })` y `return` (sin reader, sin distinguir Shift). `openNoteInEditor` pasa `guion: node.guion`.
- `search-panel.ts`: en los dos handlers de `hit.kind === 'note'`, resolver `const node = findNodeByPath(this.project.tree(), hit.path)` (`core/tree-utils.ts`); si `node?.guion` → `openNoteInEditor(path, name, node.guion)` siempre (click, Shift+click y doble click). `openNoteInEditor` recibe `guion?: string` y lo pasa a `note.open`.
- `app.ts restoreLastSession()`: `note.openInPane({ path, name, guion: node.guion }, 0)`.

- [ ] **Step 3: Menús**

En `node-actions-service.ts`:
- `buildNodeMenu` nota con `node.guion`: `[Abrir → openNote(node) (que ya pasa guion), Renombrar…, separador, Borrar nota]` — sin «Editar nota» ni reader.
- `buildNodeMenu` folder: después de «Renombrar…», separador y `node.guion === node.path ? { label: 'Quitar marca de guion', onClick: quitarGuion(node.path) } : { label: 'Marcar como guion', kbd: '.twriter-guion', onClick: marcarGuion(node.path) }`. Si está marcada, además `{ label: 'Editar diccionario…', icon: LucideBookOpen, onClick: openDictionary(node) }`.
- `buildEmptyMenu`: mismas dos entradas para la raíz, leyendo `project.tree()?.guion === root`; con la raíz marcada, «Editar diccionario…» abre `dictSvc.openFor(project.tree()!)`.
- `openNote(node)` pasa `guion: node.guion`.

- [ ] **Step 4: Badge en el árbol**

`tree.html`, en la fila de carpeta (bloque de `node.excluded`): `@if (node.guion === node.path) { <span class="excluded-badge" title="Carpeta de guion">guion</span> }` reusando la clase del badge existente (mismo estilo; si hace falta color propio, una regla `.guion-badge` en `tree.scss` con tokens).

- [ ] **Step 5: `pnpm build` y prueba manual**

Run: `pnpm build`. Expected: sin errores.
Manual (`pnpm tauri dev`, raíz `~/Repos/novelas-pruebas` o un tmp con `.md`): click derecho en carpeta libre → «Marcar como guion» crea el archivo y aparece el badge; «Quitar marca de guion» lo saca. Con la raíz marcada, el header de git desaparece (backend `Local`); al quitar la marca vuelve.

- [ ] **Step 6: Commit**

```bash
git add src/app/core/types.ts src/app/core/note-service.ts src/app/tree src/app/search-panel/search-panel.ts src/app/app.ts src/app/shared/node-actions-service.ts src/app/core/dictionary-service.ts
git commit -m "feat(guion): marcar carpeta como guion y abrir sus .md en el editor de guion"
```

---

### Task 5: Componente `GuionEditor` (texto plano + resaltado)

**Files:**
- Create: `src/app/guion/guion-editor.ts`, `guion-editor.html`, `guion-editor.scss`
- Create: `src/app/guion/guion-extensiones.ts` (nodo `linea`, teclas, plugin de resaltado)
- Modify: `src/app/app.html:261-273` y `src/app/app.ts:93-94` (imports)

**Interfaces:**
- Consumes: `partirLineas`/`unirLineas`/`resaltar` (Task 1), `NoteService.panes`/`updateContentInPane` (como `NotesEditor`), `buildEditorProps`, `vistaMenu`, `resolveEditorFontStack`, `PARAGRAPH_SPACING_EM`, `SettingsService` (`editorWidth`, `editorFontSize`, `editorFontFamily`, `bumpFontSize`, `setLastSession`), `ContextMenuService`, `CursorRestoreService`.
- Produces:
  - Selector `app-guion-editor`, input `paneId: PaneId`.
  - `guion-extensiones.ts`:
    - `Linea = Node.create({ name: 'linea', group: 'block', content: 'text*', parseHTML: [{ tag: 'div.linea' }], renderHTML: () => ['div', { class: 'linea' }, 0] })`.
    - `GuionTeclas = Extension.create({ addKeyboardShortcuts })`: `Tab` inserta `'  '`; `Shift-Tab` borra hasta dos espacios al inicio de la línea del cursor; `Enter` = `splitBlock` y después inserta en la línea nueva la sangría (`/^[ \t]*/`) de la línea de arriba. Devuelven `true` para que el browser no haga lo suyo con Tab.
    - `Resaltado = Extension.create({ addProseMirrorPlugins })`: un `Plugin` con `DecorationSet` recalculado en `apply` solo si `tr.docChanged`; recorre `doc.children` (cada `linea`) con `resaltar(linea.textContent, enComentario)` arrastrando el estado y arma `Decoration.inline(pos + 1 + desde, pos + 1 + hasta, { class: 'g-' + clase })`.
    - `docDesdeLineas(lineas: string[]): JSONContent` — `{ type: 'doc', content: lineas.map(l => l ? { type: 'linea', content: [{ type: 'text', text: l }] } : { type: 'linea' }) }`.
    - `lineasDesdeDoc(doc: PmNode): string[]` — `textContent` de cada hijo.
  - Editor: `new Editor({ extensions: [StarterKit.configure({ paragraph: false, heading: false, bold: false, italic: false, strike: false, code: false, codeBlock: false, blockquote: false, bulletList: false, orderedList: false, listItem: false, horizontalRule: false, hardBreak: false, link: false, underline: false, dropcursor: false, gapcursor: false, trailingNode: false, listKeymap: false }), Linea, GuionTeclas, Resaltado, Grammar], … })`. Quedan `document`, `text`, `undoRedo`. Sin `Typography`. Si el nombre de alguna opción de StarterKit 3.31 difiere, `pnpm build` lo dice: ajustar al nombre real, no agregar la extensión.

- [ ] **Step 1: Stub del componente y ruteo en `app.html`**

`guion-editor.ts` con el `@Component` y el host vacío; en `app.html`, en los dos panes: `@if (note.panes[N].active(); as t) { @if (t.guion) { <app-guion-editor [paneId]="N" /> } @else { <app-notes-editor [paneId]="N" /> } }`. Importar en `app.ts`. `pnpm build` verde.

- [ ] **Step 2: Carga, edición y guardado**

Mismo esqueleto que `NotesEditor` (`notes-editor.ts:86-160, 335-375`): `pane = computed(() => note.panes[paneId()])`, effect sobre `loadedAt` que crea el editor o hace `setContent(docDesdeLineas(partirLineas(content)))` con `emitUpdate: false`; `onUpdate` → `note.updateContentInPane(unirLineas(lineasDesdeDoc(doc)), paneId())`; `onSelectionUpdate` → `settings.setLastSession(path, from)` solo en pane 0; `cursorRestore` igual que notas; `autofocus` igual que notas; effect de `fontSize` → `setOptions({ editorProps: buildEditorProps(view.dom, px) })`; `ngOnDestroy` destruye el editor. Al cambiar de archivo, `withFreshHistory` (`editor/fresh-history.ts`) como hace el editor de capítulos, para que Ctrl+Z no cruce.

- [ ] **Step 3: Template y estilos**

`guion-editor.html`: toolbar (`.toolbar` del chrome compartido `shared/editor-chrome.scss`, como notas): botón **Vista** (`openViewMenu`), `A−`/`A+` (`fontBump`), y a la derecha el estado de gramática (Task 6). Host `#host` con `(contextmenu)` y `(click)`. Footer `.status-bar` como notas con badge **Guion**, nombre del archivo y `sin guardar`.

`guion-editor.scss`: importar lo mismo que `notes-editor.scss` para toolbar/footer; `.ProseMirror { white-space: pre-wrap; font-family: var(--editor-font); font-size …; max-width según editorWidth }` igual que notas; `.linea { min-height: 1lh }` (línea vacía con altura). Clases de resaltado, todas por tokens: `.g-nombre { font-weight: 700 }`, `.g-gesto { color: var(--muted) }`, `.g-narracion { font-style: italic }` (el `>`) — la prosa de narración: el span `texto` que sigue a `narracion` también va en itálica (el plugin agrega clase `g-texto--narracion` a ese tramo), `.g-instruccion { color: var(--accent) }`, `.g-tirada { color: var(--accent); font-weight: 600 }`, `.g-opcion { color: var(--accent) }`, `.g-resultado { color: var(--accent); font-weight: 600 }`, `.g-lugar { font-weight: 700 }`, `.g-titulo, .g-comentario { color: var(--muted); opacity: .7 }`. Verificar en tema claro y oscuro.

- [ ] **Step 4: Menú contextual**

Deshacer/Rehacer/Cortar/Copiar/Pegar/Seleccionar todo, copiando `buildEditorItems` de notas sin negrita/itálica. Pegar inserta texto plano: partir lo pegado por `\n` y meter una `linea` por renglón (`insertContent` con `docDesdeLineas(...).content`). También `transformPastedText`/`handlePaste` del editorProps para que Ctrl+V haga lo mismo (si no, un pegado multi-línea cae en una sola `linea`).

- [ ] **Step 5: `pnpm build` + prueba manual**

Run: `pnpm build`. Manual con `pnpm tauri dev`, raíz `~/Repos/rpg-copado/game/historia` marcada:
1. Abrir `prologo/01-llegada.md`: se ve el resaltado; las sangrías se ven.
2. Tocar una letra, esperar 2 s, `git -C ~/Repos/rpg-copado diff` muestra **solo** esa letra.
3. Enter en una línea con sangría arranca la nueva con la misma sangría; Tab mete dos espacios; Shift+Tab los saca.
4. Pegar tres renglones desde Kate crea tres líneas.
5. Cambiar de archivo y Ctrl+Z: no vuelve el texto del anterior.
6. Cerrar y reabrir la app: vuelve al mismo archivo y posición.

- [ ] **Step 6: Commit**

```bash
git add src/app/guion src/app/app.html src/app/app.ts
git commit -m "feat(guion): editor de texto plano con resaltado del formato de escenas"
```

---

### Task 6: Corrector, diccionario y tesauro en el guion

**Files:**
- Modify: `src/app/core/saga-context-service.ts:69-100` (fuente alternativa: carpeta de guion)
- Modify: `src/app/guion/guion-editor.ts`, `guion-editor.html`, `guion-editor.scss`

**Interfaces:**
- Consumes: `textoParaCorregir` (Task 2), `GrammarService` (`check`, `available`, `autoEnabled`, `canAutoCheck`, `checking`, `lastError`, `ping`, `pedirConfig`), `mapMatchesToPm`, `setGrammarMatches`, `GrammarMatchPos`, `TextRange` (`editor/grammar-extension.ts`), `GrammarPopover` (`editor/grammar-popover.ts`, inputs `match`/`anchor`/`dictSuggestions`, outputs `apply`/`dismiss`/`addToDict`/`disableRule`), `RepeticionesPopover` (`editor/repeticiones-popover.ts`, con `repeticion = null`, `palabra`, `anchor`, `resultado`, outputs `reemplazar`/`dismiss`), `TesauroService.lookup(palabra, 'es')`, `palabraEn` (`editor/palabra-en.ts`), `AnchorBox` (`editor/popover-position.ts`), `SagaContextService` (`isInDictionary`, `addToDictionary`, `dictionaryWords`), `suggestFromDictionary` (`dictionary/suggest.ts`).
- Produces:
  - `SagaContextService.guionDir = signal<string | null>(null)`. El effect del constructor: si `chapter.active()` es null y `guionDir()` no → `sagaPath.set(dir)` y `reload(dir)` (`get_saga_config` falla → `config = null`, el diccionario carga de `dir/diccionario.txt`). `GuionEditor` lo setea con `target.guion` al cargar (solo pane 0) y lo pone en `null` en `ngOnDestroy`.

- [ ] **Step 1: `SagaContextService.guionDir`** como arriba. `pnpm build` verde.

- [ ] **Step 2: Chequeo automático en `GuionEditor`**

- `onUpdate` además programa `scheduleGrammarRecheck()` (debounce 2000 ms, como `editor.ts:1737`), solo si `grammar.autoEnabled() && grammar.canAutoCheck()`.
- `checkGrammar(force = false)`: `lineas = lineasDesdeDoc(doc)`; `{ plain, tramos } = textoParaCorregir(lineas)`; si `plain` vacío → limpiar marcas y volver; si `!force && plain === lastCheckedPlain` → volver; `ranges: TextRange[]` = un rango por tramo con `pmPos = posDeLinea(tramo.linea) + 1 + tramo.desde` (posiciones de cada `linea` recorriendo `doc.forEach`); `matches = await grammar.check(plain, 'es')`; descartar si el doc cambió durante el request (comparar identidad de `state.doc`); `positioned = mapMatchesToPm(matches, ranges, doc, plain)`; filtrar `category === 'TYPOS'` cuyo texto esté en `sagaCtx.isInDictionary`; `grammarMatches.set(...)`; `setGrammarMatches(view, filtered)`.
- Al abrir el archivo, si LT está disponible y el auto está prendido: un check inicial (como el editor de capítulos tras `setContent`).
- Toolbar: botón «Revisar gramática» (`tb-btn`) que llama `checkGrammar(true)`; indicador de `grammar.checking()` y, si `grammar.available()` es false, el mismo chip/aviso que usa el editor de capítulos para «LT no responde» con `pedirConfig()`. **No** se porta el recorrido paso a paso de «Revisar» (`reviewNav`/`skipReview`): queda fuera de la v1 y se anota en el handoff.

- [ ] **Step 3: Popover de gramática**

`(click)` del host (como `editor.ts:2200`): `target.closest('.grammar-error')` → `data-grammar-idx` → `grammarMatches()[idx]` → `grammarPopover.set({ match, anchor: coordsAtPos(from), from, to, dictSuggestions: suggestFromDictionary(palabra, sagaCtx.dictionaryWords(), 3) })`; click en otro lado cierra. En el template, `<app-grammar-popover>` con: `(apply)` → `insertContentAt({ from, to }, replacement)` + sacar la marca + recheck; `(dismiss)` → sacar la marca; `(addToDict)` → `sagaCtx.addToDictionary(palabra)` y sacar todas las marcas TYPOS de esa palabra (`editor.ts:1470-1490`); `(disableRule)` → `toast.info('Las reglas se desactivan por saga; en un guion no aplica')` y cerrar; `[canDeriveForms]="false"`; `[review]="null"`.

- [ ] **Step 4: Tesauro**

En el menú contextual: si el click cae sobre una palabra (`palabraEn(linea.textContent, parentOffset)`), entrada `Sinónimos de «x»` que abre `<app-repeticiones-popover>` con `repeticion = null`, `palabra`, `anchor = coordsAtPos(from)`, y `resultado` de `tesauro.lookup(palabra, 'es')`; `(reemplazar)` → `insertContentAt({ from, to }, nuevo)`; `(dismiss)` cierra. Atajo `Ctrl+Shift+Y` como el editor (`atajo('Y', true)`).

- [ ] **Step 5: `pnpm build` + prueba manual**

Run: `pnpm build`. Manual, con LT embebido corriendo y la raíz `game/historia` marcada:
1. Escribir `HERMANO: Esto es un herror.` → subrayado solo en `herror`; `HERMANO` limpio. Click → popover con `error` → se aplica.
2. Escribir un nombre inventado en la prosa → «+ diccionario» lo guarda en `game/historia/diccionario.txt` y la marca desaparece; cerrar y reabrir: sigue sin marcar.
3. Click derecho sobre `muelle` → «Sinónimos de «muelle»» → reemplazar funciona en la misma línea.
4. Click derecho sobre la carpeta marcada (o espacio vacío con raíz marcada) → «Editar diccionario…» muestra la palabra agregada.
5. Un `[si: x]` mal escrito como `[si x]` **no** se subraya (no es prosa).

- [ ] **Step 6: Commit**

```bash
git add src/app/core/saga-context-service.ts src/app/guion
git commit -m "feat(guion): corrector sobre lo hablado, diccionario de la carpeta y tesauro"
```

---

### Task 7: Changelog, README y TODO

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Modify: `README.md` (índice línea ~21 y una sección «Guion (escenas de juego)» después de «Notas (Markdown)»)
- Modify: `TODO.md:510-535` (la sección «Escenas de juego (rpg-copado)»)

- [ ] **Step 1: CHANGELOG**

Bajo `## [Unreleased]`, `### Added`:
`- Script mode: mark any folder as a script ("Marcar como guion") and its .md files open in a plain-text editor that highlights the game's scene format (character names, gestures, stage directions, choices and rolls), checks only the spoken text with LanguageTool, keeps its own dictionary in that folder, and saves the file exactly as written. A script folder used as the root turns off git auto-sync.`

- [ ] **Step 2: README**

Sección corta (10–15 líneas) para quien usa la app: cómo marcar, qué se resalta, dónde está el diccionario, que git queda apagado si la raíz es un guion, y la línea `.twriter/` en el `.gitignore` del repo del juego. Sumar la entrada al índice.

- [ ] **Step 3: TODO**

Reemplazar el ítem por: lo hecho vive en el README; dejar como pendientes los tres del spec («Abierto»): completado de personajes/gestos, validador del juego con remedio adentro de la app, raíces recientes, más el recorrido paso a paso de «Revisar» en el guion.

- [ ] **Step 4: Correr smoke runners y build por última vez**

Run: `node scripts/run-guion-smoke.mjs && node scripts/run-changelog-smoke.mjs && pnpm build && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: todo verde.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md TODO.md
git commit -m "docs(guion): changelog, README y TODO del editor de guion"
```
