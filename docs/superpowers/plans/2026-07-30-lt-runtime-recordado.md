# Runtime de LanguageTool recordado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la app deje de arrancar el runtime de containers equivocado cuando el daemon está caído, recordando dónde vio el container y preguntando cuando no lo sabe.

**Architecture:** Una función pura `pick_runtime(installed, remembered)` concentra la decisión. El runtime recordado se persiste en `settings.json` como campo propiedad del backend, que el frontend no conoce y `set_settings` protege con un merge. Cuando hay varios candidatos y nada recordado, el backend devuelve la lista y la UI pregunta en vez de adivinar.

**Tech Stack:** Rust (Tauri 2, serde), Angular 21 (signals, standalone).

**Spec:** `docs/superpowers/specs/2026-07-30-lt-runtime-recordado-design.md`

## Global Constraints

- Branch: `fix/lt-runtime-recordado`, sacada de `main` actualizado.
- Cero dependencias npm o crates nuevas.
- UI, mensajes y comentarios en español. Nada de jerga de containers sin traducir en los textos que ve el autor.
- Convenciones Angular del repo: standalone, signals, `@if`/`@for`, sin `public`, return types explícitos, `inject()`.
- Un comando que el autor no puede ejecutar nunca va embebido en prosa: va en `Remedy.command` para el chip copiable (regla de CLAUDE.md).
- Verificación: `cargo test --manifest-path src-tauri/Cargo.toml` y `pnpm build` tienen que pasar antes de cada commit que toque su lado.
- La verificación con la app levantada la hace el autor, no el implementador.

---

### Task 1: `Runtime::key`/`from_key` + `pick_runtime`

**Files:**
- Modify: `src-tauri/src/grammar.rs` (impl `Runtime`, ~línea 29-91; nuevo tipo cerca de `detect_installed`, ~línea 266)
- Test: `src-tauri/src/grammar.rs` (`mod tests`, ~línea 1299)

**Interfaces:**
- Consumes: nada.
- Produces: `Runtime::key(self) -> &'static str`, `Runtime::from_key(&str) -> Option<Runtime>`, `enum RuntimePick { Chosen(Runtime), Ambiguous(Vec<Runtime>), None }`, `fn pick_runtime(installed: &[Runtime], remembered: Option<Runtime>) -> RuntimePick`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `mod tests` en `src-tauri/src/grammar.rs`:

```rust
    #[test]
    fn runtime_key_roundtrip() {
        for rt in Runtime::ALL {
            assert_eq!(Runtime::from_key(rt.key()), Some(rt), "roundtrip de {:?}", rt);
        }
        assert_eq!(Runtime::from_key("containerd"), None);
        assert_eq!(Runtime::from_key(""), None);
    }

    #[test]
    fn pick_prefiere_el_recordado_sobre_el_orden_fijo() {
        // El caso del bug: Docker primero en Runtime::ALL, pero el container
        // vive en Apple container.
        let installed = [Runtime::Docker, Runtime::Apple];
        assert_eq!(
            pick_runtime(&installed, Some(Runtime::Apple)),
            RuntimePick::Chosen(Runtime::Apple)
        );
    }

    #[test]
    fn pick_ignora_un_recordado_desinstalado() {
        let installed = [Runtime::Docker, Runtime::Apple];
        assert_eq!(
            pick_runtime(&installed, Some(Runtime::Podman)),
            RuntimePick::Ambiguous(vec![Runtime::Docker, Runtime::Apple])
        );
    }

    #[test]
    fn pick_con_uno_solo_no_pregunta() {
        assert_eq!(
            pick_runtime(&[Runtime::Podman], None),
            RuntimePick::Chosen(Runtime::Podman)
        );
        assert_eq!(
            pick_runtime(&[Runtime::Podman], Some(Runtime::Docker)),
            RuntimePick::Chosen(Runtime::Podman)
        );
    }

    #[test]
    fn pick_sin_runtimes_es_none() {
        assert_eq!(pick_runtime(&[], None), RuntimePick::None);
        assert_eq!(pick_runtime(&[], Some(Runtime::Docker)), RuntimePick::None);
    }

    #[test]
    fn ambiguous_nunca_con_menos_de_dos() {
        for installed in [vec![], vec![Runtime::Docker]] {
            assert!(
                !matches!(pick_runtime(&installed, None), RuntimePick::Ambiguous(_)),
                "Ambiguous con {} instalados", installed.len()
            );
        }
    }
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pick_ 2>&1 | tail -20`
Expected: FAIL de compilación — `no function or associated item named 'key' found`, `cannot find function 'pick_runtime'`.

