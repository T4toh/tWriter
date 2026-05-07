use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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
    let p = PathBuf::from(&book_path).join("book.json");
    if !p.exists() {
        // Defaults inferidos del nombre del dir
        let dir_name = PathBuf::from(&book_path)
            .file_name()
            .and_then(|s| s.to_str())
            .map(strip_numeric_prefix)
            .unwrap_or_default();
        return Ok(BookConfig {
            titulo: dir_name,
            idioma: Some("es".to_string()),
            ..Default::default()
        });
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
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
