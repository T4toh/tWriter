use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SKIP_DIRS: &[&str] = &["convertidos", "Revisiones", "exports", ".git", "zTapas"];
const CHAPTER_EXTS: &[&str] = &["html", "odt", "docx"];

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Saga,
    Book,
    Section,
    Chapter,
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
            return Err(format!("Carpeta padre no existe: {}", parent.display()));
        }
    }
    let mut content = html;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    fs::write(&p, content).map_err(|e| e.to_string())
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

/// Escribe `<chapter>.meta.json`.
#[tauri::command]
pub fn write_meta(chapter_path: String, meta: ChapterMeta) -> Result<(), String> {
    let meta_path = meta_path_for(&chapter_path);
    let raw = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    fs::write(&meta_path, raw).map_err(|e| e.to_string())
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
    for entry in read_sorted_dirs(root)? {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_skip_dir(&name) {
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
                    children,
                });
            }
            _ => {}
        }
    }
    Ok(out)
}

fn list_books(saga_dir: &Path) -> Result<Vec<TreeNode>, String> {
    let mut out = Vec::new();
    for entry in read_sorted_dirs(saga_dir)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_skip_dir(&name) {
            continue;
        }
        let path = entry.path();
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
            children,
        });
    }
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
                children,
            });
        } else if ft.is_file() {
            if let Some(node) = chapter_node(&path) {
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
            }
        }
    }
    Ok(out)
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
    let mut has_book_like_subdirs = false;
    let mut has_chapter_files = false;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if should_skip_dir(&name) {
                continue;
            }
            let p = e.path();
            if p.is_dir() && looks_like_book(&p) {
                has_book_like_subdirs = true;
            } else if p.is_file() && is_chapter_file(&p) {
                has_chapter_files = true;
            }
        }
    }
    if has_book_like_subdirs && !has_chapter_files {
        NodeKind::Saga
    } else {
        NodeKind::Book
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
                if should_skip_dir(&name) {
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

fn is_chapter_file(p: &Path) -> bool {
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

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name) || name.starts_with('.')
}

fn read_sorted_dirs(p: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries: Vec<_> = fs::read_dir(p)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .collect();
    entries.sort_by(|a, b| compare_names(&a.file_name().to_string_lossy(), &b.file_name().to_string_lossy()));
    Ok(entries)
}

fn read_sorted_entries(p: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries: Vec<_> = fs::read_dir(p)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    entries.sort_by(|a, b| compare_names(&a.file_name().to_string_lossy(), &b.file_name().to_string_lossy()));
    Ok(entries)
}

/// Ordena por prefijo numérico ("N - Name"), después alfabético.
fn compare_names(a: &str, b: &str) -> Ordering {
    let na = leading_number(a);
    let nb = leading_number(b);
    match (na, nb) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| a.cmp(b)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.cmp(b),
    }
}

fn leading_number(s: &str) -> Option<u32> {
    let trimmed = s.trim_start();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}
