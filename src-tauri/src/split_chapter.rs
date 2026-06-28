use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::import::{clean_html, inherit_idioma};

#[derive(Serialize, Debug, Clone)]
pub struct HtmlBlock {
    pub id: usize,
    pub html: String,
    pub is_candidate: bool,
    pub candidate_reason: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct SplitPreview {
    pub blocks: Vec<HtmlBlock>,
    pub default_folder_name: String,
    pub idioma: Option<String>,
    pub source_path: String,
}

#[derive(Deserialize, Debug)]
pub struct SplitPlan {
    pub source_path: String,
    pub folder_name: String,
    /// Índices de inicio de las partes 2..N (la parte 1 siempre arranca en 0).
    /// Lista vacía = el capítulo queda como una sola parte.
    pub split_indices: Vec<usize>,
    pub idioma: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct SplitResult {
    pub folder_created: String,
    pub parts_written: usize,
    pub original_archived_to: String,
}

#[tauri::command]
pub async fn split_chapter_preview(path: String) -> Result<SplitPreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_impl(&path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

#[tauri::command]
pub async fn split_chapter_apply(plan: SplitPlan) -> Result<SplitResult, String> {
    tauri::async_runtime::spawn_blocking(move || apply_impl(plan))
        .await
        .map_err(|e| format!("task: {}", e))?
}

/// Lista los paths de las partes (`<N>.html` con stem numérico) dentro de
/// un folder, ordenados por número ascendente. Usado por el botón
/// "Aplicar RAE a partes" para iterar las partes recién creadas.
#[tauri::command]
pub async fn list_part_paths(folder: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&folder);
        if !dir.is_dir() {
            return Err(format!("no es directorio: {}", folder));
        }
        let mut parts: Vec<(u32, String)> = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let p = entry.map_err(|e| e.to_string())?.path();
            if p.extension().and_then(|e| e.to_str()) != Some("html") {
                continue;
            }
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                if let Ok(n) = stem.parse::<u32>() {
                    parts.push((n, p.to_string_lossy().into_owned()));
                }
            }
        }
        parts.sort_by_key(|(n, _)| *n);
        Ok(parts.into_iter().map(|(_, p)| p).collect())
    })
    .await
    .map_err(|e| format!("task: {}", e))?
}

fn preview_impl(path: &str) -> Result<SplitPreview, String> {
    let src = PathBuf::from(path);
    if !src.is_file() {
        return Err(format!("no es archivo: {}", path));
    }
    let html = load_as_cleaned_html(&src)?;
    let blocks = parse_blocks(&html);
    let parent = src
        .parent()
        .ok_or_else(|| "sin carpeta padre".to_string())?;
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let meta_path = parent.join(format!("{}.meta.json", stem));
    let (titulo, idioma) = read_meta_fields(&meta_path);
    let default_folder_name = if !titulo.trim().is_empty() {
        titulo
    } else {
        stem.to_string()
    };
    let idioma = idioma.or_else(|| inherit_idioma(parent));
    Ok(SplitPreview {
        blocks,
        default_folder_name,
        idioma,
        source_path: path.to_string(),
    })
}

fn apply_impl(plan: SplitPlan) -> Result<SplitResult, String> {
    let src = PathBuf::from(&plan.source_path);
    if !src.is_file() {
        return Err(format!("no es archivo: {}", plan.source_path));
    }
    let parent = src
        .parent()
        .ok_or_else(|| "sin carpeta padre".to_string())?;
    let folder_name = plan.folder_name.trim();
    if folder_name.is_empty() {
        return Err("nombre de carpeta vacío".to_string());
    }
    if folder_name.contains('/') || folder_name.contains('\\') {
        return Err("nombre de carpeta no puede contener / o \\".to_string());
    }
    let folder = parent.join(folder_name);
    if folder.exists() {
        return Err(format!("ya existe: {}", folder.display()));
    }

    let html = load_as_cleaned_html(&src)?;
    let blocks = parse_blocks(&html);
    let parts = compute_parts(&blocks, &plan.split_indices)?;
    let parts = strip_label_blocks(parts);
    let idioma = plan.idioma.clone().or_else(|| inherit_idioma(parent));

    fs::create_dir(&folder).map_err(|e| format!("crear carpeta: {}", e))?;

    let parts_written = match write_parts(&folder, &parts, idioma.as_deref()) {
        Ok(n) => n,
        Err(e) => {
            let _ = fs::remove_dir_all(&folder);
            return Err(e);
        }
    };

    let originales_dir = parent.join("_originales");
    fs::create_dir_all(&originales_dir).map_err(|e| format!("crear _originales: {}", e))?;
    let archived = archive_to_originales(&src, &originales_dir)?;

    tracing::info!(
        target: "split_chapter",
        from = %plan.source_path,
        to = %folder.display(),
        parts = parts_written,
        "capítulo dividido"
    );

    Ok(SplitResult {
        folder_created: folder.to_string_lossy().into_owned(),
        parts_written,
        original_archived_to: archived.to_string_lossy().into_owned(),
    })
}

