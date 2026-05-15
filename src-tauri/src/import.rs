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
        .map_err(|e| {
            tracing::error!(target: "import", error = %e, "pandoc no encontrado");
            format!("pandoc no encontrado: {} — instalá pandoc primero", e)
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("pandoc falló (exit {})", output.status)
        } else {
            stderr
        };
        tracing::error!(target: "import", path = %input_path, error = %msg, "pandoc falló");
        return Err(msg);
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
        let inherited_idioma = inherit_idioma(parent);
        let meta = serde_json::json!({
            "orden": order,
            "titulo": stem,
            "status": "imported",
            "idioma": inherited_idioma,
        });
        fs::write(&meta_out, serde_json::to_string_pretty(&meta).unwrap_or_default())
            .map_err(|e| e.to_string())?;
    }
    // `palabras` se computa lazy en el próximo refresh del tree (fallback de
    // `chapter_word_count` lee el HTML). No seedeamos stats acá porque no
    // tenemos el `root` del workspace; la fuente de verdad es el cache que
    // arma `get_tree`.

    tracing::info!(target: "import", from = %input_path, to = %html_out.display(), "capítulo importado");
    Ok(ImportResult {
        html_path: html_out.to_string_lossy().into_owned(),
        created: true,
    })
}

/// Limpia el HTML crudo de pandoc para dejar solo el subset que usa el editor.
///
/// Los `<br>` adentro de un `<p>` se convierten en `</p><p>` porque Pandoc emite
/// `<br>` cuando el `.docx` usa saltos blandos en vez de párrafos nuevos. Si los
/// dejamos como `<br>`, el extractor de texto para LanguageTool concatena todo
/// y LT pide "espacio tras el punto" entre líneas de diálogo.
pub(crate) fn clean_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    let mut inside_p = false;

    let allowed_tags = [
        "p", "em", "strong", "i", "b", "u", "blockquote", "hr", "h1", "h2", "h3", "br",
    ];

    while let Some(c) = chars.next() {
        if c == '<' {
            let mut tag = String::new();
            while let Some(&next) = chars.peek() {
                tag.push(next);
                chars.next();
                if next == '>' {
                    break;
                }
            }
            let inner = tag.trim_end_matches('>').trim_start_matches('/');
            let tag_name = inner
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_lowercase();

            if allowed_tags.contains(&tag_name.as_str()) {
                let is_close = tag.starts_with('/');
                if is_close {
                    if tag_name == "p" {
                        inside_p = false;
                    }
                    out.push_str(&format!("</{}>", tag_name));
                } else if tag_name == "hr" {
                    out.push_str(r#"<hr class="scene-break"/>"#);
                } else if tag_name == "br" {
                    if inside_p {
                        out.push_str("</p><p>");
                    }
                } else {
                    if tag_name == "p" {
                        inside_p = true;
                    }
                    out.push_str(&format!("<{}>", tag_name));
                }
            }
        } else {
            out.push(c);
        }
    }

    while out.contains("<p></p>") {
        out = out.replace("<p></p>", "");
    }

    // Normaliza `...` literales a `…` (U+2026). El subset HTML no permite <code>,
    // así que cualquier `...` en el output es texto de prosa.
    let out = out.replace("...", "…");

    out.split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::clean_html;

    #[test]
    fn br_inside_p_becomes_paragraph_break() {
        let input = "<p>—Foo<br>—Bar<br>—Baz</p>";
        let out = clean_html(input);
        assert_eq!(out, "<p>—Foo</p><p>—Bar</p><p>—Baz</p>");
    }

    #[test]
    fn double_br_collapses_to_single_paragraph_break() {
        let input = "<p>Foo<br><br>Bar</p>";
        let out = clean_html(input);
        assert_eq!(out, "<p>Foo</p><p>Bar</p>");
    }

    #[test]
    fn br_at_start_or_end_of_p_drops_empty() {
        let input = "<p><br>Foo<br></p>";
        let out = clean_html(input);
        assert_eq!(out, "<p>Foo</p>");
    }

    #[test]
    fn br_outside_p_is_dropped() {
        let input = "<p>Foo</p><br><p>Bar</p>";
        let out = clean_html(input);
        assert_eq!(out, "<p>Foo</p><p>Bar</p>");
    }

    #[test]
    fn regular_paragraphs_passthrough() {
        let input = "<p>Hola</p>\n<p>Chau</p>";
        let out = clean_html(input);
        assert_eq!(out, "<p>Hola</p>\n<p>Chau</p>");
    }

    #[test]
    fn em_strong_preserved() {
        let input = "<p>Hola <em>mundo</em> y <strong>chau</strong></p>";
        let out = clean_html(input);
        assert_eq!(out, "<p>Hola <em>mundo</em> y <strong>chau</strong></p>");
    }

    #[test]
    fn hr_becomes_scene_break() {
        let input = "<p>Foo</p><hr><p>Bar</p>";
        let out = clean_html(input);
        assert_eq!(out, "<p>Foo</p><hr class=\"scene-break\"/><p>Bar</p>");
    }

    #[test]
    fn triple_dots_become_ellipsis() {
        let input = "<p>Gracias...</p><p>Hola...adiós</p>";
        let out = clean_html(input);
        assert_eq!(out, "<p>Gracias…</p><p>Hola…adiós</p>");
    }

    #[test]
    fn more_than_three_dots_normalize() {
        let input = "<p>Eh.... bueno</p>";
        let out = clean_html(input);
        assert_eq!(out, "<p>Eh…. bueno</p>");
    }
}

/// Camina hacia arriba buscando book.json (preferido) o saga.json para heredar idioma.
/// Devuelve None si no encuentra nada — el meta.idioma quedará null y el grammar check
/// usará language=auto.
pub(crate) fn inherit_idioma(start: &Path) -> Option<String> {
    let mut p = start.to_path_buf();
    let mut book_idioma: Option<String> = None;
    let mut saga_idioma: Option<String> = None;
    loop {
        if book_idioma.is_none() {
            if let Some(v) = read_json_field(&p.join("book.json"), "idioma") {
                book_idioma = Some(v);
            }
        }
        if saga_idioma.is_none() {
            if let Some(v) = read_json_field(&p.join("saga.json"), "idioma") {
                saga_idioma = Some(v);
            }
        }
        if book_idioma.is_some() && saga_idioma.is_some() {
            break;
        }
        let parent = match p.parent() {
            Some(parent) if parent != p => parent.to_path_buf(),
            _ => break,
        };
        p = parent;
    }
    book_idioma.or(saga_idioma)
}

fn read_json_field(path: &Path, field: &str) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let s = v.get(field)?.as_str()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub(crate) fn count_words(html: &str) -> u32 {
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
    let removed_path = p.to_string_lossy().into_owned();
    if ext == "html" {
        crate::search::remove_path_best_effort(&removed_path);
    }
    deleted.push(removed_path);

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

    fs::remove_dir_all(&target_p).map_err(|e| e.to_string())?;
    // Best-effort: el directorio borrado puede tener chapters/notes indexados.
    // Removemos solo el path raíz; el reindex full reconcilia eventualmente.
    crate::search::remove_path_best_effort(&target_p.to_string_lossy());
    Ok(())
}

#[allow(dead_code)]
fn parent_dir(p: &Path) -> Option<PathBuf> {
    p.parent().map(PathBuf::from)
}