- [ ] **Step 3: Implementar**

En `impl Runtime` (después de `fn cmd`, `src-tauri/src/grammar.rs:43`):

```rust
    /// Clave estable para persistir en settings. NO usar `label()`: eso es
    /// texto de UI y puede cambiar sin romper nada.
    fn key(self) -> &'static str {
        match self {
            Runtime::Docker => "docker",
            Runtime::Podman => "podman",
            Runtime::Apple => "apple",
        }
    }

    fn from_key(key: &str) -> Option<Runtime> {
        match key {
            "docker" => Some(Runtime::Docker),
            "podman" => Some(Runtime::Podman),
            "apple" => Some(Runtime::Apple),
            _ => None,
        }
    }
```

Justo antes de `fn detect_installed` (`src-tauri/src/grammar.rs:266`):

```rust
/// Resultado de decidir con qué runtime operar cuando ningún daemon responde
/// (con daemon vivo decide `detect_engine`, que tiene evidencia).
#[derive(Clone, Debug, PartialEq, Eq)]
enum RuntimePick {
    Chosen(Runtime),
    /// Más de un runtime instalado y nada recordado: hay que preguntar. Adivinar
    /// acá es el bug — un click puede bajar 300MB y crear un container en el
    /// runtime equivocado mientras el real duerme en otro.
    Ambiguous(Vec<Runtime>),
    None,
}

/// Única fuente de la decisión. Pura: no toca disco ni procesos.
fn pick_runtime(installed: &[Runtime], remembered: Option<Runtime>) -> RuntimePick {
    if let Some(rt) = remembered {
        if installed.contains(&rt) {
            return RuntimePick::Chosen(rt);
        }
    }
    match installed {
        [] => RuntimePick::None,
        [only] => RuntimePick::Chosen(*only),
        many => RuntimePick::Ambiguous(many.to_vec()),
    }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: PASS, incluidos los tests que ya existían.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/grammar.rs
git commit -m "feat(grammar): pick_runtime, la decisión de runtime como función pura

Runtime::key/from_key para persistir sin atarse al texto de UI, y
pick_runtime(installed, remembered) con las cuatro reglas: recordado e
instalado gana, uno solo gana, varios es Ambiguous, cero es None."
```

---

### Task 2: campo `languagetoolRuntime` en settings, protegido del round-trip

**Files:**
- Modify: `src-tauri/src/settings.rs` (struct `Settings` ~línea 18-181, `get_settings`/`set_settings` ~línea 192-207)
- Test: `src-tauri/src/settings.rs` (`mod tests`, ~línea 209)

**Interfaces:**
- Consumes: nada de Task 1.
- Produces: `Settings.languagetool_runtime: Option<String>` (JSON `languagetoolRuntime`), `fn merge_backend_owned(incoming: &mut Settings, disk: &Settings)`, `pub fn remembered_lt_runtime(app: &AppHandle) -> Option<String>`, `pub fn remember_lt_runtime(app: &AppHandle, key: &str)`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `mod tests` en `src-tauri/src/settings.rs`:

