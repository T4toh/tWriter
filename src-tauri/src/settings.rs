use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct Settings {
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default, rename = "editorWidth", skip_serializing_if = "Option::is_none")]
    pub editor_width: Option<String>,
    #[serde(
        default,
        rename = "editorFontSize",
        skip_serializing_if = "Option::is_none"
    )]
    pub editor_font_size: Option<u32>,
    #[serde(
        default,
        rename = "editorParagraphSpacing",
        skip_serializing_if = "Option::is_none"
    )]
    pub editor_paragraph_spacing: Option<String>,
    #[serde(
        default,
        rename = "grammarMode",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_mode: Option<String>,
    #[serde(
        default,
        rename = "grammarCustomUrl",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_custom_url: Option<String>,
    /// Username de LT Premium / self-hosted con auth. No es sensible (es un email),
    /// se persiste en settings.json. El apiKey va al keyring del sistema vía el
    /// módulo `secrets` (libsecret / Keychain / Credential Manager), nunca a este JSON.
    #[serde(
        default,
        rename = "grammarLtUsername",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_lt_username: Option<String>,
    #[serde(
        default,
        rename = "grammarVariantEs",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_variant_es: Option<String>,
    #[serde(
        default,
        rename = "grammarVariantEn",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_variant_en: Option<String>,
    /// Si true, el auto-check de gramática queda apagado aunque LT esté
    /// disponible. Default false (auto se activa solo cuando LT responde).
    #[serde(
        default,
        rename = "grammarAutoDisabled",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_auto_disabled: Option<bool>,
    /// Ancho del panel derecho ("compact" | "normal" | "wide" | "full").
    #[serde(
        default,
        rename = "rightPanelWidth",
        skip_serializing_if = "Option::is_none"
    )]
    pub right_panel_width: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}
