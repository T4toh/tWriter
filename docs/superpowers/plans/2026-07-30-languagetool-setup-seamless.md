# Levantar LanguageTool sin saber de containers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la ventana de gramática diga la verdad cuando el daemon del runtime está caído, y que el remedio venga adentro de la app: un botón que arranca daemon + container en un click, y el comando exacto en un chip copiable cuando la app no lo puede correr sola.

**Architecture:** Todo el diagnóstico nace de **una** función pura `daemon_plan(Runtime, Os, colima_present) -> DaemonPlan` que devuelve juntos el `Remedy` que ve el usuario y el `argv` que corre la app — así el texto y el comando no pueden divergir. `LtDockerStatus` gana `daemon_running`, `remedy` e `install_options`, y deja de colapsar el estado del daemon dentro de los flags del container. `languagetool_docker_start` gana una fase que arranca el daemon (con polling cuando el arranque es asincrónico, tipo Docker Desktop) antes de seguir con el container. En el front, un componente `app-copy-command` nuevo se usa en la rama del daemon caído y en la lista de instalación.

**Tech Stack:** Rust (Tauri 2, serde, tokio), Angular 21 (signals, standalone, `@if`/`@for`), TypeScript 5.9 strict, SCSS.

**Spec:** `docs/superpowers/specs/2026-07-30-languagetool-setup-seamless-design.md`

**Branch:** `feat/languagetool-setup-seamless` (ya creada y rebasada sobre `main` en `182e1ef`; contiene el commit del spec `967d3d8`).

## Global Constraints

- **Cero dependencias nuevas**, ni npm ni crates. Todo se hace con `std::process::Command`, `tokio`, `serde` y `navigator.clipboard`, que ya están.
- **`Os` se pasa como parámetro, no se lee con `cfg!` adentro de las funciones de remedio.** Es la única forma de testear los tres sistemas desde una sola máquina, y el spec pide que `daemon_remedy` / `daemon_start_cmd` / `install_options` sean puras de `(Runtime, OS)`. `cfg!(target_os = ...)` queda encerrado en `Os::current()`.
- **El comando nunca va embebido en la prosa.** `Remedy.message` no lleva backticks ni el comando adentro; el comando viaja en `Remedy.command`. Esto es la convención de `CLAUDE.md` ("el remedio se da adentro de la app") y es el punto del spec.
- **`can_run: false` ⇒ no hay botón.** Si la app no puede ejecutar el remedio (sudo en Linux), la UI muestra solo el chip copiable. Clickear algo que va a fallar es peor que no tenerlo.
- **`Remedy.command` nunca es `Some("")`.** Vacío se representa con `None`.
- **Los campos viejos de `LtDockerStatus` se conservan tal cual**, incluido el nombre desactualizado `docker_installed` (cubre los tres runtimes). Sumar campos es menos riesgoso que renombrar.
- **No se arranca el daemon sin que el usuario lo pida.** Fuera de alcance por el spec: levantar un servicio de la máquina como efecto secundario de abrir la app es sorpresivo.
- **No se adivina la distro de Linux.** En Linux y Windows la lista de instalación da label + URL, sin comando. Un comando que falla es peor que un link.
- **No se bundlea LanguageTool.** Sigue siendo container del usuario, por decisión de `CLAUDE.md`.
- **Convenciones del repo** (`CLAUDE.md`): standalone components, signals, `@if`/`@for`, sin `public` explícito, **return types explícitos en todos los métodos**, `inject()` para DI, comentarios y nombres de dominio en español.
- **`pnpm build` tiene que pasar** al cerrar cada task que toque `src/app/`.
- **`cargo test --manifest-path src-tauri/Cargo.toml` tiene que pasar** al cerrar cada task que toque `src-tauri/`.
- **El polling, el componente de copiar y las ramas de la UI no llevan tests automáticos.** El repo no tiene harness de DOM (no hay target `test` en `angular.json`). No inventar una función pura solo para tener algo verde: esa parte la verifica el autor a mano con el checklist del spec.
- **El item de `TODO.md` NO se marca `[x]`** en este plan: la verificación manual la hace el autor.
- **`CLAUDE.md` no se toca.** La convención "el remedio se da adentro de la app" que pide el spec ya está commiteada en la branch (`967d3d8`). No volver a agregarla.

---

### Task 1: `Os`, `Remedy` y el plan del daemon como función pura

Hoy `daemon_down_message(rt)` (`grammar.rs:269-287`) produce el texto correcto con el comando embebido entre backticks, y no existe nada que sepa *ejecutar* ese comando. Esta task crea la fuente de verdad única: una función pura que devuelve el mensaje, el comando copiable, si la app lo puede correr, y el `argv` con el que correrlo.

**Files:**
- Modify: `src-tauri/src/grammar.rs` — borrar `daemon_down_message` (`269-287`), agregar `Os` / `Remedy` / `DaemonPlan` / `daemon_plan` / `daemon_remedy` / `colima_bin` / `Engine::daemon_start_cmd`, actualizar el único caller (`702-704`), y el test `daemon_down_message_is_os_and_runtime_aware` (`947-953`).
- Test: `src-tauri/src/grammar.rs` — módulo `mod tests` al final del archivo (`839-970`).

**Interfaces:**
- Consumes: `Runtime` (enum privado, `grammar.rs:17-21`), `Engine { rt, bin }` (`98-101`), `Engine::daemon_ok()` (`105-115`).
- Produces, para las tasks siguientes:
  - `pub struct Remedy { pub message: String, pub command: Option<String>, pub can_run: bool }` — `Serialize`, `Clone`, `Debug`, `PartialEq`.
  - `enum Os { MacOs, Linux, Windows }` con `Os::current() -> Os`.
  - `fn daemon_plan(rt: Runtime, os: Os, colima_present: bool) -> DaemonPlan` (pura).
  - `fn daemon_remedy(rt: Runtime) -> Remedy` (wrapper que lee el entorno).
  - `fn colima_bin() -> Option<String>`.
  - `Engine::daemon_start_cmd(&self) -> Option<(Vec<String>, bool)>` — argv resuelto a rutas absolutas + flag de poll.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `mod tests` en `src-tauri/src/grammar.rs`, y **borrar** el test viejo `daemon_down_message_is_os_and_runtime_aware` (`947-953`) que testea la función que esta task elimina:

