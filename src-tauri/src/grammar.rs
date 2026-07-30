use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

use crate::secrets;

const LT_CONTAINER: &str = "twriter-languagetool";
const LT_IMAGE: &str = "erikvl87/languagetool:latest";

/// Runtime de containers soportado. tWriter maneja LanguageTool con cualquiera
/// de los tres comunes; no asume Docker. En Mac conviven Docker Desktop, colima
/// (ambos exponen el CLI `docker`), Podman y el `container` nativo de Apple.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Runtime {
    Docker,
    Podman,
    Apple,
}

impl Runtime {
    // Prioridad de detección: Docker y Podman primero (docker-compatibles),
    // Apple al final (sintaxis propia). El desempate real lo hace `detect_engine`,
    // que prefiere el runtime donde ya vive nuestro container.
    const ALL: [Runtime; 3] = [Runtime::Docker, Runtime::Podman, Runtime::Apple];

    fn label(self) -> &'static str {
        match self {
            Runtime::Docker => "Docker",
            Runtime::Podman => "Podman",
            Runtime::Apple => "Apple container",
        }
    }

    fn cmd(self) -> &'static str {
        match self {
            Runtime::Docker => "docker",
            Runtime::Podman => "podman",
            Runtime::Apple => "container",
        }
    }

    /// Rutas absolutas conocidas por runtime. Una app lanzada desde Finder/Dock
    /// hereda el PATH mínimo de launchd (`/usr/bin:/bin:/usr/sbin:/sbin`), que no
    /// incluye los symlinks de Homebrew ni Docker Desktop, así que
    /// `Command::new("docker")` fallaría aunque esté instalado.
    fn candidates(self) -> &'static [&'static str] {
        match self {
            Runtime::Docker => &[
                "/usr/local/bin/docker",                                  // Docker Desktop (Intel) / Homebrew
                "/opt/homebrew/bin/docker",                               // Homebrew (Apple Silicon) / colima
                "/Applications/Docker.app/Contents/Resources/bin/docker", // Docker Desktop interno
                "/usr/bin/docker",                                        // paquetes nativos Linux
            ],
            Runtime::Podman => &[
                "/opt/homebrew/bin/podman", // Homebrew (Apple Silicon)
                "/usr/local/bin/podman",    // Homebrew (Intel)
                "/usr/bin/podman",          // paquetes nativos Linux
            ],
            Runtime::Apple => &[
                "/opt/homebrew/bin/container", // Apple container (Homebrew)
                "/usr/local/bin/container",
            ],
        }
    }

    /// Resuelve el binario: rutas absolutas → `~/.docker/bin` (solo Docker) →
    /// nombre pelado en el PATH (dev / Linux). `None` si no está instalado.
    fn bin(self) -> Option<String> {
        for c in self.candidates() {
            if std::path::Path::new(c).exists() {
                return Some((*c).to_string());
            }
        }
        if self == Runtime::Docker {
            if let Some(home) = std::env::var_os("HOME") {
                let user = std::path::Path::new(&home).join(".docker/bin/docker");
                if user.exists() {
                    return Some(user.to_string_lossy().into_owned());
                }
            }
        }
        let on_path = Command::new(self.cmd())
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        on_path.then(|| self.cmd().to_string())
    }
}

/// Un runtime concreto ya resuelto a su binario, con las operaciones que
/// necesita el ciclo de vida de LanguageTool. Absorbe las diferencias de CLI
/// entre Docker/Podman (compatibles) y Apple `container`.
#[derive(Clone)]
struct Engine {
    rt: Runtime,
    bin: String,
}

