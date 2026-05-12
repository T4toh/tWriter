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

/// Resultado de consolidar fuentes al pool global.
#[derive(Serialize, Debug)]
pub struct ConsolidateResult {
    /// Fuentes nuevas movidas a `<root>/fonts/`.
    pub moved: u32,
    /// Fuentes que ya estaban en root (mismo nombre y tamaño); originales borrados.
    pub deduped: u32,
    /// Colisiones: archivos con mismo nombre pero distinto tamaño que el del root.
    /// Se dejan intactos para que el usuario decida; no se borra nada.
    pub kept: u32,
    /// Carpetas `fonts/` que quedaron vacías y fueron eliminadas.
    pub removed_dirs: u32,
}

/// Walka todas las carpetas `fonts/` dispersas (themes/*, saga, book) y mueve las
/// fuentes al pool global `<root>/fonts/`. Si una fuente ya existe en root con
/// mismo nombre y mismo tamaño, borra el original (asume dupe). Si existe con
/// tamaño distinto, deja el original (colisión a resolver a mano).
#[tauri::command]
pub fn consolidate_fonts(root_path: String) -> Result<ConsolidateResult, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(format!("root no es directorio: {}", root_path));
    }
    let dest_dir = root.join("fonts");
    fs::create_dir_all(&dest_dir).map_err(|e| format!("mkdir <root>/fonts: {}", e))?;

    let mut moved: u32 = 0;
    let mut deduped: u32 = 0;
    let mut kept: u32 = 0;

    let mut source_dirs: Vec<PathBuf> = Vec::new();
    collect_font_dirs(&root, &dest_dir, &mut source_dirs);

    for src_dir in &source_dirs {
        let entries = match fs::read_dir(src_dir) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(target: "fonts", dir = %src_dir.display(), error = %e, "consolidate: no pude leer dir");
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
            else {
                continue;
            };
            if !is_font_ext(&ext) {
                continue;
            }
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let dest = dest_dir.join(name);
            if dest.exists() {
                let src_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let dst_size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(u64::MAX);
                if src_size == dst_size {
                    match fs::remove_file(&path) {
                        Ok(_) => {
                            deduped += 1;
                            tracing::info!(target: "fonts", path = %path.display(), "consolidate: dupe borrada");
                        }
                        Err(e) => {
                            tracing::warn!(target: "fonts", path = %path.display(), error = %e, "consolidate: no pude borrar dupe");
                            kept += 1;
                        }
                    }
                } else {
                    kept += 1;
                    tracing::warn!(
                        target: "fonts",
                        path = %path.display(),
                        src_size, dst_size,
                        "consolidate: colisión de nombre con tamaño distinto, queda intacta"
                    );
                }
                continue;
            }
            // Intentar rename (atómico same-filesystem); si falla por cross-device, copy+remove.
            match fs::rename(&path, &dest) {
                Ok(_) => {
                    moved += 1;
                    tracing::info!(target: "fonts", from = %path.display(), to = %dest.display(), "consolidate: fuente movida");
                }
                Err(_) => match fs::copy(&path, &dest) {
                    Ok(_) => match fs::remove_file(&path) {
                        Ok(_) => {
                            moved += 1;
                            tracing::info!(target: "fonts", from = %path.display(), to = %dest.display(), "consolidate: fuente movida (copy+rm)");
                        }
                        Err(e) => {
                            kept += 1;
                            tracing::warn!(target: "fonts", from = %path.display(), error = %e, "consolidate: copy ok pero no pude borrar original");
                        }
                    },
                    Err(e) => {
                        kept += 1;
                        tracing::warn!(target: "fonts", from = %path.display(), error = %e, "consolidate: copy falló");
                    }
                },
            }
        }
    }

    // Cleanup: borrar las carpetas `fonts/` que quedaron vacías.
    let mut removed_dirs: u32 = 0;
    for src_dir in &source_dirs {
        if !src_dir.exists() {
            continue;
        }
        let is_empty = fs::read_dir(src_dir)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            continue;
        }
        match fs::remove_dir(src_dir) {
            Ok(_) => {
                removed_dirs += 1;
                tracing::info!(target: "fonts", dir = %src_dir.display(), "consolidate: dir vacío borrado");
            }
            Err(e) => {
                tracing::warn!(target: "fonts", dir = %src_dir.display(), error = %e, "consolidate: no pude borrar dir vacío");
            }
        }
    }

    tracing::info!(target: "fonts", moved, deduped, kept, removed_dirs, "consolidate_fonts terminó");
    Ok(ConsolidateResult {
        moved,
        deduped,
        kept,
        removed_dirs,
    })
}

/// Recursive scan que junta todas las carpetas llamadas `fonts/` debajo de `root`,
/// excepto `<root>/fonts/` mismo (que es el destino).
fn collect_font_dirs(dir: &Path, exclude: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if name == "fonts" && path != exclude {
            out.push(path.clone());
            continue;
        }
        collect_font_dirs(&path, exclude, out);
    }
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
