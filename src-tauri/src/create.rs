use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::book_config::BookConfig;
use crate::saga_config::SagaConfig;

#[derive(Serialize, Debug)]
pub struct CreateResult {
    pub path: String,
}

/// Crea un capítulo .html vacío + su .meta.json en `parent_dir`.
/// Usa el próximo número entero disponible (1.html, 2.html…).
#[tauri::command]
pub async fn create_chapter(
    parent_dir: String,
    idioma: Option<String>,
    titulo: Option<String>,
) -> Result<CreateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_chapter_impl(&parent_dir, idioma.as_deref(), titulo.as_deref())
    })
    .await
    .map_err(|e| format!("task: {}", e))?
}

fn create_chapter_impl(
    parent: &str,
    idioma: Option<&str>,
    titulo: Option<&str>,
) -> Result<CreateResult, String> {
    let parent = PathBuf::from(parent);
    if !parent.is_dir() {
        return Err(format!("no es directorio: {}", parent.display()));
    }
    let n = next_chapter_num(&parent)?;
    let html = parent.join(format!("{}.html", n));
    let meta = parent.join(format!("{}.meta.json", n));
    if html.exists() {
        return Err(format!("ya existe: {}", html.display()));
    }
    fs::write(&html, "<p></p>\n").map_err(|e| e.to_string())?;
    let lang = idioma.unwrap_or("es");
    let title = titulo
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}", n));
    let meta_json = serde_json::json!({
        "orden": n,
        "titulo": title,
        "palabras": 0,
        "ultima_edicion": null,
        "status": "draft",
        "idioma": lang,
    });
    fs::write(&meta, serde_json::to_string_pretty(&meta_json).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    tracing::info!(target: "create", path = %html.display(), idioma = %lang, "capítulo creado");
    Ok(CreateResult {
        path: html.to_string_lossy().into_owned(),
    })
}

/// Crea un directorio dentro de `parent_dir` con `name`.
/// Si `numbered` es true y los hermanos siguen el patrón "N - Nombre",
/// prepende el próximo número. Si no, usa name tal cual.
#[tauri::command]
pub async fn create_directory(
    parent_dir: String,
    name: String,
    numbered: bool,
) -> Result<CreateResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_dir_impl(&parent_dir, &name, numbered))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn create_dir_impl(parent: &str, name: &str, numbered: bool) -> Result<CreateResult, String> {
    let parent = PathBuf::from(parent);
    if !parent.is_dir() {
        return Err(format!("no es directorio: {}", parent.display()));
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("nombre vacío".to_string());
    }

    let final_name = if numbered {
        let n = next_dir_num(&parent)?;
        format!("{} - {}", n, trimmed)
    } else {
        trimmed.to_string()
    };
    let path = parent.join(&final_name);
    if path.exists() {
        return Err(format!("ya existe: {}", path.display()));
    }
    fs::create_dir(&path).map_err(|e| e.to_string())?;
    tracing::info!(target: "create", path = %path.display(), "directorio creado");
    Ok(CreateResult {
        path: path.to_string_lossy().into_owned(),
    })
}

/// Crea un libro dentro de `parent_dir` con nombre numerado ("N - Nombre"),
/// inicializa `book.json` heredando `autor`/`idioma` de la saga padre (si existe)
/// y autocompleta `serie` + `numero_en_serie` + defaults EPUB.
#[tauri::command]
pub async fn create_book(parent_dir: String, name: String) -> Result<CreateResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_book_impl(&parent_dir, &name))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn create_book_impl(parent: &str, name: &str) -> Result<CreateResult, String> {
    let parent = PathBuf::from(parent);
    if !parent.is_dir() {
        return Err(format!("no es directorio: {}", parent.display()));
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("nombre vacío".to_string());
    }

    let n = next_dir_num(&parent)?;
    let dir_name = format!("{} - {}", n, trimmed);
    let book_dir = parent.join(&dir_name);
    if book_dir.exists() {
        return Err(format!("ya existe: {}", book_dir.display()));
    }
    fs::create_dir(&book_dir).map_err(|e| e.to_string())?;

    let saga = read_saga_for(&parent);
    let cfg = build_inherited_book_config(trimmed, n, saga.as_ref(), &parent);
    let book_json = book_dir.join("book.json");
    let mut json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&book_json, json).map_err(|e| e.to_string())?;

    tracing::info!(target: "create", path = %book_dir.display(), titulo = trimmed, "libro creado");
    Ok(CreateResult {
        path: book_dir.to_string_lossy().into_owned(),
    })
}

fn read_saga_for(parent: &Path) -> Option<SagaConfig> {
    let saga_json = parent.join("saga.json");
    if !saga_json.is_file() {
        return None;
    }
    let raw = fs::read_to_string(&saga_json).ok()?;
    serde_json::from_str::<SagaConfig>(&raw).ok()
}

fn build_inherited_book_config(
    titulo: &str,
    numero: u32,
    saga: Option<&SagaConfig>,
    parent: &Path,
) -> BookConfig {
    let serie = saga
        .map(|s| s.nombre.clone())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            parent
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| strip_numeric_prefix(s))
        })
        .filter(|s| !s.trim().is_empty());

    BookConfig {
        titulo: titulo.to_string(),
        autor: saga.and_then(|s| s.autor.clone()).filter(|s| !s.is_empty()),
        idioma: Some(
            saga.and_then(|s| s.idioma.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "es".to_string()),
        ),
        serie,
        numero_en_serie: Some(numero),
        copyright_anio: Some(current_year()),
        derechos_reservados: Some(true),
        template: Some(
            saga.and_then(|s| s.template.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "6x9".to_string()),
        ),
        mostrar_titulo_capitulo: Some(saga.and_then(|s| s.mostrar_titulo_capitulo).unwrap_or(true)),
        prefijo_capitulo: Some(
            saga.and_then(|s| s.prefijo_capitulo.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "none".to_string()),
        ),
        dropcap: Some(saga.and_then(|s| s.dropcap).unwrap_or(false)),
        mostrar_numero_parte: Some(saga.and_then(|s| s.mostrar_numero_parte).unwrap_or(false)),
        formato_parte: Some(
            saga.and_then(|s| s.formato_parte.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "raw".to_string()),
        ),
        imprenta: Some(
            saga.and_then(|s| s.imprenta.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Independiente".to_string()),
        ),
        ..Default::default()
    }
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

fn current_year() -> u32 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if m <= 2 { y + 1 } else { y };
    year as u32
}

fn next_chapter_num(parent: &std::path::Path) -> Result<u32, String> {
    let mut max = 0u32;
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "html" && ext != "odt" && ext != "docx" {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            if let Ok(n) = stem.parse::<u32>() {
                if n > max {
                    max = n;
                }
            }
        }
    }
    Ok(max + 1)
}

fn next_dir_num(parent: &std::path::Path) -> Result<u32, String> {
    let mut max = 0u32;
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let trimmed = name.trim_start();
        let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            if n > max {
                max = n;
            }
        }
    }
    Ok(max + 1)
}
