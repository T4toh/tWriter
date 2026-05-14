use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::search;

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
];
const CHAPTER_EXTS: &[&str] = &["html", "odt", "docx"];
const NOTE_EXTS: &[&str] = &["md", "markdown"];
const NOTES_DIR_NAME: &str = "notas";
/// Archivos sueltos en root que NO aparecen en el tree (visible en GitHub, invisible en la app).
const ROOT_SKIP_FILES: &[&str] = &["README.md", "README.markdown", ".twriter-ignore", ".gitignore"];

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Saga,
    Book,
    Section,
    Chapter,
    Note,
    /// Carpeta `notas/` (o sub-carpeta dentro). Tiene Notes y/o NotesFolders como children.
    Notes,
    /// Carpeta genérica en root (o anidada en otra Folder) sin `saga.json`/`book.json` y
    /// sin capítulos. Contiene notas `.md` y sub-carpetas libres.
    Folder,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: NodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editable: Option<bool>,
    /// mtime del archivo en milis epoch. Para dirs, max de descendientes.
    #[serde(rename = "modifiedMs", skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
    /// Total de palabras (chapters: meta.palabras; dirs: suma recursiva).
    #[serde(rename = "wordCount", skip_serializing_if = "Option::is_none")]
    pub word_count: Option<u32>,
    /// Excluido del export EPUB. Visible en tree pero no se incluye al exportar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded: Option<bool>,
    pub children: Vec<TreeNode>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ChapterMeta {
    #[serde(default)]
    pub orden: u32,
    #[serde(default)]
    pub titulo: String,
    #[serde(default)]
    pub palabras: u32,
    #[serde(default)]
    pub ultima_edicion: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub idioma: Option<String>,
}

/// Devuelve el árbol Saga/Libro/Sección/Capítulo del repo de novelas en `root`.
#[tauri::command]
pub fn get_tree(root: String) -> Result<TreeNode, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("Root no es directorio: {}", root));
    }
    let name = root_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Novelas")
        .to_string();

    let children = list_sagas_or_books(&root_path)?;
    let modified_ms = max_child_mtime(&children);
    let word_count = sum_child_words(&children);
    Ok(TreeNode {
        name,
        path: root_path.to_string_lossy().into_owned(),
        kind: NodeKind::Saga,
        ext: None,
        editable: None,
        modified_ms,
        word_count,
        excluded: None,
        children,
    })
}

/// Lee el HTML de un capítulo. Solo soporta .html (los .odt/.docx hay que importar antes).
#[tauri::command]
pub fn read_chapter(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("No es archivo: {}", path));
    }
    match p.extension().and_then(|e| e.to_str()) {
        Some("html") => fs::read_to_string(&p).map_err(|e| e.to_string()),
        Some(other) => Err(format!(".{other} no editable directo — importar primero")),
        None => Err("Sin extensión".to_string()),
    }
}

/// Escribe el HTML del capítulo. Crea el archivo si no existe.
/// Asegura newline final (POSIX).
#[tauri::command]
pub fn write_chapter(path: String, html: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            tracing::error!(target: "fs", path = %path, "write_chapter: carpeta padre no existe");
            return Err(format!("Carpeta padre no existe: {}", parent.display()));
        }
    }
    let mut content = html;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    let bytes = content.len();
    fs::write(&p, content).map_err(|e| {
        tracing::error!(target: "fs", path = %path, error = %e, "write_chapter falló");
        e.to_string()
    })?;
    tracing::info!(target: "fs", path = %path, bytes, "capítulo guardado");
    search::index_path_best_effort(&path, "chapter");
    Ok(())
}