impl Engine {
    /// ¿Responde el daemon? Docker/Podman: `info`. Apple: `system status`.
    fn daemon_ok(&self) -> bool {
        let args: &[&str] = match self.rt {
            Runtime::Docker | Runtime::Podman => &["info"],
            Runtime::Apple => &["system", "status"],
        };
        Command::new(&self.bin)
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

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

    /// Nombres de containers. Docker/Podman soportan Go templates
    /// (`--format {{.Names}}`); Apple `container` no, solo `json` → parseamos
    /// `configuration.id` (que es el `--name` que le pasamos). `all` incluye
    /// los apagados (`-a`), igual que `docker ps -a`.
    fn names(&self, all: bool) -> Vec<String> {
        match self.rt {
            Runtime::Docker | Runtime::Podman => {
                let mut args: Vec<&str> = vec!["ps"];
                if all {
                    args.push("-a");
                }
                args.extend_from_slice(&["--format", "{{.Names}}"]);
                Command::new(&self.bin)
                    .args(&args)
                    .output()
                    .ok()
                    .map(|o| {
                        String::from_utf8_lossy(&o.stdout)
                            .lines()
                            .map(|l| l.trim().to_string())
                            .filter(|l| !l.is_empty())
                            .collect()
                    })
                    .unwrap_or_default()
            }
            Runtime::Apple => {
                let mut args: Vec<&str> = vec!["ls"];
                if all {
                    args.push("-a");
                }
                args.extend_from_slice(&["--format", "json"]);
                Command::new(&self.bin)
                    .args(&args)
                    .output()
                    .ok()
                    .and_then(|o| serde_json::from_slice::<Vec<AppleContainer>>(&o.stdout).ok())
                    .map(|v| v.into_iter().map(|c| c.configuration.id).collect())
                    .unwrap_or_default()
            }
        }
    }

    fn running(&self) -> bool {
        self.names(false).iter().any(|n| n == LT_CONTAINER)
    }

    fn exists(&self) -> bool {
        self.names(true).iter().any(|n| n == LT_CONTAINER)
    }

    fn pull(&self) -> std::io::Result<std::process::Output> {
        match self.rt {
            Runtime::Docker | Runtime::Podman => {
                Command::new(&self.bin).args(["pull", LT_IMAGE]).output()
            }
            Runtime::Apple => Command::new(&self.bin)
                .args(["image", "pull", LT_IMAGE])
                .output(),
        }
    }

    /// Args de `run` para crear el container. Apple `container` no soporta
    /// `--restart`, así que solo lo agregamos para Docker/Podman.
    fn run_args(&self) -> Vec<&'static str> {
        let mut args: Vec<&'static str> = vec!["run", "-d", "--name", LT_CONTAINER];
        if matches!(self.rt, Runtime::Docker | Runtime::Podman) {
            args.extend_from_slice(&["--restart", "unless-stopped"]);
        }
        args.extend_from_slice(&[
            "-p",
            "8081:8010",
            "-e",
            "Java_Xms=512m",
            "-e",
            "Java_Xmx=2g",
            LT_IMAGE,
        ]);
        args
    }

    /// Crea y levanta el container.
    fn run_lt(&self) -> std::io::Result<std::process::Output> {
        Command::new(&self.bin).args(self.run_args()).output()
    }

    fn start_container(&self) -> std::io::Result<std::process::Output> {
        Command::new(&self.bin).args(["start", LT_CONTAINER]).output()
    }

    fn stop_container(&self) -> std::io::Result<std::process::Output> {
        Command::new(&self.bin).args(["stop", LT_CONTAINER]).output()
    }
}

/// Shape mínimo del `container ls --format json` de Apple: solo nos importa el
/// id (== `--name`).
#[derive(Deserialize)]
struct AppleContainer {
    configuration: AppleContainerConfig,
}

#[derive(Deserialize)]
struct AppleContainerConfig {
    id: String,
}

/// Primer runtime con daemon vivo. Prefiere aquel donde ya vive nuestro
/// container (corriendo, luego existente), sino el primero por prioridad. Así,
/// si LanguageTool ya está levantado en Apple `container`, no lo ignoramos por
/// tener también Docker instalado.
fn detect_engine() -> Option<Engine> {
    let mut live: Vec<Engine> = Vec::new();
    for rt in Runtime::ALL {
        if let Some(bin) = rt.bin() {
            let engine = Engine { rt, bin };
            if engine.daemon_ok() {
                live.push(engine);
            }
        }
    }
    if let Some(e) = live.iter().find(|e| e.running()) {
        return Some(e.clone());
    }
    if let Some(e) = live.iter().find(|e| e.exists()) {
        return Some(e.clone());
    }
    live.into_iter().next()
}

/// Cualquier runtime instalado (binario presente), aunque el daemon esté
/// apagado. Distingue "no hay runtime" de "instalado pero apagado".
fn detect_installed() -> Option<Engine> {
    Runtime::ALL
        .into_iter()
        .find_map(|rt| rt.bin().map(|bin| Engine { rt, bin }))
}

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

