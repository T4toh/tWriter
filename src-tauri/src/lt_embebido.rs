//! LanguageTool sin Docker: la app baja los jars de LT (Maven Central) y un JRE
//! de Temurin, verificados contra `lt-lock.json`, y corre LT como proceso
//! propio. La lista la arma `scripts/armar-lt-lock.mjs`; acá se compila
//! adentro con `include_str!` y es el ancla de confianza: lo que no está ahí no
//! se baja ni se ejecuta.
//!
//! En disco, bajo `app_data_dir()/languagetool/`:
//! `lt-<versión>/libs/*.jar` y `jre-<versión>/<lo que trae el archivo>`, cada
//! uno con un `.ok` que se escribe al final. Van separados para que un parche
//! del JRE baje ~50 MB y no los ~142 de todo.

use crate::grammar::emit_progress;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
pub struct Archivo {
    pub url: String,
    pub file: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
pub struct Jre {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// Ruta del `java` relativa al directorio donde se extrae el archivo.
    pub java: String,
}

#[derive(Debug, Deserialize)]
pub struct Lock {
    pub lt: String,
    pub jre: String,
    pub jars: Vec<Archivo>,
    /// Por triple de Rust (`aarch64-apple-darwin`, …).
    pub jres: HashMap<String, Jre>,
}

pub fn lock() -> &'static Lock {
    static LOCK: OnceLock<Lock> = OnceLock::new();
    LOCK.get_or_init(|| {
        serde_json::from_str(include_str!("../lt-lock.json")).expect("lt-lock.json inválido")
    })
}

/// El triple del lock para el target con el que se compiló este binario. Las
/// dos builds de Mac salen del mismo runner ARM, así que tiene que ser el
/// target de compilación y no la máquina.
pub fn target_actual() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

pub fn jre_del_target(lock: &Lock) -> Option<&Jre> {
    lock.jres.get(target_actual())
}

/// La versión instalada de `prefijo` (`"lt"` o `"jre"`): el directorio
/// `<prefijo>-<versión>` que tiene `.ok`. No borra nada: el panel lo consulta
/// cada vez que se abre, también mientras se baja. Si hay más de uno con `.ok`
/// (una actualización a medio limpiar), gana el más reciente.
pub fn instalado(base: &Path, prefijo: &str) -> Option<String> {
    let cabeza = format!("{prefijo}-");
    let mut mejor: Option<(std::time::SystemTime, String)> = None;
    for entrada in fs::read_dir(base).ok()?.flatten() {
        let nombre = entrada.file_name().to_string_lossy().into_owned();
        let Some(version) = nombre.strip_prefix(&cabeza) else {
            continue;
        };
        let Ok(meta) = fs::metadata(entrada.path().join(".ok")) else {
            continue;
        };
        let cuando = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        if mejor.as_ref().is_none_or(|(t, _)| cuando > *t) {
            mejor = Some((cuando, version.to_string()));
        }
    }
    mejor.map(|(_, v)| v)
}