/// Lee `<chapter>.meta.json`. Devuelve default si no existe.
#[tauri::command]
pub fn read_meta(chapter_path: String) -> Result<ChapterMeta, String> {
    let meta_path = meta_path_for(&chapter_path);
    if !meta_path.exists() {
        return Ok(ChapterMeta::default());
    }
    let raw = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Renombra un nodo (dir o archivo). Si es archivo, preserva extensión y renombra `<stem>.meta.json` sibling.
#[tauri::command]
pub fn rename_node(path: String, new_name: String) -> Result<String, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("nombre vacío".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("nombre no puede contener separadores de path".to_string());
    }
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("no existe: {}", path));
    }
    let parent = p
        .parent()
        .ok_or_else(|| "sin parent".to_string())?
        .to_path_buf();
    if p.is_dir() {
        let target = parent.join(trimmed);
        if target.exists() {
            return Err(format!("ya existe: {}", target.display()));
        }
        fs::rename(&p, &target).map_err(|e| {
            tracing::error!(target: "fs", from = %path, to = %target.display(), error = %e, "rename_node dir falló");
            e.to_string()
        })?;
        tracing::info!(target: "fs", from = %path, to = %target.display(), "directorio renombrado");
        // Rename de directorio mueve descendientes — más seguro pedir reindex full.
        // No bloqueamos; el frontend puede disparar reindex si lo necesita.
        search::remove_path_best_effort(&path);
        return Ok(target.to_string_lossy().into_owned());
    }
    if !p.is_file() {
        return Err("ni archivo ni directorio".to_string());
    }
    let old_stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let old_ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_string());
    let new_path_buf = PathBuf::from(trimmed);
    let new_filename = if new_path_buf.extension().is_some() {
        trimmed.to_string()
    } else if let Some(ext) = &old_ext {
        format!("{}.{}", trimmed, ext)
    } else {
        trimmed.to_string()
    };
    let target = parent.join(&new_filename);
    if target.exists() {
        return Err(format!("ya existe: {}", target.display()));
    }
    fs::rename(&p, &target).map_err(|e| {
        tracing::error!(target: "fs", from = %path, to = %target.display(), error = %e, "rename_node archivo falló");
        e.to_string()
    })?;
    tracing::info!(target: "fs", from = %path, to = %target.display(), "archivo renombrado");
    search::remove_path_best_effort(&path);
    let kind_hint = match old_ext.as_deref() {
        Some("html") => Some("chapter"),
        Some("md") | Some("markdown") => Some("note"),
        _ => None,
    };
    if let Some(k) = kind_hint {
        let new_path_str = target.to_string_lossy().into_owned();
        search::index_path_best_effort(&new_path_str, k);
    }
    let old_meta = parent.join(format!("{}.meta.json", old_stem));
    if old_meta.is_file() {
        let new_stem = PathBuf::from(&new_filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(trimmed)
            .to_string();
        let new_meta = parent.join(format!("{}.meta.json", new_stem));
        if !new_meta.exists() {
            let _ = fs::rename(&old_meta, &new_meta);
        }
    }
    Ok(target.to_string_lossy().into_owned())
}

/// Escribe `<chapter>.meta.json`.
#[tauri::command]
pub fn write_meta(chapter_path: String, meta: ChapterMeta) -> Result<(), String> {
    let meta_path = meta_path_for(&chapter_path);
    let raw = serde_json::to_string_pretty(&meta).map_err(|e| {
        tracing::error!(target: "fs", chapter = %chapter_path, error = %e, "write_meta: serializar JSON falló");
        e.to_string()
    })?;
    fs::write(&meta_path, raw).map_err(|e| {
        tracing::error!(target: "fs", path = %meta_path.display(), error = %e, "write_meta falló");
        e.to_string()
    })
}

fn meta_path_for(chapter_path: &str) -> PathBuf {
    let p = PathBuf::from(chapter_path);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("chapter");
    let parent = p.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{stem}.meta.json"))
}