```rust
    /// Matriz completa (runtime × OS × colima) para los tests de invariantes.
    fn all_plans() -> Vec<((Runtime, Os, bool), DaemonPlan)> {
        let mut out = Vec::new();
        for rt in Runtime::ALL {
            for os in [Os::MacOs, Os::Linux, Os::Windows] {
                for colima in [false, true] {
                    out.push(((rt, os, colima), daemon_plan(rt, os, colima)));
                }
            }
        }
        out
    }

    #[test]
    fn apple_daemon_plan_is_container_system_start() {
        let p = daemon_plan(Runtime::Apple, Os::MacOs, false);
        assert_eq!(p.remedy.command.as_deref(), Some("container system start"));
        assert!(p.remedy.can_run);
        assert_eq!(
            p.argv,
            Some(vec![
                "container".to_string(),
                "system".to_string(),
                "start".to_string()
            ])
        );
        assert!(!p.poll, "`container system start` es sincrónico, no hace falta pollear");
        assert!(
            !p.remedy.message.contains("systemctl"),
            "Apple container nunca se arranca con systemctl"
        );
    }

    #[test]
    fn apple_outside_macos_offers_no_command() {
        // El binario `container` solo existe en macOS. Si aparece en otro OS no
        // inventamos un comando.
        for os in [Os::Linux, Os::Windows] {
            let p = daemon_plan(Runtime::Apple, os, false);
            assert_eq!(p.remedy.command, None);
            assert!(!p.remedy.can_run);
            assert_eq!(p.argv, None);
        }
    }

    #[test]
    fn podman_daemon_plan_is_machine_start_on_every_os() {
        for os in [Os::MacOs, Os::Linux, Os::Windows] {
            let p = daemon_plan(Runtime::Podman, os, false);
            assert_eq!(p.remedy.command.as_deref(), Some("podman machine start"));
            assert!(p.remedy.can_run);
            assert_eq!(
                p.argv,
                Some(vec![
                    "podman".to_string(),
                    "machine".to_string(),
                    "start".to_string()
                ])
            );
        }
    }

    #[test]
    fn docker_macos_prefers_colima_when_present() {
        let p = daemon_plan(Runtime::Docker, Os::MacOs, true);
        assert_eq!(p.remedy.command.as_deref(), Some("colima start"));
        assert!(p.remedy.can_run);
        assert_eq!(p.argv, Some(vec!["colima".to_string(), "start".to_string()]));
        assert!(!p.poll, "colima start bloquea hasta que el daemon está arriba");
    }

    #[test]
    fn docker_macos_without_colima_opens_desktop_and_polls() {
        let p = daemon_plan(Runtime::Docker, Os::MacOs, false);
        // Abrir una app de GUI no es un comando que el usuario copie y pegue.
        assert_eq!(p.remedy.command, None);
        assert!(p.remedy.can_run, "la app sí puede abrir Docker Desktop");
        assert_eq!(
            p.argv,
            Some(vec![
                "open".to_string(),
                "-a".to_string(),
                "Docker".to_string()
            ])
        );
        assert!(p.poll, "`open -a Docker` vuelve al instante; el daemon tarda ~30s");
    }

    #[test]
    fn docker_windows_launches_desktop_exe_and_polls() {
        let p = daemon_plan(Runtime::Docker, Os::Windows, false);
        assert!(p.remedy.can_run);
        assert_eq!(p.argv, Some(vec![DOCKER_DESKTOP_EXE.to_string()]));
        assert!(p.poll);
    }

    #[test]
    fn docker_linux_needs_sudo_so_app_cannot_run_it() {
        for colima in [false, true] {
            let p = daemon_plan(Runtime::Docker, Os::Linux, colima);
            assert_eq!(p.remedy.command.as_deref(), Some("sudo systemctl start docker"));
            assert!(
                !p.remedy.can_run,
                "necesita root: mostrar un botón que va a fallar es peor que no tenerlo"
            );
            assert_eq!(p.argv, None);
        }
    }

    #[test]
    fn no_remedy_message_embeds_its_command() {
        // El punto del spec: el comando viaja aparte para que el botón de copiar
        // copie el comando pelado y nada más.
        for ((rt, os, colima), p) in all_plans() {
            assert!(
                !p.remedy.message.contains('`'),
                "{:?}/{:?}/colima={} tiene backticks en el message",
                rt,
                os,
                colima
            );
            if let Some(cmd) = &p.remedy.command {
                assert!(
                    !p.remedy.message.contains(cmd.as_str()),
                    "{:?}/{:?}/colima={} repite el comando adentro del message",
                    rt,
                    os,
                    colima
                );
            }
        }
    }

    #[test]
    fn no_remedy_has_empty_command_or_message() {
        for ((rt, os, colima), p) in all_plans() {
            assert!(
                !p.remedy.message.trim().is_empty(),
                "{:?}/{:?}/colima={} sin message",
                rt,
                os,
                colima
            );
            assert!(
                p.remedy.command.as_deref() != Some(""),
                "{:?}/{:?}/colima={} tiene command vacío en vez de None",
                rt,
                os,
                colima
            );
        }
    }

    #[test]
    fn can_run_matches_argv_presence() {
        // Invariante: la UI decide el botón por `can_run`, así que tiene que
        // coincidir exactamente con "hay algo que ejecutar".
        for ((rt, os, colima), p) in all_plans() {
            assert_eq!(
                p.remedy.can_run,
                p.argv.is_some(),
                "{:?}/{:?}/colima={}: can_run y argv desalineados",
                rt,
                os,
                colima
            );
            if let Some(argv) = &p.argv {
                assert!(!argv.is_empty(), "argv vacío no se puede ejecutar");
                assert!(!argv[0].trim().is_empty(), "argv[0] vacío");
            }
        }
    }
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml daemon`
Expected: FAIL de compilación — `cannot find function daemon_plan`, `cannot find type Os`, `cannot find value DOCKER_DESKTOP_EXE`.

- [ ] **Step 3: Agregar `Os`, `Remedy`, `DaemonPlan` y `daemon_plan`**

En `src-tauri/src/grammar.rs`, **reemplazar** el bloque de `daemon_down_message` (`269-287`) por:

```rust
/// Sistema operativo relevante para elegir el remedio. Se pasa como parámetro
/// en vez de leer `cfg!(target_os)` adentro, para que las funciones de remedio
/// sean puras y testeables en las tres plataformas desde una sola máquina.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Os {
    MacOs,
    Linux,
    Windows,
}