```rust
    #[test]
    fn merge_conserva_el_runtime_de_disco_cuando_el_front_no_lo_manda() {
        // El frontend no conoce el campo, así que SIEMPRE llega None. Sin el
        // merge, cada set_settings (cambiar el tamaño de fuente, por ejemplo)
        // borraría lo que el backend descubrió.
        let mut incoming = Settings::default();
        let disk = Settings {
            languagetool_runtime: Some("apple".to_string()),
            ..Settings::default()
        };
        merge_backend_owned(&mut incoming, &disk);
        assert_eq!(incoming.languagetool_runtime, Some("apple".to_string()));
    }

    #[test]
    fn merge_no_pisa_un_valor_entrante_explicito() {
        let mut incoming = Settings {
            languagetool_runtime: Some("podman".to_string()),
            ..Settings::default()
        };
        let disk = Settings {
            languagetool_runtime: Some("apple".to_string()),
            ..Settings::default()
        };
        merge_backend_owned(&mut incoming, &disk);
        assert_eq!(incoming.languagetool_runtime, Some("podman".to_string()));
    }

    #[test]
    fn runtime_roundtripea_por_json() {
        let s = Settings {
            languagetool_runtime: Some("apple".to_string()),
            ..Settings::default()
        };
        let raw = serde_json::to_string(&s).unwrap();
        assert!(raw.contains("\"languagetoolRuntime\":\"apple\""), "raw: {raw}");
        let back: Settings = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.languagetool_runtime, Some("apple".to_string()));
    }
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml merge_ 2>&1 | tail -20`
Expected: FAIL de compilación — `struct Settings has no field named languagetool_runtime`, `cannot find function merge_backend_owned`.

- [ ] **Step 3: Implementar**

Campo nuevo, al final del struct `Settings` (después de `notes_pane_height`, `src-tauri/src/settings.rs:180`):

```rust
    /// Runtime de containers donde la app vio el container de LanguageTool
    /// ("docker" | "podman" | "apple"). Lo descubre y lo escribe el backend
    /// (`grammar.rs`); el frontend NO lo conoce ni lo manda. Ver
    /// `merge_backend_owned`.
    #[serde(
        default,
        rename = "languagetoolRuntime",
        skip_serializing_if = "Option::is_none"
    )]
    pub languagetool_runtime: Option<String>,
```

Reemplazar `get_settings`/`set_settings` (`src-tauri/src/settings.rs:192-207`) por:

```rust
/// Lectura cruda del archivo. La comparten el comando y los helpers del backend.
pub fn read_settings(app: &AppHandle) -> Result<Settings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Campos que descubre el backend por su cuenta y el frontend no conoce: si el
/// entrante no los trae (que es siempre), se conservan los de disco. Sin esto
/// hay una carrera real — el front guarda una copia de settings anterior a la
/// escritura del backend y le pisa el campo.
fn merge_backend_owned(incoming: &mut Settings, disk: &Settings) {
    if incoming.languagetool_runtime.is_none() {
        incoming.languagetool_runtime = disk.languagetool_runtime.clone();
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    read_settings(&app)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let mut settings = settings;
    if let Ok(disk) = read_settings(&app) {
        merge_backend_owned(&mut settings, &disk);
    }
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Runtime recordado, o `None` si no hay nada o el archivo no se pudo leer.
pub fn remembered_lt_runtime(app: &AppHandle) -> Option<String> {
    read_settings(app).ok()?.languagetool_runtime
}

/// Persiste el runtime si cambió. Best-effort: si falla, se loggea y sigue —
/// que la próxima vez vuelva a preguntar es peor que no arrancar el container
/// ahora.
pub fn remember_lt_runtime(app: &AppHandle, key: &str) {
    let Ok(mut s) = read_settings(app) else { return };
    if s.languagetool_runtime.as_deref() == Some(key) {
        return;
    }
    s.languagetool_runtime = Some(key.to_string());
    let Ok(path) = settings_path(app) else { return };
    match serde_json::to_string_pretty(&s) {
        Ok(raw) => {
            if let Err(e) = fs::write(&path, raw) {
                tracing::warn!(target: "grammar", error = %e, "no se pudo recordar el runtime de LanguageTool");
            }
        }
        Err(e) => {
            tracing::warn!(target: "grammar", error = %e, "no se pudo serializar settings");
        }
    }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(settings): languagetoolRuntime, campo propiedad del backend

El frontend no conoce el campo y por lo tanto siempre manda None; el
merge de set_settings conserva el de disco para que un guardado de
preferencias no borre lo que descubrió grammar.rs."
```

---

### Task 3: `detect_installed` pasa por `pick_runtime` y el status expone las opciones

