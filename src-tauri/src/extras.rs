use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const EXTRAS_DIR: &str = "extras";

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExtraKind {
    Image,
    Document,
    Text,
    Other,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExtraEntry {
    pub name: String,
    /// Path absoluto al archivo, conveniente para que el frontend lo abra con el sistema.
    pub path: String,
    /// Path relativo dentro de `<scope>/extras/`. Permite borrar/renombrar.
    pub relative_path: String,
    pub size_bytes: u64,
    pub kind: ExtraKind,
    pub ext: Option<String>,
}

fn classify_ext(ext: &str) -> ExtraKind {
    match ext {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg" => ExtraKind::Image,
        "docx" | "odt" | "doc" | "rtf" | "pdf" | "epub" => ExtraKind::Document,
        "txt" | "md" | "markdown" => ExtraKind::Text,
        _ => ExtraKind::Other,
    }
}

fn extras_dir(scope_path: &str) -> PathBuf {
    PathBuf::from(scope_path).join(EXTRAS_DIR)
}

#[tauri::command]
pub fn list_extras(scope_path: String) -> Result<Vec<ExtraEntry>, String> {
    let dir = extras_dir(&scope_path);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<ExtraEntry> = Vec::new();
    walk_extras(&dir, &dir, &mut out)?;
    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(out)
}

fn walk_extras(base: &Path, current: &Path, out: &mut Vec<ExtraEntry>) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            walk_extras(base, &path, out)?;
        } else if ft.is_file() {
            let rel = path
                .strip_prefix(base)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| {
                    path.file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string()
                });
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase());
            let kind = ext.as_deref().map(classify_ext).unwrap_or(ExtraKind::Other);
            let size_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            out.push(ExtraEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                relative_path: rel,
                size_bytes,
                kind,
                ext,
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub fn has_extras(scope_path: String) -> bool {
    let dir = extras_dir(&scope_path);
    if !dir.is_dir() {
        return false;
    }
    fs::read_dir(&dir)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
}

#[tauri::command]
pub fn add_extra(
    scope_path: String,
    source_path: String,
    target_name: Option<String>,
) -> Result<ExtraEntry, String> {
    let scope = PathBuf::from(&scope_path);
    if !scope.is_dir() {
        return Err(format!("scope no es directorio: {}", scope_path));
    }
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("source no existe o no es archivo: {}", source_path));
    }
    let dir = extras_dir(&scope_path);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir extras: {}", e))?;

    let raw_name = target_name
        .as_deref()
        .map(str::to_string)
        .or_else(|| {
            src.file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "extra".to_string());
    let safe_name = sanitize_name(&raw_name);
    let dest = unique_path(&dir, &safe_name);

    fs::copy(&src, &dest).map_err(|e| format!("copy: {}", e))?;
    entry_for(&dir, &dest)
}

#[tauri::command]
pub fn remove_extra(scope_path: String, relative_path: String) -> Result<(), String> {
    let dir = extras_dir(&scope_path);
    let target = dir.join(&relative_path);
    let canonical_target = target.canonicalize().map_err(|e| format!("canon target: {}", e))?;
    let canonical_dir = dir.canonicalize().map_err(|e| format!("canon dir: {}", e))?;
    if !canonical_target.starts_with(&canonical_dir) {
        return Err("path fuera de extras/".to_string());
    }
    if !canonical_target.is_file() {
        return Err(format!("no es archivo: {}", relative_path));
    }
    fs::remove_file(&canonical_target).map_err(|e| format!("rm: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn rename_extra(
    scope_path: String,
    relative_path: String,
    new_name: String,
) -> Result<ExtraEntry, String> {
    let dir = extras_dir(&scope_path);
    let target = dir.join(&relative_path);
    let canonical_target = target.canonicalize().map_err(|e| format!("canon target: {}", e))?;
    let canonical_dir = dir.canonicalize().map_err(|e| format!("canon dir: {}", e))?;
    if !canonical_target.starts_with(&canonical_dir) {
        return Err("path fuera de extras/".to_string());
    }
    let safe = sanitize_name(&new_name);
    let parent = canonical_target
        .parent()
        .ok_or_else(|| "sin parent".to_string())?;
    let dest = unique_path(parent, &safe);
    fs::rename(&canonical_target, &dest).map_err(|e| format!("rename: {}", e))?;
    entry_for(&dir, &dest)
}

fn entry_for(base: &Path, file: &Path) -> Result<ExtraEntry, String> {
    let rel = file
        .strip_prefix(base)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| {
            file.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        });
    let name = file
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    let kind = ext.as_deref().map(classify_ext).unwrap_or(ExtraKind::Other);
    let size_bytes = fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    Ok(ExtraEntry {
        name,
        path: file.to_string_lossy().into_owned(),
        relative_path: rel,
        size_bytes,
        kind,
        ext,
    })
}

fn sanitize_name(name: &str) -> String {
    let trimmed = name.trim();
    let cleaned: String = trimmed
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '\0' {
                '_'
            } else {
                c
            }
        })
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "extra".to_string()
    } else {
        cleaned
    }
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 1..1_000 {
        let new_name = match ext {
            Some(e) => format!("{}-{}.{}", stem, n, e),
            None => format!("{}-{}", stem, n),
        };
        let p = dir.join(new_name);
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{}-many", name))
}