impl Os {
    fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// Ruta de instalación por default de Docker Desktop en Windows. No es un
/// comando que el usuario tipee: se lanza el ejecutable.
const DOCKER_DESKTOP_EXE: &str = r"C:\Program Files\Docker\Docker\Docker Desktop.exe";

/// Rutas conocidas de colima. Mismo problema que los runtimes: una app lanzada
/// desde Finder hereda el PATH mínimo de launchd, sin los symlinks de Homebrew.
const COLIMA_CANDIDATES: [&str; 2] = ["/opt/homebrew/bin/colima", "/usr/local/bin/colima"];

fn colima_bin() -> Option<String> {
    COLIMA_CANDIDATES
        .iter()
        .find(|c| std::path::Path::new(*c).exists())
        .map(|c| (*c).to_string())
}

/// Qué pasó, qué comando lo arregla y quién puede correrlo. El comando va
/// SIEMPRE aparte del mensaje: el botón de copiar tiene que copiar el comando
/// pelado, sin arrastrar la explicación.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Remedy {
    /// Qué pasó, en prosa, SIN el comando embebido.
    pub message: String,
    /// Comando exacto para copiar, o `None` cuando no hay uno (ej. "abrí Docker
    /// Desktop", que es una app de GUI y no un comando).
    pub command: Option<String>,
    /// La app puede ejecutarlo sola: sin sudo y sin depender de que el usuario
    /// haga algo primero. Decide si la UI muestra el botón primario o solo el
    /// chip copiable.
    pub can_run: bool,
}

/// Remedio + cómo ejecutarlo, derivados juntos del mismo `match` para que el
/// texto que ve el usuario y el comando que corre la app no puedan divergir.
#[derive(Clone, Debug, PartialEq)]
struct DaemonPlan {
    remedy: Remedy,
    /// argv con un *token* de programa en `[0]` ("container", "podman",
    /// "colima", "open", o la ruta del .exe en Windows), que
    /// `Engine::daemon_start_cmd` resuelve a ruta absoluta. `None` cuando la
    /// app no puede ejecutar nada.
    argv: Option<Vec<String>>,
    /// Hay que esperar y pollear `daemon_ok()` después de lanzarlo: abrir Docker
    /// Desktop devuelve al instante pero el daemon tarda ~30s en aceptar
    /// conexiones. Sin este poll el arranque seguiría al paso siguiente contra
    /// un daemon muerto y fallaría con un error que no tiene nada que ver.
    poll: bool,
}

/// Única fuente de verdad del diagnóstico de daemon caído. Pura: no toca el
/// entorno (el chequeo de colima entra por parámetro).
fn daemon_plan(rt: Runtime, os: Os, colima_present: bool) -> DaemonPlan {
    match (rt, os) {
        (Runtime::Apple, Os::MacOs) => DaemonPlan {
            remedy: Remedy {
                message: "Apple container está instalado pero el daemon no responde. Hay que arrancarlo antes de poder usar LanguageTool.".into(),
                command: Some("container system start".into()),
                can_run: true,
            },
            argv: Some(vec!["container".into(), "system".into(), "start".into()]),
            poll: false,
        },
        // El binario `container` es de Apple y solo corre en macOS. Si aparece
        // en otro OS no inventamos un comando: decimos qué pasa y listo.
        (Runtime::Apple, _) => DaemonPlan {
            remedy: Remedy {
                message: "Apple container no responde y solo está soportado en macOS. Instalá Docker o Podman.".into(),
                command: None,
                can_run: false,
            },
            argv: None,
            poll: false,
        },
        (Runtime::Podman, _) => DaemonPlan {
            remedy: Remedy {
                message: "Podman está instalado pero su máquina no responde. Hay que arrancarla.".into(),
                command: Some("podman machine start".into()),
                can_run: true,
            },
            argv: Some(vec!["podman".into(), "machine".into(), "start".into()]),
            poll: false,
        },
        // colima primero: es un comando de verdad y arranca más rápido que
        // Docker Desktop.
        (Runtime::Docker, Os::MacOs) if colima_present => DaemonPlan {
            remedy: Remedy {
                message: "Docker está instalado pero el daemon no responde. colima puede levantarlo.".into(),
                command: Some("colima start".into()),
                can_run: true,
            },
            argv: Some(vec!["colima".into(), "start".into()]),
            poll: false,
        },
        (Runtime::Docker, Os::MacOs) => DaemonPlan {
            remedy: Remedy {
                message: "Docker está instalado pero el daemon no responde. Hay que abrir Docker Desktop y esperar a que termine de arrancar (~30s).".into(),
                command: None,
                can_run: true,
            },
            argv: Some(vec!["open".into(), "-a".into(), "Docker".into()]),
            poll: true,
        },
        (Runtime::Docker, Os::Windows) => DaemonPlan {
            remedy: Remedy {
                message: "Docker está instalado pero el daemon no responde. Hay que abrir Docker Desktop y esperar a que termine de arrancar (~30s).".into(),
                command: None,
                can_run: true,
            },
            argv: Some(vec![DOCKER_DESKTOP_EXE.into()]),
            poll: true,
        },
        // En Linux el daemon de Docker es un servicio del sistema: arrancarlo
        // pide root, que tWriter no tiene ni debería pedir.
        (Runtime::Docker, Os::Linux) => DaemonPlan {
            remedy: Remedy {
                message: "Docker está instalado pero el daemon no responde. Arrancar el servicio necesita permisos de root, así que lo tenés que correr vos en una terminal.".into(),
                command: Some("sudo systemctl start docker".into()),
                can_run: false,
            },
            argv: None,
            poll: false,
        },
    }
}

/// Remedio para el runtime detectado, leyendo el entorno real.
fn daemon_remedy(rt: Runtime) -> Remedy {
    daemon_plan(rt, Os::current(), colima_bin().is_some()).remedy
}
```

- [ ] **Step 4: Agregar `Engine::daemon_start_cmd`**

Adentro del `impl Engine` existente (`grammar.rs:103-209`), después de `daemon_ok`:

```rust
    /// argv listo para `Command`, con el token del programa resuelto a ruta
    /// absoluta (el PATH de una app lanzada desde Finder no tiene Homebrew), y
    /// el flag de poll. `None` cuando el remedio no lo puede correr la app.
    fn daemon_start_cmd(&self) -> Option<(Vec<String>, bool)> {
        let plan = daemon_plan(self.rt, Os::current(), colima_bin().is_some());
        let mut argv = plan.argv?;
        argv[0] = match argv[0].as_str() {
            // El binario del runtime ya viene resuelto en `self.bin`.
            "container" | "podman" | "docker" => self.bin.clone(),
            "colima" => colima_bin()?,
            // `open` es de macOS y vive en una ruta fija del sistema.
            "open" => "/usr/bin/open".to_string(),
            other => other.to_string(),
        };
        Some((argv, plan.poll))
    }
```

- [ ] **Step 5: Actualizar el caller de `daemon_down_message`**

En `languagetool_docker_start` (`grammar.rs:702-704`), reemplazar:

```rust
    if !engine.daemon_ok() {
        return Err(daemon_down_message(engine.rt));
    }
