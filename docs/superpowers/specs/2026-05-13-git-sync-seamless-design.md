# Git sync seamless entre PCs — diseño

Fecha: 2026-05-13
Estado: aprobado para implementación

## Contexto

tWriter está pensada para usuarios que escriben novelas, no para programadores.
Hoy el sync git deja al usuario expuesto a fallas que solo se resuelven con
terminal:

1. **Push sin pull falla silencioso si el remoto avanzó desde otra PC**
   (`README.md::TODO`). El auto-push hace `git push` directo; si la otra PC
   pusheó antes, sale `! [rejected] main -> main (fetch first)`, se loggea
   en el panel 🐛 y nada más. El usuario tiene que abrir terminal y tirar
   `git pull --rebase && git push` a mano.

2. **`.twriter/` versionado**: el índice tantivy vive en
   `<root>/.twriter/search-index/` y se regenera al boot en cada PC. Cada
   máquina lo escribe distinto → al pullear desde la otra PC hay `CONFLICT
   (add/add) in .twriter/search-index/.managed.json` garantizado.

3. **No hay auto-pull**: el polling de status detecta `behind > 0` pero solo
   muestra el badge — usuario debe apretar ⤓. Two-way sync no es seamless.

Objetivo: el usuario no tiene que aprender git para que sus capítulos se
sincronicen entre PCs. Cualquier path manual (botones ⇅/⤓, edición de
`.gitignore`, `git rm --cached`) queda solo como escape hatch.

## Solución

Tres cambios coordinados:

### 1. Push auto-rebase + retry

`src-tauri/src/git.rs::git_push_impl` cambia así:

1. Corre `git push`. Si exit = 0 → ok, salir.
2. Si stderr matchea `non-fast-forward | fetch first | rejected.*non-fast-forward`
   (clasificación `push.rejected`):
   1. Corre `git pull --rebase --autostash`.
   2. Si rebase ok → reintenta `git push` una vez.
   3. Si rebase falla → corre `git rebase --abort` para dejar el repo limpio
      y retorna error categorizado `"conflict: <archivos en conflicto>"`.
3. Cualquier otro stderr → categoriza:
   - `auth: <stderr>` si matchea `Permission denied|publickey|authentication|fatal: could not read`
   - `network: <stderr>` si matchea `Could not resolve|Connection refused|Operation timed out|unable to access`
   - `unknown: <stderr>` para el resto

`--autostash` cubre el caso defensivo: si hubiera cambios sin commitear entre
`git_commit_all` y `git_push`, los esconde y los recupera. No debería pasar
en flujo normal porque `syncNow` corre commit antes de push, pero protege
contra race con saves del editor.

Tracing targets: `git` con eventos `push.rejected`, `push.pull_rebase_ok`,
`push.retry_ok`, `push.rebase_conflict`, `push.failed`.

### 2. Auto-pull cuando `behind > 0`

`src/app/core/git-service.ts::refreshStatus` extendido:

Después de set status, si `s.behind > 0 && !this.syncing()`, dispara
`autoPull()` interno (no setea `currentOp = 'pull'` para no bloquear UI):

1. Si `s.ahead == 0` (solo behind) → `git_pull` con `--ff-only`. Backend ya
   lo hace en `git_pull_impl` actual. Ok → re-refresh.
2. Si `s.ahead > 0 && s.behind > 0` (divergente) → nuevo comando
   `git_pull_rebase` que corre `git pull --rebase --autostash`. Si exit ≠ 0
   con stderr matcheando conflict → aborta rebase + retorna `conflict:` error.
3. Cualquier error que no sea categoría `conflict` → silencioso, vuelve a
   intentar en el próximo refresh (30s).
4. Si error es `conflict` → setea `this.error` con mensaje friendly. Status
   polling sigue corriendo pero auto-pull se pausa hasta que el usuario
   apriete pull manual una vez (resetea el flag).

Throttle: contador local de fallas consecutivas (`autoFailCount`). Si llega
a 3, pausa auto-loop por 5 min. Manual sigue siempre disponible.

### 3. `.twriter/` auto-fix on boot

Nuevo comando Tauri `git_ensure_twriter_ignored(repo_path) -> EnsureResult`
en `src-tauri/src/git.rs`. Idempotente:

```rust
struct EnsureResult {
    gitignore_updated: bool,
    untracked_files: u32,
}
```

