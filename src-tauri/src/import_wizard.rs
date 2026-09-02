use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

use crate::book_config::{BookConfig, COVER_EXTS};
use crate::fs::is_chapter_file;

/// Skip más permisivo que `fs::should_skip_dir`: solo metadatos reales.
/// El importer quiere capturar `convertidos/`, `original/`, `Revisiones/` etc.
/// como extras — la lista grande de `fs.rs` es para ocultar en el tree, no acá.
fn should_skip_dir(name: &str) -> bool {
    matches!(name, ".git" | ".twriter") || name.starts_with('.')
}
use crate::import::clean_html;
use crate::saga_config::SagaConfig;
use crate::util::strip_numeric_prefix;

// ─────────── Scan: estructura propuesta del source ───────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Saga,
    Book,
}

#[derive(Serialize, Debug)]
pub struct SourceFile {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub is_chapter_candidate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SourceNode {
    Book {
        path: String,
        name: String,
        sections: Vec<SourceNode>,
        chapters: Vec<SourceFile>,
        extras: Vec<SourceFile>,
    },
    Section {
        path: String,
        name: String,
        chapters: Vec<SourceFile>,
        extras: Vec<SourceFile>,
    },
}

#[derive(Serialize, Debug)]
pub struct SourceTree {
    pub root_path: String,
    pub suggested_kind: SourceKind,
    pub name: String,
    pub children: Vec<SourceNode>,
    pub direct_chapters: Vec<SourceFile>,
    pub direct_extras: Vec<SourceFile>,
}

#[tauri::command]
pub async fn scan_import_source(path: String) -> Result<SourceTree, String> {
    tauri::async_runtime::spawn_blocking(move || scan_impl(&path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn scan_impl(path: &str) -> Result<SourceTree, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(format!("no es directorio: {}", path));
    }
    let name = strip_numeric_prefix(
        root.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Sin nombre"),
    );

    let kind = classify_source(&root);
    let mut tree = SourceTree {
        root_path: root.to_string_lossy().into_owned(),
        suggested_kind: kind,
        name,
        children: Vec::new(),
        direct_chapters: Vec::new(),
        direct_extras: Vec::new(),
    };

    match tree.suggested_kind {
        SourceKind::Saga => {
            for sub in sorted_subdirs(&root)? {
                tree.children.push(scan_book(&sub)?);
            }
        }
        SourceKind::Book => {
            // Tratar root como un único libro
            let book = scan_book(&root)?;
            tree.children.push(book);
        }
    }
    Ok(tree)
}

fn classify_source(p: &Path) -> SourceKind {
    if p.join("saga.json").is_file() {
        return SourceKind::Saga;
    }
    if p.join("book.json").is_file() {
        return SourceKind::Book;
    }
    // Heurística según estilo del autor:
    //  - Viejo: saga/libro/cap.docx (cap = file único, nombre descriptivo
    //    "1 - Ihsahan - 1.docx").
    //  - Nuevo: saga/libro/cap-folder/parte.odt (parte = file con stem
    //    numérico puro "1.odt", "2.odt").
    // Cada subdir directo de root se clasifica en uno de tres roles:
    //  - book_with_subbooks: tiene sub-subdirs con capítulos (libro estilo
    //    nuevo, o saga con sub-saga). Marker fuerte de saga si hay 2+.
    //  - flat_book: archivos directos con stems descriptivos → libro plano.
    //  - chapter_folder: archivos directos con stems puramente numéricos →
    //    carpeta-de-capítulo del estilo nuevo, dentro de un libro.
    let mut has_direct_chapters_at_root = false;
    let mut book_with_subbooks = 0u32;
    let mut flat_books = 0u32;
    let mut chapter_folders = 0u32;
    if let Ok(entries) = fs::read_dir(p) {
        for e in entries.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if should_skip_dir(&name) {
                continue;
            }
            if path.is_file() && is_chapter_file(&path) {
                has_direct_chapters_at_root = true;
            } else if path.is_dir() {
                if subdir_has_chapter_bearing_subdir(&path) {
                    book_with_subbooks += 1;
                } else {
                    match classify_chapter_dir(&path) {
                        ChapterDirRole::FlatBook => flat_books += 1,
                        ChapterDirRole::ChapterFolder => chapter_folders += 1,
                        ChapterDirRole::Empty => {}
                    }
                }
            }
        }
    }
    // 2+ libros con sub-secciones → saga (estilo mixto o nuevo).
    if book_with_subbooks >= 2 {
        return SourceKind::Saga;
    }
    // 2+ libros planos → saga estilo viejo.
    if flat_books >= 2 {
        return SourceKind::Saga;
    }
    // 1 libro con sub-secciones + libros planos sueltos → saga mixta.
    if book_with_subbooks >= 1 && flat_books >= 1 {
        return SourceKind::Saga;
    }
    // chapter_folders dominantes → estilo nuevo, root es un libro.
    if chapter_folders > 0 && flat_books == 0 && book_with_subbooks == 0 {
        return SourceKind::Book;
    }
    if has_direct_chapters_at_root {
        return SourceKind::Book;
    }
    // Edge: solo 1 flat_book sin nada más → ambiguo, default a Book (wrapper).
    SourceKind::Book
}

enum ChapterDirRole {
    FlatBook,
    ChapterFolder,
    Empty,
}

/// Clasifica un subdir SIN sub-subdirs-con-caps:
///  - archivos con stem numérico puro ("1.odt", "2.html") → ChapterFolder.
///  - archivos con stem descriptivo ("1 - Ihsahan - 1.docx") → FlatBook.
///  - sin capítulos → Empty.
fn classify_chapter_dir(p: &Path) -> ChapterDirRole {
    let Ok(entries) = fs::read_dir(p) else {
        return ChapterDirRole::Empty;
    };
    let mut numeric_stems = 0u32;
    let mut descriptive_stems = 0u32;
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_file() || !is_chapter_file(&path) {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .trim();
        if stem.is_empty() {
            continue;
        }
        if stem.chars().all(|c| c.is_ascii_digit()) {
            numeric_stems += 1;
        } else {
            descriptive_stems += 1;
        }
    }
    if numeric_stems + descriptive_stems == 0 {
        ChapterDirRole::Empty
    } else if descriptive_stems == 0 {
        ChapterDirRole::ChapterFolder
    } else {
        ChapterDirRole::FlatBook
    }
}

fn subdir_has_chapter_bearing_subdir(p: &Path) -> bool {
    let Ok(entries) = fs::read_dir(p) else {
        return false;
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if should_skip_dir(&name) {
            continue;
        }
        if dir_has_chapters_recursive(&path, 2) {
            return true;
        }
    }
    false
}

fn dir_has_chapters_recursive(p: &Path, max_depth: u32) -> bool {
    if max_depth == 0 {
        return false;
    }
    if let Ok(entries) = fs::read_dir(p) {
        for e in entries.flatten() {
            let path = e.path();
            if path.is_file() && is_chapter_file(&path) {
                return true;
            }
            if path.is_dir() {
                let name = e.file_name().to_string_lossy().into_owned();
                if should_skip_dir(&name) {
                    continue;
                }
                if dir_has_chapters_recursive(&path, max_depth - 1) {
                    return true;
                }
            }
        }
    }
    false
}

fn scan_book(book_dir: &Path) -> Result<SourceNode, String> {
    let name = strip_numeric_prefix(
        book_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(""),
    );
    let mut sections: Vec<SourceNode> = Vec::new();
    let mut chapters: Vec<SourceFile> = Vec::new();
    let mut extras: Vec<SourceFile> = Vec::new();

    for entry in sorted_entries(book_dir)? {
        let path = entry.path();
        let fname = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if should_skip_dir(&fname) {
                continue;
            }
            if dir_has_chapters_recursive(&path, 2) {
                sections.push(scan_section(&path)?);
            } else {
                collect_extras_recursive(&path, &fname, &mut extras);
            }
        } else if path.is_file() {
            classify_file_into(&path, &mut chapters, &mut extras);
        }
    }
    Ok(SourceNode::Book {
        path: book_dir.to_string_lossy().into_owned(),
        name,
        sections,
        chapters,
        extras,
    })
}