```

por (provisorio — Task 4 lo reemplaza por el arranque real; acá solo se mantiene compilando y sin perder información):

```rust
    if !engine.daemon_ok() {
        return Err(daemon_remedy(engine.rt).message);
    }
```

- [ ] **Step 6: Correr los tests y confirmar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, todos. Si aparece un warning de `dead_code` por `daemon_start_cmd` (nadie lo llama hasta Task 4), dejarlo: Task 4 lo consume. No agregar `#[allow(dead_code)]` si el build no lo trata como error.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/grammar.rs
git commit -m "feat(grammar): Remedy + daemon_plan puro con comando separado de la prosa"
```

---

### Task 2: `InstallOption` — cómo instalar un runtime, por OS

Hoy `no_runtime_message()` (`grammar.rs:254-267`) mete tres comandos de `brew` dentro de un string multilínea que la UI pinta como párrafo. Esta task lo parte en datos.

**Files:**
- Modify: `src-tauri/src/grammar.rs` — borrar `no_runtime_message` (`254-267`), agregar `InstallOption` / `install_options` / `no_runtime_remedy`, actualizar el caller en `languagetool_docker_start` (`690-693`).
- Test: `src-tauri/src/grammar.rs` — módulo `mod tests`.

**Interfaces:**
- Consumes: `Os` y `Remedy` de Task 1.
- Produces:
  - `pub struct InstallOption { pub label: String, pub command: Option<String>, pub url: String }` — `Serialize`, `Clone`, `Debug`, `PartialEq`.
  - `fn install_options(os: Os) -> Vec<InstallOption>` (pura).
  - `fn no_runtime_remedy() -> Remedy`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `mod tests`:

```rust
    #[test]
    fn macos_install_options_are_three_brew_commands() {
        let opts = install_options(Os::MacOs);
        assert_eq!(opts.len(), 3, "Apple container, colima y Podman");
        for o in &opts {
            let cmd = o
                .command
                .as_deref()
                .unwrap_or_else(|| panic!("{} sin comando en macOS", o.label));
            assert!(
                cmd.starts_with("brew install "),
                "{}: en macOS el comando es brew, no {:?}",
                o.label,
                cmd
            );
        }
        assert!(
            opts.iter().any(|o| o.label == "Apple container"),
            "Apple container es el runtime nativo de macOS y tiene que estar"
        );
    }

    #[test]
    fn linux_and_windows_install_options_have_no_command() {
        // No adivinamos apt vs dnf vs pacman: un comando que falla es peor que
        // un link.
        for os in [Os::Linux, Os::Windows] {
            let opts = install_options(os);
            assert!(!opts.is_empty(), "{:?} sin opciones de instalación", os);
            for o in &opts {
                assert_eq!(o.command, None, "{:?}/{} no debería traer comando", os, o.label);
            }
            assert!(
                !opts.iter().any(|o| o.label == "Apple container"),
                "Apple container solo existe en macOS"
            );
        }
    }

    #[test]
    fn every_install_option_has_label_and_https_url() {
        for os in [Os::MacOs, Os::Linux, Os::Windows] {
            for o in install_options(os) {
                assert!(!o.label.trim().is_empty(), "{:?}: option sin label", os);
                assert!(
                    o.url.starts_with("https://"),
                    "{:?}/{}: url inválida {:?}",
                    os,
                    o.label,
                    o.url
                );
                assert!(
                    o.command.as_deref() != Some(""),
                    "{:?}/{}: command vacío en vez de None",
                    os,
                    o.label
                );
            }
        }
    }

    #[test]
    fn no_runtime_remedy_has_no_command_and_cannot_run() {
        // Instalar un runtime no es algo que la app pueda hacer sola, y el
        // detalle de cada opción va en install_options.
        let r = no_runtime_remedy();
        assert_eq!(r.command, None);
        assert!(!r.can_run);
        assert!(!r.message.trim().is_empty());
        assert!(!r.message.contains('`'), "sin backticks en la prosa");
    }
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml install`
Expected: FAIL de compilación — `cannot find function install_options`.

- [ ] **Step 3: Implementar `InstallOption`, `install_options` y `no_runtime_remedy`**

En `src-tauri/src/grammar.rs`, **reemplazar** el bloque de `no_runtime_message` (`254-267`) por:

```rust
/// Una forma de instalar un runtime de containers. `command` solo se llena
/// cuando existe un comando que no puede fallar por variación de distro
/// (macOS: Homebrew). En Linux/Windows va `None` y queda solo la URL.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InstallOption {
    pub label: String,
    pub command: Option<String>,
    pub url: String,
}

fn install_options(os: Os) -> Vec<InstallOption> {
    match os {
        Os::MacOs => vec![
            InstallOption {
                label: "Apple container".into(),
                command: Some("brew install container && container system start".into()),
                url: "https://github.com/apple/container".into(),
            },
            InstallOption {
                label: "colima (Docker)".into(),
                command: Some("brew install colima docker && colima start".into()),
                url: "https://github.com/abiosoft/colima".into(),
            },
            InstallOption {
                label: "Podman".into(),
                command: Some(
                    "brew install podman && podman machine init && podman machine start".into(),
                ),
                url: "https://podman.io/get-started".into(),
            },
        ],
        // El comando depende de la distro (apt/dnf/pacman) y de si hay que
        // sumar el repo oficial. Damos el link a la guía y no adivinamos.
        Os::Linux => vec![
            InstallOption {
                label: "Docker Engine".into(),
                command: None,
                url: "https://docs.docker.com/engine/install/".into(),
            },
            InstallOption {
                label: "Podman".into(),
                command: None,
                url: "https://podman.io/get-started".into(),
            },
        ],
        Os::Windows => vec![
            InstallOption {
                label: "Docker Desktop".into(),
                command: None,
                url: "https://docs.docker.com/desktop/install/windows-install/".into(),
            },
            InstallOption {
                label: "Podman".into(),
                command: None,
                url: "https://podman.io/get-started".into(),
            },
        ],
    }
}

/// Remedio cuando no hay ningún runtime instalado. Acá solo la prosa: el
/// detalle accionable de cada opción va en `install_options`.
fn no_runtime_remedy() -> Remedy {
    Remedy {
        message: "No se encontró ningún runtime de containers (Docker, Podman o Apple container). Instalá uno y volvé a abrir esta ventana.".into(),
        command: None,
        can_run: false,
    }
}
```

- [ ] **Step 4: Actualizar el caller de `no_runtime_message`**

En `languagetool_docker_start` (`grammar.rs:690-693`), reemplazar `return Err(no_runtime_message())` por:

```rust
        None => return Err(no_runtime_remedy().message),
