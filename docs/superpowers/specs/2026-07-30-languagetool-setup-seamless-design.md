# Levantar LanguageTool sin saber de containers: botón que hace todo y comandos copiables

Fecha: 2026-07-30

## Problema

La app sabe diagnosticar por qué LanguageTool no está disponible y sabe cuál es el comando
que lo arregla — pero no se lo dice al usuario, o se lo dice de una forma que no puede usar.

Descubierto en vivo el 2026-07-30: el autor reinició la Mac (primera vez desde que la
compró), y en el próximo arranque de tWriter la gramática no funcionaba. Lo que la UI
mostraba era:

> Container detenido (no existe todavía).

**Las dos afirmaciones eran falsas.** El container `twriter-languagetool` existía; lo que se
había caído era el *apiserver* de Apple `container`, que nunca había estado registrado en
launchd (`container system status` → `apiserver is not running and not registered with
launchd`). Sin apiserver, `container ls` falla con `XPC connection error`, así que el backend
no podía ver ningún container y reportaba que no había ninguno.

### Por qué la UI miente

`languagetool_docker_status` (`src-tauri/src/grammar.rs:643-667`) colapsa el estado del
daemon dentro de los flags del container:

```rust
let (running, exists) = if e.daemon_ok() {
    (e.running(), e.exists())
} else {
    (false, false)          // ← "daemon caído" queda indistinguible de "no hay container"
};
```

`LtDockerStatus` no tiene ningún campo para "el daemon no responde", así que
`grammar-settings.html` cae en su rama `@else` genérica y dice "Container detenido (no existe
todavía)".

### Por qué la información existe y se tira

