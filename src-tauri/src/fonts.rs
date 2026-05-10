use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::theme::{is_font_ext, parse_face_suffix};
use crate::util::{sanitize_name, unique_path};

const FONTS_DIR: &str = "fonts";

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FontEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub ext: Option<String>,
    pub family: String,
    pub weight: u32,
    pub style: String,
}

fn fonts_dir(scope_path: &str) -> PathBuf {
    PathBuf::from(scope_path).join(FONTS_DIR)
}

#[tauri::command]
pub fn has_fonts(scope_path: String) -> bool {
    let dir = fonts_dir(&scope_path);
    if !dir.is_dir() {
        return false;
    }
    fs::read_dir(&dir)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
}

#[tauri::command]
pub fn list_fonts(scope_path: String) -> Result<Vec<FontEntry>, String> {
    let dir = fonts_dir(&scope_path);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<FontEntry> = Vec::new();
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
        let (family, weight, style) = parse_face_suffix(&stem);
        let size_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        out.push(FontEntry {
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
pub fn add_font(
    scope_path: String,
    source_path: String,
    target_name: Option<String>,
) -> Result<FontEntry, String> {
    let scope = PathBuf::from(&scope_path);
    if !scope.is_dir() {
        return Err(format!("scope no es directorio: {}", scope_path));
    }
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("source no es archivo: {}", source_path));
    }
    let dir = fonts_dir(&scope_path);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir fonts: {}", e))?;
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
    entry_for(&dir, &dest)
}

#[tauri::command]
pub fn remove_font(scope_path: String, relative_path: String) -> Result<(), String> {
    let dir = fonts_dir(&scope_path);
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
pub fn rename_font(
    scope_path: String,
    relative_path: String,
    new_name: String,
) -> Result<FontEntry, String> {
    let dir = fonts_dir(&scope_path);
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
    entry_for(&dir, &dest)
}

fn entry_for(base: &Path, file: &Path) -> Result<FontEntry, String> {
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
    let (family, weight, style) = parse_face_suffix(&stem);
    let size_bytes = fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    Ok(FontEntry {
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