```

- [ ] **Step 5: Correr los tests y confirmar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, todos.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/grammar.rs
git commit -m "feat(grammar): InstallOption por OS en vez del blob de prosa de no_runtime_message"
```

---

### Task 3: El status deja de mentir

`languagetool_docker_status` (`grammar.rs:643-667`) colapsa el estado del daemon dentro de los flags del container: `if e.daemon_ok() { (running, exists) } else { (false, false) }`. Sin un campo que diga "el daemon no responde", la UI cae en su rama genérica y afirma **"Container detenido (no existe todavía)"** — las dos cosas falsas cuando lo que se cayó es el apiserver.

**Files:**
- Modify: `src-tauri/src/grammar.rs` — `LtDockerStatus` (`631-641`) y `languagetool_docker_status` (`643-667`).
- Test: `src-tauri/src/grammar.rs` — módulo `mod tests`.

**Interfaces:**
- Consumes: `Remedy`, `daemon_remedy`, `Os` (Task 1); `InstallOption`, `install_options`, `no_runtime_remedy` (Task 2).
- Produces: el contrato JSON que consume `src/app/core/grammar-service.ts` en Task 6 — campos `daemon_running: bool`, `remedy: Remedy | null`, `install_options: InstallOption[]`, en snake_case (no hay `rename_all` en este struct).

- [ ] **Step 1: Escribir el test que falla**

El comando shellea contra el runtime real, así que no se puede unit-testear de punta a punta. Lo que sí se testea —y es la regresión que importa— es el **contrato serializado** que lee el front:

```rust
    #[test]
    fn status_json_exposes_daemon_running_remedy_and_install_options() {
        // Contrato con `LtDockerStatus` de grammar-service.ts. Si un campo se
        // renombra acá y no allá, el front lee `undefined` en silencio.
        let s = LtDockerStatus {
            docker_installed: true,
            runtime: Some(Runtime::Apple.label().to_string()),
            daemon_running: false,
            container_running: false,
            container_exists: false,
            api_responding: false,
            remedy: Some(daemon_plan(Runtime::Apple, Os::MacOs, false).remedy),
            install_options: Vec::new(),
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["daemon_running"], serde_json::json!(false));
        assert_eq!(v["remedy"]["command"], serde_json::json!("container system start"));
        assert_eq!(v["remedy"]["can_run"], serde_json::json!(true));
        assert!(v["remedy"]["message"].as_str().unwrap().len() > 10);
        assert_eq!(v["install_options"], serde_json::json!([]));
        // Los campos viejos siguen ahí: el front los usa tal cual.
        assert_eq!(v["docker_installed"], serde_json::json!(true));
        assert_eq!(v["container_exists"], serde_json::json!(false));
    }

    #[test]
    fn status_json_without_runtime_carries_install_options() {
        let s = LtDockerStatus {
            docker_installed: false,
            runtime: None,
            daemon_running: false,
            container_running: false,
            container_exists: false,
            api_responding: false,
            remedy: Some(no_runtime_remedy()),
            install_options: install_options(Os::MacOs),
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["install_options"].as_array().unwrap().len(), 3);
        assert_eq!(v["runtime"], serde_json::Value::Null);
        assert_eq!(v["remedy"]["can_run"], serde_json::json!(false));
    }
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml status_json`
Expected: FAIL de compilación — `struct LtDockerStatus has no field named daemon_running`.

- [ ] **Step 3: Sumar los campos a `LtDockerStatus`**

Reemplazar el struct (`grammar.rs:631-641`) por:

```rust
#[derive(Serialize)]
pub struct LtDockerStatus {
    /// Hay al menos un runtime de containers instalado (Docker/Podman/Apple).
    /// Conserva el nombre del campo por compat con el front.
    pub docker_installed: bool,
    /// Nombre legible del runtime detectado (ej. "Apple container"), o `null`.
    pub runtime: Option<String>,
    /// ¿Responde el daemon del runtime detectado? Cuando es `false`,
    /// `container_running` y `container_exists` NO significan nada: el CLI no
    /// puede listar containers sin daemon.
    pub daemon_running: bool,
    pub container_running: bool,
    pub container_exists: bool,
    pub api_responding: bool,
    /// Remedio accionable cuando falta el runtime o el daemon no responde.
    pub remedy: Option<Remedy>,
    /// Cómo instalar un runtime. Solo se llena cuando no hay ninguno.
    pub install_options: Vec<InstallOption>,
}
```

- [ ] **Step 4: Reescribir `languagetool_docker_status`**

Reemplazar el comando entero (`grammar.rs:643-667`) por:

```rust
#[tauri::command]
pub async fn languagetool_docker_status() -> LtDockerStatus {
    // Preferimos un runtime con daemon vivo; si ninguno responde pero hay uno
    // instalado, lo reportamos igual con el remedio para levantarlo.
    let engine = detect_engine().or_else(detect_installed);
    let api_responding = ping_local_lt().await;
    let Some(e) = engine else {
        return LtDockerStatus {
            docker_installed: false,
            runtime: None,
            daemon_running: false,
            container_running: false,
            container_exists: false,
            api_responding,
            remedy: Some(no_runtime_remedy()),
            install_options: install_options(Os::current()),
        };
    };
    let daemon_running = e.daemon_ok();
    // Sin daemon el CLI no puede listar containers (Apple `container ls` falla
    // con XPC connection error), así que los flags quedan en false y
    // `daemon_running` es el que explica por qué. Antes esto se colapsaba y la
    // UI afirmaba "el container no existe" sobre un container que sí existía.
    let (container_running, container_exists) = if daemon_running {
        (e.running(), e.exists())
    } else {
        (false, false)
    };
    LtDockerStatus {
        docker_installed: true,
        runtime: Some(e.rt.label().to_string()),
        daemon_running,
        container_running,
        container_exists,
        api_responding,
        remedy: (!daemon_running).then(|| daemon_remedy(e.rt)),
        install_options: Vec::new(),
    }
}
```

