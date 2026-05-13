//! Importadores de notas externas. Cada source (Joplin, Obsidian, Notion, etc.)
//! implementa el trait [`NoteImporter`]. El wizard del frontend solo conoce
//! comandos `<id>_scan` y `<id>_import_apply` por source.
//!
//! Hoy soporta:
//! - Joplin raw markdown export (carpeta con `.md` + `_resources/`).
//!
//! Para sumar otro source (Obsidian, Notion, Bear, Logseq, Markdown plano):
//! 1. Crear struct que implemente [`NoteImporter`].
//! 2. Exponer comandos Tauri `<id>_scan` y `<id>_import_apply` (wrap a `scan`/`apply`).
//! 3. Registrar en `lib.rs::invoke_handler!`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::search;

#[derive(Serialize, Clone, Debug)]
pub struct ImportPreview {
    pub total_notes: u32,
    pub total_folders: u32,
    pub total_bytes: u64,
    pub empty_notes: u32,
    pub tree: Vec<PreviewNode>,
}

#[derive(Serialize, Clone, Debug)]
pub struct PreviewNode {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub bytes: u64,
    pub empty: bool,
    pub children: Vec<PreviewNode>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ImportOptions {
    #[serde(default = "default_skip_empty")]
    pub skip_empty: bool,
    #[serde(default = "default_conflict")]
    pub on_conflict: ConflictPolicy,
}

fn default_skip_empty() -> bool { false }
fn default_conflict() -> ConflictPolicy { ConflictPolicy::Suffix }

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    /// Si target existe, agregar sufijo `-2.md`, `-3.md`...
    Suffix,
    /// Saltar (no copiar).
    Skip,
    /// Sobrescribir el archivo destino.
    Overwrite,
}

#[derive(Serialize, Clone, Debug)]
pub struct ImportResult {
    pub copied: u32,
    pub skipped: u32,
    pub conflicts: u32,
    pub dest_root: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ImportProgress {
    pub done: u32,
    pub total: u32,
    pub current: String,
}

/// Contrato común para importers de notas externas.
pub trait NoteImporter {
    /// Identificador único (kebab-case). Se usa en eventos y logs.
    fn id(&self) -> &'static str;
    /// Nombre legible para UI.
    #[allow(dead_code)]
    fn name(&self) -> &'static str;
    /// Recorre `source` y devuelve preview sin copiar nada.
    fn scan(&self, source: &Path) -> Result<ImportPreview, String>;
    /// Copia notas de `source` a `dest` aplicando `opts`. Emite progreso al
    /// `AppHandle` con el evento `<id>-import-progress`.
    fn apply(
        &self,
        source: &Path,
        dest: &Path,
        opts: &ImportOptions,
        app: &AppHandle,
    ) -> Result<ImportResult, String>;
}

// ───── Joplin ─────

pub struct JoplinImporter;

impl NoteImporter for JoplinImporter {
    fn id(&self) -> &'static str { "joplin" }
    fn name(&self) -> &'static str { "Joplin (Markdown export)" }

    fn scan(&self, source: &Path) -> Result<ImportPreview, String> {
        if !source.is_dir() {
            return Err(format!("no es directorio: {}", source.display()));
        }
        let mut total_notes = 0u32;
        let mut total_folders = 0u32;
        let mut total_bytes = 0u64;
        let mut empty_notes = 0u32;
        let tree = scan_dir(
            source,
            source,
            &mut total_notes,
            &mut total_folders,
            &mut total_bytes,
            &mut empty_notes,
        )?;
        tracing::info!(
            target: "joplin",
            notes = total_notes,
            folders = total_folders,
            bytes = total_bytes,
            "scan completado"
        );
        Ok(ImportPreview {
            total_notes,
            total_folders,
            total_bytes,
            empty_notes,
            tree,
        })
    }