fn scan_section(section_dir: &Path) -> Result<SourceNode, String> {
    let name = strip_numeric_prefix(
        section_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(""),
    );
    let mut chapters: Vec<SourceFile> = Vec::new();
    let mut extras: Vec<SourceFile> = Vec::new();
    for entry in sorted_entries(section_dir)? {
        let path = entry.path();
        let fname = entry.file_name().to_string_lossy().into_owned();
        if path.is_file() {
            classify_file_into(&path, &mut chapters, &mut extras);
        } else if path.is_dir() {
            if should_skip_dir(&fname) {
                continue;
            }
            // Subdirs adentro de section → extras de la section, preservando subpath.
            // (No anidamos sections: estructura plana cap/extras.)
            collect_extras_recursive(&path, &fname, &mut extras);
        }
    }
    Ok(SourceNode::Section {
        path: section_dir.to_string_lossy().into_owned(),
        name,
        chapters,
        extras,
    })
}

fn classify_file_into(path: &Path, chapters: &mut Vec<SourceFile>, extras: &mut Vec<SourceFile>) {
    let name = match path.file_stem().and_then(|s| s.to_str()) {
        Some(n) => n.to_string(),
        None => return,
    };
    let fname_full = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if fname_full.ends_with(".meta.json") {
        return;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let candidate = matches!(ext.as_str(), "html" | "docx" | "odt");
    let f = SourceFile {
        path: path.to_string_lossy().into_owned(),
        name,
        ext,
        is_chapter_candidate: candidate,
        subpath: None,
    };
    if candidate {
        chapters.push(f);
    } else {
        extras.push(f);
    }
}

fn collect_extras_recursive(dir: &Path, prefix: &str, out: &mut Vec<SourceFile>) {
    let entries = match sorted_entries(dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    for entry in entries {
        let path = entry.path();
        let fname = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if should_skip_dir(&fname) {
                continue;
            }
            let next_prefix = format!("{}/{}", prefix, fname);
            collect_extras_recursive(&path, &next_prefix, out);
        } else if path.is_file() {
            if fname.ends_with(".meta.json") {
                continue;
            }
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            out.push(SourceFile {
                path: path.to_string_lossy().into_owned(),
                name,
                ext,
                is_chapter_candidate: false,
                subpath: Some(prefix.to_string()),
            });
        }
    }
}

fn sorted_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    entries.sort_by(|a, b| {
        compare_names(
            &a.file_name().to_string_lossy(),
            &b.file_name().to_string_lossy(),
        )
    });
    Ok(entries)
}