**Files:**
- Modify: `src-tauri/src/grammar.rs` (`detect_installed` ~línea 266-272, `LtDockerStatus` ~línea 853-871, `languagetool_docker_status` ~línea 873-911)
- Test: `src-tauri/src/grammar.rs` (`mod tests`)

**Interfaces:**
- Consumes: `RuntimePick`, `pick_runtime`, `Runtime::key`/`from_key` (Task 1); `settings::remembered_lt_runtime`, `settings::remember_lt_runtime` (Task 2).
- Produces: `struct RuntimeChoice { key: String, label: String }`, `LtDockerStatus.runtime_choices: Vec<RuntimeChoice>`, `fn installed_runtimes() -> Vec<Runtime>`, `fn engine_for(rt: Runtime) -> Option<Engine>`, `fn pick_installed(app: &AppHandle) -> RuntimePick`, `fn ambiguous_remedy(rts: &[Runtime]) -> Remedy`, `fn runtime_choices(rts: &[Runtime]) -> Vec<RuntimeChoice>`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `mod tests` en `src-tauri/src/grammar.rs`:

```rust
    #[test]
    fn ambiguous_remedy_nombra_los_runtimes_y_no_trae_comando() {
        let r = ambiguous_remedy(&[Runtime::Docker, Runtime::Apple]);
        assert!(r.message.contains("Docker"), "message: {}", r.message);
        assert!(r.message.contains("Apple container"), "message: {}", r.message);
        // No hay un comando único que sirva: la UI ofrece un botón por runtime.
        assert_eq!(r.command, None);
        assert!(!r.can_run);
    }

    #[test]
    fn runtime_choices_usa_key_estable_y_label_de_ui() {
        let choices = runtime_choices(&[Runtime::Docker, Runtime::Apple]);
        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0].key, "docker");
        assert_eq!(choices[0].label, "Docker");
        assert_eq!(choices[1].key, "apple");
        assert_eq!(choices[1].label, "Apple container");
        // El key tiene que poder volver al enum: es lo que manda la UI al start.
        for c in &choices {
            assert!(Runtime::from_key(&c.key).is_some(), "key inválida: {}", c.key);
        }
    }
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml ambiguous_remedy runtime_choices 2>&1 | tail -20`
Expected: FAIL de compilación — `cannot find function 'ambiguous_remedy'` / `'runtime_choices'`.

- [ ] **Step 3: Implementar**

Agregar, justo después de `detect_installed` (`src-tauri/src/grammar.rs:272`). **`detect_installed`
queda intacta en esta task**: la siguen usando `languagetool_docker_start` y `_stop`, que se
migran en la Task 4, y el árbol tiene que compilar en cada commit.

```rust
/// Runtimes con binario presente, en el orden de `Runtime::ALL`.
fn installed_runtimes() -> Vec<Runtime> {
    Runtime::ALL
        .into_iter()
        .filter(|rt| rt.bin().is_some())
        .collect()
}

fn engine_for(rt: Runtime) -> Option<Engine> {
    rt.bin().map(|bin| Engine { rt, bin })
}

/// Con qué runtime operar cuando ningún daemon responde. Antes esto agarraba el
/// primero de `Runtime::ALL`, que no tiene ninguna relación con cuál es dueño
/// del container.
fn pick_installed(app: &AppHandle) -> RuntimePick {
    let remembered = settings::remembered_lt_runtime(app)
        .as_deref()
        .and_then(Runtime::from_key);
    pick_runtime(&installed_runtimes(), remembered)
}

/// Runtimes candidatos para que la UI arme un botón por cada uno.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeChoice {
    /// Clave estable, la que vuelve como parámetro de `languagetool_docker_start`.
    pub key: String,
    pub label: String,
}

fn runtime_choices(rts: &[Runtime]) -> Vec<RuntimeChoice> {
    rts.iter()
        .map(|rt| RuntimeChoice {
            key: rt.key().to_string(),
            label: rt.label().to_string(),
        })
        .collect()
}

/// Remedio cuando hay varios runtimes instalados, ninguno respondiendo y nada
/// recordado. No hay comando: la decisión es del autor y la toma con los
/// botones que arma la UI desde `runtime_choices`.
fn ambiguous_remedy(rts: &[Runtime]) -> Remedy {
    let nombres: Vec<&str> = rts.iter().map(|rt| rt.label()).collect();
    Remedy {
        message: format!(
            "Tenés más de un runtime de containers instalado ({}) y ninguno está respondiendo. ¿Cuál usás para LanguageTool?",
            nombres.join(", ")
        ),
        command: None,
        can_run: false,
    }
}
```

