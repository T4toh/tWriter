use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::query::{
    BooleanQuery, BoostQuery, FuzzyTermQuery, Occur, Query, QueryParser, TermQuery,
};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, FAST, STORED, STRING,
};
use tantivy::tokenizer::{LowerCaser, RemoveLongFilter, SimpleTokenizer, TextAnalyzer};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};
use tauri::{AppHandle, Emitter};

use crate::fs as fs_mod;

const INDEX_SUBDIR: &str = ".twriter/search-index";
// v4: el tokenizer `es_text` preserva acentos Y stopwords (lowercase only) — el
// modo exacto (default) necesita matchear el string literal tal cual para
// proofreading; el modo fuzzy (opt-in) absorbe typos/acentos vía Levenshtein.
// Bump fuerza wipe + full reindex.
const INDEX_VERSION: u32 = 4;
const VERSION_FILE: &str = ".version";
const WRITER_HEAP_BYTES: usize = 50_000_000;
const SNIPPET_MAX_LEN: usize = 240;
const ES_TOKENIZER: &str = "es_text";
const TITLE_BOOST: f32 = 2.5;

// Fuzzy/typo tolerance: distancia Levenshtein escalada por longitud del término.
// Max 2 — tantivy 0.22 sólo cachea autómatas 0/1/2 (≥3 ⇒ InvalidArgument).
const FUZZY_LEN_EXACT_MAX: usize = 3; // <=3 chars ⇒ distancia 0 (exacto)
const FUZZY_LEN_ONE_MAX: usize = 7; // 4..=7 chars ⇒ distancia 1; >=8 ⇒ distancia 2
const FUZZY_TRANSPOSITION_COST_ONE: bool = true; // swap adyacente cuesta 1 edit
// Boost del clause "todos los términos" (AND) sobre el OR base — docs con todos
// los términos ranquean por encima de los que matchean sólo alguno.
const FULL_MATCH_BOOST: f32 = 3.0;

static INDEX_STATE: OnceLock<Mutex<Option<SearchIndex>>> = OnceLock::new();

fn state() -> &'static Mutex<Option<SearchIndex>> {
    INDEX_STATE.get_or_init(|| Mutex::new(None))
}

/// Wrapper alrededor del Index tantivy + writer + reader.
pub struct SearchIndex {
    index: Index,
    writer: Mutex<IndexWriter>,
    reader: IndexReader,
    root: PathBuf,
    path_field: Field,
    kind_field: Field,
    title_field: Field,
    content_field: Field,
    saga_field: Field,
    book_field: Field,
    section_field: Field,
    mtime_field: Field,
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchHit {
    pub path: String,
    pub kind: String,
    pub title: String,
    pub snippet: String,
    pub score: f32,
    /// Palabras REALES del doc que matchearon cada término (resueltas vía
    /// fold+fuzzy). Permiten al frontend resaltar el término existente — ej.
    /// "Kallai" cuando se tipeó "kellai" — en vez del literal inexistente.
    #[serde(rename = "matchedTerms")]
    pub matched_terms: Vec<String>,
    /// Score BM25 puro (sin el boost ×2 de forma rica). Solo presente cuando
    /// la query llega con `debug=true`. Útil para diagnosticar resultados.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bm25_score: Option<f32>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ReindexProgress {
    pub done: u32,
    pub total: u32,
    pub current: String,
}

/// Filtro de scope opcional pasado desde el frontend.
/// - `saga` / `book`: id (= nombre del directorio) — match exacto via `Term`.
/// - `kind`: "note" | "chapter" — restringe el tipo de documento.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchScope {
    pub saga: Option<String>,
    pub book: Option<String>,
    pub kind: Option<String>,
}

fn build_schema() -> (Schema, SchemaFields) {
    let mut sb = Schema::builder();
    let path_field = sb.add_text_field("path", STRING | STORED);
    let kind_field = sb.add_text_field("kind", STRING | STORED);
    let saga_field = sb.add_text_field("saga", STRING | STORED);
    let book_field = sb.add_text_field("book", STRING | STORED);
    let section_field = sb.add_text_field("section", STRING | STORED);
    // title + content usan el tokenizer "es_text" (lowercase + stopwords ES + remove-long).
    let es_indexing = TextFieldIndexing::default()
        .set_tokenizer(ES_TOKENIZER)
        .set_index_option(IndexRecordOption::WithFreqsAndPositions);
    let es_options = TextOptions::default()
        .set_indexing_options(es_indexing)
        .set_stored();
    let title_field = sb.add_text_field("title", es_options.clone());
    let content_field = sb.add_text_field("content", es_options);
    let mtime_field = sb.add_u64_field("mtime", STORED | FAST);
    let schema = sb.build();
    (
        schema,
        SchemaFields {
            path_field,
            kind_field,
            title_field,
            content_field,
            saga_field,
            book_field,
            section_field,
            mtime_field,
        },
    )
}

struct SchemaFields {
    path_field: Field,
    kind_field: Field,
    title_field: Field,
    content_field: Field,
    saga_field: Field,
    book_field: Field,
    section_field: Field,
    mtime_field: Field,
}

