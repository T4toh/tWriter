use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

use crate::secrets;

const LT_CONTAINER: &str = "twriter-languagetool";
const LT_IMAGE: &str = "erikvl87/languagetool:latest";

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
    pub docker_installed: bool,
    pub container_running: bool,
    pub container_exists: bool,
    pub api_responding: bool,
}

#[tauri::command]
pub async fn languagetool_docker_status() -> LtDockerStatus {
    let docker_installed = Command::new("docker")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let mut container_running = false;
    let mut container_exists = false;
    if docker_installed {
        if let Ok(out) = Command::new("docker")
            .args(["ps", "--format", "{{.Names}}"])
            .output()
        {
            container_running = String::from_utf8_lossy(&out.stdout)
                .lines()
                .any(|l| l.trim() == LT_CONTAINER);
        }
        if let Ok(out) = Command::new("docker")
            .args(["ps", "-a", "--format", "{{.Names}}"])
            .output()
        {
            container_exists = String::from_utf8_lossy(&out.stdout)
                .lines()
                .any(|l| l.trim() == LT_CONTAINER);
        }
    }
    let api_responding = ping_local_lt().await;
    LtDockerStatus {
        docker_installed,
        container_running,
        container_exists,
        api_responding,
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

#[tauri::command]
pub async fn languagetool_docker_start(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "checking", "Chequeando que Docker esté instalado…");
    let docker_check = Command::new("docker").arg("--version").output();
    match docker_check {
        Ok(o) if o.status.success() => {}
        _ => {
            return Err(
                "Docker no está instalado. Instalalo desde https://docs.docker.com/get-docker/ y volvé a intentar."
                    .into(),
            );
        }
    }
    emit_progress(&app, "checking", "Chequeando que el daemon de Docker responda…");
    if let Ok(o) = Command::new("docker").args(["info"]).output() {
        if !o.status.success() {
            return Err(
                "Docker está instalado pero el daemon no responde. Iniciá el servicio (ej: `sudo systemctl start docker`)."
                    .into(),
            );
        }
    }

    let already_running = Command::new("docker")
        .args(["ps", "--format", "{{.Names}}"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .any(|l| l.trim() == LT_CONTAINER)
        })
        .unwrap_or(false);
    if already_running {
        emit_progress(&app, "ready", "El container ya estaba corriendo.");
        return Ok("Ya estaba corriendo.".into());
    }

    let exists = Command::new("docker")
        .args(["ps", "-a", "--format", "{{.Names}}"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .any(|l| l.trim() == LT_CONTAINER)
        })
        .unwrap_or(false);

    if exists {
        emit_progress(&app, "starting", "Reiniciando container existente…");
        let out = Command::new("docker")
            .args(["start", LT_CONTAINER])
            .output()
            .map_err(|e| format!("docker start: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "docker start falló: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    } else {
        emit_progress(
            &app,
            "pulling",
            "Bajando imagen erikvl87/languagetool (~300MB, puede tardar 1–3 min según conexión)…",
        );
        let pull = tokio::task::spawn_blocking(|| {
            Command::new("docker").args(["pull", LT_IMAGE]).output()
        })
        .await
        .map_err(|e| format!("spawn pull: {}", e))?
        .map_err(|e| format!("docker pull: {}", e))?;
        if !pull.status.success() {
            return Err(format!(
                "docker pull falló: {}",
                String::from_utf8_lossy(&pull.stderr)
            ));
        }
        emit_progress(&app, "starting", "Creando container en localhost:8081…");
        let run = Command::new("docker")
            .args([
                "run",
                "-d",
                "--name",
                LT_CONTAINER,
                "--restart",
                "unless-stopped",
                "-p",
                "8081:8010",
                "-e",
                "Java_Xms=512m",
                "-e",
                "Java_Xmx=2g",
                LT_IMAGE,
            ])
            .output()
            .map_err(|e| format!("docker run: {}", e))?;
        if !run.status.success() {
            return Err(format!(
                "docker run falló: {}",
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
            tracing::info!(target: "grammar", "LanguageTool Docker listo en localhost:8081");
            return Ok("LanguageTool listo en localhost:8081".into());
        }
        sleep(Duration::from_millis(1000)).await;
    }
    tracing::error!(target: "grammar", "container levantado pero LT no responde tras 40s");
    Err("Container levantado pero no responde después de 40s. Revisá `docker logs twriter-languagetool`.".into())
}

#[tauri::command]
pub async fn languagetool_docker_stop() -> Result<(), String> {
    let out = Command::new("docker")
        .args(["stop", LT_CONTAINER])
        .output()
        .map_err(|e| format!("docker stop: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("No such container") || err.contains("no such container") {
            return Ok(());
        }
        tracing::error!(target: "grammar", error = %err, "docker stop LanguageTool falló");
        return Err(format!("docker stop falló: {}", err));
    }
    tracing::info!(target: "grammar", "LanguageTool Docker detenido");
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
}