`daemon_down_message` (`grammar.rs:269-287`) produce exactamente el texto correcto —
*"Apple container está instalado pero el daemon no responde. Corré `container system
start`"* — pero **solo se devuelve desde el path de arranque** (`languagetool_docker_start`,
`grammar.rs:702-703`), no desde el de status, que es el que corre solo al abrir la ventana.
Y aun cuando aparece, el comando viene embebido en la prosa entre backticks: no hay forma de
copiarlo sin arrastrar la explicación.

Lo mismo con `no_runtime_message` (`grammar.rs:254-267`): tres comandos de `brew` dentro de
un string multilínea que la UI pinta como párrafo.

### La política que esto revela

El autor sabía resolverlo a mano. Igual perdió tiempo, porque la app lo mandó en la dirección
equivocada. La conclusión no es "documentarlo en el README": es que **cuando la app puede
detectar un problema de entorno, tiene que decir qué pasó y dar el remedio accionable adentro
de la app** — botón si lo puede correr ella, comando copiable si no. Esa política se anota
como convención en `CLAUDE.md`, porque aplica a features futuras y no solo a esta.

## Alcance

- `src-tauri/src/grammar.rs` — `Remedy`, `daemon_start_cmd`, `daemon_running`/`remedy` en el
  status, la fase de daemon en `languagetool_docker_start`, `InstallOption`.
- `src/app/core/grammar-service.ts` — los tipos nuevos.
- `src/app/grammar-settings/grammar-settings.html` + `.scss` — rama del daemon caído, lista
  de opciones de instalación, fase nueva del stepper.
- `src/app/shared/copy-command.ts` (+ template/estilos) — componente nuevo.
- `CLAUDE.md` — la convención.

Queda **fuera**:

- **Arrancar el daemon sin que el usuario lo pida.** Se evaluó y se descartó: levantar un
  servicio de la máquina como efecto secundario de abrir la app es sorpresivo, y en Linux
  hace falta sudo igual, así que no elimina el caso del comando copiable.
- **Detectar la distro de Linux para dar el comando de instalación exacto**
  (`apt`/`dnf`/`pacman`). Un comando que falla es peor que un link: en Linux y Windows la
  lista de instalación da URL sin comando.
- Bundlear LanguageTool como sidecar. Sigue siendo container del usuario, por decisión de
  `CLAUDE.md`.
- Los otros items del `TODO.md`.

## Decisiones de diseño

- **Un botón, no dos.** "Levantar LanguageTool" arranca el daemon si hace falta y sigue con
  el container. El usuario no tiene que aprender que son dos capas — que es exactamente el
  conocimiento que este spec busca no exigirle.
- **El comando se separa de la prosa.** Un campo `command` aparte del `message`, para que el
  botón de copiar copie el comando y nada más.
- **`can_run` decide botón o chip.** Si la app no puede ejecutar el remedio (sudo), no se
  muestra un botón: clickear algo que va a fallar es peor que no tenerlo.
- **La app sí abre Docker Desktop.** Es el runtime más común en Mac y Windows y no es un
  daemon que se arranque con un comando limpio. Se prueba `colima start` primero si colima
  está instalado (es un comando de verdad y más rápido), sino se lanza la app.
- **No se inventan comandos que puedan fallar.** macOS tiene `brew` como norma y los
  comandos ya están escritos en `no_runtime_message`; Linux y Windows reciben URL.
- **Los campos viejos de `LtDockerStatus` se conservan.** `docker_installed` ya tiene el
  nombre desactualizado (cubre los tres runtimes) y se dejó por compat con el front; sumar
  campos nuevos es menos riesgoso que renombrar.

## Diseño

### 1. `Remedy`: qué pasó, qué comando lo arregla, quién puede correrlo

```rust
#[derive(Serialize, Clone)]
pub struct Remedy {
    /// Qué pasó, en prosa, SIN el comando embebido.
    pub message: String,
    /// Comando exacto para copiar, o `None` cuando no hay uno (ej. "abrí Docker Desktop").
    pub command: Option<String>,
    /// La app puede ejecutarlo sola: sin sudo y sin depender de que el usuario haga algo
    /// primero. Decide si la UI muestra el botón primario o solo el chip copiable.
    pub can_run: bool,
}
```

`daemon_down_message(rt) -> String` pasa a `daemon_remedy(rt) -> Remedy`. La prosa pierde los
backticks (el comando ya viaja aparte).

### 2. `daemon_start_cmd`: cómo revivir cada runtime

```rust
impl Engine {
    /// Comando para revivir el daemon, o `None` si necesita intervención del usuario
    /// (sudo en Linux). El segundo bool indica si hay que esperar y pollear después de
    /// lanzarlo: abrir Docker Desktop devuelve al instante pero el daemon tarda ~30s.
    fn daemon_start_cmd(&self) -> Option<(Vec<String>, bool)>
}
```

| Runtime | macOS | Linux | Windows |
|---|---|---|---|
| Apple container | `container system start` | — | — |
| Podman | `podman machine start` | `podman machine start` | `podman machine start` |
| Docker | `colima start` si colima está instalado, sino `open -a Docker` (poll) | `None` → chip `sudo systemctl start docker`, `can_run: false` | lanzar `Docker Desktop.exe` (poll) |

Cuando el flag de poll está en true, se espera a `daemon_ok()` con timeout de 60s emitiendo
progreso, en vez de asumir que quedó arriba. Sin ese poll, el arranque seguiría al paso
siguiente contra un daemon que todavía no acepta conexiones y fallaría con un error que no
tiene nada que ver.

### 3. El status deja de mentir

```rust
pub struct LtDockerStatus {
    pub docker_installed: bool,
    pub runtime: Option<String>,
    /// ¿Responde el daemon del runtime detectado? Cuando es `false`,
    /// `container_running` y `container_exists` NO significan nada: el CLI no puede
    /// listar containers sin daemon.
    pub daemon_running: bool,
    pub container_running: bool,
    pub container_exists: bool,
    pub api_responding: bool,
    /// Remedio accionable cuando falta el runtime o el daemon no responde.
    pub remedy: Option<Remedy>,
}
```

### 4. Un botón que hace las dos capas

`languagetool_docker_start` deja de cortar con `Err` cuando el daemon está caído: si
`daemon_start_cmd()` devuelve algo, lo corre, espera, y sigue con el container. Solo devuelve
`Err(remedy)` cuando no hay nada que pueda correr. El stepper de la UI gana una fase al
frente:

```
① Arrancando el runtime → ② Chequeando runtime → ③ Bajando imagen → ④ Creando container → ⑤ Cargando modelos
```

### 5. `shared/copy-command.ts`

Componente standalone: un `<code>` con el comando y un botón que hace
`navigator.clipboard.writeText` (ya usado en `context-menu-service.ts:67`) y muestra
"copiado ✓" por 2s.

```ts
readonly command = input.required<string>();
```

Lo consumen la rama del daemon caído y la lista de instalación.

### 6. La UI

- Rama nueva `@if (!ds.daemon_running)` **antes** del `@else` genérico: muestra
  `remedy.message`, el `<app-copy-command>` cuando hay `command`, y el botón primario de
  siempre solo cuando `remedy.can_run`.
- La rama `@if (!ds.docker_installed)` deja de ser un párrafo de prosa con links y pasa a
  renderizar la lista de opciones:

  ```rust
  pub struct InstallOption {
      pub label: String,           // "Apple container"
      pub command: Option<String>, // "brew install container" | None en Linux/Windows
      pub url: String,
  }
  ```

  macOS: los tres `brew` que ya están en `no_runtime_message`. Linux y Windows: label + URL,
  sin comando.

## Testing

`daemon_remedy`, `daemon_start_cmd` y la lista de `InstallOption` son funciones puras de
`(Runtime, OS)`: van a los tests de `grammar.rs`, que ya tiene
`daemon_down_message_is_os_and_runtime_aware` para extender. Casos: cada runtime devuelve el
comando de su plataforma; Apple nunca sugiere `systemctl`; Docker en Linux devuelve
`can_run: false` con el comando de sudo; ningún `Remedy` tiene `command: Some("")`; las
opciones de instalación traen comando en macOS y no en Linux.

El polling, el componente de copiar y las ramas de la UI se verifican a mano — el repo no
tiene harness de DOM (no hay target `test` en `angular.json`; el harness real son los
`scripts/run-*-smoke.mjs` sobre funciones puras y los tests de Rust).

## Verificación manual (la hace el autor)

Se puede simular cada estado sin romper nada:

1. `container system stop` → abrir la ventana de gramática: tiene que decir que el daemon no
   responde (no "container no existe"), con el comando `container system start` copiable y el
   botón primario disponible.
2. Clickear el botón: arranca el daemon, sigue con el container, LT queda respondiendo. El
   stepper muestra la fase ① nueva.
3. Copiar el comando con el botón y pegarlo en una terminal: tiene que ser el comando pelado,
   sin backticks ni prosa alrededor.
4. `container stop twriter-languagetool` con el daemon arriba → la UI vuelve a decir
   "container detenido (existe pero apagado)", que ahora sí es verdad.
5. Renombrar temporalmente el binario de `container` (o probar en una máquina sin runtime) →
   la lista de instalación con los tres `brew` copiables.
6. Con Docker Desktop instalado y apagado (si hay una máquina a mano): el botón lo abre y
   espera, sin fallar antes de que el daemon acepte conexiones.