Agregar el import de settings arriba del archivo, junto a `use crate::secrets;` (`src-tauri/src/grammar.rs:8`):

```rust
use crate::settings;
```

Campo nuevo en `LtDockerStatus` (después de `install_options`, `src-tauri/src/grammar.rs:870`):

```rust
    /// Candidatos para que el autor elija. No vacío SOLO cuando hay más de un
    /// runtime instalado, ninguno respondiendo y nada recordado.
    pub runtime_choices: Vec<RuntimeChoice>,
```

Reemplazar el cuerpo de `languagetool_docker_status` (`src-tauri/src/grammar.rs:873-911`) por:

```rust
#[tauri::command]
pub async fn languagetool_docker_status(app: AppHandle) -> LtDockerStatus {
    let api_responding = ping_local_lt().await;

    // Con un daemon vivo hay evidencia: `detect_engine` ya prefiere el runtime
    // donde vive nuestro container. Si lo encontramos, lo recordamos.
    if let Some(e) = detect_engine() {
        let container_running = e.running();
        let container_exists = e.exists();
        if container_running || container_exists {
            settings::remember_lt_runtime(&app, e.rt.key());
        }
        return LtDockerStatus {
            docker_installed: true,
            runtime: Some(e.rt.label().to_string()),
            daemon_running: true,
            container_running,
            container_exists,
            api_responding,
            remedy: None,
            install_options: Vec::new(),
            runtime_choices: Vec::new(),
        };
    }

    // Ningún daemon responde: sin daemon el CLI no puede ni listar containers
    // (Apple `container ls` falla con XPC connection error), así que los flags
    // quedan en false y `daemon_running` es el que explica por qué.
    match pick_installed(&app) {
        RuntimePick::Chosen(rt) => LtDockerStatus {
            docker_installed: true,
            runtime: Some(rt.label().to_string()),
            daemon_running: false,
            container_running: false,
            container_exists: false,
            api_responding,
            remedy: Some(daemon_remedy(rt)),
            install_options: Vec::new(),
            runtime_choices: Vec::new(),
        },
        RuntimePick::Ambiguous(rts) => LtDockerStatus {
            docker_installed: true,
            // No afirmamos un runtime que no sabemos cuál es.
            runtime: None,
            daemon_running: false,
            container_running: false,
            container_exists: false,
            api_responding,
            remedy: Some(ambiguous_remedy(&rts)),
            install_options: Vec::new(),
            runtime_choices: runtime_choices(&rts),
        },
        RuntimePick::None => LtDockerStatus {
            docker_installed: false,
            runtime: None,
            daemon_running: false,
            container_running: false,
            container_exists: false,
            api_responding,
            remedy: Some(no_runtime_remedy()),
            install_options: install_options(Os::current()),
            runtime_choices: Vec::new(),
        },
    }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: PASS. `languagetool_docker_start`/`_stop` siguen usando `detect_installed` y compilan sin cambios.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/grammar.rs
git commit -m "fix(grammar): el status elige runtime por evidencia, no por orden fijo

detect_installed pasa a resolver por pick_runtime con el runtime
recordado; cuando hay varios candidatos el status devuelve
runtime_choices y no afirma ninguno. El runtime se recuerda cuando el
container aparece corriendo o existente."
```

---

### Task 4: `start` acepta el runtime elegido, `stop` no adivina

**Files:**
- Modify: `src-tauri/src/grammar.rs` (`languagetool_docker_start` ~línea 1127-1133, `languagetool_docker_stop` ~línea 1231-1236)

**Interfaces:**
- Consumes: `RuntimePick`, `pick_installed`, `engine_for`, `Runtime::from_key`, `settings::remember_lt_runtime`.
- Produces: `languagetool_docker_start(app: AppHandle, runtime: Option<String>)`, `languagetool_docker_stop(app: AppHandle)`.