const PUBLIC_BASE: &str = "https://api.languagetool.org";
const LOCAL_BASE: &str = "http://localhost:8081";
const MAX_CHUNK_BYTES: usize = 19_500;
const PUBLIC_RPM_LIMIT: u32 = 18;
const PUBLIC_BPM_LIMIT: usize = 70_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const PING_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Serialize, Debug, Clone)]
pub struct GrammarMatch {
    pub offset: usize,
    pub length: usize,
    pub message: String,
    #[serde(rename = "shortMessage")]
    pub short_message: String,
    #[serde(rename = "ruleId")]
    pub rule_id: String,
    pub category: String,
    pub replacements: Vec<String>,
}

#[derive(Deserialize, Clone)]
pub struct GrammarConfig {
    pub mode: String,
    #[serde(default, rename = "customUrl")]
    pub custom_url: Option<String>,
    #[serde(default, rename = "variantEs")]
    pub variant_es: Option<String>,
    #[serde(default, rename = "variantEn")]
    pub variant_en: Option<String>,
    /// LanguageTool Premium / self-hosted con auth. Solo aplica si `mode == "custom"`.
    #[serde(default, rename = "ltUsername")]
    pub lt_username: Option<String>,
    /// Override transitorio del apiKey, solo usado por el modal de gramática para
    /// poder hacer "Probar conexión" antes de persistir. En operación normal
    /// (check_grammar de cada chunk) este campo viene `None` y el backend lo
    /// carga del keyring del OS vía `secrets::load_lt_api_key`.
    #[serde(default, rename = "ltApiKey")]
    pub lt_api_key: Option<String>,
}

// Debug manual: nunca exponer el apiKey en logs ni snapshots.
impl std::fmt::Debug for GrammarConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GrammarConfig")
            .field("mode", &self.mode)
            .field("custom_url", &self.custom_url)
            .field("variant_es", &self.variant_es)
            .field("variant_en", &self.variant_en)
            .field("lt_username", &self.lt_username)
            .field("lt_api_key", &self.lt_api_key.as_ref().map(|_| "***"))
            .finish()
    }
}

#[derive(Deserialize)]
struct LtResponse {
    matches: Vec<LtMatch>,
}

#[derive(Deserialize)]
struct LtMatch {
    message: String,
    #[serde(default, rename = "shortMessage")]
    short_message: String,
    offset: usize,
    length: usize,
    #[serde(default)]
    replacements: Vec<LtReplacement>,
    rule: LtRule,
}

#[derive(Deserialize)]
struct LtReplacement {
    value: String,
}

#[derive(Deserialize)]
struct LtRule {
    id: String,
    category: LtCategory,
}

#[derive(Deserialize)]
struct LtCategory {
    id: String,
}

struct PublicRateBudget {
    requests: Vec<Instant>,
    bytes: Vec<(Instant, usize)>,
}

impl PublicRateBudget {
    const fn new() -> Self {
        Self {
            requests: Vec::new(),
            bytes: Vec::new(),
        }
    }

    fn prune(&mut self) {
        let cutoff = Instant::now() - Duration::from_secs(60);
        self.requests.retain(|t| *t >= cutoff);
        self.bytes.retain(|(t, _)| *t >= cutoff);
    }

    fn try_consume(&mut self, size: usize) -> Result<(), String> {
        self.prune();
        if self.requests.len() as u32 >= PUBLIC_RPM_LIMIT {
            return Err(
                "Límite del API público alcanzado (20 req/min). Esperá un minuto o cambiá a modo local."
                    .into(),
            );
        }
        let used: usize = self.bytes.iter().map(|(_, b)| *b).sum();
        if used + size > PUBLIC_BPM_LIMIT {
            return Err(
                "Cuota de bytes del API público alcanzada (75KB/min). Esperá o cambiá a modo local."
                    .into(),
            );
        }
        let now = Instant::now();
        self.requests.push(now);
        self.bytes.push((now, size));
        Ok(())
    }
}

static PUBLIC_BUDGET: Mutex<PublicRateBudget> = Mutex::new(PublicRateBudget::new());

