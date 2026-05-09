use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// Busca `cover.<ext>` en `dir`. Devuelve el nombre relativo (ej: "cover.jpg") si existe.
pub fn find_cover_in(dir: &Path) -> Option<String> {
    find_named_image(dir, "cover")
}

/// Busca `back-cover.<ext>` en `dir`. Devuelve el nombre relativo si existe.
pub fn find_back_cover_in(dir: &Path) -> Option<String> {
    find_named_image(dir, "back-cover")
}

fn find_named_image(dir: &Path, stem: &str) -> Option<String> {
    for ext in COVER_EXTS {
        let candidate = dir.join(format!("{}.{}", stem, ext));
        if candidate.is_file() {
            return Some(format!("{}.{}", stem, ext));
        }
    }
    None
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BookConfig {
    #[serde(default)]
    pub titulo: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitulo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autor: Option<String>,
    #[serde(default)]
    pub idioma: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    /// Path relativo al book dir (ej: "cover.png") o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tapa: Option<String>,
    /// Contratapa. Path relativo al book dir (ej: "back-cover.png") o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contratapa: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copyright_anio: Option<u32>,
    #[serde(default)]
    pub derechos_reservados: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedicatoria: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imprenta: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serie: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numero_en_serie: Option<u32>,
    /// Mostrar el título del capítulo en la chapter title page. Default: true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_titulo_capitulo: Option<bool>,
    /// Prefijo del capítulo: "none" | "decimal" | "roman". Default: "none".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefijo_capitulo: Option<String>,
    /// Letrina (drop cap) en primera letra del primer párrafo de cada capítulo. Default: false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropcap: Option<bool>,
    /// Mostrar número/título de la parte arriba de su contenido. Default: false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_numero_parte: Option<bool>,
    /// Formato de etiqueta de parte: "raw" (1) | "parte" (Parte 1) | "punto" (1.). Default: "raw".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formato_parte: Option<String>,
    /// Template de tamaño de página para export EPUB: "6x9" | "5x8" | "a5". Default: "6x9".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

#[tauri::command]
pub fn get_book_config(book_path: String) -> Result<BookConfig, String> {
    let book_dir = PathBuf::from(&book_path);
    let p = book_dir.join("book.json");
    let mut cfg = if p.exists() {
        let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        serde_json::from_str::<BookConfig>(&raw).map_err(|e| e.to_string())?
    } else {
        let dir_name = book_dir
            .file_name()
            .and_then(|s| s.to_str())
            .map(strip_numeric_prefix)
            .unwrap_or_default();
        BookConfig {
            titulo: dir_name,
            idioma: Some("es".to_string()),
            ..Default::default()
        }
    };
    if cfg.tapa.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        if let Some(found) = find_cover_in(&book_dir) {
            cfg.tapa = Some(found);
        }
    }
    if cfg.contratapa.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        if let Some(found) = find_back_cover_in(&book_dir) {
            cfg.contratapa = Some(found);
        }
    }
    Ok(cfg)
}

#[tauri::command]
pub fn set_book_config(book_path: String, config: BookConfig) -> Result<(), String> {
    let p = PathBuf::from(&book_path);
    if !p.is_dir() {
        return Err(format!("no es directorio: {}", book_path));
    }
    let target = p.join("book.json");
    let mut json =
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&target, json).map_err(|e| e.to_string())
}

fn strip_numeric_prefix(s: &str) -> String {
    let trimmed = s.trim_start();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return s.to_string();
    }
    let rest = &trimmed[digits.len()..];
    rest.trim_start_matches(|c: char| c.is_whitespace() || c == '-')
        .to_string()
}
