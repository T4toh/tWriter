use regex::Regex;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::search;
use crate::stats::{self, StatsMap};

/// Colapsa whitespace que contiene un newline entre tags adyacentes.
/// TipTap `getHTML()` no emite `\n` entre block tags; disco importado vía
/// Pandoc sí los tiene. Sin normalizar, abrir un cap marca `dirty` aunque
/// el usuario no edite nada (TipTap parsea, serializa sin `\n`, comparación
/// raw falla). La regex solo matchea cuando hay `\n` real — preserva
/// espacios significativos entre inlines (`<em>x</em> <strong>y</strong>`).
fn normalize_chapter_html(html: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r">\s*\n\s*<").unwrap());
    re.replace_all(html.trim_end(), "><").into_owned()
}

thread_local! {
    /// Contexto del walk de `get_tree`: root + stats cargados una vez por call.
    /// Se setea al inicio de `get_tree` y se consulta desde `chapter_node`.
    /// `RefCell<Option<...>>` porque cada Tauri command corre en su propio
    /// thread y nunca se anida.
    static TREE_CTX: RefCell<Option<(PathBuf, StatsMap)>> = const { RefCell::new(None) };
}

fn with_tree_ctx<F, R>(f: F) -> R
where
    F: FnOnce(Option<&(PathBuf, StatsMap)>) -> R,
{
    TREE_CTX.with(|c| f(c.borrow().as_ref()))
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
    "Plantillas",
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

/// Metadata persistente y estable de un capítulo. Solo cambia cuando el
/// usuario renombra/reordena/cambia status o idioma. Los campos volátiles
/// (`palabras`, `ultima_edicion`) viven en `.twriter/stats.json` (ver
/// `stats.rs`) para que `meta.json` no genere commits ruidosos en cada save.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ChapterMeta {
    #[serde(default)]
    pub orden: u32,
    #[serde(default)]
    pub titulo: String,
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

    // Migración one-shot: si no existe stats.json todavía, scaneamos meta.json
    // y movemos palabras/ultima_edicion al cache local. No bloquea el walk si
    // falla; mantenemos `read_meta_word_count` como fallback.
    let stats_file = root_path.join(".twriter").join("stats.json");
    if !stats_file.exists() {
        if let Err(e) = stats::migrate_meta_to_stats(&root_path) {
            tracing::warn!(target: "fs", error = %e, "migración stats falló");
        }
    }
    // Un rename de carpeta hecho afuera de la app deja las claves apuntando a
    // paths viejos. Se reconcilia acá, antes de leer: si no, el árbol muestra
    // 0 palabras en esos capítulos hasta el próximo save.
    stats::reconciliar_stats(&root_path);
    let stats_map = stats::read_stats(&root_path);
    TREE_CTX.with(|c| *c.borrow_mut() = Some((root_path.clone(), stats_map)));

    let result: Result<TreeNode, String> = (|| {
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
    })();

    TREE_CTX.with(|c| c.borrow_mut().take());
    result
}

/// Escribe `content` de forma atómica: archivo `.tmp` al lado, `sync_all()`
/// y `rename()` sobre el destino, que en POSIX es atómico. Un `fs::write`
/// pelado abre con `O_TRUNC` y recién después vuelca los bytes, así que un
/// ENOSPC, un `kill -9` o un corte de luz a mitad de la escritura dejan el
/// archivo truncado y sin ningún estado intermedio recuperable. Mismo patrón
/// que `stats::write_stats`.
///
/// El nombre del `.tmp` lleva pid + contador porque dos writers sobre el
/// mismo capítulo (autosave del editor y `replace_apply`, por ejemplo)
/// compartiendo un tmp fijo podrían intercalar bytes y renombrar un archivo
/// mezclado. Si el rename falla, el tmp se borra.
pub fn write_atomic(p: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let tmp = p.with_file_name(format!(".{}.{}.{}.tmp", name, std::process::id(), seq));

    // `rename` solo necesita permiso de escritura en el directorio, así que
    // pisaría un archivo de solo lectura que `fs::write` rechazaba con
    // EACCES. Se mantiene el rechazo, y se le copian los permisos del
    // destino al tmp para que un guardado no le baje el modo a 0644.
    // (El rename también rompe hard links en vez de escribir los dos lados:
    // los capítulos linkeados divergen, que es lo esperable acá.)
    let perms = match fs::metadata(p) {
        Ok(md) if md.permissions().readonly() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("{}: archivo de solo lectura", p.display()),
            ));
        }
        Ok(md) => Some(md.permissions()),
        Err(_) => None,
    };

    let write = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        if let Some(perms) = perms {
            f.set_permissions(perms)?;
        }
        // ponytail: sin fsync del directorio — el rename puede quedar sin
        // durar si se corta la luz justo después, pero entonces sobrevive el
        // contenido viejo entero, que es el punto del patrón.
        f.sync_all()
    })();
    if let Err(e) = write.and_then(|_| fs::rename(&tmp, p)) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Lee el HTML de un capítulo. Solo soporta .html (los .odt/.docx hay que importar antes).