    fn apply(
        &self,
        source: &Path,
        dest: &Path,
        opts: &ImportOptions,
        app: &AppHandle,
    ) -> Result<ImportResult, String> {
        if !source.is_dir() {
            return Err(format!("source no es directorio: {}", source.display()));
        }
        fs::create_dir_all(dest).map_err(|e| format!("create dest: {e}"))?;
        // Pre-cuenta para progress.
        let total = count_md_recursive(source);
        let mut copied = 0u32;
        let mut skipped = 0u32;
        let mut conflicts = 0u32;
        let mut done = 0u32;
        copy_dir(
            source,
            source,
            dest,
            opts,
            app,
            "joplin-import-progress",
            total,
            &mut done,
            &mut copied,
            &mut skipped,
            &mut conflicts,
        )?;
        tracing::info!(
            target: "joplin",
            copied,
            skipped,
            conflicts,
            dest = %dest.display(),
            "import aplicado"
        );
        Ok(ImportResult {
            copied,
            skipped,
            conflicts,
            dest_root: dest.to_string_lossy().into_owned(),
        })
    }
}

// ───── Scan helpers ─────

/// Carpetas que el importer ignora siempre (resources de Joplin, etc.).
const SKIP_DIRS: &[&str] = &["_resources", ".git", ".obsidian", ".trash"];

fn scan_dir(
    root: &Path,
    dir: &Path,
    total_notes: &mut u32,
    total_folders: &mut u32,
    total_bytes: &mut u64,
    empty_notes: &mut u32,
) -> Result<Vec<PreviewNode>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    let mut sorted: Vec<_> = entries.flatten().collect();
    sorted.sort_by_key(|e| e.file_name());

    for entry in sorted {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            *total_folders += 1;
            let children = scan_dir(root, &path, total_notes, total_folders, total_bytes, empty_notes)?;
            let rel = rel_path(root, &path);
            out.push(PreviewNode {
                name,
                rel_path: rel,
                is_dir: true,
                bytes: 0,
                empty: false,
                children,
            });
        } else if ft.is_file() {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            if ext != "md" && ext != "markdown" {
                continue;
            }
            let bytes = path.metadata().map(|m| m.len()).unwrap_or(0);
            let empty = bytes == 0
                || fs::read_to_string(&path)
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true);
            *total_notes += 1;
            *total_bytes += bytes;
            if empty {
                *empty_notes += 1;
            }
            out.push(PreviewNode {
                name,
                rel_path: rel_path(root, &path),
                is_dir: false,
                bytes,
                empty,
                children: Vec::new(),
            });
        }
    }
    Ok(out)
}

fn rel_path(root: &Path, target: &Path) -> String {
    target
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| target.to_string_lossy().into_owned())
}

fn count_md_recursive(dir: &Path) -> u32 {
    let mut n = 0u32;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            n += count_md_recursive(&p);
        } else if ft.is_file() {
            let ext = p.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase()).unwrap_or_default();
            if ext == "md" || ext == "markdown" {
                n += 1;
            }
        }
    }
    n
}

// ───── Apply helpers ─────

#[allow(clippy::too_many_arguments)]
fn copy_dir(
    root_src: &Path,
    src_dir: &Path,
    dest_dir: &Path,
    opts: &ImportOptions,
    app: &AppHandle,
    event_name: &str,
    total: u32,
    done: &mut u32,
    copied: &mut u32,
    skipped: &mut u32,
    conflicts: &mut u32,
) -> Result<(), String> {
    let entries = fs::read_dir(src_dir).map_err(|e| format!("read_dir {}: {e}", src_dir.display()))?;
    let mut sorted: Vec<_> = entries.flatten().collect();
    sorted.sort_by_key(|e| e.file_name());

    for entry in sorted {
        let src_path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            let sub_dest = dest_dir.join(&name);
            fs::create_dir_all(&sub_dest).map_err(|e| format!("create_dir_all: {e}"))?;
            copy_dir(
                root_src, &src_path, &sub_dest, opts, app, event_name, total, done, copied, skipped, conflicts,
            )?;
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        let ext = src_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if ext != "md" && ext != "markdown" {
            continue;
        }
        *done += 1;
        let _ = app.emit(
            event_name,
            ImportProgress {
                done: *done,
                total,
                current: rel_path(root_src, &src_path),
            },
        );

        if opts.skip_empty {
            let bytes = src_path.metadata().map(|m| m.len()).unwrap_or(0);
            let empty = bytes == 0
                || fs::read_to_string(&src_path)
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true);
            if empty {
                *skipped += 1;
                continue;
            }
        }

        let target = resolve_target(dest_dir, &name, opts.on_conflict, conflicts);
        let target = match target {
            Some(t) => t,
            None => {
                *skipped += 1;
                continue;
            }
        };
        if let Err(e) = fs::copy(&src_path, &target) {
            tracing::warn!(
                target: "joplin",
                from = %src_path.display(),
                to = %target.display(),
                error = %e,
                "copy falló"
            );
            *skipped += 1;
            continue;
        }
        *copied += 1;
        // Indexar la nota recién copiada (best-effort; el reindex full eventual
        // reconcilia si falla).
        search::index_path_best_effort(&target.to_string_lossy(), "note");
    }
    Ok(())
}