fn write_parts(folder: &Path, parts: &[Vec<String>], idioma: Option<&str>) -> Result<usize, String> {
    for (i, part_blocks) in parts.iter().enumerate() {
        let n = (i + 1) as u32;
        let mut content = part_blocks.join("\n");
        if content.trim().is_empty() {
            content = "<p></p>".to_string();
        }
        if !content.ends_with('\n') {
            content.push('\n');
        }
        let html_path = folder.join(format!("{}.html", n));
        fs::write(&html_path, &content)
            .map_err(|e| format!("escribir {}: {}", html_path.display(), e))?;

        let meta = serde_json::json!({
            "orden": n,
            "titulo": n.to_string(),
            "status": "imported",
            "idioma": idioma,
        });
        let meta_path = folder.join(format!("{}.meta.json", n));
        fs::write(
            &meta_path,
            serde_json::to_string_pretty(&meta).unwrap_or_default(),
        )
        .map_err(|e| format!("escribir {}: {}", meta_path.display(), e))?;

        crate::search::index_path_best_effort(&html_path.to_string_lossy(), "chapter");
    }
    Ok(parts.len())
}

fn load_as_cleaned_html(src: &Path) -> Result<String, String> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "docx" | "odt" => pandoc_to_html(src),
        "html" => {
            let raw = fs::read_to_string(src).map_err(|e| e.to_string())?;
            Ok(clean_html(&raw))
        }
        other => Err(format!("formato no soportado: .{}", other)),
    }
}

fn pandoc_to_html(src: &Path) -> Result<String, String> {
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
    Ok(clean_html(&raw_html))
}

fn read_meta_fields(meta_path: &Path) -> (String, Option<String>) {
    if !meta_path.is_file() {
        return (String::new(), None);
    }
    let raw = match fs::read_to_string(meta_path) {
        Ok(s) => s,
        Err(_) => return (String::new(), None),
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return (String::new(), None),
    };
    let titulo = v
        .get("titulo")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let idioma = v
        .get("idioma")
        .and_then(|x| x.as_str())
        .map(String::from);
    (titulo, idioma)
}

fn parse_blocks(html: &str) -> Vec<HtmlBlock> {
    let re = regex::Regex::new(r"(?i)</p>|</h1>|</h2>|</h3>|</blockquote>|<hr\b[^>]*/?>").unwrap();
    let mut blocks = Vec::new();
    let mut prev_end = 0usize;
    for m in re.find_iter(html) {
        let end = m.end();
        let chunk = html[prev_end..end].trim();
        if !chunk.is_empty() {
            let reason = detect_candidate(chunk);
            blocks.push(HtmlBlock {
                id: blocks.len(),
                html: chunk.to_string(),
                is_candidate: reason.is_some(),
                candidate_reason: reason,
            });
        }
        prev_end = end;
    }
    let trailing = html[prev_end..].trim();
    if !trailing.is_empty() {
        let reason = detect_candidate(trailing);
        blocks.push(HtmlBlock {
            id: blocks.len(),
            html: trailing.to_string(),
            is_candidate: reason.is_some(),
            candidate_reason: reason,
        });
    }
    blocks
}