fn resolve_base(cfg: &GrammarConfig) -> Result<String, String> {
    match cfg.mode.as_str() {
        "public" => Ok(PUBLIC_BASE.to_string()),
        "local" => Ok(LOCAL_BASE.to_string()),
        "custom" => cfg
            .custom_url
            .as_deref()
            .map(|s| s.trim_end_matches('/').to_string())
            .ok_or_else(|| "Modo custom sin URL configurada".into()),
        other => Err(format!("Modo de gramática desconocido: {}", other)),
    }
}

fn map_lang(lang: &str, cfg: &GrammarConfig) -> String {
    match lang {
        "es" => cfg.variant_es.clone().unwrap_or_else(|| "es-AR".into()),
        "en" => cfg.variant_en.clone().unwrap_or_else(|| "en-US".into()),
        "" | "auto" => "auto".into(),
        other => other.into(),
    }
}

fn preferred_variants(cfg: &GrammarConfig) -> String {
    let es = cfg.variant_es.clone().unwrap_or_else(|| "es-AR".into());
    let en = cfg.variant_en.clone().unwrap_or_else(|| "en-US".into());
    format!("{},{}", es, en)
}

fn category_of(rule_cat: &str) -> String {
    match rule_cat {
        c if c.starts_with("TYPO") => "TYPOS".into(),
        c if c.contains("GRAMMAR") => "GRAMMAR".into(),
        "STYLE" | "REDUNDANCY" | "TYPOGRAPHY" | "PLAIN_ENGLISH" | "CASING" => rule_cat.into(),
        _ => rule_cat.into(),
    }
}

#[tauri::command]
pub async fn check_grammar_available(cfg: GrammarConfig) -> bool {
    let base = match resolve_base(&cfg) {
        Ok(b) => b,
        Err(_) => return false,
    };
    if cfg.mode == "public" {
        return true;
    }
    let url = format!("{}/v2/languages", base);
    let client = match reqwest::Client::builder().timeout(PING_TIMEOUT).build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    matches!(client.get(&url).send().await, Ok(r) if r.status().is_success())
}

#[tauri::command]
pub async fn check_grammar(
    app: AppHandle,
    text: String,
    lang: String,
    cfg: GrammarConfig,
) -> Result<Vec<GrammarMatch>, String> {
    let base = resolve_base(&cfg)?;
    let lang_code = map_lang(&lang, &cfg);
    let chunks = split_chunks(&text);
    if chunks.len() > 1 {
        tracing::info!(target: "grammar", bytes = text.len(), partes = chunks.len(), "texto >20KB, chunking aplicado");
    }
    tracing::info!(target: "grammar", mode = %cfg.mode, lang = %lang_code, partes = chunks.len(), "check_grammar inicio");
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| {
            tracing::error!(target: "grammar", error = %e, "no se pudo construir HTTP client");
            format!("HTTP client: {}", e)
        })?;

    // Para modo custom, si cfg no trae apiKey transitorio, cargamos del keyring.
    let resolved_key = if cfg.mode == "custom" && cfg.lt_api_key.is_none() {
        secrets::load_lt_api_key(&app)
    } else {
        cfg.lt_api_key.clone()
    };
    let cfg_with_key = GrammarConfig {
        lt_api_key: resolved_key,
        ..cfg
    };

    let mut all_matches: Vec<GrammarMatch> = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        if cfg_with_key.mode == "public" {
            let mut bug = PUBLIC_BUDGET
                .lock()
                .map_err(|_| "lock envenenado".to_string())?;
            bug.try_consume(chunk.text.len())?;
            drop(bug);
        }
        if i > 0 {
            sleep(Duration::from_millis(250)).await;
        }
        let matches = post_check(&client, &base, &chunk.text, &lang_code, &cfg_with_key).await?;
        for m in matches {
            all_matches.push(GrammarMatch {
                offset: m.offset + chunk.start,
                length: m.length,
                message: m.message,
                short_message: m.short_message,
                rule_id: m.rule.id,
                category: category_of(&m.rule.category.id),
                replacements: m.replacements.into_iter().map(|r| r.value).collect(),
            });
        }
    }
    Ok(all_matches)
}

