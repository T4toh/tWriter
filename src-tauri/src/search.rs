use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde::Serialize;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, Schema, Value, FAST, STORED, STRING, TEXT};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};
use tauri::{AppHandle, Emitter};

use crate::fs as fs_mod;

const INDEX_SUBDIR: &str = ".twriter/search-index";
const WRITER_HEAP_BYTES: usize = 50_000_000;
const SNIPPET_MAX_LEN: usize = 240;

static INDEX_STATE: OnceLock<Mutex<Option<SearchIndex>>> = OnceLock::new();

fn state() -> &'static Mutex<Option<SearchIndex>> {
    INDEX_STATE.get_or_init(|| Mutex::new(None))
}

/// Wrapper alrededor del Index tantivy + writer + reader.
pub struct SearchIndex {
    index: Index,
    writer: Mutex<IndexWriter>,
    reader: IndexReader,
    path_field: Field,
    kind_field: Field,
    title_field: Field,
    content_field: Field,
    mtime_field: Field,
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchHit {
    pub path: String,
    pub kind: String,
    pub title: String,
    pub snippet: String,
    pub score: f32,
}

#[derive(Serialize, Clone, Debug)]
pub struct ReindexProgress {
    pub done: u32,
    pub total: u32,
    pub current: String,
}

fn build_schema() -> (
    Schema,
    Field, // path
    Field, // kind
    Field, // title
    Field, // content
    Field, // mtime
) {
    let mut sb = Schema::builder();
    let path_field = sb.add_text_field("path", STRING | STORED);
    let kind_field = sb.add_text_field("kind", STRING | STORED);
    let title_field = sb.add_text_field("title", TEXT | STORED);
    let content_field = sb.add_text_field("content", TEXT | STORED);
    let mtime_field = sb.add_u64_field("mtime", STORED | FAST);
    let schema = sb.build();
    (schema, path_field, kind_field, title_field, content_field, mtime_field)
}

/// Abre o crea el índice tantivy en `<root>/.twriter/search-index/`.
fn open_or_create(root: &Path) -> Result<SearchIndex, String> {
    let dir = root.join(INDEX_SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let (schema, path_field, kind_field, title_field, content_field, mtime_field) = build_schema();
    let index = if Index::exists(&tantivy::directory::MmapDirectory::open(&dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?
    {
        Index::open_in_dir(&dir).map_err(|e| format!("open_in_dir: {e}"))?
    } else {
        Index::create_in_dir(&dir, schema.clone()).map_err(|e| format!("create_in_dir: {e}"))?
    };
    let writer = index
        .writer(WRITER_HEAP_BYTES)
        .map_err(|e| format!("writer: {e}"))?;
    let reader = index
        .reader_builder()
        .reload_policy(ReloadPolicy::OnCommitWithDelay)
        .try_into()
        .map_err(|e| format!("reader: {e}"))?;
    Ok(SearchIndex {
        index,
        writer: Mutex::new(writer),
        reader,
        path_field,
        kind_field,
        title_field,
        content_field,
        mtime_field,
    })
}

/// Inicializa o re-inicializa el state global del index para `root`.
/// Si ya existía un index para otro root, lo descarta.
pub fn init_for_root(root: &Path) -> Result<(), String> {
    let idx = open_or_create(root)?;
    let mut slot = state().lock().map_err(|e| e.to_string())?;
    *slot = Some(idx);
    Ok(())
}

/// Ejecuta `f` con acceso al SearchIndex actual. Si no hay index inicializado,
/// devuelve `Ok(())` sin hacer nada (best-effort para hooks).
fn with_index<F: FnOnce(&SearchIndex) -> Result<(), String>>(f: F) -> Result<(), String> {
    let slot = match state().lock() {
        Ok(g) => g,
        Err(_) => return Ok(()),
    };
    if let Some(idx) = slot.as_ref() {
        f(idx)?;
    }
    Ok(())
}

/// HTML strip simple. Reemplaza tags y entidades comunes por espacios.
fn html_to_text(html: &str) -> String {
    static TAG_RE: OnceLock<Regex> = OnceLock::new();
    let re = TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let stripped = re.replace_all(html, " ");
    let decoded = stripped
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    // Colapsa whitespace.
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Genera un snippet centrado en el primer match de los términos de la query.
fn make_snippet(content: &str, query_terms: &[String]) -> String {
    if content.is_empty() || query_terms.is_empty() {
        let cut: String = content.chars().take(SNIPPET_MAX_LEN).collect();
        return cut;
    }
    let lower = content.to_lowercase();
    let mut best: Option<usize> = None;
    for t in query_terms {
        if let Some(idx) = lower.find(&t.to_lowercase()) {
            best = Some(best.map_or(idx, |b| b.min(idx)));
        }
    }
    let center = best.unwrap_or(0);
    let start = center.saturating_sub(SNIPPET_MAX_LEN / 3);
    let end = (start + SNIPPET_MAX_LEN).min(content.len());
    // Ajustar a límite de char válido.
    let start = floor_char_boundary(content, start);
    let end = floor_char_boundary(content, end);
    let mut s = String::new();
    if start > 0 {
        s.push('…');
    }
    s.push_str(&content[start..end]);
    if end < content.len() {
        s.push('…');
    }
    s
}

fn floor_char_boundary(s: &str, idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    let mut i = idx;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn mtime_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn delete_doc_by_path(writer: &mut IndexWriter, path_field: Field, path: &str) {
    let term = Term::from_field_text(path_field, path);
    writer.delete_term(term);
}

/// Devuelve título legible para un path: stem para archivos, nombre del dir para
/// carpetas. Capítulos con meta.json usan el `titulo` si está presente.
fn title_for(path: &Path) -> String {
    if path.is_file() {
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            // Intenta leer .meta.json sibling para chapters.
            if path.extension().and_then(|e| e.to_str()) == Some("html") {
                let parent = path.parent().unwrap_or_else(|| Path::new("."));
                let meta = parent.join(format!("{}.meta.json", stem));
                if meta.is_file() {
                    if let Ok(raw) = fs::read_to_string(&meta) {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                            if let Some(t) = v.get("titulo").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    return t.to_string();
                                }
                            }
                        }
                    }
                }
            }
            return stem.to_string();
        }
    } else if path.is_dir() {
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            return name.to_string();
        }
    }
    path.display().to_string()
}

/// Lee contenido del archivo según su kind. Para folders devuelve "".
fn content_for(path: &Path, kind: &str) -> String {
    if kind == "chapter" {
        let raw = fs::read_to_string(path).unwrap_or_default();
        return html_to_text(&raw);
    }
    if kind == "note" {
        return fs::read_to_string(path).unwrap_or_default();
    }
    String::new()
}

/// Agrega/actualiza un documento en el índice. `kind` espera lowercase: chapter|note|saga|book|section|folder|notes.
pub fn index_document(path: &Path, kind: &str) -> Result<(), String> {
    with_index(|idx| {
        let mut writer = idx.writer.lock().map_err(|e| e.to_string())?;
        let path_str = path.to_string_lossy().to_string();
        delete_doc_by_path(&mut writer, idx.path_field, &path_str);
        let title = title_for(path);
        let content = content_for(path, kind);
        let mt = mtime_ms(path);
        writer
            .add_document(doc!(
                idx.path_field => path_str.as_str(),
                idx.kind_field => kind,
                idx.title_field => title.as_str(),
                idx.content_field => content.as_str(),
                idx.mtime_field => mt,
            ))
            .map_err(|e| e.to_string())?;
        writer.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Borra un documento del índice por path. Mejor effort.
pub fn remove_document(path: &Path) -> Result<(), String> {
    with_index(|idx| {
        let mut writer = idx.writer.lock().map_err(|e| e.to_string())?;
        delete_doc_by_path(&mut writer, idx.path_field, &path.to_string_lossy());
        writer.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Recorre el repo y reindexa todo. Si `progress_cb` es Some, emite progreso.
pub fn full_reindex(
    root: &Path,
    mut progress_cb: Option<&mut dyn FnMut(ReindexProgress)>,
) -> Result<u64, String> {
    let collected = collect_indexable(root);
    let total = collected.len() as u32;

    init_for_root(root)?;

    let slot = state().lock().map_err(|e| e.to_string())?;
    let idx = slot
        .as_ref()
        .ok_or_else(|| "index no inicializado".to_string())?;
    let mut writer = idx.writer.lock().map_err(|e| e.to_string())?;
    writer.delete_all_documents().map_err(|e| e.to_string())?;
    let mut done: u32 = 0;
    for (path, kind) in &collected {
        let path_str = path.to_string_lossy().to_string();
        let title = title_for(path);
        let content = content_for(path, kind);
        let mt = mtime_ms(path);
        if writer
            .add_document(doc!(
                idx.path_field => path_str.as_str(),
                idx.kind_field => kind.as_str(),
                idx.title_field => title.as_str(),
                idx.content_field => content.as_str(),
                idx.mtime_field => mt,
            ))
            .is_err()
        {
            continue;
        }
        done += 1;
        if let Some(cb) = progress_cb.as_mut() {
            cb(ReindexProgress {
                done,
                total,
                current: path_str,
            });
        }
    }
    writer.commit().map_err(|e| e.to_string())?;
    tracing::info!(target: "search", indexed = done, "reindex full completo");
    Ok(done as u64)
}

/// Camina el repo y devuelve la lista de `(path, kind)` a indexar.
fn collect_indexable(root: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    walk_collect(root, root, &mut out, 0);
    out
}

const ROOT_SKIP_FILES: &[&str] = &["README.md", "README.markdown", ".twriter-ignore", ".gitignore"];
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
const CHAPTER_EXTS: &[&str] = &["html"];
const NOTE_EXTS: &[&str] = &["md", "markdown"];

fn walk_collect(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, String)>, depth: u32) {
    // Indexar el dir como folder/saga/book/section (excepto root mismo).
    if depth > 0 {
        if let Some(kind) = classify_dir(dir) {
            out.push((dir.to_path_buf(), kind.to_string()));
        }
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
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
            if fs_mod::is_excluded_dir(&path) {
                continue;
            }
            walk_collect(root, &path, out, depth + 1);
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        if depth == 0 && ROOT_SKIP_FILES.contains(&name.as_str()) {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());
        match ext.as_deref() {
            Some(e) if CHAPTER_EXTS.contains(&e) => {
                if !name.ends_with(".meta.json") {
                    out.push((path, "chapter".into()));
                }
            }
            Some(e) if NOTE_EXTS.contains(&e) => {
                out.push((path, "note".into()));
            }
            _ => {}
        }
    }
}

fn classify_dir(dir: &Path) -> Option<&'static str> {
    let name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name == "notas" {
        return Some("notes");
    }
    if dir.join("saga.json").exists() {
        return Some("saga");
    }
    if dir.join("book.json").exists() {
        return Some("book");
    }
    // Heurística: sección si tiene capítulos directos; folder en otro caso.
    let mut has_chapter = false;
    let mut has_subdirs = false;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    if CHAPTER_EXTS.contains(&ext.to_lowercase().as_str())
                        && !p.file_name()
                            .and_then(|s| s.to_str())
                            .map(|n| n.ends_with(".meta.json"))
                            .unwrap_or(false)
                    {
                        has_chapter = true;
                    }
                }
            } else if p.is_dir() {
                has_subdirs = true;
            }
        }
    }
    if has_chapter {
        Some("section")
    } else if has_subdirs {
        Some("folder")
    } else {
        Some("folder")
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub total: usize,
}

/// Ejecuta una búsqueda contra el índice activo.
pub fn search_query_impl(query: &str, limit: usize) -> Result<SearchResult, String> {
    let slot = state().lock().map_err(|e| e.to_string())?;
    let idx = match slot.as_ref() {
        Some(i) => i,
        None => {
            return Ok(SearchResult {
                hits: Vec::new(),
                total: 0,
            })
        }
    };
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            total: 0,
        });
    }
    let searcher = idx.reader.searcher();
    let parser = QueryParser::for_index(&idx.index, vec![idx.title_field, idx.content_field]);
    let parsed = match parser.parse_query(q) {
        Ok(p) => p,
        Err(_) => return Ok(SearchResult { hits: Vec::new(), total: 0 }),
    };
    let limit = limit.clamp(1, 200);
    let top_docs = searcher
        .search(&parsed, &TopDocs::with_limit(limit))
        .map_err(|e| e.to_string())?;
    let terms: Vec<String> = q
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()).to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let mut hits = Vec::with_capacity(top_docs.len());
    for (score, addr) in top_docs {
        let doc: TantivyDocument = match searcher.doc(addr) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let path = doc
            .get_first(idx.path_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let kind = doc
            .get_first(idx.kind_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title = doc
            .get_first(idx.title_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let content = doc
            .get_first(idx.content_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        hits.push(SearchHit {
            path,
            kind,
            title,
            snippet: make_snippet(&content, &terms),
            score,
        });
    }
    let total = hits.len();
    Ok(SearchResult { hits, total })
}

// ───── Comandos Tauri ─────

#[tauri::command]
pub fn search_query(query: String, limit: Option<usize>) -> Result<SearchResult, String> {
    search_query_impl(&query, limit.unwrap_or(50))
}

#[tauri::command]
pub async fn search_reindex(app: AppHandle, root: String) -> Result<u64, String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut emit_cb = |p: ReindexProgress| {
            let _ = app_clone.emit("search-reindex-progress", p);
        };
        let r = PathBuf::from(&root);
        full_reindex(&r, Some(&mut emit_cb))
    })
    .await
    .map_err(|e| format!("task: {e}"))?
}

/// Helper para hooks de write: ejecuta indexación best-effort sin propagar errores.
pub fn index_path_best_effort(path: &str, kind: &str) {
    let p = PathBuf::from(path);
    if let Err(e) = index_document(&p, kind) {
        tracing::warn!(target: "search", path = %path, error = %e, "indexado falló (best-effort)");
    }
}

/// Helper para hooks de delete.
pub fn remove_path_best_effort(path: &str) {
    let p = PathBuf::from(path);
    if let Err(e) = remove_document(&p) {
        tracing::warn!(target: "search", path = %path, error = %e, "remove falló (best-effort)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_strip_basics() {
        assert_eq!(
            html_to_text("<p>hola <em>mundo</em></p>"),
            "hola mundo".to_string()
        );
        assert_eq!(
            html_to_text("a&nbsp;b&amp;c"),
            "a b&c".to_string()
        );
    }

    #[test]
    fn snippet_centers_on_match() {
        let content = "lorem ipsum dolor sit amet magia consectetur adipiscing elit";
        let s = make_snippet(content, &["magia".into()]);
        assert!(s.contains("magia"));
    }
}