fn sorted_subdirs(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !should_skip_dir(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    dirs.sort_by(|a, b| {
        compare_names(
            &a.file_name().unwrap_or_default().to_string_lossy(),
            &b.file_name().unwrap_or_default().to_string_lossy(),
        )
    });
    Ok(dirs)
}

fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    let na = leading_number(a);
    let nb = leading_number(b);
    match (na, nb) {
        (Some(na), Some(nb)) => na.cmp(&nb).then_with(|| a.cmp(b)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.cmp(b),
    }
}

fn leading_number(s: &str) -> Option<u32> {
    let t = s.trim_start();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

// ─────────── Apply: ejecutar el plan ───────────

#[derive(Deserialize, Debug)]
pub struct ChapterImport {
    pub source_path: String,
    pub target_name: String,
    #[serde(default)]
    pub orden: u32,
    #[serde(default)]
    pub titulo: String,
    #[serde(default)]
    pub idioma: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct ExtraImport {
    pub source_path: String,
    pub relative_dest: String,
}

#[derive(Deserialize, Debug)]
pub struct SectionImportSpec {
    pub dir_name: String,
    #[serde(default = "default_true")]
    pub convert_chapters: bool,
    pub chapters: Vec<ChapterImport>,
    #[serde(default)]
    pub extras: Vec<ExtraImport>,
}

#[derive(Deserialize, Debug)]
pub struct BookImportSpec {
    pub dir_name: String,
    pub config: BookConfig,
    #[serde(default = "default_true")]
    pub convert_chapters: bool,
    #[serde(default)]
    pub sections: Vec<SectionImportSpec>,
    #[serde(default)]
    pub direct_chapters: Vec<ChapterImport>,
    #[serde(default)]
    pub extras: Vec<ExtraImport>,
}

#[derive(Deserialize, Debug)]
pub struct SagaImportSpec {
    pub dir_name: String,
    pub config: SagaConfig,
    #[serde(default)]
    pub extras: Vec<ExtraImport>,
}

#[derive(Deserialize, Debug)]
pub struct WizardPlan {
    pub target_root: String,
    #[serde(default)]
    pub saga: Option<SagaImportSpec>,
    pub books: Vec<BookImportSpec>,
}

fn default_true() -> bool {
    true
}

/// Devuelve true si el nombre de la sección representa un epílogo.
/// Acepta "Epílogo"/"epilogo"/"Epilogue" con o sin prefijo numérico.
fn is_epilogo_name(name: &str) -> bool {
    let stripped = strip_numeric_prefix(name).trim().to_lowercase();
    let flat: String = stripped
        .chars()
        .map(|c| match c {
            'á' => 'a',
            'é' => 'e',
            'í' => 'i',
            'ó' => 'o',
            'ú' | 'ü' => 'u',
            'ñ' => 'n',
            other => other,
        })
        .collect();
    matches!(flat.as_str(), "epilogo" | "epilogue")
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct ImportSummary {
    pub created_dirs: u32,
    pub converted_chapters: u32,
    pub copied_chapters: u32,
    pub copied_extras: u32,
    pub failed: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ProgressPayload {
    pub done: u32,
    pub total: u32,
    pub current: String,
}

#[tauri::command]
pub async fn import_wizard_apply(
    app: AppHandle,
    plan: WizardPlan,
) -> Result<ImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || apply_impl(app, plan))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn count_total_files(plan: &WizardPlan) -> u32 {
    let mut t = 0u32;
    if let Some(saga) = &plan.saga {
        t += saga.extras.len() as u32;
    }
    for b in &plan.books {
        t += b.direct_chapters.len() as u32;
        t += b.extras.len() as u32;
        for s in &b.sections {
            t += s.chapters.len() as u32;
            t += s.extras.len() as u32;
        }
    }
    t
}

fn apply_impl(app: AppHandle, plan: WizardPlan) -> Result<ImportSummary, String> {
    let target_root = PathBuf::from(&plan.target_root);
    if !target_root.is_dir() {
        tracing::error!(target: "import-wizard", target_root = %plan.target_root, "target no existe");
        return Err(format!("target no existe: {}", plan.target_root));
    }
    let total = count_total_files(&plan);
    let mut done = 0u32;
    let mut summary = ImportSummary::default();
    tracing::info!(target: "import-wizard", total, libros = plan.books.len(), saga = plan.saga.is_some(), "iniciando wizard apply");

    let saga_dir = if let Some(saga) = &plan.saga {
        let dir = target_root.join(&saga.dir_name);
        ensure_dir(&dir, &mut summary)?;
        write_saga_json(&dir, &saga.config)?;
        for x in &saga.extras {
            done += 1;
            emit_progress(&app, done, total, &x.source_path);
            handle_extra(&dir, x, &mut summary);
        }
        dir
    } else {
        target_root.clone()
    };

    for book in &plan.books {
        let book_dir = saga_dir.join(&book.dir_name);
        ensure_dir(&book_dir, &mut summary)?;

        // Normalizar tapa/contratapa: si son paths absolutos fuera del book_dir, copiar a
        // <book_dir>/cover.<ext> y <book_dir>/back-cover.<ext> y rescribir el field a relativo.
        let mut book_cfg = book.config.clone();
        // Auto-detectar epílogo por nombre de sección si no estaba seteado.
        if book_cfg.epilogo.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
            for sec in &book.sections {
                if is_epilogo_name(&sec.dir_name) {
                    book_cfg.epilogo = Some(sec.dir_name.clone());
                    break;
                }
            }
        }
        // Copiar tapa/contratapa ANTES de escribir el book.json: si la copia
        // falla, el field tiene que quedar vacío en vez de persistir una
        // referencia a un archivo que nunca llegó a estar en el book_dir.
        for (field, stem) in [(&mut book_cfg.tapa, "cover"), (&mut book_cfg.contratapa, "back-cover")] {
            resolve_cover_image(field, stem, &book_dir, &mut summary);
        }
        if let Err(e) = write_book_json(&book_dir, &book_cfg) {
            summary.failed.push(format!("book.json {}: {}", book.dir_name, e));
        }

        // direct chapters
        for ch in &book.direct_chapters {
            done += 1;
            emit_progress(&app, done, total, &ch.source_path);
            handle_chapter(&book_dir, ch, book.convert_chapters, &mut summary);
        }
        // extras del book
        for x in &book.extras {
            done += 1;
            emit_progress(&app, done, total, &x.source_path);
            handle_extra(&book_dir, x, &mut summary);
        }
        // sections
        for sec in &book.sections {
            let sec_dir = book_dir.join(&sec.dir_name);
            ensure_dir(&sec_dir, &mut summary)?;
            for ch in &sec.chapters {
                done += 1;
                emit_progress(&app, done, total, &ch.source_path);
                handle_chapter(&sec_dir, ch, sec.convert_chapters, &mut summary);
            }
            for x in &sec.extras {
                done += 1;
                emit_progress(&app, done, total, &x.source_path);
                handle_extra(&sec_dir, x, &mut summary);
            }
        }
    }
    tracing::info!(
        target: "import-wizard",
        convertidos = summary.converted_chapters,
        copiados = summary.copied_chapters,
        extras = summary.copied_extras,
        fallos = summary.failed.len(),
        "wizard apply listo"
    );
    Ok(summary)
}

fn emit_progress(app: &AppHandle, done: u32, total: u32, current: &str) {
    let _ = app.emit(
        "import-progress",
        ProgressPayload {
            done,
            total,
            current: current.to_string(),
        },
    );
}

/// Valida la tapa/contratapa elegida en el wizard antes de copiarla.
///
/// El picker del wizard solo filtra por UI: se puede tipear un nombre a mano
/// o elegir "todos los archivos" y colar una extensión que el decoder de
/// portadas no sabe abrir (`image` se compila sin soporte webp/gif, ver
/// `book_config::COVER_EXTS`). Si `field` apunta a un archivo con una
/// extensión no soportada, no se copia nada y se limpia el campo para que
/// el `book.json` no quede referenciando un archivo que el EPUB no puede
/// decodificar — mejor sin tapa que con una referencia rota o un webp que
/// exporta el EPUB sin portada en silencio. El aviso se empuja a `failed`,
/// que ya es donde el wizard junta el resto de los problemas por-archivo
/// (ver `handle_chapter`/`handle_extra`), así que el resto del import sigue
/// su curso y el autor ve el motivo en la misma lista al terminar.
///
/// Copia la tapa/contratapa elegida en el wizard a `<book_dir>/<stem>.<ext>`
/// y reescribe `field` a ese nombre relativo — pero solo si la copia salió
/// bien. Si falla (o el formato no está soportado), `field` queda en `None`:
/// mejor sin tapa que con un `book.json` apuntando a un archivo que no está
/// en el book_dir. El motivo se empuja a `summary.failed`, que ya es donde
/// el wizard junta el resto de los problemas por-archivo (ver
/// `handle_chapter`/`handle_extra`), así que el resto del import sigue su
/// curso y el autor ve el motivo en la misma lista al terminar.
///
/// No hace nada (deja `field` como está) si el campo estaba vacío o ya era
/// relativo — nada para copiar en ese caso.
fn resolve_cover_image(field: &mut Option<String>, stem: &str, book_dir: &Path, summary: &mut ImportSummary) {
    let etiqueta = if stem == "cover" { "tapa" } else { "contratapa" };
    let Some(value) = field.as_deref().filter(|s| !s.trim().is_empty()) else {
        return;
    };
    let candidate = PathBuf::from(value);
    if !(candidate.is_absolute() && candidate.is_file()) {
        return;
    }
    let ext = candidate
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !COVER_EXTS.contains(&ext.as_str()) {
        let nombre = candidate.file_name().and_then(|n| n.to_str()).unwrap_or(value);
        summary.failed.push(format!(
            "{} \"{}\": formato de imagen no soportado, usá JPG o PNG",
            etiqueta, nombre
        ));
        *field = None;
        return;
    }
    let dest_name = format!("{}.{}", stem, ext);
    let dest = book_dir.join(&dest_name);
    if dest.exists() {
        *field = Some(dest_name);
        return;
    }
    match fs::copy(&candidate, &dest) {
        Ok(_) => {
            summary.copied_extras += 1;
            *field = Some(dest_name);
        }
        Err(e) => {
            summary
                .failed
                .push(format!("copiar {} {}: {}", etiqueta, candidate.display(), e));
            *field = None;
        }
    }
}

fn ensure_dir(p: &Path, summary: &mut ImportSummary) -> Result<(), String> {
    if p.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(p).map_err(|e| format!("mkdir {}: {}", p.display(), e))?;
    summary.created_dirs += 1;
    Ok(())
}

fn write_saga_json(dir: &Path, cfg: &SagaConfig) -> Result<(), String> {
    let path = dir.join("saga.json");
    let mut json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn write_book_json(dir: &Path, cfg: &BookConfig) -> Result<(), String> {
    let path = dir.join("book.json");
    let mut json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn handle_chapter(
    target_dir: &Path,
    ch: &ChapterImport,
    convert: bool,
    summary: &mut ImportSummary,
) {
    let src = PathBuf::from(&ch.source_path);
    if !src.is_file() {
        summary
            .failed
            .push(format!("falta source: {}", ch.source_path));
        return;
    }
    let src_ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    if convert && (src_ext == "docx" || src_ext == "odt") {
        match convert_to_html(&src, target_dir, &ch.target_name, ch) {
            Ok(()) => summary.converted_chapters += 1,
            Err(e) => summary.failed.push(format!("convertir {}: {}", ch.source_path, e)),
        }
    } else if src_ext == "html" {
        // Caso HTML existente: copiar tal cual + meta
        match copy_html_chapter(&src, target_dir, &ch.target_name, ch) {
            Ok(()) => summary.copied_chapters += 1,
            Err(e) => summary.failed.push(format!("copiar html {}: {}", ch.source_path, e)),
        }
    } else {
        // No convert: copiar el archivo crudo + meta apuntando a la ext original
        match copy_raw_chapter(&src, target_dir, &ch.target_name, &src_ext, ch) {
            Ok(()) => summary.copied_chapters += 1,
            Err(e) => summary.failed.push(format!("copiar {}: {}", ch.source_path, e)),
        }
    }
}

fn convert_to_html(
    src: &Path,
    target_dir: &Path,
    target_name: &str,
    ch: &ChapterImport,
) -> Result<(), String> {
    let html_out = target_dir.join(format!("{}.html", target_name));
    if html_out.exists() {
        return Err(format!("ya existe: {}", html_out.display()));
    }

    let output = Command::new(crate::import::pandoc_bin())
        .arg(src)
        .args(["--to=html5", "--no-highlight", "--wrap=none"])
        .output()
        .map_err(|e| format!("pandoc no encontrado: {} — instalá pandoc primero", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("pandoc falló (exit {})", output.status)
        } else {
            stderr
        });
    }
    let raw_html = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut cleaned = clean_html(&raw_html);
    if !cleaned.ends_with('\n') {
        cleaned.push('\n');
    }
    fs::write(&html_out, &cleaned).map_err(|e| e.to_string())?;
    write_chapter_meta(target_dir, target_name, ch, "imported")?;
    Ok(())
}

fn copy_html_chapter(
    src: &Path,
    target_dir: &Path,
    target_name: &str,
    ch: &ChapterImport,
) -> Result<(), String> {
    let dest = target_dir.join(format!("{}.html", target_name));
    if dest.exists() {
        return Err(format!("ya existe: {}", dest.display()));
    }
    fs::copy(src, &dest).map_err(|e| e.to_string())?;
    write_chapter_meta(target_dir, target_name, ch, "imported")?;
    Ok(())
}

fn copy_raw_chapter(
    src: &Path,
    target_dir: &Path,
    target_name: &str,
    ext: &str,
    ch: &ChapterImport,
) -> Result<(), String> {
    let dest = target_dir.join(format!("{}.{}", target_name, ext));
    if dest.exists() {
        return Err(format!("ya existe: {}", dest.display()));
    }
    fs::copy(src, &dest).map_err(|e| e.to_string())?;
    write_chapter_meta(target_dir, target_name, ch, "raw")?;
    Ok(())
}

fn write_chapter_meta(
    target_dir: &Path,
    target_name: &str,
    ch: &ChapterImport,
    status: &str,
) -> Result<(), String> {
    let meta_path = target_dir.join(format!("{}.meta.json", target_name));
    if meta_path.exists() {
        return Ok(());
    }
    let titulo = if ch.titulo.trim().is_empty() {
        target_name.to_string()
    } else {
        ch.titulo.clone()
    };
    let orden = if ch.orden == 0 {
        target_name.parse::<u32>().unwrap_or(0)
    } else {
        ch.orden
    };
    let meta = serde_json::json!({
        "orden": orden,
        "titulo": titulo,
        "status": status,
        "idioma": ch.idioma,
    });
    fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap_or_default())
        .map_err(|e| e.to_string())
}

fn handle_extra(target_dir: &Path, x: &ExtraImport, summary: &mut ImportSummary) {
    let src = PathBuf::from(&x.source_path);
    if !src.is_file() {
        summary
            .failed
            .push(format!("falta extra: {}", x.source_path));
        return;
    }
    let dest = target_dir.join(&x.relative_dest);
    if let Some(parent) = dest.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            summary
                .failed
                .push(format!("mkdir {}: {}", parent.display(), e));
            return;
        }
    }
    if dest.exists() {
        summary
            .failed
            .push(format!("ya existe: {}", dest.display()));
        return;
    }
    match fs::copy(&src, &dest) {
        Ok(_) => summary.copied_extras += 1,
        Err(e) => summary.failed.push(format!("copiar {}: {}", x.source_path, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn unique_tmp(prefix: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("twriter-{}-{}-{}", prefix, pid, n));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("crear tmp");
        dir
    }

    fn touch(p: &Path) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(p, b"x").expect("write");
    }

    #[test]
    fn scan_book_classifies_no_chapter_folder_as_extras_with_subpath() {
        let root = unique_tmp("scanbook");
        touch(&root.join("cap1.docx"));
        touch(&root.join("section_a").join("c1.docx"));
        touch(&root.join("sin_caps").join("foo.jpg"));
        touch(&root.join("sin_caps").join("sub").join("bar.epub"));
        touch(&root.join("notas.txt"));

        let node = scan_book(&root).expect("scan_book");
        let (sections, extras) = match node {
            SourceNode::Book {
                sections, extras, ..
            } => (sections, extras),
            _ => panic!("debería ser Book"),
        };

        assert_eq!(sections.len(), 1, "solo section_a debería ser section");
        match &sections[0] {
            SourceNode::Section { name, .. } => assert_eq!(name, "section_a"),
            _ => panic!("debería ser Section"),
        }

        let foo = extras
            .iter()
            .find(|f| f.name == "foo")
            .expect("foo en extras");
        assert_eq!(foo.subpath.as_deref(), Some("sin_caps"));
        assert_eq!(foo.ext, "jpg");

        let bar = extras
            .iter()
            .find(|f| f.name == "bar")
            .expect("bar en extras");
        assert_eq!(bar.subpath.as_deref(), Some("sin_caps/sub"));
        assert_eq!(bar.ext, "epub");

        let notas = extras
            .iter()
            .find(|f| f.name == "notas")
            .expect("notas en extras (suelto)");
        assert!(notas.subpath.is_none(), "archivo suelto sin subpath");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_section_treats_subdirs_as_extras_with_subpath() {
        let root = unique_tmp("scansection");
        let book = root.join("book");
        let sec = book.join("section_a");
        touch(&sec.join("1.odt"));
        touch(&sec.join("2.odt"));
        touch(&sec.join("convertidos").join("1_convertido.odt"));
        touch(&sec.join("convertidos").join("1_convertido.log.txt"));
        touch(&sec.join("original").join("section_a.odt"));

        let node = scan_book(&book).expect("scan_book");
        let sections = match node {
            SourceNode::Book { sections, .. } => sections,
            _ => panic!("debería ser Book"),
        };
        assert_eq!(sections.len(), 1);
        let (chapters, extras) = match &sections[0] {
            SourceNode::Section {
                chapters, extras, ..
            } => (chapters, extras),
            _ => panic!("debería ser Section"),
        };
        assert_eq!(chapters.len(), 2, "1.odt y 2.odt como caps");

        let conv_odt = extras
            .iter()
            .find(|f| f.name == "1_convertido" && f.ext == "odt")
            .expect("convertido odt en extras");
        assert_eq!(conv_odt.subpath.as_deref(), Some("convertidos"));

        let orig = extras
            .iter()
            .find(|f| f.name == "section_a" && f.ext == "odt")
            .expect("original section_a.odt en extras");
        assert_eq!(orig.subpath.as_deref(), Some("original"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_cover_image_rechaza_extension_no_soportada_sin_tocar_el_campo() {
        let root = unique_tmp("cover-webp");
        let source = root.join("mi tapa.webp");
        touch(&source);
        let book_dir = root.join("book");
        fs::create_dir_all(&book_dir).expect("mkdir book_dir");

        let mut field = Some(source.to_string_lossy().to_string());
        let mut summary = ImportSummary::default();
        resolve_cover_image(&mut field, "cover", &book_dir, &mut summary);

        // ...el campo queda limpio, así el book.json no referencia un archivo
        // que el EPUB no puede decodificar...
        assert_eq!(field, None, "el field no debe quedar apuntando al webp");
        // ...y el archivo no se copió al book_dir.
        assert!(
            !book_dir.join("cover.webp").exists(),
            "el webp no debe copiarse al book_dir"
        );
        // ...y el autor se entera del motivo, en español, con el nombre del
        // archivo y los formatos que sí andan.
        assert_eq!(summary.failed.len(), 1);
        assert!(summary.failed[0].contains("mi tapa.webp"), "el mensaje: {}", summary.failed[0]);
        assert!(summary.failed[0].contains("JPG"), "el mensaje: {}", summary.failed[0]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_cover_image_acepta_png_copia_y_reescribe_el_campo_a_relativo() {
        let root = unique_tmp("cover-png");
        let source = root.join("mi tapa.png");
        touch(&source);
        let book_dir = root.join("book");
        fs::create_dir_all(&book_dir).expect("mkdir book_dir");

        let mut field = Some(source.to_string_lossy().to_string());
        let mut summary = ImportSummary::default();
        resolve_cover_image(&mut field, "cover", &book_dir, &mut summary);

        assert!(book_dir.join("cover.png").is_file(), "la copia sí debe existir en disco");
        assert_eq!(field.as_deref(), Some("cover.png"));
        assert!(summary.failed.is_empty());
        assert_eq!(summary.copied_extras, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_cover_image_copia_fallida_no_deja_el_campo_escrito() {
        // Discrimina el bug del finding: si `fs::copy` falla, `field` no
        // puede quedar apuntando a "cover.png" — ese archivo nunca llegó a
        // existir en el book_dir, y persistir la referencia deja el
        // book.json roto (mismo problema que un `write_book_json` corrido
        // antes de intentar la copia).
        let root = unique_tmp("cover-copy-fails");
        let source = root.join("mi tapa.png");
        touch(&source);
        // book_dir NO se crea: fs::copy falla porque el destino no tiene
        // directorio padre en disco.
        let book_dir = root.join("book-inexistente");

        let mut field = Some(source.to_string_lossy().to_string());
        let mut summary = ImportSummary::default();
        resolve_cover_image(&mut field, "cover", &book_dir, &mut summary);

        assert_eq!(field, None, "una copia fallida no debe dejar el field escrito");
        assert_eq!(summary.copied_extras, 0);
        assert_eq!(summary.failed.len(), 1, "el fallo se reporta, no se traga");
        assert!(summary.failed[0].contains("copiar"), "el mensaje: {}", summary.failed[0]);

        let _ = fs::remove_dir_all(&root);
    }
}