/// Pliega una vocal acentuada a su base (á→a … ü→u y mayúsculas), preservando
/// ñ/Ñ. Length-preserving en chars (1 char → 1 char). El índice NO se pliega
/// (modo exacto accent-sensitive); este fold se usa sólo para `resolve_matched_words`
/// (ubicar la palabra real de un hit ignorando acentos).
fn fold_accent_char(c: char) -> char {
    match c {
        'á' | 'à' | 'ä' | 'â' | 'ã' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        'Á' | 'À' | 'Ä' | 'Â' | 'Ã' => 'A',
        'É' | 'È' | 'Ë' | 'Ê' => 'E',
        'Í' | 'Ì' | 'Ï' | 'Î' => 'I',
        'Ó' | 'Ò' | 'Ö' | 'Ô' | 'Õ' => 'O',
        'Ú' | 'Ù' | 'Ü' | 'Û' => 'U',
        // ñ/Ñ NO se pliegan — "año" ≠ "ano".
        other => other,
    }
}

fn fold_accents(s: &str) -> String {
    s.chars().map(fold_accent_char).collect()
}

/// Pipeline de `title` y `content`: simple tokenizer → remove-long → lowercase.
/// Deliberadamente SIN fold de acentos ni drop de stopwords: el índice preserva
/// la grafía (lowercased) para que el modo exacto encuentre el string literal
/// — incluyendo palabras función — que es lo que se busca al corregir errores.
fn make_es_analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(RemoveLongFilter::limit(40))
        .filter(LowerCaser)
        .build()
}

