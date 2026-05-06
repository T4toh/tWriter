use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Debug)]
pub struct CreateResult {
    pub path: String,
}

/// Crea un capítulo .html vacío + su .meta.json en `parent_dir`.
/// Usa el próximo número entero disponible (1.html, 2.html…).
#[tauri::command]
pub async fn create_chapter(parent_dir: String, idioma: Option<String>) -> Result<CreateResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_chapter_impl(&parent_dir, idioma.as_deref()))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn create_chapter_impl(parent: &str, idioma: Option<&str>) -> Result<CreateResult, String> {
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
    let meta_json = serde_json::json!({
        "orden": n,
        "titulo": format!("{}", n),
        "palabras": 0,
        "ultima_edicion": null,
        "status": "draft",
        "idioma": lang,
    });
    fs::write(&meta, serde_json::to_string_pretty(&meta_json).unwrap_or_default())
        .map_err(|e| e.to_string())?;
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
    Ok(CreateResult {
        path: path.to_string_lossy().into_owned(),
    })
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