fn list_sagas_or_books(root: &Path) -> Result<Vec<TreeNode>, String> {
    let mut out = Vec::new();
    let mut loose_notes = Vec::new();
    let mut loose_folders = Vec::new();
    for entry in read_sorted_entries(root)? {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_file() {
            if ROOT_SKIP_FILES.contains(&name.as_str()) {
                continue;
            }
            if let Some(node) = note_node(&path) {
                loose_notes.push(node);
            }
            continue;
        }
        if !ft.is_dir() {
            continue;
        }
        if should_skip_dir(&name) {
            continue;
        }
        if name == NOTES_DIR_NAME {
            out.push(notes_folder_node(&path, name)?);
            continue;
        }
        let excluded = is_excluded_dir(&path);
        if excluded {
            out.push(TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: classify_top_level(&path),
                ext: None,
                editable: None,
                modified_ms: None,
                word_count: None,
                excluded: Some(true),
                children: Vec::new(),
            });
            continue;
        }
        let kind = classify_top_level(&path);
        match kind {
            NodeKind::Saga => {
                let children = list_books(&path)?;
                let modified_ms = max_child_mtime(&children);
                let word_count = sum_child_words(&children);
                out.push(TreeNode {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    kind: NodeKind::Saga,
                    ext: None,
                    editable: None,
                    modified_ms,
                    word_count,
                    excluded: None,
                    children,
                });
            }
            NodeKind::Book => {
                let children = list_sections_or_chapters(&path)?;
                let modified_ms = max_child_mtime(&children);
                let word_count = sum_child_words(&children);
                out.push(TreeNode {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    kind: NodeKind::Book,
                    ext: None,
                    editable: None,
                    modified_ms,
                    word_count,
                    excluded: None,
                    children,
                });
            }
            NodeKind::Folder => {
                let children = list_folder_contents(&path)?;
                let modified_ms = max_child_mtime(&children);
                loose_folders.push(TreeNode {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    kind: NodeKind::Folder,
                    ext: None,
                    editable: None,
                    modified_ms,
                    word_count: None,
                    excluded: None,
                    children,
                });
            }
            _ => {}
        }
    }
    out.append(&mut loose_folders);
    out.append(&mut loose_notes);
    Ok(out)
}

fn list_books(saga_dir: &Path) -> Result<Vec<TreeNode>, String> {
    let mut out = Vec::new();
    let mut loose_notes = Vec::new();
    for entry in read_sorted_entries(saga_dir)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_file() {
            if let Some(node) = note_node(&path) {
                loose_notes.push(node);
            }
            continue;
        }
        if !ft.is_dir() {
            continue;
        }
        if should_skip_dir(&name) {
            continue;
        }
        if name == NOTES_DIR_NAME {
            out.push(notes_folder_node(&path, name)?);
            continue;
        }
        let excluded = is_excluded_dir(&path);
        if excluded {
            out.push(TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: NodeKind::Book,
                ext: None,
                editable: None,
                modified_ms: None,
                word_count: None,
                excluded: Some(true),
                children: Vec::new(),
            });
            continue;
        }
        let children = list_sections_or_chapters(&path)?;
        let modified_ms = max_child_mtime(&children);
        let word_count = sum_child_words(&children);
        out.push(TreeNode {
            name,
            path: path.to_string_lossy().into_owned(),
            kind: NodeKind::Book,
            ext: None,
            editable: None,
            modified_ms,
            word_count,
            excluded: None,
            children,
        });
    }
    out.append(&mut loose_notes);
    Ok(out)
}

fn list_sections_or_chapters(book_dir: &Path) -> Result<Vec<TreeNode>, String> {
    let mut sections = Vec::new();
    let mut direct_chapters = Vec::new();
    for entry in read_sorted_entries(book_dir)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            if name == NOTES_DIR_NAME {
                sections.push(notes_folder_node(&path, name)?);
                continue;
            }
            let excluded = is_excluded_dir(&path);
            if excluded {
                sections.push(TreeNode {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    kind: NodeKind::Section,
                    ext: None,
                    editable: None,
                    modified_ms: None,
                    word_count: None,
                    excluded: Some(true),
                    children: Vec::new(),
                });
                continue;
            }
            let children = list_chapters(&path)?;
            let modified_ms = max_child_mtime(&children);
            let word_count = sum_child_words(&children);
            sections.push(TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: NodeKind::Section,
                ext: None,
                editable: None,
                modified_ms,
                word_count,
                excluded: None,
                children,
            });
        } else if ft.is_file() {
            if let Some(node) = chapter_node(&path) {
                direct_chapters.push(node);
            } else if let Some(node) = note_node(&path) {
                direct_chapters.push(node);
            }
        }
    }
    sections.append(&mut direct_chapters);
    Ok(sections)
}

fn list_chapters(section_dir: &Path) -> Result<Vec<TreeNode>, String> {
    let mut out = Vec::new();
    for entry in read_sorted_entries(section_dir)? {
        let path = entry.path();
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_file() {
            if let Some(node) = chapter_node(&path) {
                out.push(node);
            } else if let Some(node) = note_node(&path) {
                out.push(node);
            }
        }
    }
    Ok(out)
}