async fn post_check(
    client: &reqwest::Client,
    base: &str,
    text: &str,
    lang: &str,
    cfg: &GrammarConfig,
) -> Result<Vec<LtMatch>, String> {
    let url = format!("{}/v2/check", base);
    let mut params: Vec<(&str, String)> = vec![
        ("text", text.to_string()),
        ("language", lang.to_string()),
        ("level", "default".to_string()),
    ];
    if lang == "auto" {
        params.push(("preferredVariants", preferred_variants(cfg)));
    }
    // Premium / self-hosted auth: solo en modo custom, ambos campos requeridos.
    // NUNCA loggear el apiKey en plain text.
    if cfg.mode == "custom" {
        if let (Some(user), Some(key)) = (cfg.lt_username.as_deref(), cfg.lt_api_key.as_deref()) {
            let user = user.trim();
            let key = key.trim();
            if !user.is_empty() && !key.is_empty() {
                params.push(("username", user.to_string()));
                params.push(("apiKey", key.to_string()));
            }
        }
    }
    let resp = client
        .post(&url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("LanguageTool: {}", e))?;
    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(|s| format!(" (retry-after: {}s)", s))
            .unwrap_or_default();
        tracing::warn!(target: "grammar", retry = %retry, "LanguageTool rate-limit servidor");
        return Err(format!(
            "LanguageTool rate-limit{}. Esperá un minuto o cambiá a modo local.",
            retry
        ));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        tracing::error!(target: "grammar", status = %status, body = %body, "LanguageTool HTTP error");
        return Err(format!("LanguageTool {}: {}", status, body));
    }
    let parsed: LtResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse LT response: {}", e))?;
    Ok(parsed.matches)
}

struct Chunk {
    /// Offset del chunk en el texto original, contado en **UTF-16 code units**
    /// (la unidad que usa LanguageTool en `match.offset` y JavaScript en
    /// `string.slice`). El frontend suma `m.offset + chunk.start` para mapear
    /// matches de chunk N>0 a la posición global; mezclarlo con bytes UTF-8
    /// corre los squiggles cada vez que el prefijo tiene un char no-ASCII.
    start: usize,
    text: String,
}

fn split_chunks(text: &str) -> Vec<Chunk> {
    if text.len() <= MAX_CHUNK_BYTES {
        return vec![Chunk { start: 0, text: text.to_string() }];
    }
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut byte_cursor = 0;
    let mut utf16_cursor: usize = 0;
    while byte_cursor < bytes.len() {
        let end_target = (byte_cursor + MAX_CHUNK_BYTES).min(bytes.len());
        let split_at = if end_target == bytes.len() {
            end_target
        } else {
            find_split(text, byte_cursor, end_target)
        };
        let slice = &text[byte_cursor..split_at];
        out.push(Chunk {
            start: utf16_cursor,
            text: slice.to_string(),
        });
        utf16_cursor += slice.chars().map(|c| c.len_utf16()).sum::<usize>();
        byte_cursor = split_at;
    }
    out
}

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

#[derive(Serialize, Clone)]
struct LtProgress {
    phase: &'static str,
    message: String,
}

fn emit_progress(app: &AppHandle, phase: &'static str, message: impl Into<String>) {
    let msg: String = message.into();
    tracing::info!(target: "grammar", phase, msg = %msg, "languagetool progress");
    let _ = app.emit(
        "languagetool-progress",
        LtProgress {
            phase,
            message: msg,
        },
    );
}

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

