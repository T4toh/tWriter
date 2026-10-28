use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

use crate::secrets;

const PUBLIC_BASE: &str = "https://api.languagetool.org";
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
    /// `level=picky` en vez de `default`: activa reglas extra de texto formal.
    /// `None` == false.
    #[serde(default)]
    pub picky: Option<bool>,
    /// LanguageTool Premium / self-hosted con auth. Solo aplica si `mode == "custom"`.
    #[serde(default, rename = "ltUsername")]
    pub lt_username: Option<String>,
    /// Ids de reglas de LT que el autor mató para esta saga (falsos positivos).
    /// Van como `disabledRules` en `/v2/check`. `None` o lista vacía == no
    /// mandar el param.
    #[serde(default, rename = "disabledRules")]
    pub disabled_rules: Option<Vec<String>>,
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
            .field("picky", &self.picky)
            .field("disabled_rules", &self.disabled_rules)
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

/// La base para un pedido. En modo Local espera al embebido si está
/// arrancando; los demás modos no dependen de nada que arranque.
async fn base_para(app: &AppHandle, cfg: &GrammarConfig) -> Result<String, String> {
    if cfg.mode == "local" {
        return crate::lt_embebido::base_local(app).await;
    }
    resolve_base(cfg)
}

fn resolve_base(cfg: &GrammarConfig) -> Result<String, String> {
    match cfg.mode.as_str() {
        "public" => Ok(PUBLIC_BASE.to_string()),
        "local" => crate::lt_embebido::base_embebida()
            .ok_or_else(|| "LanguageTool local no está corriendo".into()),
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
pub async fn check_grammar_available(app: AppHandle, cfg: GrammarConfig) -> bool {
    let base = match base_para(&app, &cfg).await {
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

/// Versión del LT configurado, para el pie del editor. LT no tiene endpoint de
/// versión: sale de `software.version` de un `/v2/check` mínimo. En modo
/// público no se pide: gastaría del presupuesto de requests.
#[tauri::command]
pub async fn languagetool_version(app: AppHandle, cfg: GrammarConfig) -> Option<String> {
    if cfg.mode == "public" {
        return None;
    }
    let base = base_para(&app, &cfg).await.ok()?;
    let client = reqwest::Client::builder()
        .timeout(PING_TIMEOUT)
        .build()
        .ok()?;
    let resp = client
        .post(format!("{}/v2/check", base))
        .form(&[("text", "a"), ("language", "en-US")])
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let parsed: LtVersionResponse = resp.json().await.ok()?;
    Some(parsed.software.version)
}

#[derive(Deserialize)]
struct LtVersionResponse {
    software: LtSoftware,
}

#[derive(Deserialize)]
struct LtSoftware {
    version: String,
}

#[tauri::command]
pub async fn check_grammar(
    app: AppHandle,
    text: String,
    lang: String,
    cfg: GrammarConfig,
) -> Result<Vec<GrammarMatch>, String> {
    let base = base_para(&app, &cfg).await?;
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

/// `level` del request a LT. `None` (settings viejo, sin la clave) == default.
fn level_for(cfg: &GrammarConfig) -> &'static str {
    if cfg.picky.unwrap_or(false) {
        "picky"
    } else {
        "default"
    }
}

/// `disabledRules` del request, o `None` si no hay ninguna. LT interpreta un
/// `disabledRules=` vacío como "desactivá nada de lo que traés por default",
/// que no es lo mismo que omitirlo, así que la lista vacía no manda el param.
fn disabled_rules_param(cfg: &GrammarConfig) -> Option<String> {
    let ids = cfg.disabled_rules.as_ref()?;
    let csv = ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    if csv.is_empty() {
        None
    } else {
        Some(csv)
    }
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
        ("level", level_for(cfg).to_string()),
    ];
    if lang == "auto" {
        params.push(("preferredVariants", preferred_variants(cfg)));
    }
    if let Some(ids) = disabled_rules_param(cfg) {
        params.push(("disabledRules", ids));
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

#[derive(Serialize, Clone)]
struct LtProgress {
    phase: &'static str,
    message: String,
}

pub(crate) fn emit_progress(app: &AppHandle, phase: &'static str, message: impl Into<String>) {
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

    /// reqwest va con `rustls-no-provider`: sin el proveedor que instala
    /// `run()`, `build()` hace panic y LanguageTool deja de andar sin que falle
    /// ningún otro test.
    #[test]
    fn el_cliente_http_encuentra_proveedor_tls() {
        crate::install_tls_provider();
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("reqwest sin proveedor de cripto para rustls");
    }

    fn utf16_len(s: &str) -> usize {
        s.chars().map(|c| c.len_utf16()).sum()
    }

    #[test]
    fn resolve_base_local_es_el_embebido() {
        use std::sync::atomic::Ordering;
        let local: GrammarConfig = serde_json::from_str(r#"{"mode":"local"}"#).unwrap();
        let custom: GrammarConfig =
            serde_json::from_str(r#"{"mode":"custom","customUrl":"http://x"}"#).unwrap();
        crate::lt_embebido::PUERTO.store(8083, Ordering::SeqCst);
        let con_embebido = resolve_base(&local);
        let custom_gana = resolve_base(&custom);
        crate::lt_embebido::PUERTO.store(0, Ordering::SeqCst);
        assert_eq!(con_embebido.unwrap(), "http://127.0.0.1:8083");
        assert_eq!(custom_gana.unwrap(), "http://x");
        assert!(resolve_base(&local).is_err());
    }

    #[test]
    fn level_picky_only_when_opted_in() {
        // El bridge JS manda `picky` sin rename; un settings.json viejo no manda
        // la clave y tiene que caer en "default" (nunca activar reglas extra
        // sin que el autor las pida).
        let base = r#"{"mode":"local"}"#;
        let cfg: GrammarConfig = serde_json::from_str(base).unwrap();
        assert_eq!(cfg.picky, None);
        assert_eq!(level_for(&cfg), "default");

        let on: GrammarConfig = serde_json::from_str(r#"{"mode":"local","picky":true}"#).unwrap();
        assert_eq!(level_for(&on), "picky");

        let off: GrammarConfig = serde_json::from_str(r#"{"mode":"local","picky":false}"#).unwrap();
        assert_eq!(level_for(&off), "default");
    }

    #[test]
    fn disabled_rules_param_solo_cuando_hay_reglas() {
        // Sin la clave (saga sin reglas desactivadas, o config vieja) el param
        // NO se manda: `disabledRules=` vacío en LT desactiva el default de la
        // request y no es lo mismo que no mandarlo.
        let cfg: GrammarConfig = serde_json::from_str(r#"{"mode":"local"}"#).unwrap();
        assert_eq!(disabled_rules_param(&cfg), None);

        let vacio: GrammarConfig =
            serde_json::from_str(r#"{"mode":"local","disabledRules":[]}"#).unwrap();
        assert_eq!(disabled_rules_param(&vacio), None);

        let una: GrammarConfig =
            serde_json::from_str(r#"{"mode":"local","disabledRules":["TU_TILDE"]}"#).unwrap();
        assert_eq!(disabled_rules_param(&una), Some("TU_TILDE".to_string()));

        // Varias van CSV, que es el formato que pide /v2/check.
        let varias: GrammarConfig = serde_json::from_str(
            r#"{"mode":"local","disabledRules":["TU_TILDE","AGREEMENT_POSTPONED_ADJ"]}"#,
        )
        .unwrap();
        assert_eq!(
            disabled_rules_param(&varias),
            Some("TU_TILDE,AGREEMENT_POSTPONED_ADJ".to_string())
        );

        // Basura defensiva: ids vacíos o con espacios sobrantes. Un id vacío
        // colado en la lista dejaría una coma suelta en el CSV.
        let sucia: GrammarConfig = serde_json::from_str(
            r#"{"mode":"local","disabledRules":["  ","  TU_TILDE  ","",  "OTRA"]}"#,
        )
        .unwrap();
        assert_eq!(
            disabled_rules_param(&sucia),
            Some("TU_TILDE,OTRA".to_string())
        );
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