/// Devuelve un nodo `Notes` (carpeta) con sus `.md` y sub-carpetas como children.
/// Llamado al encontrar un dir llamado `notas` o dentro de uno.
fn notes_folder_node(path: &Path, name: String) -> Result<TreeNode, String> {
    let children = list_notes_dir(path)?;
    let modified_ms = max_child_mtime(&children);
    Ok(TreeNode {
        name,
        path: path.to_string_lossy().into_owned(),
        kind: NodeKind::Notes,
        ext: None,
        editable: None,
        modified_ms,
        word_count: None,
        excluded: None,
        children,
    })
}

/// Walk recursivo dentro de una carpeta genérica (kind: Folder). Devuelve sub-folders,
/// carpetas `notas/`, y notas `.md` sueltas. NO desciende a sagas/books anidados —
/// esas estructuras solo se reconocen en root.
fn list_folder_contents(dir: &Path) -> Result<Vec<TreeNode>, String> {
    let mut subdirs = Vec::new();
    let mut files = Vec::new();
    for entry in read_sorted_entries(dir)? {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            if is_excluded_dir(&path) {
                continue;
            }
            if name == NOTES_DIR_NAME {
                subdirs.push(notes_folder_node(&path, name)?);
                continue;
            }
            let children = list_folder_contents(&path)?;
            let modified_ms = max_child_mtime(&children);
            subdirs.push(TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: NodeKind::Folder,
                ext: None,
                editable: None,
                modified_ms,
                word_count: None,
                excluded: None,
                children,
            });
        } else if ft.is_file() {
            if let Some(node) = note_node(&path) {
                files.push(node);
            }
        }
    }
    subdirs.append(&mut files);
    Ok(subdirs)
}

/// Walk recursivo dentro de una carpeta `notas/`. Devuelve Notes (sub-dirs) y Notes hojas (`.md`).
fn list_notes_dir(dir: &Path) -> Result<Vec<TreeNode>, String> {
    let mut subdirs = Vec::new();
    let mut files = Vec::new();
    for entry in read_sorted_entries(dir)? {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if name.starts_with('.') {
                continue;
            }
            subdirs.push(notes_folder_node(&path, name)?);
        } else if ft.is_file() {
            if let Some(node) = note_node(&path) {
                files.push(node);
            }
        }
    }
    subdirs.append(&mut files);
    Ok(subdirs)
}

/// Construye un nodo Note si el archivo es `.md`/`.markdown`. Devuelve None si no.
fn note_node(path: &Path) -> Option<TreeNode> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())?;
    if !NOTE_EXTS.contains(&ext.as_str()) {
        return None;
    }
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string();
    let modified_ms = mtime_ms(path);
    Some(TreeNode {
        name,
        path: path.to_string_lossy().into_owned(),
        kind: NodeKind::Note,
        ext: Some(ext),
        editable: Some(true),
        modified_ms,
        word_count: None,
        excluded: None,
        children: Vec::new(),
    })
}

fn chapter_node(path: &Path) -> Option<TreeNode> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())?;
    if !CHAPTER_EXTS.contains(&ext.as_str()) {
        return None;
    }
    if path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|n| n.ends_with(".meta.json"))
        .unwrap_or(false)
    {
        return None;
    }
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string();
    let modified_ms = mtime_ms(path);
    let word_count = read_meta_word_count(path);
    Some(TreeNode {
        name,
        path: path.to_string_lossy().into_owned(),
        kind: NodeKind::Chapter,
        editable: Some(ext == "html"),
        ext: Some(ext),
        modified_ms,
        word_count,
        excluded: None,
        children: Vec::new(),
    })
}

fn read_meta_word_count(chapter_path: &Path) -> Option<u32> {
    let stem = chapter_path.file_stem().and_then(|s| s.to_str())?;
    let parent = chapter_path.parent()?;
    let meta_path = parent.join(format!("{}.meta.json", stem));
    if !meta_path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&meta_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("palabras")?.as_u64().map(|n| n as u32)
}

