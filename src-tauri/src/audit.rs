//! Comando para recolectar los capítulos `.html` de una saga / libro / sección
//! en una sola invoke, junto a su metadata `idioma`. El validador RAE corre en
//! el frontend (TS) sobre el payload que devolvemos acá.
//!
//! Filtra carpetas que no aportan capítulos: `extras/`, `notas/`, `fonts/`,
//! `themes/`, `.twriter/`, `.git/`, `Exportados/`, etc.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
pub struct ChapterPayload {
    pub path: String,
    pub html: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idioma: Option<String>,
}

const SKIP_DIRS: &[&str] = &[
    "convertidos",
    "Revisiones",
    "exports",
    "Exportados",
    ".git",
    "zTapas",
    "extras",
    "fonts",
    "themes",
    ".twriter",
    "notas",
];

#[tauri::command]
pub fn list_chapters_for_audit(scope_path: String) -> Result<Vec<ChapterPayload>, String> {
    let root = PathBuf::from(&scope_path);
    if !root.exists() {
        return Err(format!("scope_path no existe: {}", scope_path));
    }
    let mut out = Vec::new();
    walk(&root, &mut out)?;
    tracing::info!(
        target: "audit",
        scope = %scope_path,
        chapters = out.len(),
        "list_chapters_for_audit"
    );
    Ok(out)
}

fn walk(path: &Path, out: &mut Vec<ChapterPayload>) -> Result<(), String> {
    for p in chapter_paths(path)? {
        push_chapter(&p, out)?;
    }
    Ok(())
}

/// Enumera los `.html` de un scope (saga / libro / sección / un archivo
/// suelto), salteando las carpetas de `SKIP_DIRS`. Ordenado por path para que
/// el resultado sea estable entre corridas.
pub fn chapter_paths(scope: &Path) -> Result<Vec<PathBuf>, String> {
    if !scope.exists() {
        return Err(format!("scope no existe: {}", scope.display()));
    }
    let mut out = Vec::new();
    walk_paths(scope, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk_paths(path: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_file() {
        if path.extension().and_then(|e| e.to_str()) == Some("html") {
            out.push(path.to_path_buf());
        }
        return Ok(());
    }
    let entries = fs::read_dir(path).map_err(|e| format!("read_dir {}: {}", path.display(), e))?;
    let mut sorted: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    sorted.sort();
    for entry in sorted {
        if entry.is_dir() {
            let name = entry.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if SKIP_DIRS.iter().any(|skip| skip.eq_ignore_ascii_case(name)) {
                continue;
            }
            walk_paths(&entry, out)?;
        } else if entry.extension().and_then(|e| e.to_str()) == Some("html") {
            out.push(entry);
        }
    }
    Ok(())
}

fn push_chapter(path: &Path, out: &mut Vec<ChapterPayload>) -> Result<(), String> {
    let html = fs::read_to_string(path)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    let idioma = read_meta_field(path, "idioma");
    out.push(ChapterPayload {
        path: path.to_string_lossy().into_owned(),
        html,
        idioma,
    });
    Ok(())
}

/// Lee un campo string de `<stem>.meta.json`. None si no existe el archivo,
/// no parsea, o el campo no está.
pub fn read_meta_field(chapter_path: &Path, field: &str) -> Option<String> {
    let stem = chapter_path.file_stem()?.to_str()?;
    let parent = chapter_path.parent()?;
    let meta_path = parent.join(format!("{stem}.meta.json"));
    if !meta_path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&meta_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get(field).and_then(|v| v.as_str()).map(String::from)
}