- [ ] **Step 5: Correr los tests y confirmar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, todos.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/grammar.rs
git commit -m "fix(grammar): daemon_running + remedy en el status, sin colapsar daemon y container"
```

---

### Task 4: Un botón que hace las dos capas

`languagetool_docker_start` corta con `Err` cuando el daemon está caído. Pasa a arrancarlo él mismo cuando puede, esperando a que acepte conexiones, y sigue con el container: el usuario no tiene que aprender que son dos capas — que es exactamente el conocimiento que este spec busca no exigirle.

**Nota de diseño (desviación explícita del spec):** el spec numera el stepper con "Arrancando el runtime" como fase ①. Pero el código ya emite `checking` ("Buscando un runtime de containers…") **antes** de saber si el daemon está caído, y `phaseDone` del front compara índices en un array ordenado: si `daemon` fuera el índice 0 y llegara después de `checking`, el stepper iría para atrás. Así que el orden real es `checking` → `daemon` → `pulling` → `starting` → `loading`, y la fase nueva es ② con el label "Arrancando el runtime". Es el mismo flujo del spec, numerado como el código lo emite.

**Files:**
- Modify: `src-tauri/src/grammar.rs` — `languagetool_docker_start` (`687-770`), agregar `daemon_block_error` y `start_daemon`.
- Test: `src-tauri/src/grammar.rs` — módulo `mod tests`.

**Interfaces:**
- Consumes: `Engine::daemon_start_cmd`, `daemon_plan`, `Os`, `colima_bin` (Task 1); `no_runtime_remedy` (Task 2); `emit_progress` (`grammar.rs:675-685`).
- Produces: la fase de progreso `"daemon"` en el evento `languagetool-progress` (`LtProgress.phase`), que Task 6 agrega al tipo `DockerPhase` del front.

- [ ] **Step 1: Escribir el test que falla**

El arranque real y el polling shellean contra el sistema; lo puro es el mensaje de error cuando la app **no** puede arrancar el daemon:

```rust
    #[test]
    fn daemon_block_error_carries_the_command_for_sudo_cases() {
        // Docker en Linux: la app no puede correrlo, así que el Err tiene que
        // llevar el comando además de la explicación (el chip copiable de la UI
        // viene del status, pero el mensaje del stepper tiene que servir solo).
        let msg = daemon_block_error(Runtime::Docker, Os::Linux, false);
        assert!(msg.contains("sudo systemctl start docker"), "msg: {}", msg);
        assert!(msg.contains("root"), "msg: {}", msg);
    }

    #[test]
    fn daemon_block_error_without_command_is_just_the_message() {
        let msg = daemon_block_error(Runtime::Apple, Os::Linux, false);
        let expected = daemon_plan(Runtime::Apple, Os::Linux, false).remedy.message;
        assert_eq!(msg, expected, "sin comando no se le pega nada al mensaje");
    }
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `cargo test --manifest-path src-tauri/Cargo.toml daemon_block_error`
Expected: FAIL de compilación — `cannot find function daemon_block_error`.

- [ ] **Step 3: Agregar `daemon_block_error` y `start_daemon`**

En `src-tauri/src/grammar.rs`, justo antes de `#[tauri::command] pub async fn languagetool_docker_start` (`687`):

```rust
/// Timeout del poll cuando el arranque es asincrónico (abrir Docker Desktop
/// tarda ~30s en aceptar conexiones). Con arranque sincrónico alcanza un
/// margen corto: si `container system start` volvió bien, el daemon ya está.
const DAEMON_POLL_SECS: u64 = 60;
const DAEMON_SYNC_GRACE_SECS: u64 = 5;

/// Texto del `Err` cuando la app no puede arrancar el daemon sola. Le pega el
/// comando al final para que el mensaje del stepper sirva por sí mismo; el chip
/// copiable de la UI sale del `remedy` del status, que se refresca al terminar.
fn daemon_block_error(rt: Runtime, os: Os, colima_present: bool) -> String {
    let r = daemon_plan(rt, os, colima_present).remedy;
    match r.command {
        Some(cmd) => format!("{} Corré: {}", r.message, cmd),
        None => r.message,
    }
}

/// Lanza el arranque del daemon y espera a que acepte conexiones. `poll` marca
/// los arranques asincrónicos (apps de GUI): ahí el exit code del lanzador no
/// dice nada del daemon, así que el veredicto lo da `daemon_ok`.
async fn start_daemon(
    app: &AppHandle,
    engine: &Engine,
    argv: Vec<String>,
    poll: bool,
) -> Result<(), String> {
    let program = argv[0].clone();
    let rest: Vec<String> = argv[1..].to_vec();
    let launch = tokio::task::spawn_blocking(move || Command::new(&program).args(&rest).output())
        .await
        .map_err(|e| format!("spawn arranque del daemon: {}", e))?
        .map_err(|e| format!("no se pudo lanzar el arranque del daemon: {}", e))?;
    if !launch.status.success() && !poll {
        return Err(format!(
            "no se pudo arrancar {}: {}",
            engine.rt.label(),
            String::from_utf8_lossy(&launch.stderr).trim()
        ));
    }
    let timeout = if poll {
        DAEMON_POLL_SECS
    } else {
        DAEMON_SYNC_GRACE_SECS
    };
    for i in 0..timeout {
        let e = engine.clone();
        let ok = tokio::task::spawn_blocking(move || e.daemon_ok())
            .await
            .unwrap_or(false);
        if ok {
            return Ok(());
        }
        if poll && i % 5 == 0 {
            emit_progress(
                app,
                "daemon",
                format!(
                    "Esperando a que {} acepte conexiones ({}s de {}s)…",
                    engine.rt.label(),
                    i,
                    timeout
                ),
            );
        }
        sleep(Duration::from_secs(1)).await;
    }
    Err(format!(
        "{} no respondió después de {}s. Revisá que haya terminado de arrancar y volvé a intentar.",
        engine.rt.label(),
        timeout
    ))
}
```

- [ ] **Step 4: Meter la fase del daemon en `languagetool_docker_start`**

Reemplazar el bloque de chequeo del daemon (`grammar.rs:694-704`, el `emit_progress` de "Usando … Chequeando que el daemon responda…" más el `if !engine.daemon_ok()`) por:

```rust
    emit_progress(
        &app,
        "checking",
        format!(
            "Usando {}. Chequeando que el daemon responda…",
            engine.rt.label()
        ),
    );
    if !engine.daemon_ok() {
        let Some((argv, poll)) = engine.daemon_start_cmd() else {
            return Err(daemon_block_error(
                engine.rt,
                Os::current(),
                colima_bin().is_some(),
            ));
        };
        emit_progress(
            &app,
            "daemon",
            format!("Arrancando {}…", engine.rt.label()),
        );
        start_daemon(&app, &engine, argv, poll).await?;
        emit_progress(
            &app,
            "daemon",
            format!("{} respondiendo.", engine.rt.label()),
        );
    }
```