#[tauri::command]
pub fn read_chapter(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("No es archivo: {}", path));
    }
    match p.extension().and_then(|e| e.to_str()) {
        Some("html") => fs::read_to_string(&p)
            .map(|s| normalize_chapter_html(&s))
            .map_err(|e| e.to_string()),
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
    write_atomic(&p, &content).map_err(|e| {
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
    write_atomic(&meta_path, &raw).map_err(|e| {
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
    let word_count = chapter_word_count(path);
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

/// Devuelve palabras del capítulo: consulta el cache `.twriter/stats.json`
/// (cargado al inicio de `get_tree`). Si falta, hace fallback computando
/// desde el HTML (lazy).
fn chapter_word_count(chapter_path: &Path) -> Option<u32> {
    with_tree_ctx(|ctx| {
        let (root, stats) = ctx?;
        stats::palabras_for_chapter(stats, root, chapter_path)
    })
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

#[cfg(test)]
mod tests {
    use super::normalize_chapter_html;

    #[test]
    fn colapsa_newlines_entre_block_tags() {
        let disk = "<p>uno</p>\n<p>dos</p>\n<p>tres</p>\n";
        assert_eq!(normalize_chapter_html(disk), "<p>uno</p><p>dos</p><p>tres</p>");
    }

    #[test]
    fn preserva_espacios_entre_inlines() {
        // TipTap preserva el espacio entre inlines; no debemos colapsarlo.
        let html = "<p><em>foo</em> <strong>bar</strong></p>";
        assert_eq!(normalize_chapter_html(html), html);
    }

    #[test]
    fn idempotente_sobre_html_ya_normalizado() {
        let canon = "<p>a</p><p>b</p>";
        assert_eq!(normalize_chapter_html(canon), canon);
    }

    #[test]
    fn newline_entre_inlines_se_colapsa() {
        // Caso raro pero posible: tras normalizar, el navegador inserta el
        // espacio implícito del salto. Asumimos pérdida tolerable.
        let html = "<p><em>foo</em>\n<strong>bar</strong></p>";
        assert_eq!(
            normalize_chapter_html(html),
            "<p><em>foo</em><strong>bar</strong></p>"
        );
    }

    #[test]
    fn write_atomic_pisa_y_no_deja_tmp() {
        let td = tempfile::TempDir::new().unwrap();
        let dest = td.path().join("1.html");
        super::write_atomic(&dest, "<p>uno</p>\n").unwrap();
        super::write_atomic(&dest, "<p>dos</p>\n").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "<p>dos</p>\n");
        let sobrantes: Vec<_> = std::fs::read_dir(td.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(sobrantes.is_empty(), "quedaron tmps: {:?}", sobrantes);
    }

    #[test]
    fn write_atomic_falla_sin_dejar_tmp_ni_tocar_el_destino() {
        // Destino que es un directorio: el rename falla y el tmp tiene que
        // desaparecer igual.
        let td = tempfile::TempDir::new().unwrap();
        let dest = td.path().join("soy-carpeta");
        std::fs::create_dir(&dest).unwrap();
        assert!(super::write_atomic(&dest, "<p>x</p>\n").is_err());
        assert!(dest.is_dir());
        let sobrantes: Vec<_> = std::fs::read_dir(td.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(sobrantes.is_empty(), "quedaron tmps: {:?}", sobrantes);
    }
}