fn detect_candidate(block: &str) -> Option<String> {
    let trimmed = block.trim_start();
    if trimmed.starts_with("<h1") {
        return Some("heading-1".to_string());
    }
    if trimmed.starts_with("<h2") {
        return Some("heading-2".to_string());
    }
    if trimmed.starts_with("<hr") {
        return Some("hr".to_string());
    }
    if trimmed.starts_with("<p") {
        let text = strip_tags(trimmed);
        let t = text.trim();
        let word_count = t.split_whitespace().count();
        if word_count > 0 && word_count <= 3 {
            let re =
                regex::Regex::new(r"(?i)^(parte\s+)?[ivxlcdm\d]+\s*\.?\s*$").unwrap();
            if re.is_match(t) {
                return Some("short-numeric".to_string());
            }
        }
    }
    None
}

fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }
    out
}

fn compute_parts(
    blocks: &[HtmlBlock],
    split_indices: &[usize],
) -> Result<Vec<Vec<String>>, String> {
    let n = blocks.len();
    if n == 0 {
        return Err("capítulo vacío".to_string());
    }
    let mut prev = 0usize;
    for &idx in split_indices {
        if idx == 0 {
            return Err("split en índice 0 no permitido (parte vacía)".to_string());
        }
        if idx >= n {
            return Err(format!(
                "split en índice {} fuera de rango (max {})",
                idx,
                n - 1
            ));
        }
        if idx <= prev {
            return Err("índices de split deben ser crecientes".to_string());
        }
        prev = idx;
    }
    let mut parts: Vec<Vec<String>> = Vec::new();
    let mut start = 0usize;
    for &idx in split_indices {
        parts.push(blocks[start..idx].iter().map(|b| b.html.clone()).collect());
        start = idx;
    }
    parts.push(blocks[start..].iter().map(|b| b.html.clone()).collect());
    Ok(parts)
}

/// Limpia bloques redundantes al inicio de cada parte: títulos sueltos
/// (solo en parte 1) y labels numéricos tipo "1" / "Parte 2" / "III" (en
/// cualquier parte). El título del capítulo vive en el folder name; el
/// número de parte vive en el filename. Mantener esos bloques duplica
/// información y suele ser ruido heredado del docx/odt original.
fn strip_label_blocks(mut parts: Vec<Vec<String>>) -> Vec<Vec<String>> {
    for (part_idx, blocks) in parts.iter_mut().enumerate() {
        if blocks.is_empty() {
            continue;
        }
        // Rule A — solo parte 1: strip primer bloque si parece título.
        if part_idx == 0 && looks_like_title_block(&blocks[0]) {
            blocks.remove(0);
        }
        // Rule B — cualquier parte: strip primer bloque short-numeric.
        if !blocks.is_empty()
            && detect_candidate(&blocks[0]).as_deref() == Some("short-numeric")
        {
            blocks.remove(0);
        }
    }
    parts
}

fn looks_like_title_block(block: &str) -> bool {
    let t = block.trim_start();
    if t.starts_with("<h1") || t.starts_with("<h2") || t.starts_with("<h3") {
        return true;
    }
    if !t.starts_with("<p") {
        return false;
    }
    let text = strip_tags(t);
    let inner = text.trim();
    let wc = inner.split_whitespace().count();
    if wc == 0 || wc > 4 {
        return false;
    }
    // Si ya matchea short-numeric, NO contar como título — lo agarra Rule B.
    let re = regex::Regex::new(r"(?i)^(parte\s+)?[ivxlcdm\d]+\s*\.?\s*$").unwrap();
    !re.is_match(inner)
}

fn archive_to_originales(src: &Path, originales_dir: &Path) -> Result<PathBuf, String> {
    let filename = src
        .file_name()
        .ok_or_else(|| "sin filename".to_string())?
        .to_owned();
    let dest = unique_path(originales_dir, &filename)?;
    move_file(src, &dest)?;

    let parent = src.parent().ok_or_else(|| "sin padre".to_string())?;
    let src_stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let meta = parent.join(format!("{}.meta.json", src_stem));
    if meta.is_file() {
        let dest_stem = dest
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(src_stem);
        let meta_dest = originales_dir.join(format!("{}.meta.json", dest_stem));
        if !meta_dest.exists() {
            let _ = move_file(&meta, &meta_dest);
        }
    }
    Ok(dest)
}