- [ ] **Step 5: Correr los tests y confirmar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, todos. Ya no debería quedar warning de `dead_code` por `daemon_start_cmd`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/grammar.rs
git commit -m "feat(grammar): el arranque levanta el daemon y espera antes de tocar el container"
```

---

### Task 5: `app-copy-command`, el chip de comando copiable

Componente standalone chico: un `<code>` con el comando y un botón que lo copia al clipboard y confirma. Lo consumen la rama del daemon caído y la lista de instalación (Task 6). Sigue el patrón de `src/app/shared/spinner.ts`: template y estilos inline porque es un componente de una sola pieza.

**Files:**
- Create: `src/app/shared/copy-command.ts`

**Interfaces:**
- Consumes: nada del backend.
- Produces: `class CopyCommand` con selector `app-copy-command` e input `command = input.required<string>()`. Task 6 lo importa desde `../shared/copy-command`.

- [ ] **Step 1: Escribir el componente**

Crear `src/app/shared/copy-command.ts`:

```ts
import { ChangeDetectionStrategy, Component, OnDestroy, input, signal } from '@angular/core';

/** Ventana del "copiado ✓". 2s: alcanza para leerlo y no queda pegado. */
const COPIED_MS = 2000;

/**
 * Comando pelado + botón de copiar. Existe para que el usuario pueda copiar el
 * comando sin arrastrar la prosa que lo explica (ver la convención "el remedio
 * se da adentro de la app" en CLAUDE.md).
 */