- [ ] **Step 1: Reemplazar la resolución del engine en `start`**

Reemplazar las líneas 1127-1133 de `src-tauri/src/grammar.rs`:

```rust
#[tauri::command]
pub async fn languagetool_docker_start(
    app: AppHandle,
    runtime: Option<String>,
) -> Result<String, String> {
    emit_progress(&app, "checking", "Buscando un runtime de containers…");
    // `runtime` viene lleno solo cuando el autor eligió en la UI (caso
    // ambiguo). Sin elección explícita, decide `pick_installed`.
    let rt = match runtime.as_deref().and_then(Runtime::from_key) {
        Some(rt) => rt,
        None => match pick_installed(&app) {
            RuntimePick::Chosen(rt) => rt,
            // La UI no llega acá: cuando `runtime_choices` no viene vacío
            // muestra los botones. El comando no confía en eso igual.
            RuntimePick::Ambiguous(rts) => return Err(ambiguous_remedy(&rts).message),
            RuntimePick::None => return Err(no_runtime_remedy().message),
        },
    };
    let Some(engine) = engine_for(rt) else {
        return Err(no_runtime_remedy().message);
    };
    // Se recuerda antes de bajar nada: si el pull se corta a la mitad, la
    // próxima vez seguimos apuntando al mismo runtime y no al primero de la
    // lista.
    settings::remember_lt_runtime(&app, rt.key());
```

El resto del cuerpo (desde `emit_progress(&app, "checking", format!("Usando {}. …"` en adelante) queda **igual**.

- [ ] **Step 2: Reemplazar la resolución del engine en `stop`**

Reemplazar las líneas 1231-1236 de `src-tauri/src/grammar.rs`:

```rust
#[tauri::command]
pub async fn languagetool_docker_stop(app: AppHandle) -> Result<(), String> {
    let engine = match detect_engine() {
        Some(e) => Some(e),
        None => match pick_installed(&app) {
            RuntimePick::Chosen(rt) => engine_for(rt),
            // Frenar un container que no sabemos dónde vive no tiene sentido, y
            // frenar el del runtime equivocado tampoco.
            RuntimePick::Ambiguous(_) | RuntimePick::None => None,
        },
    };
    let Some(engine) = engine else {
        return Ok(()); // sin runtime resuelto no hay nada que detener
    };
```

El resto del cuerpo (desde `let out = engine.stop_container()`) queda **igual**.

- [ ] **Step 3: Borrar `detect_installed`**

Ya no la usa nadie: eliminar la función completa (`src-tauri/src/grammar.rs:266-272` antes de
la Task 3, ahora justo arriba de `installed_runtimes`) junto con su doc comment.

- [ ] **Step 4: Compilar y correr los tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: PASS, sin warnings de función sin usar.

- [ ] **Step 5: Verificar que no quedó ningún uso viejo**

Run: `grep -n "detect_installed" src-tauri/src/grammar.rs`
Expected: sin resultados.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/grammar.rs
git commit -m "fix(grammar): start acepta el runtime elegido y stop no adivina

languagetool_docker_start toma runtime: Option<String> — la elección
explícita de la UI cuando hay varios candidatos — y la persiste antes de
bajar la imagen. stop es no-op si el pick es ambiguo."
```

---

### Task 5: el frontend conoce las opciones y las manda

**Files:**
- Modify: `src/app/core/grammar-service.ts` (`LtDockerStatus` ~línea 35-53, `dockerStatus`/`dockerStart` ~línea 179-192)
- Modify: `src/app/grammar-settings/grammar-settings.ts` (`startDocker` ~línea 125-143)

**Interfaces:**
- Consumes: el contrato serializado de Task 3/4 (`runtime_choices: { key, label }[]`, parámetro `runtime` de `languagetool_docker_start`).
- Produces: `RuntimeChoice` (TS), `GrammarService.dockerStart(runtime?: string)`, `GrammarSettings.startDocker(runtime?: string)`.

- [ ] **Step 1: Sumar el tipo y el campo en el servicio**

En `src/app/core/grammar-service.ts`, después de `InstallOption` (línea 33):

```ts
/** Runtime candidato cuando la app no puede saber cuál usa LanguageTool. */
export interface RuntimeChoice {
  /** Clave estable que vuelve como parámetro de dockerStart. */
  key: string;
  label: string;
}
```

Y dentro de `LtDockerStatus`, después de `install_options` (línea 52):

```ts
  /**
   * Candidatos entre los que elegir. No vacío SOLO cuando hay más de un runtime
   * instalado, ninguno respondiendo y nada recordado.
   */
  runtime_choices: RuntimeChoice[];
