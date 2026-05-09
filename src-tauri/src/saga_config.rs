use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::book_config::find_cover_in;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SagaConfig {
    #[serde(default)]
    pub nombre: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idioma: Option<String>,
    /// Tapa de la serie. Path relativo al saga dir (ej: "cover.png") o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tapa: Option<String>,
    /// Glosario compartido por todos los libros de la saga (nombres propios, neologismos).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diccionario: Option<Vec<String>>,
    /// Imprenta heredada a libros nuevos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imprenta: Option<String>,
    /// Defaults EPUB heredados a libros nuevos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_titulo_capitulo: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefijo_capitulo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropcap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_numero_parte: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formato_parte: Option<String>,
    /// Marca la saga como finalizada (sin más novelas por agregar). Oculta el creador de novelas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalizada: Option<bool>,
}

#[tauri::command]
pub fn find_saga_dir(path: String) -> Option<String> {
    let mut p = PathBuf::from(&path);
    if p.is_file() {
        p = p.parent()?.to_path_buf();
    }
    let mut book_dir: Option<PathBuf> = None;
    loop {
        if p.join("saga.json").is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
        if book_dir.is_none() && p.join("book.json").is_file() {
            book_dir = Some(p.clone());
        }
        let parent = p.parent()?.to_path_buf();
        if parent == p {
            break;
        }
        p = parent;
    }
    // Sin saga.json en el árbol: caer al padre del book dir como saga implícita.
    book_dir.and_then(|b| b.parent().map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn get_saga_config(saga_path: String) -> Result<SagaConfig, String> {
    let saga_dir = PathBuf::from(&saga_path);
    let p = saga_dir.join("saga.json");
    let mut cfg = if p.exists() {
        let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        serde_json::from_str::<SagaConfig>(&raw).map_err(|e| e.to_string())?
    } else {
        let nombre = saga_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        SagaConfig {
            nombre,
            ..Default::default()
        }
    };
    if cfg.tapa.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        if let Some(found) = find_cover_in(&saga_dir) {
            cfg.tapa = Some(found);
        }
    }
    Ok(cfg)
}

#[tauri::command]
pub fn set_saga_config(saga_path: String, config: SagaConfig) -> Result<(), String> {
    let p = PathBuf::from(&saga_path);
    if !p.is_dir() {
        return Err(format!("no es directorio: {}", saga_path));
    }
    let target = p.join("saga.json");
    let mut json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&target, json).map_err(|e| e.to_string())
}
