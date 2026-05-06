use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Debug)]
pub struct ImportResult {
    pub html_path: String,
    pub created: bool,
}

#[derive(Serialize, Debug)]
pub struct DeleteResult {
    pub deleted: Vec<String>,
}

/// Importa un capítulo .docx/.odt a HTML usando pandoc CLI.
/// Genera `<stem>.html` en la misma carpeta y `<stem>.meta.json` mínimo.
/// Si ya existe `<stem>.html`, falla (no sobrescribe).
#[tauri::command]
pub async fn import_chapter(path: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_impl(&path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn import_impl(input_path: &str) -> Result<ImportResult, String> {
    let input = PathBuf::from(input_path);
    if !input.is_file() {
        return Err(format!("no es archivo: {}", input_path));
    }
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if ext != "docx" && ext != "odt" {
        return Err(format!("formato no soportado: .{}", ext));
    }
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "sin nombre".to_string())?;
    let parent = input.parent().ok_or_else(|| "sin carpeta padre".to_string())?;
    let html_out = parent.join(format!("{}.html", stem));
    if html_out.exists() {
        return Err(format!(
            "ya existe {} — borralo o renombralo si querés re-importar",
            html_out.display()
        ));
    }

    // Pandoc → HTML5 fragment, sin highlight, sin wrap
    // Pandoc auto-detecta el formato desde la extensión del input.
    let output = Command::new("pandoc")
        .arg(&input)
        .args(["--to=html5", "--no-highlight", "--wrap=none"])
        .output()
        .map_err(|e| format!("pandoc no encontrado: {} — instalá pandoc primero", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("pandoc falló (exit {})", output.status)
        } else {
            stderr
        });
    }

    let raw_html = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut cleaned = clean_html(&raw_html);
    if !cleaned.ends_with('\n') {
        cleaned.push('\n');
    }
    fs::write(&html_out, cleaned).map_err(|e| e.to_string())?;

    // .meta.json mínimo
    let meta_out = parent.join(format!("{}.meta.json", stem));
    if !meta_out.exists() {
        let order = stem.parse::<u32>().unwrap_or(0);
        let meta = serde_json::json!({
            "orden": order,
            "titulo": stem,
            "palabras": count_words(&raw_html),
            "ultima_edicion": null,
            "status": "imported",
            "idioma": "es",
        });
        fs::write(&meta_out, serde_json::to_string_pretty(&meta).unwrap_or_default())
            .map_err(|e| e.to_string())?;
    }

    Ok(ImportResult {
        html_path: html_out.to_string_lossy().into_owned(),
        created: true,
    })
}

/// Limpia el HTML crudo de pandoc para dejar solo el subset que usa el editor.
fn clean_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();

    // Remueve tags no permitidos transformándolos a sus equivalentes,
    // o eliminándolos preservando contenido.
    // Conservamos: p, em, strong, i, b, u, blockquote, hr, h1-h3, br
    // Eliminamos: div, span (preservando texto), header, section, etc.
    let allowed_tags = [
        "p", "em", "strong", "i", "b", "u", "blockquote", "hr", "h1", "h2", "h3", "br",
    ];

    while let Some(c) = chars.next() {
        if c == '<' {
            // Lee hasta '>'
            let mut tag = String::new();
            while let Some(&next) = chars.peek() {
                tag.push(next);
                chars.next();
                if next == '>' {
                    break;
                }
            }
            // Parse tag
            let inner = tag.trim_end_matches('>').trim_start_matches('/');
            let tag_name = inner
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_lowercase();

            if allowed_tags.contains(&tag_name.as_str()) {
                // Reemitimos el tag pero sin atributos (excepto hr y br)
                let is_close = tag.starts_with("</");
                if is_close {
                    out.push_str(&format!("</{}>", tag_name));
                } else if tag_name == "hr" {
                    out.push_str(r#"<hr class="scene-break"/>"#);
                } else if tag_name == "br" {
                    out.push_str("<br/>");
                } else {
                    out.push_str(&format!("<{}>", tag_name));
                }
            }
            // Tags no permitidos: descartar (preservando contenido al no emitirlos)
        } else {
            out.push(c);
        }
    }

    // Normaliza saltos de línea / espacios
    out.split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn count_words(html: &str) -> u32 {
    let mut text = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            text.push(c);
        }
    }
    text.split_whitespace().count() as u32
}

/// Borra un capítulo (.html/.odt/.docx) y su .meta.json sibling.
/// Sólo permite borrar archivos con extensiones de capítulo conocidas.
#[tauri::command]
pub async fn delete_chapter_file(path: String) -> Result<DeleteResult, String> {
    tauri::async_runtime::spawn_blocking(move || delete_impl(&path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn delete_impl(path: &str) -> Result<DeleteResult, String> {
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err(format!("no es archivo: {}", path));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if ext != "odt" && ext != "docx" && ext != "html" {
        return Err(format!(
            "no permitido borrar .{} (sólo .odt/.docx/.html)",
            ext
        ));
    }

    let mut deleted = Vec::new();
    fs::remove_file(&p).map_err(|e| e.to_string())?;
    deleted.push(p.to_string_lossy().into_owned());

    // Borrar .meta.json huérfano si:
    //  - estamos borrando un .html → siempre
    //  - estamos borrando .odt/.docx → sólo si no queda un .html sibling
    let parent = p.parent().ok_or_else(|| "sin padre".to_string())?;
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let meta = parent.join(format!("{}.meta.json", stem));
    let should_delete_meta = if ext == "html" {
        true
    } else {
        !parent.join(format!("{}.html", stem)).exists()
    };
    if should_delete_meta && meta.exists() {
        fs::remove_file(&meta).map_err(|e| e.to_string())?;
        deleted.push(meta.to_string_lossy().into_owned());
    }

    Ok(DeleteResult { deleted })
}

/// Borra un directorio recursivo. Por seguridad, target debe estar dentro de root y no ser igual.
#[tauri::command]
pub async fn delete_directory(root: String, target: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_dir_impl(&root, &target))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn delete_dir_impl(root: &str, target: &str) -> Result<(), String> {
    let root_p = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("root inválido: {}", e))?;
    let target_p = PathBuf::from(target)
        .canonicalize()
        .map_err(|e| format!("target inválido: {}", e))?;

    if !target_p.is_dir() {
        return Err(format!("no es directorio: {}", target));
    }
    if target_p == root_p {
        return Err("no se puede borrar la raíz".to_string());
    }
    if !target_p.starts_with(&root_p) {
        return Err(format!("target está fuera de root ({})", root));
    }

    fs::remove_dir_all(&target_p).map_err(|e| e.to_string())
}

#[allow(dead_code)]
fn parent_dir(p: &Path) -> Option<PathBuf> {
    p.parent().map(PathBuf::from)
}