fn read_index_version(dir: &Path) -> Option<u32> {
    fs::read_to_string(dir.join(VERSION_FILE))
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn write_index_version(dir: &Path) -> Result<(), String> {
    fs::write(dir.join(VERSION_FILE), INDEX_VERSION.to_string()).map_err(|e| e.to_string())
}

/// Limpia el contenido del directorio del índice (preservando el dir mismo).
/// Usado para forzar full reindex cuando la versión del schema cambió.
fn wipe_index_dir(dir: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            fs::remove_dir_all(&p).map_err(|e| format!("rm -rf {}: {e}", p.display()))?;
        } else {
            fs::remove_file(&p).map_err(|e| format!("rm {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

/// Abre o crea el índice tantivy en `<root>/.twriter/search-index/`. Si la
/// versión del schema cambió desde el último boot, wipea el dir y recrea
/// (el caller debe lanzar full_reindex después si quiere repoblar).
fn open_or_create(root: &Path) -> Result<SearchIndex, String> {
    let dir = root.join(INDEX_SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let stored_version = read_index_version(&dir);
    if stored_version != Some(INDEX_VERSION) {
        if dir.read_dir().ok().map(|mut i| i.next().is_some()).unwrap_or(false) {
            tracing::info!(
                target: "search",
                from = ?stored_version,
                to = INDEX_VERSION,
                "index schema bump: wipe + reindex"
            );
        }
        wipe_index_dir(&dir)?;
    }
    let (schema, fields) = build_schema();
    let mmap = tantivy::directory::MmapDirectory::open(&dir).map_err(|e| e.to_string())?;
    let index = if Index::exists(&mmap).map_err(|e| e.to_string())? {
        Index::open_in_dir(&dir).map_err(|e| format!("open_in_dir: {e}"))?
    } else {
        Index::create_in_dir(&dir, schema.clone()).map_err(|e| format!("create_in_dir: {e}"))?
    };
    // Registrar el tokenizer ES antes del primer write/read.
    index.tokenizers().register(ES_TOKENIZER, make_es_analyzer());
    write_index_version(&dir)?;
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
        root: root.to_path_buf(),
        path_field: fields.path_field,
        kind_field: fields.kind_field,
        title_field: fields.title_field,
        content_field: fields.content_field,
        saga_field: fields.saga_field,
        book_field: fields.book_field,
        section_field: fields.section_field,
        mtime_field: fields.mtime_field,
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
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Distancia Levenshtein entre dos strings (sobre chars). Con corte temprano:
/// si la diferencia de longitud ya supera `max`, devuelve `max + 1` sin calcular.
fn levenshtein(a: &str, b: &str, max: usize) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (la, lb) = (a.len(), b.len());
    if la.abs_diff(lb) > max {
        return max + 1;
    }
    let mut prev: Vec<usize> = (0..=lb).collect();
    let mut cur = vec![0usize; lb + 1];
    for i in 1..=la {
        cur[0] = i;
        let mut row_min = cur[0];
        for j in 1..=lb {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            row_min = row_min.min(cur[j]);
        }
        // Corte: si toda la fila ya excede max, no hay vuelta atrás.
        if row_min > max {
            return max + 1;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[lb]
}

/// Para cada término de la query, busca en `content` la palabra real que lo
/// matchea (igual criterio que el índice: fold de acentos + lowercase + fuzzy
/// escalado por longitud) y devuelve esa palabra ORIGINAL (con su tilde/caso tal
/// cual aparece). Reusado para (a) centrar el snippet en la palabra correcta
/// aunque sea un match fuzzy/acento, y (b) que el frontend resalte el término
/// real en el editor en vez del literal tipeado (que puede no existir en el doc).
fn resolve_matched_words(content: &str, query_terms: &[String], fuzzy: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // Palabras del contenido (runs alfanuméricos) con su forma normalizada.
    let words: Vec<(&str, String)> = content
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| (w, fold_accents(&w.to_lowercase())))
        .collect();
    for term in query_terms {
        let qn = fold_accents(&term.to_lowercase());
        if qn.is_empty() {
            continue;
        }
        // Exacto ⇒ budget 0 (sólo la palabra literal, ya presente en el hit).
        let budget = if fuzzy {
            fuzzy_distance_for(qn.chars().count()) as usize
        } else {
            0
        };
        let mut best: Option<(usize, &str)> = None;
        for (orig, wn) in &words {
            let d = levenshtein(&qn, wn, budget);
            if d <= budget && best.map_or(true, |(bd, _)| d < bd) {
                best = Some((d, orig));
                if d == 0 {
                    break; // match exacto (post-fold) — no hay mejor.
                }
            }
        }
        if let Some((_, w)) = best {
            if !out.iter().any(|e| e.eq_ignore_ascii_case(w)) {
                out.push(w.to_string());
            }
        }
    }
    out
}

/// Genera un snippet centrado en el primer match de los términos de la query.
/// Si `raw_query` (case-insensitive, preservando puntuación) aparece literal,
/// gana sobre el match de tokens — así `¡Duendes!` cae en el grito y no en
/// el primer `duendes` lowercase del párrafo.
fn make_snippet(content: &str, raw_query: &str, query_terms: &[String]) -> String {
    if content.is_empty() {
        return String::new();
    }
    let lower = content.to_lowercase();
    let raw_trim = raw_query.trim();
    let mut best: Option<usize> = None;
    if !raw_trim.is_empty() {
        let raw_lower = raw_trim.to_lowercase();
        if let Some(idx) = lower.find(&raw_lower) {
            best = Some(idx);
        }
    }
    if best.is_none() {
        for t in query_terms {
            if let Some(idx) = lower.find(&t.to_lowercase()) {
                best = Some(best.map_or(idx, |b| b.min(idx)));
            }
        }
    }
    if best.is_none() && query_terms.is_empty() && raw_trim.is_empty() {
        let cut: String = content.chars().take(SNIPPET_MAX_LEN).collect();
        return cut;
    }
    let center = best.unwrap_or(0);
    let start = center.saturating_sub(SNIPPET_MAX_LEN / 3);
    let end = (start + SNIPPET_MAX_LEN).min(content.len());
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

/// Walkea ancestros de `target` (que debe estar adentro de `root`) y devuelve
/// el id (= nombre del directorio) de la saga, libro y sección más cercanos.
///
/// Reglas:
/// - **saga**: directorio ancestro más cercano con `saga.json`.
/// - **book**: directorio ancestro más cercano con `book.json`.
/// - **section**: para chapters (file `.html`), el parent dir si no es un libro
///   ni saga ni el root mismo. Para dirs `section` ya clasificados,
///   `target.file_name()`.
///
/// Si `target` mismo es saga/book/section, ese nivel se incluye (un libro
/// indexa con `book = su propio nombre` para que `book:foo` matchee también
/// el nodo del libro).
fn extract_scope(root: &Path, target: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let start_dir = if target.is_file() {
        target.parent().unwrap_or(target)
    } else {
        target
    };
    let mut saga: Option<String> = None;
    let mut book: Option<String> = None;
    let mut section: Option<String> = None;
    let mut cur = Some(start_dir.to_path_buf());
    while let Some(p) = cur {
        if book.is_none() && p.join("book.json").is_file() {
            book = p
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string());
        }
        if saga.is_none() && p.join("saga.json").is_file() {
            saga = p
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string());
        }
        if p == root {
            break;
        }
        cur = p.parent().map(|x| x.to_path_buf());
        if cur.as_deref().map(|x| !x.starts_with(root) && x != root).unwrap_or(false) {
            // Stop si nos pasamos del root (defensivo).
            break;
        }
    }
    // Section: solo aplica a chapters cuyo parent no es book/saga/root.
    if target.is_file() {
        if let Some(parent) = target.parent() {
            if parent != root
                && !parent.join("book.json").is_file()
                && !parent.join("saga.json").is_file()
            {
                section = parent
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string());
            }
        }
    }
    (saga, book, section)
}

/// Agrega/actualiza un documento en el índice. `kind` espera lowercase:
/// chapter|note|saga|book|section|folder|notes.
pub fn index_document(path: &Path, kind: &str) -> Result<(), String> {
    with_index(|idx| {
        let mut writer = idx.writer.lock().map_err(|e| e.to_string())?;
        let path_str = path.to_string_lossy().to_string();
        delete_doc_by_path(&mut writer, idx.path_field, &path_str);
        let title = title_for(path);
        let content = content_for(path, kind);
        let mt = mtime_ms(path);
        let (saga, book, section) = extract_scope(&idx.root, path);
        let mut document = doc!(
            idx.path_field => path_str.as_str(),
            idx.kind_field => kind,
            idx.title_field => title.as_str(),
            idx.content_field => content.as_str(),
            idx.mtime_field => mt,
        );
        if let Some(s) = &saga {
            document.add_text(idx.saga_field, s);
        }
        if let Some(b) = &book {
            document.add_text(idx.book_field, b);
        }
        if let Some(sec) = &section {
            document.add_text(idx.section_field, sec);
        }
        writer.add_document(document).map_err(|e| e.to_string())?;
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
        let (saga, book, section) = extract_scope(&idx.root, path);
        let mut document = doc!(
            idx.path_field => path_str.as_str(),
            idx.kind_field => kind.as_str(),
            idx.title_field => title.as_str(),
            idx.content_field => content.as_str(),
            idx.mtime_field => mt,
        );
        if let Some(s) = &saga {
            document.add_text(idx.saga_field, s);
        }
        if let Some(b) = &book {
            document.add_text(idx.book_field, b);
        }
        if let Some(sec) = &section {
            document.add_text(idx.section_field, sec);
        }
        if writer.add_document(document).is_err() {
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
    // Forzamos un reload sincrónico — el `ReloadPolicy::OnCommitWithDelay` del
    // reader normal espera ~50ms, lo que deja la primera query post-reindex
    // viendo state stale. Para boot y reindex completos preferimos visibilidad
    // inmediata (la latencia adicional acá es despreciable comparada al
    // recorrido del repo).
    idx.reader.reload().ok();
    tracing::info!(target: "search", indexed = done, "reindex full completo");
    Ok(done as u64)
}

/// Camina el repo y devuelve la lista de `(path, kind)` a indexar.
fn collect_indexable(root: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    walk_collect(root, &mut out, 0);
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

fn walk_collect(dir: &Path, out: &mut Vec<(PathBuf, String)>, depth: u32) {
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
            walk_collect(&path, out, depth + 1);
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
            Some(e) if CHAPTER_EXTS.contains(&e) && !name.ends_with(".meta.json") => {
                out.push((path, "chapter".into()));
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
    let mut has_chapter = false;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    if CHAPTER_EXTS.contains(&ext.to_lowercase().as_str())
                        && !p
                            .file_name()
                            .and_then(|s| s.to_str())
                            .map(|n| n.ends_with(".meta.json"))
                            .unwrap_or(false)
                    {
                        has_chapter = true;
                        break;
                    }
                }
            }
        }
    }
    if has_chapter {
        Some("section")
    } else {
        Some("folder")
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub total: usize,
}

/// Ejecuta una búsqueda contra el índice activo, con scope/debug opcionales.
pub fn search_query_impl(
    query: &str,
    limit: usize,
    scope: Option<&SearchScope>,
    debug: bool,
    fuzzy: bool,
) -> Result<SearchResult, String> {
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
    // Modo fuzzy (opt-in) + query "plain" (sin operadores) ⇒ builder fuzzy/OR:
    // tolera typos/acentos, trae por OR con boost al match completo. En modo
    // exacto (default) o con operadores (`"frase"`, `OR`, `-término`, `kind:`)
    // va el QueryParser clásico (AND default), accent-sensitive ⇒ encuentra el
    // string literal tal cual, que es lo que se busca al corregir errores.
    let parsed: Box<dyn Query> = if fuzzy && is_plain_query(q) {
        match build_fuzzy_or_query(idx, q) {
            Some(query) => query,
            None => return Ok(SearchResult { hits: Vec::new(), total: 0 }),
        }
    } else {
        let mut parser =
            QueryParser::for_index(&idx.index, vec![idx.title_field, idx.content_field]);
        // Title pesa más que content — un hit en el título ranquea sobre uno
        // en el body. El boost se compone multiplicativamente con BM25.
        parser.set_field_boost(idx.title_field, TITLE_BOOST);
        // Default AND: `duendes AND mansión` exige ambos.
        parser.set_conjunction_by_default();
        match parser.parse_query(q) {
            Ok(p) => p,
            Err(_) => return Ok(SearchResult { hits: Vec::new(), total: 0 }),
        }
    };
    let final_query: Box<dyn Query> = build_scoped_query(idx, parsed, scope);
    let limit = limit.clamp(1, 200);
    let top_docs = searcher
        .search(&*final_query, &TopDocs::with_limit(limit))
        .map_err(|e| e.to_string())?;
    let terms: Vec<String> = q
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()).to_string())
        .filter(|t| !t.is_empty())
        .collect();
    // Si la query "rica" (mayúsculas, `¡`, `!`, `?`, etc.) difiere del set de
    // tokens normalizados que indexa tantivy, boostamos docs que contienen el
    // literal por encima de los que solo matchean al token plano.
    let raw_lower = q.to_lowercase();
    let has_rich_form = q
        .chars()
        .any(|c| c.is_uppercase() || (!c.is_alphanumeric() && !c.is_whitespace()));
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
        let exact_hit = has_rich_form && content.to_lowercase().contains(&raw_lower);
        let final_score = if exact_hit { score * 2.0 } else { score };
        // Palabras reales del doc que matchearon (fold/fuzzy). Centran el snippet
        // en la palabra correcta aunque sea un match no-literal y viajan al
        // frontend para el highlight. Si no se resolvió ninguna, caemos a los
        // términos tipeados (caso operadores/phrase, ya literales).
        let matched = resolve_matched_words(&content, &terms, fuzzy);
        let snippet_terms: &[String] = if matched.is_empty() { &terms } else { &matched };
        hits.push(SearchHit {
            path,
            kind,
            title,
            snippet: make_snippet(&content, q, snippet_terms),
            score: final_score,
            matched_terms: matched,
            bm25_score: if debug { Some(score) } else { None },
        });
    }
    if has_rich_form {
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    }
    let total = hits.len();
    Ok(SearchResult { hits, total })
}

/// Una query es "plain" si no usa sintaxis de operadores del QueryParser.
/// Esas van por el builder fuzzy/OR; el resto sigue por QueryParser intacto.
fn is_plain_query(q: &str) -> bool {
    if q.contains('"') || q.contains(':') || q.contains('-') {
        return false;
    }
    // `OR`/`AND` como tokens sueltos (el QueryParser sólo los reconoce en
    // mayúsculas) — evita falso positivo en palabras como "ORden".
    !q.split_whitespace().any(|t| t == "OR" || t == "AND")
}

/// Distancia Levenshtein para un término según su longitud (en chars).
fn fuzzy_distance_for(term_chars: usize) -> u8 {
    if term_chars <= FUZZY_LEN_EXACT_MAX {
        0
    } else if term_chars <= FUZZY_LEN_ONE_MAX {
        1
    } else {
        2
    }
}

/// Construye una BooleanQuery fuzzy+OR para queries "plain":
/// - cada término ⇒ `FuzzyTermQuery` contra title (boosteado ×TITLE_BOOST) OR
///   content, como clause `Occur::Should` del outer (OR entre términos).
/// - si hay >1 término, un clause extra `Occur::Should` boosteado
///   (×FULL_MATCH_BOOST) que exige TODOS los términos (AND-de-fuzzy) ⇒ los docs
///   con todos los términos ranquean por encima de los que matchean alguno.
/// El boost de title se aplica a mano vía `BoostQuery` (`set_field_boost` es del
/// QueryParser, no aplica acá). Normaliza igual que el indexado: alfanumérico,
/// lowercase, fold de acentos.
fn build_fuzzy_or_query(idx: &SearchIndex, q: &str) -> Option<Box<dyn Query>> {
    // Lowercase para alinear con el índice (LowerCaser). NO se pliega: el índice
    // preserva acentos y el fuzzy ya absorbe á↔a como 1 edit.
    let terms: Vec<String> = q
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect();
    if terms.is_empty() {
        return None;
    }

    // Un término ⇒ OR(title fuzzy [boosted], content fuzzy).
    let per_term = |t: &str| -> Box<dyn Query> {
        let dist = fuzzy_distance_for(t.chars().count());
        let title_q: Box<dyn Query> = Box::new(BoostQuery::new(
            Box::new(FuzzyTermQuery::new(
                Term::from_field_text(idx.title_field, t),
                dist,
                FUZZY_TRANSPOSITION_COST_ONE,
            )),
            TITLE_BOOST,
        ));
        let content_q: Box<dyn Query> = Box::new(FuzzyTermQuery::new(
            Term::from_field_text(idx.content_field, t),
            dist,
            FUZZY_TRANSPOSITION_COST_ONE,
        ));
        Box::new(BooleanQuery::new(vec![
            (Occur::Should, title_q),
            (Occur::Should, content_q),
        ]))
    };

    let mut should: Vec<(Occur, Box<dyn Query>)> =
        terms.iter().map(|t| (Occur::Should, per_term(t))).collect();

    // Clause de "full match": todos los términos requeridos, boosteado.
    if terms.len() > 1 {
        let all_must: Vec<(Occur, Box<dyn Query>)> =
            terms.iter().map(|t| (Occur::Must, per_term(t))).collect();
        let full_match: Box<dyn Query> = Box::new(BooleanQuery::new(all_must));
        should.push((
            Occur::Should,
            Box::new(BoostQuery::new(full_match, FULL_MATCH_BOOST)),
        ));
    }

    Some(Box::new(BooleanQuery::new(should)))
}

/// Si hay scope, combina la query parseada con term filters via BooleanQuery
/// (Occur::Must). Sin scope, devuelve la query original tal cual.
fn build_scoped_query(
    idx: &SearchIndex,
    parsed: Box<dyn Query>,
    scope: Option<&SearchScope>,
) -> Box<dyn Query> {
    let scope = match scope {
        Some(s) => s,
        None => return parsed,
    };
    let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, parsed)];
    let mut push_term = |field: Field, value: &str| {
        let term = Term::from_field_text(field, value);
        let q: Box<dyn Query> = Box::new(TermQuery::new(term, IndexRecordOption::Basic));
        clauses.push((Occur::Must, q));
    };
    if let Some(s) = scope.saga.as_deref().filter(|s| !s.is_empty()) {
        push_term(idx.saga_field, s);
    }
    if let Some(b) = scope.book.as_deref().filter(|s| !s.is_empty()) {
        push_term(idx.book_field, b);
    }
    if let Some(k) = scope.kind.as_deref().filter(|s| !s.is_empty()) {
        push_term(idx.kind_field, k);
    }
    if clauses.len() == 1 {
        return clauses.pop().unwrap().1;
    }
    Box::new(BooleanQuery::new(clauses))
}

// ───── Comandos Tauri ─────

#[tauri::command]
pub fn search_query(
    query: String,
    limit: Option<usize>,
    scope: Option<SearchScope>,
    debug: Option<bool>,
    fuzzy: Option<bool>,
) -> Result<SearchResult, String> {
    search_query_impl(
        &query,
        limit.unwrap_or(50),
        scope.as_ref(),
        debug.unwrap_or(false),
        fuzzy.unwrap_or(false),
    )
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

/// Aplica un cambio de path al índice tras un pull. `kind` ∈
/// `"added"|"modified"|"renamed"|"deleted"`. Para `deleted` (o si el path
/// dejó de existir) hace remove; en el resto indexa. Infiere el `kind` del
/// índice (chapter/note) por extensión: `.html` ⇒ chapter, `.md` ⇒ note.
/// Otros archivos (meta.json, book.json, fonts) se ignoran silenciosamente.
#[tauri::command]
pub fn search_apply_path_change(path: String, kind: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    let doc_kind = match ext.as_deref() {
        Some("html") => "chapter",
        Some("md") => "note",
        _ => return Ok(()),
    };
    let deleted = kind == "deleted" || !p.exists();
    if deleted {
        if let Err(e) = remove_document(&p) {
            tracing::warn!(target: "search", path = %path, error = %e, "remove tras pull falló (best-effort)");
        }
    } else if let Err(e) = index_document(&p, doc_kind) {
        tracing::warn!(target: "search", path = %path, error = %e, "index tras pull falló (best-effort)");
    }
    Ok(())
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
    use std::sync::Mutex as StdMutex;
    use tempfile::TempDir;

    /// Los tests comparten el global INDEX_STATE — los serializamos para evitar
    /// que se pisen entre sí cuando cargo corre `--test-threads > 1`.
    static TEST_GUARD: StdMutex<()> = StdMutex::new(());

    fn make_repo() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Saga A con un libro y un capítulo.
        let saga_a = root.join("Saga A");
        std::fs::create_dir_all(saga_a.join("Libro 1")).unwrap();
        std::fs::write(saga_a.join("saga.json"), "{\"nombre\":\"Saga A\"}").unwrap();
        std::fs::write(saga_a.join("Libro 1").join("book.json"), "{\"titulo\":\"Libro 1\"}")
            .unwrap();
        std::fs::write(
            saga_a.join("Libro 1").join("1.html"),
            "<p>los duendes habitan la mansión encantada</p>",
        )
        .unwrap();
        std::fs::write(
            saga_a.join("Libro 1").join("1.meta.json"),
            "{\"titulo\":\"Capítulo uno\"}",
        )
        .unwrap();
        // Saga B también con duendes — para verificar scope filtering.
        let saga_b = root.join("Saga B");
        std::fs::create_dir_all(saga_b.join("Libro 1")).unwrap();
        std::fs::write(saga_b.join("saga.json"), "{\"nombre\":\"Saga B\"}").unwrap();
        std::fs::write(saga_b.join("Libro 1").join("book.json"), "{\"titulo\":\"Libro 1\"}")
            .unwrap();
        std::fs::write(
            saga_b.join("Libro 1").join("1.html"),
            "<p>los duendes son distintos acá</p>",
        )
        .unwrap();
        // Una nota suelta en root.
        std::fs::write(root.join("worldbuilding.md"), "los duendes son criaturas").unwrap();
        dir
    }

    fn reset_state() {
        let mut slot = state().lock().unwrap();
        *slot = None;
    }

    #[test]
    fn html_strip_basics() {
        assert_eq!(html_to_text("<p>hola <em>mundo</em></p>"), "hola mundo");
        assert_eq!(html_to_text("a&nbsp;b&amp;c"), "a b&c");
    }

    #[test]
    fn snippet_centers_on_match() {
        let content = "lorem ipsum dolor sit amet magia consectetur adipiscing elit";
        let s = make_snippet(content, "magia", &["magia".into()]);
        assert!(s.contains("magia"));
    }

    #[test]
    fn snippet_prefers_exact_form_over_first_token() {
        let content = "Hablaban del tema de los duendes. \
            Mucho después, en otro momento, alguien gritó: ¡Duendes! gritó con energía.";
        let s = make_snippet(content, "¡Duendes!", &["duendes".into()]);
        assert!(s.contains("¡Duendes!"), "got: {s:?}");
    }

    #[test]
    fn snippet_falls_back_to_tokens_when_no_exact_match() {
        let content = "Hablaban del tema de los duendes a la noche.";
        let s = make_snippet(content, "¡Duendes!", &["duendes".into()]);
        assert!(s.contains("duendes"));
    }

    #[test]
    fn extract_scope_walks_ancestors() {
        let dir = make_repo();
        let root = dir.path();
        let chapter = root.join("Saga A").join("Libro 1").join("1.html");
        let (saga, book, section) = extract_scope(root, &chapter);
        assert_eq!(saga.as_deref(), Some("Saga A"));
        assert_eq!(book.as_deref(), Some("Libro 1"));
        // El parent es book, así que no hay section.
        assert!(section.is_none(), "section should be None when parent is book");
    }

    #[test]
    fn extract_scope_detects_section() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let section = root.join("Saga A").join("Libro 1").join("Parte 1");
        std::fs::create_dir_all(&section).unwrap();
        std::fs::write(root.join("Saga A").join("saga.json"), "{}").unwrap();
        std::fs::write(
            root.join("Saga A").join("Libro 1").join("book.json"),
            "{}",
        )
        .unwrap();
        let chapter = section.join("1.html");
        std::fs::write(&chapter, "<p>contenido</p>").unwrap();
        let (saga, book, sec) = extract_scope(root, &chapter);
        assert_eq!(saga.as_deref(), Some("Saga A"));
        assert_eq!(book.as_deref(), Some("Libro 1"));
        assert_eq!(sec.as_deref(), Some("Parte 1"));
    }

    #[test]
    fn full_reindex_populates_scope_fields() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo();
        let n = full_reindex(dir.path(), None).unwrap();
        assert!(n >= 3, "expected ≥3 docs indexed, got {n}");
    }

    #[test]
    fn search_plain_multiword_or_recall_and_ranking() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo();
        full_reindex(dir.path(), None).unwrap();
        // fuzzy=true + plain ⇒ OR. Trae cap A (ambos términos) y cap B / nota
        // (sólo "duendes"). El full-match (Saga A) ranquea primero.
        let res = search_query_impl("duendes mansión", 50, None, false, true).unwrap();
        assert!(
            res.hits.len() >= 2,
            "OR debería traer A + B/nota: {:?}",
            res.hits
        );
        assert!(
            res.hits[0].path.contains("Saga A"),
            "el full-match (Saga A) debería ranquear primero: {:?}",
            res.hits
        );
    }

    #[test]
    fn operator_query_still_strict() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo();
        full_reindex(dir.path(), None).unwrap();
        // Con `AND` explícito vuelve la semántica estricta del QueryParser,
        // incluso en modo fuzzy (el operador fuerza ese path).
        let res = search_query_impl("duendes AND mansión", 50, None, false, true).unwrap();
        assert!(!res.hits.is_empty(), "debería matchear cap A");
        assert!(
            res.hits.iter().all(|h| h.path.contains("Saga A")),
            "AND sólo cap A: {:?}",
            res.hits
        );
    }

    #[test]
    fn search_or_operator_widens() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo();
        full_reindex(dir.path(), None).unwrap();
        // Operador OR explícito funciona aun en modo exacto (default).
        let res = search_query_impl("mansión OR distintos", 50, None, false, false).unwrap();
        assert!(res.hits.len() >= 2, "OR should match both A and B chapters: {:?}", res.hits);
    }

    #[test]
    fn search_negation_excludes() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo();
        full_reindex(dir.path(), None).unwrap();
        let res = search_query_impl("duendes -mansión", 50, None, false, false).unwrap();
        // Ningún hit debería contener "mansión".
        for h in &res.hits {
            assert!(!h.snippet.to_lowercase().contains("mansión"), "leak: {h:?}");
        }
    }

    #[test]
    fn search_kind_filter_via_scope() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo();
        full_reindex(dir.path(), None).unwrap();
        let scope = SearchScope {
            kind: Some("note".into()),
            ..Default::default()
        };
        let res = search_query_impl("duendes", 50, Some(&scope), false, false).unwrap();
        assert!(!res.hits.is_empty(), "expected note hit");
        for h in &res.hits {
            assert_eq!(h.kind, "note", "leak non-note: {h:?}");
        }
    }

    #[test]
    fn search_saga_scope_filters() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo();
        full_reindex(dir.path(), None).unwrap();
        let scope = SearchScope {
            saga: Some("Saga A".into()),
            ..Default::default()
        };
        let res = search_query_impl("duendes", 50, Some(&scope), false, false).unwrap();
        assert!(!res.hits.is_empty(), "expected hits in Saga A");
        for h in &res.hits {
            assert!(h.path.contains("Saga A"), "leak from B: {h:?}");
        }
    }

    #[test]
    fn search_debug_exposes_bm25() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo();
        full_reindex(dir.path(), None).unwrap();
        let res_no_debug = search_query_impl("duendes", 5, None, false, false).unwrap();
        assert!(res_no_debug.hits.iter().all(|h| h.bm25_score.is_none()));
        let res_debug = search_query_impl("duendes", 5, None, true, false).unwrap();
        assert!(res_debug.hits.iter().all(|h| h.bm25_score.is_some()));
    }

    #[test]
    fn exact_finds_common_words_and_is_accent_sensitive() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo();
        full_reindex(dir.path(), None).unwrap();
        // Las stopwords YA NO se dropean (el índice las preserva): el modo exacto
        // debe encontrar palabras función literales — útil para proofreading.
        let res = search_query_impl("los", 50, None, false, false).unwrap();
        assert!(
            !res.hits.is_empty(),
            "exacto: 'los' (presente en los docs) debería matchear"
        );
        // Modo exacto es accent-sensitive: "mansion" sin tilde NO encuentra
        // "mansión" — esto es lo que permite ubicar el typo literal al corregir.
        let res = search_query_impl("mansion", 50, None, false, false).unwrap();
        assert!(
            res.hits.is_empty(),
            "exacto: 'mansion' no debería traer 'mansión': {:?}",
            res.hits
        );
        let res = search_query_impl("mansión", 50, None, false, false).unwrap();
        assert!(!res.hits.is_empty(), "exacto: 'mansión' literal debería matchear");
    }

    /// Repo mínimo: Saga A / Libro 1 con un capítulo por `(nombre, contenido)`.
    fn make_repo_chapters(chapters: &[(&str, &str)]) -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("Saga A").join("Libro 1");
        std::fs::create_dir_all(&book).unwrap();
        std::fs::write(
            dir.path().join("Saga A").join("saga.json"),
            "{\"nombre\":\"Saga A\"}",
        )
        .unwrap();
        std::fs::write(book.join("book.json"), "{\"titulo\":\"Libro 1\"}").unwrap();
        for (name, content) in chapters {
            std::fs::write(book.join(format!("{name}.html")), format!("<p>{content}</p>")).unwrap();
        }
        dir
    }

    #[test]
    fn fold_accents_basic() {
        assert_eq!(fold_accents("Mansión"), "Mansion");
        assert_eq!(fold_accents("camión corazón"), "camion corazon");
        assert_eq!(fold_accents("ÁÉÍÓÚ"), "AEIOU");
    }

    #[test]
    fn fold_accents_preserves_enie() {
        assert_eq!(fold_accents("año"), "año");
        assert_ne!(fold_accents("año"), "ano");
        assert_eq!(fold_accents("niño"), "niño");
    }

    #[test]
    fn fold_accents_length_preserving() {
        for s in ["áéíóúü", "Mansión", "señor", "corazón"] {
            assert_eq!(
                fold_accents(s).chars().count(),
                s.chars().count(),
                "fold no length-preserving para {s:?}"
            );
        }
    }

    #[test]
    fn fuzzy_is_accent_insensitive() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo_chapters(&[("1", "la mansión encantada del bosque")]);
        full_reindex(dir.path(), None).unwrap();
        // En modo fuzzy, "mansion" sin tilde encuentra "mansión" (lev á↔a = 1).
        let res = search_query_impl("mansion", 50, None, false, true).unwrap();
        assert!(!res.hits.is_empty(), "fuzzy: 'mansion' debería encontrar 'mansión'");
        let res = search_query_impl("mansión", 50, None, false, true).unwrap();
        assert!(!res.hits.is_empty(), "fuzzy: 'mansión' debería encontrarse");
    }

    #[test]
    fn search_enie_not_folded() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        // Término corto (≤3 chars ⇒ distancia fuzzy 0): aun en modo fuzzy, "ano"
        // NO debe traer "año" (lev á... 1 > 0). ñ no se confunde con n.
        let dir = make_repo_chapters(&[("1", "ano"), ("2", "año")]);
        full_reindex(dir.path(), None).unwrap();
        let res = search_query_impl("ano", 50, None, false, true).unwrap();
        assert!(!res.hits.is_empty(), "'ano' debería matchear su doc");
        for h in &res.hits {
            assert!(
                h.path.ends_with("1.html"),
                "'ano' no debería traer el doc 'año': {h:?}"
            );
        }
    }

    #[test]
    fn fuzzy_hit_snippet_and_matched_terms_center_on_real_word() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo_chapters(&[(
            "1",
            "He was running on the treadmill. Later that night Kallai arrived at the gate.",
        )]);
        full_reindex(dir.path(), None).unwrap();
        // Modo fuzzy: typo "kellai" (dist 1 de "Kallai") matchea, centra el
        // snippet en "Kallai" (no en el inicio) y reporta la palabra real.
        let res = search_query_impl("kellai", 50, None, false, true).unwrap();
        assert_eq!(res.hits.len(), 1, "debería matchear el doc: {:?}", res.hits);
        let h = &res.hits[0];
        assert!(
            h.snippet.contains("Kallai"),
            "snippet debe centrarse en 'Kallai': {:?}",
            h.snippet
        );
        assert!(
            h.matched_terms.iter().any(|m| m == "Kallai"),
            "matched_terms debe incluir 'Kallai': {:?}",
            h.matched_terms
        );
    }

    #[test]
    fn levenshtein_early_exit() {
        assert_eq!(levenshtein("kellai", "kallai", 1), 1);
        assert_eq!(levenshtein("sol", "col", 0), 1); // excede budget 0 ⇒ max+1
        assert_eq!(levenshtein("casa", "casa", 2), 0);
    }

    #[test]
    fn search_fuzzy_typo() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo_chapters(&[("1", "la mansión encantada")]);
        full_reindex(dir.path(), None).unwrap();
        // "mansionn" (len 8 ⇒ dist 2) vs indexado "mansión": 2 edits ⇒ match.
        let res = search_query_impl("mansionn", 50, None, false, true).unwrap();
        assert!(!res.hits.is_empty(), "typo 'mansionn' debería encontrar 'mansión'");
    }

    #[test]
    fn search_fuzzy_short_term_exact() {
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        let dir = make_repo_chapters(&[("1", "brillaba el sol radiante")]);
        full_reindex(dir.path(), None).unwrap();
        // Modo fuzzy, término ≤3 chars ⇒ distancia 0: "col" NO debe traer "sol".
        let res = search_query_impl("col", 50, None, false, true).unwrap();
        assert!(res.hits.is_empty(), "term corto debe ser exacto: {:?}", res.hits);
        let res = search_query_impl("sol", 50, None, false, true).unwrap();
        assert!(!res.hits.is_empty(), "'sol' debería matchear");
    }

    #[test]
    fn index_version_bump_wipes_dir() {
        let dir = tempfile::tempdir().unwrap();
        let idx_dir = dir.path().join(INDEX_SUBDIR);
        std::fs::create_dir_all(&idx_dir).unwrap();
        std::fs::write(idx_dir.join(VERSION_FILE), "1").unwrap();
        std::fs::write(idx_dir.join("stale.bin"), b"garbage").unwrap();
        let _g = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset_state();
        // open_or_create debería ver versión 1, hacer wipe, escribir versión 2.
        let _idx = open_or_create(dir.path()).unwrap();
        assert!(
            !idx_dir.join("stale.bin").exists(),
            "wipe debería borrar stale.bin"
        );
        let v = read_index_version(&idx_dir);
        assert_eq!(v, Some(INDEX_VERSION));
    }
}
