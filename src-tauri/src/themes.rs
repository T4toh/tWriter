use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::theme::{is_font_ext, resolve_theme, Theme, ThemeRef};
use crate::util::{sanitize_name, unique_path};

const THEMES_DIR: &str = "themes";

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ThemeMeta {
    pub id: String,
    /// Resto de campos del Theme JSON, para que la UI muestre preview de la familia, tamaños, etc.
    #[serde(flatten)]
    pub theme: Theme,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ThemeFontEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub ext: Option<String>,
    /// Familia base parsed del filename (e.g. `Merriweather` para `Merriweather-Bold.ttf`).
    pub family: String,
    /// 400 | 700.
    pub weight: u32,
    /// `normal` | `italic`.
    pub style: String,
}

fn themes_root(root_path: &str) -> PathBuf {
    PathBuf::from(root_path).join(THEMES_DIR)
}

fn theme_dir(root_path: &str, id: &str) -> PathBuf {
    themes_root(root_path).join(id)
}

fn theme_fonts_dir(root_path: &str, id: &str) -> PathBuf {
    theme_dir(root_path, id).join("fonts")
}

fn validate_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("id de tema vacío".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("id de tema no puede contener separadores".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("id de tema inválido".to_string());
    }
    Ok(())
}

fn read_theme_file(path: &Path) -> Result<Theme, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))
}

