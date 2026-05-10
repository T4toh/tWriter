use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::theme::ThemeRef;

const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// Busca `cover.<ext>` en `dir`. Devuelve el nombre relativo (ej: "cover.jpg") si existe.
pub fn find_cover_in(dir: &Path) -> Option<String> {
    find_named_image(dir, "cover")
}

/// Busca `back-cover.<ext>` en `dir`. Devuelve el nombre relativo si existe.
pub fn find_back_cover_in(dir: &Path) -> Option<String> {
    find_named_image(dir, "back-cover")
}

/// Busca `author.<ext>` o `autor.<ext>` en `dir`. Devuelve el nombre relativo
/// si existe. Permite ambas convenciones (en/es).
pub fn find_author_photo_in(dir: &Path) -> Option<String> {
    find_named_image(dir, "author").or_else(|| find_named_image(dir, "autor"))
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
    /// Marca la novela como finalizada (sin más capítulos por agregar). Oculta el creador de capítulos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalizada: Option<bool>,
    /// Path relativo al book dir del directorio del epílogo (ej: "Epílogo"). Único por novela.
    /// El epílogo se trata como un capítulo independiente al final del libro, fuera del TOC principal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epilogo: Option<String>,
    /// Tema base + overrides per-campo. Sobrescribe lo heredado de la saga.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemeRef>,
    /// Bio del autor para la página "Sobre el autor" del EPUB. Plain text;
    /// cada línea no vacía se renderea como un `<p>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sobre_el_autor: Option<String>,
    /// Path relativo al book dir (ej: "author.jpg") o absoluto. Si es absoluto,
    /// el builder lo copia al EPUB; si es relativo, se busca en `<book>/`.
    /// Auto-detecta `author.*`/`autor.*` en disco si está vacío.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foto_autor: Option<String>,
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
    if cfg.foto_autor.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        if let Some(found) = find_author_photo_in(&book_dir) {
            cfg.foto_autor = Some(found);
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

/// Marca un directorio sección como epílogo de su novela contenedora.
/// Renombra el dir a "Epílogo" / "Epilogue" según `book.json::idioma`,
/// quitando cualquier prefijo numérico, y escribe `book.json::epilogo`.
/// Falla si ya hay epílogo o si la sección no es hija directa de la novela.
#[tauri::command]
pub async fn mark_as_epilogo(section_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mark_as_epilogo_impl(&section_path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn mark_as_epilogo_impl(section_path: &str) -> Result<String, String> {
    let section = PathBuf::from(section_path);
    if !section.is_dir() {
        return Err(format!("no es directorio: {}", section_path));
    }
    let parent = section
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "sección sin parent".to_string())?;
    let book_json = parent.join("book.json");
    if !book_json.is_file() {
        return Err("la sección no es hija directa de una novela (sin book.json)".to_string());
    }
    let raw = fs::read_to_string(&book_json).map_err(|e| e.to_string())?;
    let mut cfg: BookConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if cfg
        .epilogo
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        return Err(format!(
            "la novela ya tiene epílogo: {}",
            cfg.epilogo.as_deref().unwrap_or("")
        ));
    }
    let target_name = match cfg.idioma.as_deref().unwrap_or("es") {
        "en" => "Epilogue",
        _ => "Epílogo",
    };
    let current_name = section
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "nombre de sección inválido".to_string())?
        .to_string();
    let final_path = if current_name == target_name {
        section.clone()
    } else {
        let target = parent.join(target_name);
        if target.exists() {
            return Err(format!("ya existe: {}", target.display()));
        }
        fs::rename(&section, &target).map_err(|e| e.to_string())?;
        target
    };
    cfg.epilogo = Some(target_name.to_string());
    let mut out = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    out.push('\n');
    fs::write(&book_json, out).map_err(|e| e.to_string())?;
    Ok(final_path.to_string_lossy().into_owned())
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