/// Borra los `lt-*`/`jre-*` sin `.ok`: restos de una descarga cortada. Solo
/// desde `instalar`, que es el único que escribe ahí.
pub fn limpiar_incompletos(base: &Path) {
    let Ok(entradas) = fs::read_dir(base) else { return };
    for e in entradas.flatten() {
        let nombre = e.file_name().to_string_lossy().into_owned();
        let nuestro = nombre.starts_with("lt-") || nombre.starts_with("jre-");
        if nuestro && e.path().is_dir() && !e.path().join(".ok").exists() {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

/// El primer puerto libre en localhost desde `desde`.
pub fn puerto_libre(desde: u16) -> Option<u16> {
    (desde..desde.saturating_add(100)).find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
}

/// Falla si el sha256 de `path` no es `esperado`. Va siempre antes de
/// desempaquetar o mover nada: es código que se va a ejecutar.
pub fn verificar_sha256(path: &Path, esperado: &str) -> Result<(), String> {
    let nombre = path.file_name().unwrap_or_default().to_string_lossy();
    let mut f = File::open(path).map_err(|e| format!("No pude leer {nombre}: {e}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| format!("No pude leer {nombre}: {e}"))?;
    let real = format!("{:x}", hasher.finalize());
    if real.eq_ignore_ascii_case(esperado) {
        Ok(())
    } else {
        Err(format!(
            "El archivo {nombre} no coincide con el esperado. Puede ser una descarga cortada: probá de nuevo."
        ))
    }
}

/// Desempaqueta `.tar.gz` o `.zip` (por la extensión de `archivo`) en
/// `destino`. Si falla, `destino` no queda. Sin temporal ni rename: en
/// Windows el antivirus escanea lo recién escrito y un rename de directorio
/// falla con acceso denegado; lo que dice "instalado" es el `.ok`.
pub fn extraer(archivo: &Path, destino: &Path) -> Result<(), String> {
    let hecho = (|| -> Result<(), String> {
        let f = File::open(archivo).map_err(|e| e.to_string())?;
        if archivo.extension().is_some_and(|e| e == "zip") {
            zip::ZipArchive::new(f)
                .and_then(|mut z| z.extract(destino))
                .map_err(|e| e.to_string())
        } else {
            let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(f));
            tar.set_preserve_permissions(true);
            tar.unpack(destino).map_err(|e| e.to_string())
        }
    })();
    if let Err(e) = hecho {
        let _ = fs::remove_dir_all(destino);
        let nombre = archivo.file_name().unwrap_or_default().to_string_lossy();
        return Err(format!("No pude desempaquetar {nombre}: {e}. Probá bajarlo de nuevo."));
    }
    Ok(())
}

/// Baja lo que falte o difiera del lock a `base`. LT y el JRE se instalan por
/// separado, cada uno con su `.ok` al final; una pieza que falla se borra
/// entera y la otra queda. No borra versiones viejas: eso lo hace quien llama,
/// después de comprobar que la nueva arranca.
pub async fn instalar(
    base: &Path,
    progreso: &(dyn Fn(&'static str, String) + Sync),
) -> Result<(), String> {
    let lock = lock();
    let jre = jre_del_target(lock)
        .ok_or_else(|| format!("No hay Java para {} en la lista de tWriter.", target_actual()))?;
    fs::create_dir_all(base).map_err(|e| format!("No pude crear {}: {e}", base.display()))?;
    limpiar_incompletos(base);
    let falta_lt = instalado(base, "lt").as_deref() != Some(lock.lt.as_str());
    let falta_jre = instalado(base, "jre").as_deref() != Some(lock.jre.as_str());
    let total = if falta_lt { lock.jars.iter().map(|j| j.size).sum() } else { 0 }
        + if falta_jre { jre.size } else { 0 };
    let mut bajada = Bajada { client: cliente()?, hechos: 0, total, avisado: 0, progreso };

    if falta_lt {
        let dir = base.join(format!("lt-{}", lock.lt));
        let r = async {
            fs::create_dir_all(dir.join("libs")).map_err(|e| e.to_string())?;
            for jar in &lock.jars {
                let destino = dir.join("libs").join(&jar.file);
                bajada.bajar(&jar.url, &destino).await?;
                verificar_sha256(&destino, &jar.sha256)?;
            }
            fs::write(dir.join(".ok"), "").map_err(|e| e.to_string())
        }
        .await;
        if let Err(e) = r {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
    }

    if falta_jre {
        let dir = base.join(format!("jre-{}", lock.jre));
        let nombre = jre.url.rsplit('/').next().unwrap_or("jre");
        let archivo = base.join(nombre);
        let r = async {
            bajada.bajar(&jre.url, &archivo).await?;
            (bajada.progreso)("verifying", "Verificando Java…".into());
            verificar_sha256(&archivo, &jre.sha256)?;
            (bajada.progreso)("extracting", "Desempaquetando Java…".into());
            let _ = fs::remove_dir_all(&dir);
            extraer(&archivo, &dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(dir.join(&jre.java), fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("No pude marcar java como ejecutable: {e}"))?;
            }
            fs::write(dir.join(".ok"), "").map_err(|e| e.to_string())
        }
        .await;
        let _ = fs::remove_file(&archivo);
        if let Err(e) = r {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
    }
    Ok(())
}

fn cliente() -> Result<reqwest::Client, String> {
    cliente_con(Duration::from_secs(30))
}

/// Sin timeout total: son ~142 MB y una conexión lenta no es un error. Sí uno
/// de lectura, para que un servidor que se cuelga sin cortar no deje la
/// descarga (y `INSTALANDO`) trabada para siempre.
fn cliente_con(lectura: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(lectura)
        .build()
        .map_err(|e| e.to_string())
}

struct Bajada<'a> {
    client: reqwest::Client,
    hechos: u64,
    total: u64,
    avisado: u64,
    progreso: &'a (dyn Fn(&'static str, String) + Sync),
}

impl Bajada<'_> {
    async fn bajar(&mut self, url: &str, destino: &Path) -> Result<(), String> {
        let host = url.split('/').nth(2).unwrap_or(url);
        let sin_red = |e: reqwest::Error| format!("No pude bajar de {host}: {e}. Revisá la conexión y probá de nuevo.");
        let mut resp = self.client.get(url).send().await.and_then(|r| r.error_for_status()).map_err(sin_red)?;
        let mut f = File::create(destino).map_err(|e| format!("No pude escribir {}: {e}", destino.display()))?;
        while let Some(chunk) = resp.chunk().await.map_err(sin_red)? {
            f.write_all(&chunk).map_err(|e| format!("No pude escribir {}: {e}", destino.display()))?;
            self.hechos += chunk.len() as u64;
            if self.hechos - self.avisado >= 1 << 20 || self.hechos == self.total {
                self.avisado = self.hechos;
                (self.progreso)(
                    "downloading",
                    format!("Bajando LanguageTool: {} / {} MB", self.hechos >> 20, self.total >> 20),
                );
            }
        }
        Ok(())
    }
}

/// Puerto del LT embebido que está corriendo; 0 = no corre. Static y no state
/// de Tauri porque `grammar::resolve_base` es sync y no tiene `AppHandle`
/// (mismo criterio que `PUBLIC_BUDGET`).
pub(crate) static PUERTO: AtomicU16 = AtomicU16::new(0);

/// `http://127.0.0.1:<puerto>` si el embebido está corriendo.
pub fn base_embebida() -> Option<String> {
    match PUERTO.load(Ordering::SeqCst) {
        0 => None,
        p => Some(format!("http://127.0.0.1:{p}")),
    }
}

/// Los argumentos de `java`, cada uno su `OsString`: sin shell de por medio,
/// una ruta con espacios o acentos (`Application Support`, `C:\Users\Ñandú`)
/// llega entera.
pub fn java_args(libs: &Path, puerto: u16) -> Vec<OsString> {
    vec![
        "-Xmx256m".into(),
        "-cp".into(),
        libs.join("*").into_os_string(),
        "org.languagetool.server.HTTPServer".into(),
        "--port".into(),
        puerto.to_string().into(),
    ]
}

fn escribir_pid(base: &Path, pid: u32, puerto: u16) -> std::io::Result<()> {
    fs::write(base.join("lt.pid"), format!("{pid} {puerto}"))
}

fn leer_pid(base: &Path) -> Option<(u32, u16)> {
    let s = fs::read_to_string(base.join("lt.pid")).ok()?;
    let (pid, puerto) = s.trim().split_once(' ')?;
    Some((pid.parse().ok()?, puerto.parse().ok()?))
}

/// El `java` de un JRE instalado. La raíz del archivo de Temurin cambia con
/// cada versión (`jdk-21.0.12.1+1-jre/`), así que se busca el único
/// subdirectorio y se le pega el resto de la ruta del lock (`bin/java`,
/// `Contents/Home/bin/java`): un JRE viejo que sigue instalado no está en el
/// lock con su nombre.
fn ruta_java(dir_jre: &Path) -> Option<PathBuf> {
    let resto: PathBuf = Path::new(&jre_del_target(lock())?.java).components().skip(1).collect();
    let raiz = fs::read_dir(dir_jre).ok()?.flatten().find(|e| e.path().is_dir())?;
    Some(raiz.path().join(resto))
}

static PROCESO: Mutex<Option<Child>> = Mutex::new(None);
static ULTIMO_ERROR: Mutex<Option<String>> = Mutex::new(None);
/// Ya se relanzó una vez después de una caída; no se vuelve a intentar solo
/// hasta que el autor toque «Reiniciar».
static RELANZADO: AtomicBool = AtomicBool::new(false);
static INSTALANDO: AtomicBool = AtomicBool::new(false);
/// Serializa los arranques: el del `setup` y el de `asegurar_corriendo` pueden
/// llegar juntos al abrir la app.
static ARRANQUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const PUERTO_DESDE: u16 = 8082;
/// Medido 0,4 s en frío, pero la primera vez el antivirus de Windows puede
/// escanear el JRE entero; y si vence en una actualización, se borra lo recién
/// bajado. Mismo margen que el smoke de CI.
const ESPERA_ARRANQUE: Duration = Duration::from_secs(60);

fn corriendo() -> bool {
    let mut g = PROCESO.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true,
        Some(_) => {
            *g = None;
            PUERTO.store(0, Ordering::SeqCst);
            false
        }
        None => false,
    }
}

async fn responde(puerto: u16) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_millis(1500)).build() else {
        return false;
    };
    matches!(
        client.get(format!("http://127.0.0.1:{puerto}/v2/languages")).send().await,
        Ok(r) if r.status().is_success()
    )
}

/// Un `java` nuestro que quedó vivo de una sesión que crasheó: si el puerto que
/// anotó sigue contestando como LanguageTool, se mata ese pid.
async fn matar_huerfano(base: &Path) {
    let Some((pid, puerto)) = leer_pid(base) else {
        return;
    };
    if responde(puerto).await {
        tracing::info!(target: "grammar", pid, puerto, "matando LT embebido huérfano");
        #[cfg(unix)]
        let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        #[cfg(windows)]
        let _ = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .status()
        };
    }
    let _ = fs::remove_file(base.join("lt.pid"));
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Levanta LT con lo que haya instalado en `base` y espera a que conteste.
/// Cualquier falla queda en `ULTIMO_ERROR` para que el panel diga por qué no
/// corre, también cuando el arranque fue el automático al abrir la app.
pub async fn arrancar_en(base: &Path) -> Result<u16, String> {
    let r = arrancar_sin_registrar(base).await;
    if let Err(e) = &r {
        *ULTIMO_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone());
    }
    r
}