#[tauri::command]
pub async fn languagetool_docker_start(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "checking", "Buscando un runtime de containers…");
    let engine = match detect_installed() {
        Some(e) => e,
        None => return Err(no_runtime_remedy().message),
    };
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

    if engine.running() {
        emit_progress(&app, "ready", "El container ya estaba corriendo.");
        return Ok("Ya estaba corriendo.".into());
    }

    if engine.exists() {
        emit_progress(&app, "starting", "Reiniciando container existente…");
        let out = engine
            .start_container()
            .map_err(|e| format!("{} start: {}", engine.rt.cmd(), e))?;
        if !out.status.success() {
            return Err(format!(
                "start falló: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    } else {
        emit_progress(
            &app,
            "pulling",
            "Bajando imagen erikvl87/languagetool (~300MB, puede tardar 1–3 min según conexión)…",
        );
        let engine_pull = engine.clone();
        let pull = tokio::task::spawn_blocking(move || engine_pull.pull())
            .await
            .map_err(|e| format!("spawn pull: {}", e))?
            .map_err(|e| format!("pull: {}", e))?;
        if !pull.status.success() {
            return Err(format!(
                "pull falló: {}",
                String::from_utf8_lossy(&pull.stderr)
            ));
        }
        emit_progress(&app, "starting", "Creando container en localhost:8081…");
        let run = engine
            .run_lt()
            .map_err(|e| format!("{} run: {}", engine.rt.cmd(), e))?;
        if !run.status.success() {
            return Err(format!(
                "run falló: {}",
                String::from_utf8_lossy(&run.stderr)
            ));
        }
    }

    emit_progress(
        &app,
        "loading",
        "Cargando modelos de español + inglés (~30s la primera vez)…",
    );
    for _ in 0..40 {
        if ping_local_lt().await {
            emit_progress(&app, "ready", "LanguageTool listo en localhost:8081");
            tracing::info!(target: "grammar", runtime = engine.rt.label(), "LanguageTool listo en localhost:8081");
            return Ok("LanguageTool listo en localhost:8081".into());
        }
        sleep(Duration::from_millis(1000)).await;
    }
    tracing::error!(target: "grammar", "container levantado pero LT no responde tras 40s");
    Err(format!(
        "Container levantado pero no responde después de 40s. Revisá `{} logs {}`.",
        engine.rt.cmd(),
        LT_CONTAINER
    ))
}

#[tauri::command]
pub async fn languagetool_docker_stop() -> Result<(), String> {
    let engine = match detect_engine().or_else(detect_installed) {
        Some(e) => e,
        None => return Ok(()), // sin runtime no hay nada que detener
    };
    let out = engine
        .stop_container()
        .map_err(|e| format!("{} stop: {}", engine.rt.cmd(), e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.to_lowercase().contains("no such container") {
            return Ok(());
        }
        tracing::error!(target: "grammar", error = %err, "stop LanguageTool falló");
        return Err(format!("stop falló: {}", err));
    }
    tracing::info!(target: "grammar", runtime = engine.rt.label(), "LanguageTool detenido");
    Ok(())
}

async fn ping_local_lt() -> bool {
    let client = match reqwest::Client::builder().timeout(PING_TIMEOUT).build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    matches!(
        client.get("http://localhost:8081/v2/languages").send().await,
        Ok(r) if r.status().is_success()
    )
}

fn find_split(text: &str, start: usize, target: usize) -> usize {
    // Snap target hacia abajo a un char boundary antes de slicear: `target =
    // cursor + MAX_CHUNK_BYTES` puede caer adentro de un caracter multibyte
    // (em-dash = 3 bytes UTF-8, acentos = 2 bytes), y `text[start..target]`
    // panickea cuando target no es char boundary. El panic queda en el worker
    // de tokio y deja `invoke('check_grammar')` colgado sin rechazar la promise.
    let mut target = target.min(text.len());
    while target > start && !text.is_char_boundary(target) {
        target -= 1;
    }
    if target <= start {
        // Pathological: no había boundary entre start y el target original.
        // Avanzar un char completo para garantizar progreso del while de
        // split_chunks (evita loop infinito).
        return text[start..]
            .char_indices()
            .nth(1)
            .map(|(i, _)| start + i)
            .unwrap_or(text.len());
    }
    if let Some(pos) = text[start..target].rfind("\n\n") {
        return start + pos + 2;
    }
    if let Some(pos) = text[start..target].rfind('\n') {
        return start + pos + 1;
    }
    if let Some(pos) = text[start..target].rfind(". ") {
        return start + pos + 2;
    }
    if let Some(pos) = text[start..target].rfind(' ') {
        return start + pos + 1;
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16_len(s: &str) -> usize {
        s.chars().map(|c| c.len_utf16()).sum()
    }

    #[test]
    fn chunk_start_is_utf16_offset_not_bytes() {
        // Em-dash al inicio: 3 bytes UTF-8, 1 UTF-16 code unit. El resto ASCII.
        // Forzamos chunking metiendo >MAX_CHUNK_BYTES de relleno ASCII.
        let text = format!("—{}", "a".repeat(MAX_CHUNK_BYTES + 100));
        let chunks = split_chunks(&text);
        assert!(chunks.len() >= 2, "texto debería partirse en >=2 chunks");
        // chunk[1].start representa el offset al que el frontend suma m.offset
        // (UTF-16 en JS string). Tiene que ser UTF-16 del prefijo, no bytes.
        let expected = utf16_len(&chunks[0].text);
        assert_eq!(
            chunks[1].start, expected,
            "chunk.start debe ser UTF-16 offset; bytes del em-dash inflarían el offset"
        );
    }

    #[test]
    fn single_chunk_has_zero_start() {
        let text = "—Hola, mundo.".to_string();
        let chunks = split_chunks(&text);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].start, 0);
    }

    #[test]
    fn find_split_handles_emdash_at_target_byte() {
        // Em-dash en bytes 19499..19502; target del primer chunk = 19500 cae
        // adentro del em-dash. Antes del fix esto panickeaba tokio worker.
        let text = format!("{}—{}", "a".repeat(19_499), "a".repeat(1000));
        let chunks = split_chunks(&text);
        assert!(chunks.len() >= 2);
        // Verificar que los chunks no rompen el texto a mitad de char:
        // concatenar las partes y comparar.
        let rebuilt: String = chunks.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(rebuilt, text);
    }

    #[test]
    fn find_split_handles_accented_char_at_target_byte() {
        // 'á' en bytes 19499..19501 (2 bytes UTF-8). target=19500 cae al medio.
        let text = format!("{}á{}", "a".repeat(19_499), "a".repeat(1000));
        let chunks = split_chunks(&text);
        assert!(chunks.len() >= 2);
        let rebuilt: String = chunks.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(rebuilt, text);
    }

    fn engine(rt: Runtime) -> Engine {
        Engine {
            rt,
            bin: rt.cmd().to_string(),
        }
    }

    #[test]
    fn docker_run_args_include_restart() {
        let args = engine(Runtime::Docker).run_args();
        assert!(
            args.windows(2).any(|w| w == ["--restart", "unless-stopped"]),
            "Docker debe incluir --restart unless-stopped"
        );
        assert!(args.windows(2).any(|w| w == ["-p", "8081:8010"]));
        assert_eq!(*args.last().unwrap(), LT_IMAGE);
    }

    #[test]
    fn podman_run_args_include_restart() {
        let args = engine(Runtime::Podman).run_args();
        assert!(args.windows(2).any(|w| w == ["--restart", "unless-stopped"]));
    }

    #[test]
    fn apple_run_args_omit_restart() {
        // Apple `container` no soporta --restart; incluirlo rompería el run.
        let args = engine(Runtime::Apple).run_args();
        assert!(
            !args.iter().any(|a| *a == "--restart"),
            "Apple container NO debe llevar --restart"
        );
        assert!(args.windows(2).any(|w| w == ["-p", "8081:8010"]));
        assert!(args.windows(2).any(|w| w == ["--name", LT_CONTAINER]));
        assert_eq!(*args.last().unwrap(), LT_IMAGE);
    }

    #[test]
    fn apple_container_json_parses_id() {
        // El `container ls --format json` de Apple anida el nombre en
        // configuration.id. Verificamos el parseo que usa Engine::names.
        let json = r#"[{"configuration":{"id":"twriter-languagetool","image":{"reference":"x"}}}]"#;
        let parsed: Vec<AppleContainer> = serde_json::from_slice(json.as_bytes()).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].configuration.id, "twriter-languagetool");
    }

    #[test]
    fn apple_container_json_empty_is_ok() {
        let parsed: Vec<AppleContainer> = serde_json::from_slice(b"[]").unwrap();
        assert!(parsed.is_empty());
    }

    #[test]
    fn multiple_chunks_accumulate_utf16() {
        // 3 chunks: cada uno con varios em-dashes para que bytes >> UTF-16.
        let block = format!("{}{}", "—".repeat(100), "a".repeat(MAX_CHUNK_BYTES));
        let text = block.repeat(3);
        let chunks = split_chunks(&text);
        assert!(chunks.len() >= 2);
        let mut acc = 0usize;
        for (i, c) in chunks.iter().enumerate() {
            assert_eq!(c.start, acc, "chunk[{}].start desalineado", i);
            acc += utf16_len(&c.text);
        }
        // Suma total de UTF-16 de los chunks == UTF-16 del texto original
        assert_eq!(acc, utf16_len(&text));
    }

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
}