fn move_file(src: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("destino ya existe: {}", dest.display()));
    }
    if fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    fs::copy(src, dest).map_err(|e| {
        format!(
            "copiar {} → {}: {}",
            src.display(),
            dest.display(),
            e
        )
    })?;
    fs::remove_file(src).map_err(|e| format!("borrar {}: {}", src.display(), e))?;
    Ok(())
}

fn unique_path(dir: &Path, filename: &std::ffi::OsString) -> Result<PathBuf, String> {
    let base = dir.join(filename);
    if !base.exists() {
        return Ok(base);
    }
    let filename_path = Path::new(filename);
    let stem = filename_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let ext = filename_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    for i in 2..1000 {
        let candidate = if ext.is_empty() {
            dir.join(format!("{}-{}", stem, i))
        } else {
            dir.join(format!("{}-{}.{}", stem, i, ext))
        };
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "no se pudo encontrar nombre libre para {}",
        filename.to_string_lossy()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parse_blocks_simple_paragraphs() {
        let html = "<p>foo</p><p>bar</p>";
        let blocks = parse_blocks(html);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].html, "<p>foo</p>");
        assert_eq!(blocks[1].html, "<p>bar</p>");
    }

    #[test]
    fn parse_blocks_with_newlines() {
        let html = "<p>foo</p>\n<p>bar</p>\n<hr class=\"scene-break\"/>";
        let blocks = parse_blocks(html);
        assert_eq!(blocks.len(), 3);
    }

    #[test]
    fn parse_blocks_h1_h2_hr() {
        let html = "<h1>One</h1><p>x</p><h2>Two</h2><p>y</p><hr/>";
        let blocks = parse_blocks(html);
        assert_eq!(blocks.len(), 5);
        assert_eq!(blocks[0].candidate_reason.as_deref(), Some("heading-1"));
        assert_eq!(blocks[2].candidate_reason.as_deref(), Some("heading-2"));
        assert_eq!(blocks[4].candidate_reason.as_deref(), Some("hr"));
    }

    #[test]
    fn detect_short_numeric_candidates() {
        assert_eq!(detect_candidate("<p>1</p>").as_deref(), Some("short-numeric"));
        assert_eq!(detect_candidate("<p>Parte 2</p>").as_deref(), Some("short-numeric"));
        assert_eq!(detect_candidate("<p>III</p>").as_deref(), Some("short-numeric"));
        assert_eq!(detect_candidate("<p>1.</p>").as_deref(), Some("short-numeric"));
    }

    #[test]
    fn detect_non_candidates() {
        assert_eq!(detect_candidate("<p>Capítulo uno aquí</p>"), None);
        assert_eq!(
            detect_candidate("<p>Largo párrafo con muchas palabras aquí.</p>"),
            None
        );
        assert_eq!(detect_candidate("<p>foo</p>"), None);
    }

    fn fake_blocks(n: usize) -> Vec<HtmlBlock> {
        (0..n)
            .map(|i| HtmlBlock {
                id: i,
                html: format!("<p>{}</p>", i),
                is_candidate: false,
                candidate_reason: None,
            })
            .collect()
    }

    #[test]
    fn compute_parts_basic() {
        let blocks = fake_blocks(6);
        let parts = compute_parts(&blocks, &[2, 4]).unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], vec!["<p>0</p>", "<p>1</p>"]);
        assert_eq!(parts[1], vec!["<p>2</p>", "<p>3</p>"]);
        assert_eq!(parts[2], vec!["<p>4</p>", "<p>5</p>"]);
    }

    #[test]
    fn compute_parts_no_split_single_part() {
        let blocks = fake_blocks(3);
        let parts = compute_parts(&blocks, &[]).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].len(), 3);
    }

    #[test]
    fn compute_parts_rejects_index_zero() {
        let blocks = fake_blocks(3);
        assert!(compute_parts(&blocks, &[0]).is_err());
    }

    #[test]
    fn compute_parts_rejects_out_of_range() {
        let blocks = fake_blocks(3);
        assert!(compute_parts(&blocks, &[3]).is_err());
        assert!(compute_parts(&blocks, &[5]).is_err());
    }

    #[test]
    fn compute_parts_rejects_non_increasing() {
        let blocks = fake_blocks(5);
        assert!(compute_parts(&blocks, &[2, 2]).is_err());
        assert!(compute_parts(&blocks, &[3, 1]).is_err());
    }

    #[test]
    fn apply_html_source_creates_folder_parts_and_archives() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path();
        let src = parent.join("1.html");
        // Párrafos suficientemente largos para no ser confundidos con título
        // por strip_label_blocks (>4 palabras cada uno).
        fs::write(
            &src,
            "<p>Aedan caminaba por el bosque oscuro de Selas.</p>\n\
             <p>La caballera estaba dormida sobre su pecho.</p>\n\
             <p>El alquimista preparaba el desayuno tranquilamente.</p>\n",
        )
        .unwrap();
        let meta = parent.join("1.meta.json");
        fs::write(
            &meta,
            r#"{"orden":1,"titulo":"1 - Test","status":"raw","idioma":"es"}"#,
        )
        .unwrap();
        fs::write(
            parent.join("book.json"),
            r#"{"titulo":"Libro","idioma":"es"}"#,
        )
        .unwrap();

        let plan = SplitPlan {
            source_path: src.to_string_lossy().into_owned(),
            folder_name: "1 - Test".to_string(),
            split_indices: vec![1],
            idioma: Some("es".to_string()),
        };
        let result = apply_impl(plan).unwrap();
        assert_eq!(result.parts_written, 2);
        assert!(parent.join("1 - Test/1.html").exists());
        assert!(parent.join("1 - Test/1.meta.json").exists());
        assert!(parent.join("1 - Test/2.html").exists());
        assert!(parent.join("1 - Test/2.meta.json").exists());
        assert!(parent.join("_originales/1.html").exists());
        assert!(parent.join("_originales/1.meta.json").exists());
        assert!(!src.exists());

        let p1 = fs::read_to_string(parent.join("1 - Test/1.html")).unwrap();
        assert!(p1.contains("Aedan caminaba"));
        assert!(!p1.contains("caballera estaba"));

        let m1_raw = fs::read_to_string(parent.join("1 - Test/1.meta.json")).unwrap();
        let m1: serde_json::Value = serde_json::from_str(&m1_raw).unwrap();
        assert_eq!(m1["orden"].as_u64(), Some(1));
        assert_eq!(m1["titulo"].as_str(), Some("1"));
        assert_eq!(m1["status"].as_str(), Some("imported"));
        assert_eq!(m1["idioma"].as_str(), Some("es"));
    }

    // ───── Tests de strip_label_blocks ─────

    #[test]
    fn strips_pandoc_paragraph_title_and_numeric_label_part_1() {
        // Caso real de Princesa: <p>Realeza</p>\n<p>1</p>\n<p>cuerpo...</p>
        let blocks = vec![
            HtmlBlock {
                id: 0,
                html: "<p>Realeza</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
            HtmlBlock {
                id: 1,
                html: "<p>1</p>".to_string(),
                is_candidate: true,
                candidate_reason: Some("short-numeric".to_string()),
            },
            HtmlBlock {
                id: 2,
                html: "<p>Yiri venía caminando a su lado por el bosque.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
        ];
        let parts = compute_parts(&blocks, &[]).unwrap();
        let cleaned = strip_label_blocks(parts);
        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned[0].len(), 1);
        assert!(cleaned[0][0].contains("Yiri venía caminando"));
    }

    #[test]
    fn strips_numeric_label_at_start_of_part_2_onward() {
        let blocks = vec![
            HtmlBlock {
                id: 0,
                html: "<p>Realeza</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
            HtmlBlock {
                id: 1,
                html: "<p>1</p>".to_string(),
                is_candidate: true,
                candidate_reason: Some("short-numeric".to_string()),
            },
            HtmlBlock {
                id: 2,
                html: "<p>Contenido largo de la primera parte aquí.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
            HtmlBlock {
                id: 3,
                html: "<p>2</p>".to_string(),
                is_candidate: true,
                candidate_reason: Some("short-numeric".to_string()),
            },
            HtmlBlock {
                id: 4,
                html: "<p>Contenido largo de la segunda parte aquí.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
        ];
        let parts = compute_parts(&blocks, &[3]).unwrap();
        let cleaned = strip_label_blocks(parts);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[0].len(), 1);
        assert!(cleaned[0][0].contains("primera parte"));
        assert_eq!(cleaned[1].len(), 1);
        assert!(cleaned[1][0].contains("segunda parte"));
    }

    #[test]
    fn strips_h1_title_from_part_1() {
        let blocks = vec![
            HtmlBlock {
                id: 0,
                html: "<h1>Capítulo 1</h1>".to_string(),
                is_candidate: true,
                candidate_reason: Some("heading-1".to_string()),
            },
            HtmlBlock {
                id: 1,
                html: "<p>Cuerpo del capítulo de prueba.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
        ];
        let parts = compute_parts(&blocks, &[]).unwrap();
        let cleaned = strip_label_blocks(parts);
        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned[0].len(), 1);
        assert!(cleaned[0][0].contains("Cuerpo del capítulo"));
    }

    #[test]
    fn strips_two_word_paragraph_title() {
        let blocks = vec![
            HtmlBlock {
                id: 0,
                html: "<p>Laguna Escondida</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
            HtmlBlock {
                id: 1,
                html: "<p>Contenido largo del capítulo aquí.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
        ];
        let parts = compute_parts(&blocks, &[]).unwrap();
        let cleaned = strip_label_blocks(parts);
        assert_eq!(cleaned[0].len(), 1);
        assert!(cleaned[0][0].contains("Contenido largo"));
    }

    #[test]
    fn keeps_long_paragraph_in_part_1() {
        let blocks = vec![
            HtmlBlock {
                id: 0,
                html: "<p>El sol caía sobre el horizonte como una moneda de cobre.</p>"
                    .to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
            HtmlBlock {
                id: 1,
                html: "<p>Más contenido aquí mismo.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
        ];
        let parts = compute_parts(&blocks, &[]).unwrap();
        let cleaned = strip_label_blocks(parts);
        assert_eq!(cleaned[0].len(), 2);
        assert!(cleaned[0][0].contains("El sol caía"));
    }

    #[test]
    fn keeps_short_paragraph_in_part_2() {
        // Rule A no aplica fuera de parte 1: un párrafo corto no numérico al
        // arrancar parte 2 se considera contenido legítimo (scene-setter).
        let blocks = vec![
            HtmlBlock {
                id: 0,
                html: "<p>Contenido largo de parte 1 aquí.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
            HtmlBlock {
                id: 1,
                html: "<p>Tres días después.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
            HtmlBlock {
                id: 2,
                html: "<p>Resto del contenido de parte 2.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
        ];
        let parts = compute_parts(&blocks, &[1]).unwrap();
        let cleaned = strip_label_blocks(parts);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[1].len(), 2);
        assert!(cleaned[1][0].contains("Tres días"));
    }

    #[test]
    fn roman_numeral_stripped_anywhere() {
        let blocks = vec![
            HtmlBlock {
                id: 0,
                html: "<p>Contenido largo de parte 1 aquí mismo.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
            HtmlBlock {
                id: 1,
                html: "<p>III</p>".to_string(),
                is_candidate: true,
                candidate_reason: Some("short-numeric".to_string()),
            },
            HtmlBlock {
                id: 2,
                html: "<p>Contenido largo de parte 2 aquí mismo.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
        ];
        let parts = compute_parts(&blocks, &[1]).unwrap();
        let cleaned = strip_label_blocks(parts);
        assert_eq!(cleaned[1].len(), 1);
        assert!(cleaned[1][0].contains("parte 2"));
    }

    #[test]
    fn bold_title_stripped() {
        let blocks = vec![
            HtmlBlock {
                id: 0,
                html: "<p><strong>Realeza</strong></p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
            HtmlBlock {
                id: 1,
                html: "<p>Contenido del capítulo va acá.</p>".to_string(),
                is_candidate: false,
                candidate_reason: None,
            },
        ];
        let parts = compute_parts(&blocks, &[]).unwrap();
        let cleaned = strip_label_blocks(parts);
        assert_eq!(cleaned[0].len(), 1);
        assert!(cleaned[0][0].contains("Contenido"));
    }

    #[test]
    fn empty_part_after_strip_gets_placeholder() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path();
        let src = parent.join("1.html");
        // Parte 1 = solo título + número, nada de cuerpo → tras strip queda vacía
        // y debe escribirse como <p></p>\n
        fs::write(
            &src,
            "<p>Realeza</p>\n<p>1</p>\n<p>Contenido largo de la parte dos acá.</p>\n",
        )
        .unwrap();

        let plan = SplitPlan {
            source_path: src.to_string_lossy().into_owned(),
            folder_name: "1 - Empty".to_string(),
            split_indices: vec![2],
            idioma: Some("es".to_string()),
        };
        let result = apply_impl(plan).unwrap();
        assert_eq!(result.parts_written, 2);
        let p1 = fs::read_to_string(parent.join("1 - Empty/1.html")).unwrap();
        assert_eq!(p1.trim(), "<p></p>");
        let p2 = fs::read_to_string(parent.join("1 - Empty/2.html")).unwrap();
        assert!(p2.contains("Contenido largo"));
    }

    #[test]
    fn apply_rejects_existing_folder() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path();
        let src = parent.join("1.html");
        fs::write(&src, "<p>uno</p>").unwrap();
        fs::create_dir(parent.join("1 - Test")).unwrap();

        let plan = SplitPlan {
            source_path: src.to_string_lossy().into_owned(),
            folder_name: "1 - Test".to_string(),
            split_indices: vec![],
            idioma: None,
        };
        let result = apply_impl(plan);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("ya existe"));
    }

    #[test]
    fn apply_rejects_empty_folder_name() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path();
        let src = parent.join("1.html");
        fs::write(&src, "<p>uno</p>").unwrap();

        let plan = SplitPlan {
            source_path: src.to_string_lossy().into_owned(),
            folder_name: "   ".to_string(),
            split_indices: vec![],
            idioma: None,
        };
        assert!(apply_impl(plan).is_err());
    }

    #[test]
    fn apply_rejects_path_separator_in_folder_name() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path();
        let src = parent.join("1.html");
        fs::write(&src, "<p>uno</p>").unwrap();

        let plan = SplitPlan {
            source_path: src.to_string_lossy().into_owned(),
            folder_name: "evil/path".to_string(),
            split_indices: vec![],
            idioma: None,
        };
        assert!(apply_impl(plan).is_err());
    }

    #[test]
    fn archive_handles_filename_collision() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path();
        let src = parent.join("1.html");
        fs::write(&src, "<p>uno</p>").unwrap();
        let originales = parent.join("_originales");
        fs::create_dir(&originales).unwrap();
        fs::write(originales.join("1.html"), "existing").unwrap();

        let archived = archive_to_originales(&src, &originales).unwrap();
        assert_eq!(
            archived.file_name().unwrap().to_str().unwrap(),
            "1-2.html"
        );
        assert!(!src.exists());
    }

    #[test]
    fn preview_html_source() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path();
        let src = parent.join("1.html");
        fs::write(&src, "<p>foo</p><p>1</p><p>bar</p>").unwrap();
        let meta = parent.join("1.meta.json");
        fs::write(
            &meta,
            r#"{"orden":1,"titulo":"1 - Shin - 1","status":"raw","idioma":"es"}"#,
        )
        .unwrap();

        let preview = preview_impl(&src.to_string_lossy()).unwrap();
        assert_eq!(preview.blocks.len(), 3);
        assert!(!preview.blocks[0].is_candidate);
        assert!(preview.blocks[1].is_candidate);
        assert_eq!(
            preview.blocks[1].candidate_reason.as_deref(),
            Some("short-numeric")
        );
        assert_eq!(preview.default_folder_name, "1 - Shin - 1");
        assert_eq!(preview.idioma.as_deref(), Some("es"));
    }
}