async fn arrancar_sin_registrar(base: &Path) -> Result<u16, String> {
    let _turno = ARRANQUE.lock().await;
    if corriendo() {
        return Ok(PUERTO.load(Ordering::SeqCst));
    }
    let (Some(lt), Some(jre)) = (instalado(base, "lt"), instalado(base, "jre")) else {
        return Err("LanguageTool no está instalado.".into());
    };
    matar_huerfano(base).await;
    let java = ruta_java(&base.join(format!("jre-{jre}")))
        .ok_or("No encuentro el java instalado. Borralo y bajalo de nuevo.")?;
    let puerto = puerto_libre(PUERTO_DESDE).ok_or("No hay ningún puerto libre desde 8082.")?;
    let log = base.join("lt.log");
    let stderr = File::create(&log).map_err(|e| format!("No pude crear {}: {e}", log.display()))?;
    let mut cmd = std::process::Command::new(&java);
    cmd.args(java_args(&base.join(format!("lt-{lt}")).join("libs"), puerto))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("No pude lanzar java: {e}"))?;
    let _ = escribir_pid(base, child.id(), puerto);

    let inicio = std::time::Instant::now();
    let listo = loop {
        if responde(puerto).await {
            break true;
        }
        if inicio.elapsed() > ESPERA_ARRANQUE || !matches!(child.try_wait(), Ok(None)) {
            break false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    if !listo {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_file(base.join("lt.pid"));
        let ultima = fs::read_to_string(&log)
            .ok()
            .and_then(|s| s.lines().rev().find(|l| !l.trim().is_empty()).map(str::to_string))
            .unwrap_or_else(|| "sin detalle".into());
        return Err(format!("LanguageTool no arrancó: {ultima}"));
    }
    tracing::info!(target: "grammar", puerto, lt, jre, "LT embebido listo");
    *PROCESO.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    *ULTIMO_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = None;
    PUERTO.store(puerto, Ordering::SeqCst);
    Ok(puerto)
}

/// Mata el `java` embebido si hay uno. Va en `RunEvent::Exit`.
pub fn detener() {
    PUERTO.store(0, Ordering::SeqCst);
    if let Some(mut c) = PROCESO.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    if let Some(base) = BASE.get() {
        let _ = fs::remove_file(base.join("lt.pid"));
    }
}

/// `app_data_dir()/languagetool`, recordado para `detener()`, que corre al
/// salir y no tiene `AppHandle` a mano.
static BASE: OnceLock<PathBuf> = OnceLock::new();

fn base_de(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(b) = BASE.get() {
        return Ok(b.clone());
    }
    let b = app
        .path()
        // Local y no Roaming: en Windows son ~300 MB de binarios que no tienen
        // que viajar con el perfil. En Mac y Linux es el mismo directorio.
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?
        .join("languagetool");
    Ok(BASE.get_or_init(|| b).clone())
}

/// Para el modo Local: si LT está instalado y se cayó (o nunca arrancó), lo
/// levanta. Después de una caída relanza una sola vez.
pub async fn asegurar_corriendo(app: &AppHandle) {
    if corriendo() || INSTALANDO.load(Ordering::SeqCst) {
        return;
    }
    let Ok(base) = base_de(app) else { return };
    if instalado(&base, "lt").is_none() || instalado(&base, "jre").is_none() {
        return;
    }
    if RELANZADO.swap(true, Ordering::SeqCst) {
        return;
    }
    if arrancar_en(&base).await.is_ok() {
        RELANZADO.store(false, Ordering::SeqCst);
    }
}

/// Al abrir la app, en segundo plano, si el modo es Local y está instalado.
pub fn arrancar_al_abrir(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        asegurar_corriendo(&app).await;
    });
}