/// Resuelve el path destino según `policy`. Devuelve `None` si la policy es
/// `Skip` y el target ya existe.
fn resolve_target(
    dest_dir: &Path,
    filename: &str,
    policy: ConflictPolicy,
    conflicts: &mut u32,
) -> Option<PathBuf> {
    let initial = dest_dir.join(filename);
    if !initial.exists() {
        return Some(initial);
    }
    *conflicts += 1;
    match policy {
        ConflictPolicy::Overwrite => Some(initial),
        ConflictPolicy::Skip => None,
        ConflictPolicy::Suffix => {
            let (stem, ext) = split_filename(filename);
            for n in 2..1000 {
                let candidate = if ext.is_empty() {
                    format!("{stem}-{n}")
                } else {
                    format!("{stem}-{n}.{ext}")
                };
                let p = dest_dir.join(&candidate);
                if !p.exists() {
                    return Some(p);
                }
            }
            None
        }
    }
}

fn split_filename(name: &str) -> (String, String) {
    if let Some(idx) = name.rfind('.') {
        if idx > 0 {
            return (name[..idx].to_string(), name[idx + 1..].to_string());
        }
    }
    (name.to_string(), String::new())
}

// ───── Comandos Tauri ─────

#[tauri::command]
pub fn joplin_scan(source: String) -> Result<ImportPreview, String> {
    let src = PathBuf::from(source);
    JoplinImporter.scan(&src)
}

#[tauri::command]
pub async fn joplin_import_apply(
    app: AppHandle,
    source: String,
    dest: String,
    options: Option<ImportOptions>,
) -> Result<ImportResult, String> {
    let opts = options.unwrap_or(ImportOptions {
        skip_empty: false,
        on_conflict: ConflictPolicy::Suffix,
    });
    tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(source);
        let dst = PathBuf::from(dest);
        JoplinImporter.apply(&src, &dst, &opts, &app)
    })
    .await
    .map_err(|e| format!("task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_dir(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("twriter-joplin-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn split_filename_basics() {
        assert_eq!(split_filename("hola.md"), ("hola".into(), "md".into()));
        assert_eq!(split_filename("sin-ext"), ("sin-ext".into(), "".into()));
        assert_eq!(split_filename(".hidden"), (".hidden".into(), "".into()));
        assert_eq!(split_filename("a.b.md"), ("a.b".into(), "md".into()));
    }

    #[test]
    fn scan_skips_resources_and_counts() {
        let src = tmp_dir("scan");
        fs::create_dir_all(src.join("Meridian/Lugares")).unwrap();
        fs::create_dir_all(src.join("_resources")).unwrap();
        fs::write(src.join("Meridian/Lugares/Marabec.md"), "# Marabec\n").unwrap();
        fs::write(src.join("Meridian/Pinto.md"), "").unwrap();
        fs::write(src.join("README.md"), "hola").unwrap();
        fs::write(src.join("_resources/img.png"), b"\x89PNG").unwrap();

        let preview = JoplinImporter.scan(&src).unwrap();
        assert_eq!(preview.total_notes, 3);
        // Meridian + Lugares.
        assert_eq!(preview.total_folders, 2);
        assert_eq!(preview.empty_notes, 1);

        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn split_filename_handles_dots() {
        assert_eq!(split_filename("a"), ("a".into(), "".into()));
    }
}