@Component({
  selector: 'app-copy-command',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <code class="cc-cmd">{{ command() }}</code>
    <button
      type="button"
      class="cc-btn"
      [attr.aria-label]="'Copiar el comando ' + command()"
      (click)="copy()"
    >
      {{ copied() ? 'copiado ✓' : 'copiar' }}
    </button>
  `,
  styles: [`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
    }
    .cc-cmd {
      font-family: var(--font-mono);
      font-size: 11px;
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 3px 6px;
      user-select: all;
      overflow-x: auto;
      white-space: nowrap;
    }
    .cc-btn {
      flex: none;
      font-size: 11px;
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 3px;
      background: transparent;
      color: var(--fg-muted);
      cursor: pointer;
    }
    .cc-btn:hover {
      color: var(--fg);
      border-color: var(--accent);
    }
  `],
})
export class CopyCommand implements OnDestroy {
  readonly command = input.required<string>();

  protected readonly copied = signal<boolean>(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.command());
    } catch {
      // Sin permiso de clipboard. El `user-select: all` del <code> deja
      // seleccionarlo con un click, así que no dejamos al usuario sin salida.
      return;
    }
    this.copied.set(true);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.copied.set(false), COPIED_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
```

- [ ] **Step 2: Verificar que compila**

Run: `pnpm build`
Expected: build exitosa, sin errores de TypeScript. (No hay test de DOM en el repo — el comportamiento del copiado lo verifica el autor a mano, punto 3 del checklist del spec.)

- [ ] **Step 3: Commit**

```bash
git add src/app/shared/copy-command.ts
git commit -m "feat(shared): componente app-copy-command para comandos copiables"
```

---

### Task 6: La UI dice qué pasó y ofrece el remedio

Los tipos del front y las ramas del panel. Hoy `!ds.docker_installed` es un párrafo de prosa con links, y el daemon caído cae en el `@else` genérico que afirma "Container detenido (no existe todavía)".

**Files:**
- Modify: `src/app/core/grammar-service.ts` — interface `LtDockerStatus` (`18-26`), sumar `Remedy` e `InstallOption`.
- Modify: `src/app/grammar-settings/grammar-settings.ts` — `DockerPhase` (`26`), imports (`21-24`, `36-40`), `phaseDone` (`181-186`), `startDocker` (`117-135`).
- Modify: `src/app/grammar-settings/grammar-settings.html` — panel docker (`105-176`).
- Modify: `src/app/grammar-settings/grammar-settings.scss` — sumar `.install-options` después de `.docker-msg` (`254`).

**Interfaces:**
- Consumes: el JSON de `languagetool_docker_status` (Task 3: `daemon_running`, `remedy`, `install_options`), la fase `"daemon"` del evento de progreso (Task 4), y `CopyCommand` (Task 5).
- Produces: nada para tasks siguientes.

- [ ] **Step 1: Sumar los tipos en `grammar-service.ts`**

Reemplazar la interface `LtDockerStatus` (`src/app/core/grammar-service.ts:18-26`) por:

```ts
/** Qué pasó y con qué se arregla. Espeja `Remedy` de `grammar.rs`. */
export interface Remedy {
  /** Qué pasó, en prosa, sin el comando embebido. */
  message: string;
  /** Comando exacto para copiar, o null si no hay uno (ej. abrir Docker Desktop). */
  command: string | null;
  /** La app puede ejecutarlo sola. Decide botón primario vs solo chip copiable. */
  can_run: boolean;
}

/** Una forma de instalar un runtime. `command` solo viene en macOS (Homebrew). */
export interface InstallOption {
  label: string;
  command: string | null;
  url: string;
}

export interface LtDockerStatus {
  /** Hay al menos un runtime de containers instalado (Docker/Podman/Apple). */
  docker_installed: boolean;
  /** Nombre legible del runtime detectado (ej. "Apple container"), o null. */
  runtime: string | null;
  /**
   * ¿Responde el daemon del runtime? Cuando es false, `container_running` y
   * `container_exists` NO significan nada: el CLI no puede listar containers
   * sin daemon.
   */
  daemon_running: boolean;
  container_running: boolean;
  container_exists: boolean;
  api_responding: boolean;
  /** Remedio accionable cuando falta el runtime o el daemon no responde. */
  remedy: Remedy | null;
  /** Cómo instalar un runtime. Solo viene con contenido si no hay ninguno. */
  install_options: InstallOption[];
}
```

- [ ] **Step 2: Sumar la fase `daemon` en `grammar-settings.ts`**

Tres cambios en `src/app/grammar-settings/grammar-settings.ts`:

`DockerPhase` (`26`):

```ts
export type DockerPhase =
  | 'checking'
  | 'daemon'
  | 'pulling'
  | 'starting'
  | 'loading'
  | 'ready'
  | 'error';
```

`phaseDone` (`181-186`) — el array tiene que reflejar el orden en que el backend emite:

```ts
  /** Devuelve true si la fase `p` ya pasó (la actual está más adelante en el flujo). */
  protected phaseDone(p: DockerPhase): boolean {
    const order: DockerPhase[] = ['checking', 'daemon', 'pulling', 'starting', 'loading', 'ready'];
    const cur = this.dockerPhase();
    if (!cur || cur === 'error') return false;
    return order.indexOf(cur) > order.indexOf(p);
  }
```

El mensaje inicial de `startDocker` (`120`) menciona solo Docker; el backend arranca buscando cualquiera de los tres:

```ts
    this.dockerMessage.set('Buscando un runtime de containers…');
```

Y el import de `CopyCommand`: sumar `import { CopyCommand } from '../shared/copy-command';` junto al de `Select` (`23`), y `CopyCommand` al array `imports` del decorador (`37`, junto a `FormsModule, Select`).

- [ ] **Step 3: Reescribir las ramas del panel en el template**

Reemplazar el bloque `@if (!ds.docker_installed) { … } @else if …` completo (`src/app/grammar-settings/grammar-settings.html:107-145`) por:

```html
                @if (!ds.docker_installed) {
                  <div class="docker-status err">
                    {{ ds.remedy?.message ?? 'No se detectó ningún runtime de containers (Docker, Podman o Apple container).' }}
                  </div>
                  <ul class="install-options">
                    @for (opt of ds.install_options; track opt.label) {
                      <li>
                        <a [href]="opt.url" target="_blank" rel="noopener">{{ opt.label }}</a>
                        @if (opt.command; as cmd) {
                          <app-copy-command [command]="cmd" />
                        }
                      </li>
                    }
                  </ul>
                } @else if (!ds.daemon_running) {
                  <!-- El daemon no responde: sin él el CLI no puede ni listar
                       containers, así que container_running/exists no dicen nada. -->
                  <div class="docker-status warn">
                    {{ ds.remedy?.message ?? 'El daemon del runtime no responde.' }}
                  </div>
                  @if (ds.remedy; as rem) {
                    @if (rem.command; as cmd) {
                      <app-copy-command [command]="cmd" />
                    }
                    @if (rem.can_run) {
                      <button
                        type="button"
                        class="btn btn-primary docker-btn"
                        [disabled]="dockerBusy() !== null"
                        (click)="startDocker()"
                      >
                        {{ dockerBusy() === 'starting' ? 'Levantando…' : 'Levantar LanguageTool' }}
                      </button>
                    }
                  }
                } @else if (ds.container_running && ds.api_responding) {
                  <div class="docker-status ok">
                    <svg lucideCircle [size]="10"></svg>
                    LanguageTool corriendo en localhost:8081{{ ds.runtime ? ' (vía ' + ds.runtime + ')' : '' }}
                  </div>
                  <button
                    type="button"
                    class="btn btn-secondary docker-btn"
                    [disabled]="dockerBusy() !== null"
                    (click)="stopDocker()"
                  >
                    {{ dockerBusy() === 'stopping' ? 'Deteniendo…' : 'Detener LanguageTool' }}
                  </button>
                } @else if (ds.container_running) {
                  <div class="docker-status warn">
                    Container corriendo pero el API todavía no responde (cargando modelos).
                  </div>
                } @else {
                  <div class="docker-status">
                    Container detenido{{ ds.container_exists ? ' (existe pero apagado)' : ' (no existe todavía)' }}.
                  </div>
                  <button
                    type="button"
                    class="btn btn-primary docker-btn"
                    [disabled]="dockerBusy() !== null"
                    (click)="startDocker()"
                  >
                    {{ dockerBusy() === 'starting' ? 'Levantando…' : 'Levantar LanguageTool' }}
                  </button>
                }
```

- [ ] **Step 4: Sumar la fase nueva al stepper**

En el mismo archivo, en el `<ol class="docker-stepper">` (`148-169`), insertar el `<li>` de la fase `daemon` **después** del de `checking` y renumerar los iconos de los que siguen (③④⑤):

```html
                    <li [class.active]="dockerPhase() === 'daemon'"
                        [class.done]="phaseDone('daemon')">
                      <span class="step-icon">②</span>
                      <span class="step-label">Arrancando el runtime</span>
                    </li>
```

El `<li>` de `pulling` pasa a `③ Bajando imagen (~300MB)`, el de `starting` a `④ Creando container`, y el de `loading` a `⑤ Cargando modelos (~30s)`.

- [ ] **Step 5: Estilar la lista de instalación**

En `src/app/grammar-settings/grammar-settings.scss`, después de `.docker-msg` (cierre en `254`):

```scss
.install-options {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
  }

  a {
    color: var(--accent);
    text-decoration: underline;
    flex: none;
  }
}
```

- [ ] **Step 6: Verificar que compila**

Run: `pnpm build`
Expected: build exitosa. Si aparece `NG8001: 'app-copy-command' is not a known element`, falta el import de `CopyCommand` en el array `imports` del componente (Step 2).

- [ ] **Step 7: Commit**

```bash
git add src/app/core/grammar-service.ts src/app/grammar-settings/grammar-settings.ts src/app/grammar-settings/grammar-settings.html src/app/grammar-settings/grammar-settings.scss
git commit -m "feat(grammar): rama de daemon caído con comando copiable y lista de instalación"
```

---

### Task 7: Cerrar el item de `TODO.md` como implementado, sin marcarlo

El item de `TODO.md` §Plataformas describe el bug y el plan. Pasa a describir qué quedó implementado y qué falta verificar. **No se marca `[x]`**: la verificación manual la hace el autor con la app levantada.

**Files:**
- Modify: `TODO.md` — el item "Levantar LanguageTool sin saber de containers" en §Plataformas (arranca en `298`).

**Interfaces:**
- Consumes: nada. Es documentación.
- Produces: nada.

- [ ] **Step 1: Reescribir el cierre del item**

Al final del item (después de "…van a los tests de `grammar.rs`."), agregar:

```markdown
  **Estado**: implementado en `feat/languagetool-setup-seamless` — `Remedy` +
  `daemon_plan(Runtime, Os, colima)` puro como fuente única del diagnóstico,
  `daemon_running`/`remedy`/`install_options` en `LtDockerStatus`, la fase
  `daemon` al frente del arranque con polling de 60s para Docker Desktop, y
  `shared/copy-command.ts`. Los tests de Rust cubren la matriz runtime × OS ×
  colima, las invariantes (`can_run` ⟺ hay argv, nunca `command: Some("")`,
  nunca el comando embebido en el `message`) y el contrato serializado del
  status. **Falta la verificación manual** del checklist del spec (`container
  system stop` → mensaje correcto, el botón haciendo las dos capas, el chip
  copiando el comando pelado, la lista de instalación sin runtime) — hasta
  entonces este item no se marca.
```

- [ ] **Step 2: Commit**

```bash
git add TODO.md
git commit -m "docs: estado del item de LanguageTool seamless tras la implementación"
```

---

## Verificación final (antes de abrir PR)

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` — PASS completo.
- [ ] `pnpm build` — PASS.
- [ ] `git log --oneline main..HEAD` — 7 commits, uno por task (más el del spec).
- [ ] El checklist manual del spec (§"Verificación manual (la hace el autor)") queda para el autor. **No marcar el item de `TODO.md`** ni afirmar que la feature está verificada hasta que él lo corra.