fn limpiar_otras(base: &Path, prefijo: &str, conservar: &str) {
    let Ok(entradas) = fs::read_dir(base) else { return };
    for e in entradas.flatten() {
        let nombre = e.file_name().to_string_lossy().into_owned();
        if nombre.starts_with(&format!("{prefijo}-")) && nombre != format!("{prefijo}-{conservar}") {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

#[derive(Serialize)]
pub struct LtEmbebidoStatus {
    lt_instalado: Option<String>,
    jre_instalado: Option<String>,
    lt_lock: String,
    jre_lock: String,
    /// Lo que falta bajar según el lock; 0 si está al día.
    mb_a_bajar: u64,
    corriendo: bool,
    puerto: Option<u16>,
    /// Último error de arranque, con la última línea de stderr de java.
    error: Option<String>,
}

#[tauri::command]
pub async fn lt_embebido_status(app: AppHandle) -> LtEmbebidoStatus {
    let base = base_de(&app).unwrap_or_default();
    let lock = lock();
    let lt_instalado = instalado(&base, "lt");
    let jre_instalado = instalado(&base, "jre");
    let mut bytes = 0;
    if lt_instalado.as_deref() != Some(lock.lt.as_str()) {
        bytes += lock.jars.iter().map(|j| j.size).sum::<u64>();
    }
    if jre_instalado.as_deref() != Some(lock.jre.as_str()) {
        bytes += jre_del_target(lock).map_or(0, |j| j.size);
    }
    let corre = corriendo();
    LtEmbebidoStatus {
        lt_instalado,
        jre_instalado,
        lt_lock: lock.lt.clone(),
        jre_lock: lock.jre.clone(),
        mb_a_bajar: bytes.div_ceil(1 << 20),
        corriendo: corre,
        puerto: corre.then(|| PUERTO.load(Ordering::SeqCst)),
        error: ULTIMO_ERROR.lock().unwrap_or_else(|e| e.into_inner()).clone(),
    }
}

/// Baja lo que falte, arranca la versión nueva y recién entonces borra la
/// vieja. Si la nueva no arranca, se borra la nueva y vuelve la vieja.
#[tauri::command]
pub async fn lt_embebido_instalar(app: AppHandle) -> Result<(), String> {
    if INSTALANDO.swap(true, Ordering::SeqCst) {
        return Err("Ya se está bajando LanguageTool.".into());
    }
    let r = instalar_y_arrancar(&app).await;
    INSTALANDO.store(false, Ordering::SeqCst);
    match &r {
        Ok(()) => emit_progress(&app, "ready", "LanguageTool listo"),
        Err(e) => emit_progress(&app, "error", e.clone()),
    }
    r
}

async fn instalar_y_arrancar(app: &AppHandle) -> Result<(), String> {
    let base = base_de(app)?;
    let lock = lock();
    let antes = (instalado(&base, "lt"), instalado(&base, "jre"));
    instalar(&base, &|fase, msg| emit_progress(app, fase, msg)).await?;
    emit_progress(app, "starting", "Arrancando LanguageTool…");
    detener();
    RELANZADO.store(false, Ordering::SeqCst);
    match arrancar_en(&base).await {
        Ok(_) => {
            limpiar_otras(&base, "lt", &lock.lt);
            limpiar_otras(&base, "jre", &lock.jre);
            Ok(())
        }
        Err(e) => {
            // La nueva no arranca: se borra lo recién bajado y vuelve lo de antes.
            if antes.0.as_deref() != Some(lock.lt.as_str()) && antes.0.is_some() {
                let _ = fs::remove_dir_all(base.join(format!("lt-{}", lock.lt)));
            }
            if antes.1.as_deref() != Some(lock.jre.as_str()) && antes.1.is_some() {
                let _ = fs::remove_dir_all(base.join(format!("jre-{}", lock.jre)));
            }
            if antes.0.is_some() && antes.1.is_some() {
                let _ = arrancar_en(&base).await;
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn lt_embebido_reiniciar(app: AppHandle) -> Result<(), String> {
    let base = base_de(&app)?;
    detener();
    RELANZADO.store(false, Ordering::SeqCst);
    arrancar_en(&base).await.map(|_| ())
}

#[tauri::command]
pub async fn lt_embebido_borrar(app: AppHandle) -> Result<(), String> {
    if INSTALANDO.load(Ordering::SeqCst) {
        return Err("Esperá a que termine la descarga.".into());
    }
    let base = base_de(&app)?;
    detener();
    *ULTIMO_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = None;
    match fs::remove_dir_all(&base) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("No pude borrar {}: {e}", base.display())),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lock_compilado_parsea_y_tiene_el_target_actual() {
        assert!(!lock().lt.is_empty());
        assert!(lock().jars.len() > 100, "jars: {}", lock().jars.len());
        assert!(jre_del_target(lock()).is_some(), "sin JRE para {}", target_actual());
    }

    #[test]
    fn instalado_devuelve_la_version_con_ok() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("lt-6.8")).unwrap();
        fs::write(base.path().join("lt-6.8/.ok"), "").unwrap();
        assert_eq!(instalado(base.path(), "lt").as_deref(), Some("6.8"));
        assert_eq!(instalado(base.path(), "jre"), None);
    }

    /// El panel pide el estado cada vez que se abre Configuración, también
    /// mientras se baja: no puede borrar lo que se está escribiendo.
    #[test]
    fn instalado_no_borra_lo_que_se_esta_bajando() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("lt-6.9/libs")).unwrap();
        fs::create_dir_all(base.path().join("lt-6.8")).unwrap();
        fs::write(base.path().join("lt-6.8/.ok"), "").unwrap();
        assert_eq!(instalado(base.path(), "lt").as_deref(), Some("6.8"));
        assert!(base.path().join("lt-6.9/libs").exists());
    }

    #[test]
    fn limpiar_incompletos_borra_lo_que_no_tiene_ok() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("lt-6.9/libs")).unwrap();
        fs::create_dir_all(base.path().join("jre-21.1")).unwrap();
        fs::create_dir_all(base.path().join("lt-6.8")).unwrap();
        fs::write(base.path().join("lt-6.8/.ok"), "").unwrap();
        limpiar_incompletos(base.path());
        assert!(!base.path().join("lt-6.9").exists());
        assert!(!base.path().join("jre-21.1").exists());
        assert!(base.path().join("lt-6.8/.ok").exists());
    }

    #[test]
    fn arrancar_sin_java_deja_el_error_visible() {
        let base = tempfile::tempdir().unwrap();
        for d in ["lt-1", "jre-1"] {
            fs::create_dir_all(base.path().join(d)).unwrap();
            fs::write(base.path().join(d).join(".ok"), "").unwrap();
        }
        let err = tauri::async_runtime::block_on(arrancar_en(base.path())).unwrap_err();
        let visible = ULTIMO_ERROR.lock().unwrap().clone();
        assert_eq!(visible.as_deref(), Some(err.as_str()));
    }

    /// Un servidor que manda los encabezados y se cuelga no puede dejar la
    /// descarga (y `INSTALANDO`) trabada para siempre.
    #[test]
    fn bajada_que_se_cuelga_falla() {
        crate::install_tls_provider();
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let puerto = server.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = server.accept() {
                let mut pedido = [0u8; 1024];
                let _ = std::io::Read::read(&mut c, &mut pedido);
                let _ = c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nabc");
                std::thread::sleep(Duration::from_secs(5));
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let mut b = Bajada {
            client: cliente_con(Duration::from_millis(300)).unwrap(),
            hechos: 0,
            total: 1000,
            avisado: 0,
            progreso: &|_, _| {},
        };
        let inicio = std::time::Instant::now();
        let r = tauri::async_runtime::block_on(b.bajar(&format!("http://127.0.0.1:{puerto}/x"), &dir.path().join("x")));
        assert!(r.is_err());
        assert!(inicio.elapsed() < Duration::from_secs(4), "{:?}", inicio.elapsed());
    }

    #[test]
    fn instalado_sin_nada_es_none() {
        let base = tempfile::tempdir().unwrap();
        assert_eq!(instalado(&base.path().join("no-existe"), "lt"), None);
    }

    #[test]
    fn puerto_libre_saltea_ocupado() {
        let ocupado = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let p = ocupado.local_addr().unwrap().port();
        let libre = puerto_libre(p).expect("algún puerto libre");
        assert_ne!(libre, p);
        assert!(libre > p);
    }

    #[test]
    fn sha_que_no_coincide_no_extrae() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.jar");
        fs::write(&f, b"hola").unwrap();
        let err = verificar_sha256(&f, &"0".repeat(64)).unwrap_err();
        assert!(err.contains("no coincide"), "{err}");
        assert!(err.contains("a.jar"), "{err}");
    }

    #[test]
    fn sha_correcto_pasa() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.jar");
        fs::write(&f, b"hola").unwrap();
        verificar_sha256(&f, "b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn extraer_tar_gz_preserva_ejecutable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let archivo = dir.path().join("jre.tar.gz");
        let gz = flate2::write::GzEncoder::new(fs::File::create(&archivo).unwrap(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        let mut h = tar::Header::new_gnu();
        h.set_size(4);
        h.set_mode(0o755);
        h.set_cksum();
        tar.append_data(&mut h, "x/bin/java", &b"java"[..]).unwrap();
        tar.into_inner().unwrap().finish().unwrap();

        let destino = dir.path().join("jre-21");
        extraer(&archivo, &destino).unwrap();
        let modo = fs::metadata(destino.join("x/bin/java")).unwrap().permissions().mode();
        assert_eq!(modo & 0o111, 0o111, "modo {modo:o}");
    }

    #[test]
    fn extraer_corrupto_no_deja_destino() {
        let dir = tempfile::tempdir().unwrap();
        let archivo = dir.path().join("jre.tar.gz");
        fs::write(&archivo, b"esto no es un tar.gz").unwrap();
        let destino = dir.path().join("jre-21");
        assert!(extraer(&archivo, &destino).is_err());
        assert!(!destino.exists());
    }

    #[test]
    fn java_args_con_espacios_quedan_en_un_solo_arg() {
        let args = java_args(Path::new("/a b/Ñandú/libs"), 8082);
        let cp = Path::new("/a b/Ñandú/libs").join("*").into_os_string();
        let esperado: Vec<OsString> = [
            OsString::from("-Xmx256m"),
            OsString::from("-cp"),
            cp,
            OsString::from("org.languagetool.server.HTTPServer"),
            OsString::from("--port"),
            OsString::from("8082"),
        ]
        .into();
        assert_eq!(args, esperado);
        assert!(!args.iter().any(|a| a == "--public"));
    }

    #[test]
    fn pid_file_round_trip() {
        let base = tempfile::tempdir().unwrap();
        assert_eq!(leer_pid(base.path()), None);
        escribir_pid(base.path(), 1234, 8083).unwrap();
        assert_eq!(leer_pid(base.path()), Some((1234, 8083)));
    }

    /// Baja de verdad (~142 MB), arranca y chequea. A mano:
    /// `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored instala_y_chequea`
    #[test]
    #[ignore]
    fn instala_y_chequea_de_verdad() {
        crate::install_tls_provider();
        let base = tempfile::tempdir().unwrap();
        tauri::async_runtime::block_on(async {
            instalar(base.path(), &|_, m| eprintln!("{m}")).await.unwrap();
            let puerto = arrancar_en(base.path()).await.unwrap();
            let r: serde_json::Value = reqwest::Client::new()
                .post(format!("http://127.0.0.1:{puerto}/v2/check"))
                .form(&[
                    ("language", "es-AR"),
                    ("text", "Ella fué a la casa y vió que el perro estaban dormido."),
                ])
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            detener();
            let reglas: Vec<&str> =
                r["matches"].as_array().unwrap().iter().filter_map(|m| m["rule"]["id"].as_str()).collect();
            assert!(reglas.contains(&"MONOSILABOS"), "{reglas:?}");
            assert!(!corriendo());
        });
    }
}
