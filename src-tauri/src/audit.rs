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
    // Antes `filter_map(|e| e.ok())` se tragaba en silencio las entradas cuyo
    // `read_dir` falla (permisos, symlink roto en Dropbox/iCloud) — un preview
    // podía omitir capítulos y reportar como completo un scope que no lo era.
    // Propagar el error es peor UX puntual pero mejor que mentir sobre el
    // scope. CAMBIA COMPORTAMIENTO para los dos consumidores existentes de
    // `chapter_paths`: `list_chapters_for_audit` (auditoría RAE) y el
    // educador de comillas (`quotes-fix-service.ts`), que antes seguían de
    // largo ante una entrada ilegible y ahora fallan con error.
    let mut sorted: Vec<PathBuf> = entries
        .map(|e| {
            e.map(|entry| entry.path())
                .map_err(|e| format!("read_dir {}: {}", path.display(), e))
        })
        .collect::<Result<_, _>>()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Una entrada cuyo `read_dir` falla (subcarpeta sin permiso de lectura)
    /// tiene que propagar el error en vez de tragarse en silencio y devolver
    /// un scope incompleto. Solo Unix: en Windows los permisos POSIX no
    /// aplican y `set_readonly` no bloquea el listado de un directorio.
    #[cfg(unix)]
    #[test]
    fn walk_paths_propaga_error_de_entrada_ilegible() {
        use std::os::unix::fs::PermissionsExt;
        use tempfile::TempDir;

        let td = TempDir::new().unwrap();
        let sin_permiso = td.path().join("sin-permiso");
        fs::create_dir(&sin_permiso).unwrap();
        fs::write(td.path().join("1.html"), "<p>ok</p>").unwrap();

        let permisos_originales = fs::metadata(&sin_permiso).unwrap().permissions();
        fs::set_permissions(&sin_permiso, std::fs::Permissions::from_mode(0o000)).unwrap();

        let resultado = chapter_paths(td.path());

        // Restaurar permisos ANTES de asertar: si el assert paniquea, el
        // `TempDir` igual se borra al final del test, y sin permisos de
        // lectura ese borrado fallaría y dejaría basura en /tmp.
        fs::set_permissions(&sin_permiso, permisos_originales).unwrap();

        assert!(resultado.is_err(), "esperaba error, dio {resultado:?}");
    }
}