fn write_theme_file(path: &Path, theme: &Theme) -> Result<(), String> {
    let mut json = serde_json::to_string_pretty(theme).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_themes(root_path: String) -> Result<Vec<ThemeMeta>, String> {
    let dir = themes_root(&root_path);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<ThemeMeta> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if id.starts_with('.') {
            continue;
        }
        let theme_json = path.join("theme.json");
        let theme = if theme_json.is_file() {
            read_theme_file(&theme_json).unwrap_or_default()
        } else {
            Theme::default()
        };
        out.push(ThemeMeta { id, theme });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Familias de fuentes resueltas del tema activo en un capítulo dado. Útil
/// para sugerir en el selector del editor "ver cómo se vería en el EPUB".
/// Todos los campos son nombres de familia o `None` cuando el tema/scope no
/// los define.
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChapterThemeFonts {
    pub body_font: Option<String>,
    pub heading_font: Option<String>,
    pub editorial_body_font: Option<String>,
    pub editorial_heading_font: Option<String>,
}

/// Dado el path absoluto de un capítulo (`<root>/<saga>?/<book>/<section>?/<n>.html`),
/// camina hacia arriba para encontrar `book.json` y `saga.json`, resuelve el
/// tema heredado (root theme + overrides saga + overrides book) y devuelve
/// las familias de fuentes finales.
#[tauri::command]
pub fn get_chapter_theme_fonts(
    chapter_path: String,
    root_path: String,
) -> Result<ChapterThemeFonts, String> {
    let chap = PathBuf::from(&chapter_path);
    let mut cur: PathBuf = if chap.is_file() {
        chap.parent()
            .ok_or_else(|| "chapter path sin parent".to_string())?
            .to_path_buf()
    } else {
        chap
    };
    let root = PathBuf::from(&root_path);
    let canon_root = root.canonicalize().unwrap_or(root.clone());

    let mut book_dir: Option<PathBuf> = None;
    let mut saga_dir: Option<PathBuf> = None;
    loop {
        if book_dir.is_none() && cur.join("book.json").is_file() {
            book_dir = Some(cur.clone());
        }
        if saga_dir.is_none() && cur.join("saga.json").is_file() {
            saga_dir = Some(cur.clone());
        }
        let canon_cur = cur.canonicalize().unwrap_or(cur.clone());
        if canon_cur == canon_root {
            break;
        }
        let Some(parent) = cur.parent() else { break };
        if parent == cur {
            break;
        }
        cur = parent.to_path_buf();
    }
    let Some(b_dir) = book_dir else {
        return Ok(ChapterThemeFonts::default());
    };
    let resolved = resolve_theme(&b_dir, saga_dir.as_deref(), &root);
    Ok(ChapterThemeFonts {
        body_font: resolved.body_font,
        heading_font: resolved.heading_font,
        editorial_body_font: resolved.editorial_body_font,
        editorial_heading_font: resolved.editorial_heading_font,
    })
}

#[tauri::command]
pub fn get_theme(root_path: String, id: String) -> Result<Theme, String> {
    validate_id(&id)?;
    let path = theme_dir(&root_path, &id).join("theme.json");
    if !path.is_file() {
        return Err(format!("tema no existe: {}", id));
    }
    let mut theme = read_theme_file(&path)?;
    theme.id = Some(id);
    Ok(theme)
}

#[tauri::command]
pub fn set_theme(root_path: String, id: String, theme: Theme) -> Result<(), String> {
    validate_id(&id)?;
    let dir = theme_dir(&root_path, &id);
    if !dir.is_dir() {
        return Err(format!("tema no existe: {}", id));
    }
    let mut to_write = theme;
    to_write.id = Some(id);
    write_theme_file(&dir.join("theme.json"), &to_write)
}

#[tauri::command]
pub fn create_theme(root_path: String, id: String, theme: Theme) -> Result<(), String> {
    validate_id(&id)?;
    let dir = theme_dir(&root_path, &id);
    if dir.exists() {
        return Err(format!("ya existe: {}", id));
    }
    fs::create_dir_all(dir.join("fonts")).map_err(|e| format!("mkdir: {}", e))?;
    let mut to_write = theme;
    to_write.id = Some(id);
    write_theme_file(&dir.join("theme.json"), &to_write)
}

#[tauri::command]
pub fn rename_theme(
    root_path: String,
    old_id: String,
    new_id: String,
) -> Result<(), String> {
    validate_id(&old_id)?;
    validate_id(&new_id)?;
    if old_id == new_id {
        return Ok(());
    }
    let old = theme_dir(&root_path, &old_id);
    let new = theme_dir(&root_path, &new_id);
    if !old.is_dir() {
        return Err(format!("tema no existe: {}", old_id));
    }
    if new.exists() {
        return Err(format!("ya existe: {}", new_id));
    }
    fs::rename(&old, &new).map_err(|e| format!("rename: {}", e))?;
    // Actualizar el id en theme.json. También actualizar nombre si era el
    // default (== old_id); preserva nombres custom.
    let theme_json = new.join("theme.json");
    if theme_json.is_file() {
        if let Ok(mut theme) = read_theme_file(&theme_json) {
            if theme.nombre.as_deref() == Some(old_id.as_str()) {
                theme.nombre = Some(new_id.clone());
            }
            theme.id = Some(new_id);
            let _ = write_theme_file(&theme_json, &theme);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn duplicate_theme(
    root_path: String,
    src_id: String,
    dst_id: String,
) -> Result<(), String> {
    validate_id(&src_id)?;
    validate_id(&dst_id)?;
    let src = theme_dir(&root_path, &src_id);
    let dst = theme_dir(&root_path, &dst_id);
    if !src.is_dir() {
        return Err(format!("tema no existe: {}", src_id));
    }
    if dst.exists() {
        return Err(format!("ya existe: {}", dst_id));
    }
    copy_dir_recursive(&src, &dst).map_err(|e| format!("copy: {}", e))?;
    // Actualizar id en theme.json. También actualizar nombre si era el default
    // (== src_id); preserva nombres custom.
    let theme_json = dst.join("theme.json");
    if theme_json.is_file() {
        if let Ok(mut theme) = read_theme_file(&theme_json) {
            if theme.nombre.as_deref() == Some(src_id.as_str()) {
                theme.nombre = Some(dst_id.clone());
            }
            theme.id = Some(dst_id);
            let _ = write_theme_file(&theme_json, &theme);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delete_theme(root_path: String, id: String) -> Result<(), String> {
    validate_id(&id)?;
    let dir = theme_dir(&root_path, &id);
    if !dir.is_dir() {
        return Err(format!("tema no existe: {}", id));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("rm: {}", e))
}

// ───────── Theme fonts ─────────

#[tauri::command]
pub fn list_theme_fonts(root_path: String, id: String) -> Result<Vec<ThemeFontEntry>, String> {
    validate_id(&id)?;
    let dir = theme_fonts_dir(&root_path, &id);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<ThemeFontEntry> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());
        let Some(ext_ref) = ext.as_deref() else {
            continue;
        };
        if !is_font_ext(ext_ref) {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(name)
            .to_string();
        let (family, weight, style) = crate::theme::parse_face_suffix(&stem);
        let size_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        out.push(ThemeFontEntry {
            name: name.to_string(),
            path: path.to_string_lossy().into_owned(),
            relative_path: name.to_string(),
            size_bytes,
            ext,
            family,
            weight,
            style: style.to_string(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn add_theme_font(
    root_path: String,
    id: String,
    source_path: String,
    target_name: Option<String>,
) -> Result<ThemeFontEntry, String> {
    validate_id(&id)?;
    let dir = theme_fonts_dir(&root_path, &id);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir fonts: {}", e))?;
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("source no es archivo: {}", source_path));
    }
    let raw_name = target_name
        .as_deref()
        .map(str::to_string)
        .or_else(|| {
            src.file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "font".to_string());
    let safe = sanitize_name(&raw_name, "font");
    // Validar extensión.
    let ext = Path::new(&safe)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_string());
    let ext_ok = ext.as_deref().map(is_font_ext).unwrap_or(false);
    if !ext_ok {
        return Err(format!(
            "extensión no soportada (ttf/otf/woff/woff2): {}",
            safe
        ));
    }
    let dest = unique_path(&dir, &safe);
    fs::copy(&src, &dest).map_err(|e| format!("copy: {}", e))?;
    entry_for_theme_font(&dir, &dest)
}

#[tauri::command]
pub fn remove_theme_font(
    root_path: String,
    id: String,
    relative_path: String,
) -> Result<(), String> {
    validate_id(&id)?;
    let dir = theme_fonts_dir(&root_path, &id);
    let target = dir.join(&relative_path);
    let canonical_target = target
        .canonicalize()
        .map_err(|e| format!("canon target: {}", e))?;
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("canon dir: {}", e))?;
    if !canonical_target.starts_with(&canonical_dir) {
        return Err("path fuera de fonts/".to_string());
    }
    if !canonical_target.is_file() {
        return Err(format!("no es archivo: {}", relative_path));
    }
    fs::remove_file(&canonical_target).map_err(|e| format!("rm: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn rename_theme_font(
    root_path: String,
    id: String,
    relative_path: String,
    new_name: String,
) -> Result<ThemeFontEntry, String> {
    validate_id(&id)?;
    let dir = theme_fonts_dir(&root_path, &id);
    let target = dir.join(&relative_path);
    let canonical_target = target
        .canonicalize()
        .map_err(|e| format!("canon target: {}", e))?;
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("canon dir: {}", e))?;
    if !canonical_target.starts_with(&canonical_dir) {
        return Err("path fuera de fonts/".to_string());
    }
    let safe = sanitize_name(&new_name, "font");
    let ext = Path::new(&safe)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_string());
    let ext_ok = ext.as_deref().map(is_font_ext).unwrap_or(false);
    if !ext_ok {
        return Err(format!(
            "extensión no soportada (ttf/otf/woff/woff2): {}",
            safe
        ));
    }
    let parent = canonical_target
        .parent()
        .ok_or_else(|| "sin parent".to_string())?;
    let dest = unique_path(parent, &safe);
    fs::rename(&canonical_target, &dest).map_err(|e| format!("rename: {}", e))?;
    entry_for_theme_font(&dir, &dest)
}

fn entry_for_theme_font(base: &Path, file: &Path) -> Result<ThemeFontEntry, String> {
    let name = file
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "filename inválido".to_string())?
        .to_string();
    let rel = file
        .strip_prefix(base)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| name.clone());
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    let stem = file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&name)
        .to_string();
    let (family, weight, style) = crate::theme::parse_face_suffix(&stem);
    let size_bytes = fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    Ok(ThemeFontEntry {
        name,
        path: file.to_string_lossy().into_owned(),
        relative_path: rel,
        size_bytes,
        ext,
        family,
        weight,
        style: style.to_string(),
    })
}

/// Set de familias referenciadas por algún tema, saga o libro del repo.
/// Sirve para marcar qué fuentes del pool global están en uso vs. cuáles son
/// candidatas a borrar.
#[derive(Serialize, Debug, Default)]
pub struct FontUsage {
    /// Familias referenciadas en `body_font` / `heading_font` / `editorial_*`.
    /// Comparación case-insensitive contra `FontEntry.family`.
    pub families: Vec<String>,
}

/// Walka temas + saga/book overrides para juntar todas las familias
/// referenciadas. Read-only, no toca disco.
#[tauri::command]
pub fn list_font_usage(root_path: String) -> Result<FontUsage, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(format!("root no es directorio: {}", root_path));
    }
    let mut families: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    // 1. Temas en <root>/themes/<id>/theme.json
    let themes_dir = root.join("themes");
    if themes_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&themes_dir) {
            for e in entries.flatten() {
                let p = e.path().join("theme.json");
                if !p.is_file() {
                    continue;
                }
                if let Some(t) = read_theme_json(&p) {
                    collect_from_theme(&t, &mut families);
                }
            }
        }
    }

    // 2. saga.json + book.json (overrides) en root + subdirs (depth 2).
    walk_configs(&root, 2, &mut families);

    Ok(FontUsage {
        families: families.into_iter().collect(),
    })
}

fn read_theme_json(path: &Path) -> Option<Theme> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Theme>(&raw).ok()
}

fn read_theme_ref_from(path: &Path) -> Option<ThemeRef> {
    let raw = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let theme = v.get("theme")?;
    serde_json::from_value::<ThemeRef>(theme.clone()).ok()
}

fn collect_from_theme(
    t: &Theme,
    families: &mut std::collections::BTreeSet<String>,
) {
    for fam in [
        &t.body_font,
        &t.heading_font,
        &t.editorial_body_font,
        &t.editorial_heading_font,
    ] {
        if let Some(s) = fam.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            families.insert(s.to_ascii_lowercase());
        }
    }
}

fn walk_configs(
    dir: &Path,
    depth: u32,
    families: &mut std::collections::BTreeSet<String>,
) {
    for cfg in ["saga.json", "book.json"] {
        let p = dir.join(cfg);
        if !p.is_file() {
            continue;
        }
        if let Some(tref) = read_theme_ref_from(&p) {
            if let Some(t) = tref.overrides.as_ref() {
                collect_from_theme(t, families);
            }
        }
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        match name {
            "themes" | "fonts" | "extras" | "notas" | "exports" | "Exportados"
            | "convertidos" | "Revisiones" | "zTapas" => continue,
            _ => {}
        }
        walk_configs(&p, depth - 1, families);
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else if path.is_file() {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
}