fn mtime_ms(p: &Path) -> Option<u64> {
    let meta = fs::metadata(p).ok()?;
    let modified: SystemTime = meta.modified().ok()?;
    let dur = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as u64)
}

fn max_child_mtime(children: &[TreeNode]) -> Option<u64> {
    children.iter().filter_map(|c| c.modified_ms).max()
}

fn sum_child_words(children: &[TreeNode]) -> Option<u32> {
    let total: u32 = children.iter().filter_map(|c| c.word_count).sum();
    if total == 0 {
        None
    } else {
        Some(total)
    }
}

fn classify_top_level(dir: &Path) -> NodeKind {
    if dir.join("saga.json").exists() {
        return NodeKind::Saga;
    }
    if dir.join("book.json").exists() {
        return NodeKind::Book;
    }
    // Heurística: si los subdirs contienen subdirs o capítulos, es saga.
    // Si los subdirs son secciones (con capítulos adentro) o hay capítulos directos, es book.
    // Si NO hay nada de eso, es una carpeta libre (Folder).
    let mut has_book_like_subdirs = false;
    let mut has_chapter_files = false;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let p = e.path();
            if should_skip_dir(&name) || (p.is_dir() && is_excluded_dir(&p)) {
                continue;
            }
            if p.is_dir() && looks_like_book(&p) {
                has_book_like_subdirs = true;
            } else if p.is_file() && is_chapter_file(&p) {
                has_chapter_files = true;
            }
        }
    }
    if has_chapter_files {
        NodeKind::Book
    } else if has_book_like_subdirs {
        NodeKind::Saga
    } else {
        NodeKind::Folder
    }
}

fn looks_like_book(dir: &Path) -> bool {
    if dir.join("book.json").exists() {
        return true;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() && is_chapter_file(&p) {
                return true;
            }
            if p.is_dir() {
                let name = e.file_name().to_string_lossy().into_owned();
                if should_skip_dir(&name) || is_excluded_dir(&p) {
                    continue;
                }
                // sección con capítulos adentro
                if let Ok(inner) = fs::read_dir(&p) {
                    for ie in inner.flatten() {
                        if ie.path().is_file() && is_chapter_file(&ie.path()) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

pub(crate) fn is_chapter_file(p: &Path) -> bool {
    let Some(ext) = p.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_lowercase();
    if !CHAPTER_EXTS.contains(&ext.as_str()) {
        return false;
    }
    !p.file_name()
        .and_then(|s| s.to_str())
        .map(|n| n.ends_with(".meta.json"))
        .unwrap_or(false)
}

pub(crate) fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name) || name.starts_with('.')
}

pub fn is_excluded_dir(path: &Path) -> bool {
    path.join(".twriter-ignore").is_file()
}

#[tauri::command]
pub fn is_directory_excluded(path: String) -> bool {
    is_excluded_dir(&PathBuf::from(path))
}

#[tauri::command]
pub fn set_directory_excluded(path: String, excluded: bool) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("no es directorio: {}", path));
    }
    let marker = dir.join(".twriter-ignore");
    if excluded {
        if !marker.exists() {
            fs::write(&marker, "").map_err(|e| e.to_string())?;
        }
    } else if marker.exists() {
        fs::remove_file(&marker).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn read_sorted_entries(p: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries: Vec<_> = fs::read_dir(p)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    entries.sort_by(|a, b| compare_names(&a.file_name().to_string_lossy(), &b.file_name().to_string_lossy()));
    Ok(entries)
}

/// Ordena por prefijo numérico ("N - Name"), después alfabético.
pub(crate) fn compare_names(a: &str, b: &str) -> Ordering {
    let na = leading_number(a);
    let nb = leading_number(b);
    match (na, nb) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| a.cmp(b)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.cmp(b),
    }
}

pub(crate) fn leading_number(s: &str) -> Option<u32> {
    let trimmed = s.trim_start();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

pub(crate) fn classify_top_level_pub(dir: &Path) -> NodeKind {
    classify_top_level(dir)
}

pub(crate) fn notes_dir_name() -> &'static str {
    NOTES_DIR_NAME
}

pub(crate) fn chapter_exts() -> &'static [&'static str] {
    CHAPTER_EXTS
}

pub(crate) fn note_exts() -> &'static [&'static str] {
    NOTE_EXTS
}