Pasos:

1. **Gitignore**: lee `<root>/.gitignore`. Si no contiene una línea que matchee
   `^\.twriter/?$` (con o sin slash final), append:

   ```
   # tWriter: índice de búsqueda local (se regenera al boot)
   .twriter/
   ```

   Si el archivo no existe, lo crea con ese contenido.

2. **Untrack**: corre `git ls-files .twriter` (subprocess, no libgit2 para
   evitar issues de path escaping). Si output ≠ vacío → corre
   `git rm -r --cached .twriter` (preserva el directorio en disco, solo lo
   saca del index).

3. Si `gitignore_updated || untracked_files > 0`, el effect del frontend
   loggea con tracing target `git`, action `twriter_cleanup`. Los cambios
   quedan uncommitted — el próximo auto-commit (5 min) los pickea con
   mensaje `auto: ...`.

Frontend (`git-service.ts`) invoca `git_ensure_twriter_ignored` una vez por
sesión por root, dentro del mismo effect que arranca los timers (después de
detectar backend = git, antes del primer `refreshStatus`).

## Mensajes friendly al usuario

`git-service.ts` mapea categorías de error a strings en español sin jargon:

| Categoría backend | Mensaje en UI |
|---|---|
| `auth:` | "No se pudo autenticar contra el remoto. Revisá la clave SSH o el token." |
| `network:` | "Sin conexión al remoto. Reintentamos en 30 s." |
| `conflict:` | "Conflicto entre esta PC y el remoto en `<archivo>`. Abrí el panel 🐛 para detalle." |
| `unknown:` | "Falló el sync. Mirá el panel 🐛 para más info." |

Badge del header muestra el mensaje en hover. Panel 🐛 conserva el stderr
exacto vía el bridge tracing → debug-service.

## Archivos tocados

- `src-tauri/src/git.rs`: modificación `git_push_impl`, nueva
  `git_pull_rebase_impl` + comando, nueva `git_ensure_twriter_ignored_impl`
  + comando, categorización de errores.
- `src-tauri/src/lib.rs`: registrar los dos comandos nuevos.
- `src/app/core/git-service.ts`: invocar `git_ensure_twriter_ignored` al
  cambiar root + backend=git, agregar `autoPull` en `refreshStatus`, mapeo
  de mensajes friendly, throttle de errores.
- `README.md` + `CLAUDE.md`: mover items del TODO a sección Hecho.

## Tests

`src-tauri/src/git.rs` (sección `#[cfg(test)]`):

- `push_auto_rebases_on_non_ff`: dos repos locales (bare origin + 2 clones).
  Clone A commit + push. Clone B commit (sin pull) → push debe pull-rebase
  + retry y quedar ok.
- `push_returns_conflict_on_rebase_conflict`: ambos clones tocan la misma
  línea del mismo archivo → push retorna `conflict:` con el archivo.
- `ensure_twriter_ignored_appends_when_missing`: gitignore sin la línea →
  append + flag true.
- `ensure_twriter_ignored_idempotent_when_present`: gitignore ya tiene la
  línea → no escribe + flag false.
- `ensure_twriter_ignored_untracks_when_tracked`: repo con `.twriter/`
  commiteado → `git ls-files` post = vacío, flag `untracked_files > 0`.

## Out of scope

- Resolución asistida de conflicts en UI (el conflict tira al panel 🐛 y
  pide intervención manual). Futuro: modal "Conflicto en cap N, abrí ambas
  versiones para mergear".
- Auth setup wizard (clave SSH / token). Hoy se sigue confiando en que el
  usuario ya tiene SSH configurado.
- Pull manual via shell desde un botón "Abrir terminal" (ya en TODO de
  Archivos).
- Auto-commit más agresivo (sigue cada 5 min).

## Riesgos

- `git pull --rebase --autostash` con muchos commits locales puede tardar.
  Lo corremos en `spawn_blocking`, no bloquea UI. Si dura > 10s, el badge
  muestra `syncing` visible para que el usuario sepa.
- `git rm -r --cached .twriter` en un repo donde el usuario manualmente
  trackeó algo dentro de `.twriter/` lo destrackea. Aceptable: nadie
  debería commitear ese directorio.
- Regex de categorización de stderr es frágil ante locale del CLI git. CI y
  máquinas del usuario corren git en es-AR/en-US. Probamos los dos.