```

- [ ] **Step 2: Pasar el runtime elegido al invoke**

Reemplazar `dockerStart` (`src/app/core/grammar-service.ts:183-192`):

```ts
  async dockerStart(runtime?: string): Promise<string> {
    try {
      const msg = await invoke<string>('languagetool_docker_start', {
        runtime: runtime ?? null,
      });
      this.debug.info('grammar', `LanguageTool Docker arrancado`, msg);
      return msg;
    } catch (e) {
      this.debug.error('grammar', `falló arrancar Docker LanguageTool`, String(e));
      throw e;
    }
  }
```

- [ ] **Step 3: Propagar el parámetro desde el componente**

Reemplazar la firma y la llamada en `src/app/grammar-settings/grammar-settings.ts:125-131`:

```ts
  protected async startDocker(runtime?: string): Promise<void> {
    this.dockerBusy.set('starting');
    this.dockerPhase.set('checking');
    this.dockerMessage.set('Buscando un runtime de containers…');
    await this.attachProgressListener();
    try {
      const msg = await this.grammar.dockerStart(runtime);
```

El resto del método queda **igual**.

- [ ] **Step 4: Compilar**

Run: `pnpm build 2>&1 | tail -15`
Expected: build exitoso.

- [ ] **Step 5: Commit**

```bash
git add src/app/core/grammar-service.ts src/app/grammar-settings/grammar-settings.ts
git commit -m "feat(grammar-settings): el front pasa el runtime elegido al start"
```

---

### Task 6: la UI pregunta en vez de adivinar

**Files:**
- Modify: `src/app/grammar-settings/grammar-settings.html` (rama `@else if (!ds.daemon_running)`, líneas 121-158)
- Modify: `src/app/grammar-settings/grammar-settings.scss` (estilo de la lista de botones)

**Interfaces:**
- Consumes: `ds.runtime_choices` (Task 5), `startDocker(runtime?)` (Task 5).
- Produces: nada para tasks posteriores.

- [ ] **Step 1: Bifurcar la rama del daemon caído**

En `src/app/grammar-settings/grammar-settings.html`, reemplazar el bloque que arranca en la línea 121 (`} @else if (!ds.daemon_running) {`) hasta el `}` que cierra antes de `@else if (ds.container_running && ds.api_responding)` (línea 159), por:

```html
                } @else if (!ds.daemon_running) {
                  <!-- El daemon no responde: sin él el CLI no puede ni listar
                       containers, así que container_running/exists no dicen nada. -->
                  <div class="docker-status warn">
                    {{ ds.remedy?.message ?? 'El daemon del runtime no responde.' }}
                  </div>
                  @if (ds.runtime_choices.length > 0) {
                    <!-- Varios runtimes instalados y ninguno respondiendo:
                         adivinar acá es el bug — arrancar el equivocado baja
                         ~300MB y crea un container paralelo. Pregunta y
                         recuerda la respuesta. -->
                    <div class="runtime-choices">
                      @for (choice of ds.runtime_choices; track choice.key) {
                        <button
                          type="button"
                          class="btn btn-secondary docker-btn"
                          [disabled]="dockerBusy() !== null"
                          (click)="startDocker(choice.key)"
                        >
                          Usar {{ choice.label }}
                        </button>
                      }
                    </div>
                  } @else if (ds.remedy; as rem) {
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
                    } @else {
                      <!-- No podemos arrancarlo solos (ej. Docker en Linux
                           necesita sudo): el usuario corre el comando de arriba
                           en su propia terminal y vuelve. El status solo se
                           refresca al abrir el panel o después de start/stop,
                           así que sin este botón queda diciendo "caído" hasta
                           que el usuario cierra y reabre la ventana. No es un
                           botón de arranque, no viola el constraint de
                           `can_run: false`. -->
                      <button
                        type="button"
                        class="btn btn-secondary docker-btn"
                        [disabled]="dockerBusy() !== null"
                        (click)="refreshDockerStatus()"
                      >
                        Volver a chequear
                      </button>
                    }
                  }
                } @else if (ds.container_running && ds.api_responding) {
```

- [ ] **Step 2: Estilar la fila de botones**

Agregar al final de `src/app/grammar-settings/grammar-settings.scss`:

```scss
/* Un botón por runtime candidato. Envuelve en ventanas angostas en vez de
   desbordar; son 2-3 botones como mucho. */
.runtime-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
```

- [ ] **Step 3: Compilar**

Run: `pnpm build 2>&1 | tail -15`
Expected: build exitoso.

- [ ] **Step 4: Verificar que el caso de un solo runtime no cambió**

Run: `grep -n "Levantar LanguageTool" src/app/grammar-settings/grammar-settings.html`
Expected: el botón sigue existiendo, ahora dentro del `@else if (ds.remedy; as rem)`. Con `runtime_choices` vacío (máquina con un solo runtime) la UI es idéntica a la de antes.

- [ ] **Step 5: Commit**

```bash
git add src/app/grammar-settings/grammar-settings.html src/app/grammar-settings/grammar-settings.scss
git commit -m "feat(grammar-settings): elegir runtime cuando la app no puede saberlo

Con varios runtimes instalados y ninguno respondiendo, la fase daemon
muestra un botón por candidato en vez del botón único que arrancaba el
primero de la lista."
```

---

### Task 7: cerrar el item del TODO

**Files:**
- Modify: `TODO.md` (item "`detect_installed` elige runtime sin saber cuál es dueño del container", sección Plataformas, líneas 372-386)

**Interfaces:**
- Consumes: nada.
- Produces: nada.

- [ ] **Step 1: Marcar el item con el resumen de lo implementado**

Reemplazar el `- **\`detect_installed\` elige runtime...` de `TODO.md:372` por un `- [x]` con el mismo cuerpo más un párrafo de estado:

```markdown
  **Estado**: implementado en `fix/lt-runtime-recordado` — spec en
  `docs/superpowers/specs/2026-07-30-lt-runtime-recordado-design.md`.
  `pick_runtime(installed, remembered)` es la única fuente de la decisión
  (pura, testeada en matriz), el runtime se recuerda en el campo
  `languagetoolRuntime` de `settings.json` cuando la app ve el container
  corriendo o existente, y `set_settings` lo protege del round-trip del
  frontend vía `merge_backend_owned` (el front no conoce el campo). Cuando hay
  varios runtimes instalados, ninguno respondiendo y nada recordado, el status
  devuelve `runtime_choices` y la UI ofrece un botón por candidato en vez de
  adivinar. **Falta la verificación a mano** (la hace el autor).
```

- [ ] **Step 2: Commit**

```bash
git add TODO.md
git commit -m "docs: cerrar el item de detect_installed en TODO.md"
```

---

## Verificación a mano (la hace el autor, en macOS)

Después del último commit, pasarle este checklist:

1. Con el container corriendo en Apple `container`, abrir la config de gramática y confirmar
   que `~/Library/Application Support/<bundle>/settings.json` quedó con
   `"languagetoolRuntime": "apple"`.
2. `container system stop` → reabrir la app → la fase daemon nombra Apple container (no
   Docker) y el botón arranca el correcto.
3. Cambiar el tamaño de fuente del editor (fuerza un `set_settings` desde el front) y
   confirmar que `languagetoolRuntime` sigue en el archivo.
4. Borrar el campo a mano con los dos daemons caídos → la UI ofrece "Usar Docker" y "Usar
   Apple container"; elegir Apple y confirmar que arranca ese y que el campo quedó escrito.
5. En una máquina con un solo runtime, confirmar que la UI es la de siempre (un botón).
