use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

use crate::book_config::{find_back_cover_in, find_cover_in, BookConfig};
use crate::fs::is_excluded_dir;
use crate::theme::{resolve_theme, FontEmbed, ResolvedTheme};

#[derive(Serialize, Debug)]
pub struct ExportResult {
    pub epub_path: String,
    pub chapters: u32,
}

#[derive(Serialize, Debug, Clone)]
pub struct ExportEntry {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
}

#[tauri::command]
pub fn list_exports(book_path: String) -> Result<Vec<ExportEntry>, String> {
    let dir = PathBuf::from(&book_path).join("Exportados");
    if !dir.is_dir() {
        // Fallback al nombre viejo "exports" para libros pre-rename.
        let legacy = PathBuf::from(&book_path).join("exports");
        if legacy.is_dir() {
            return read_export_dir(&legacy);
        }
        return Ok(Vec::new());
    }
    read_export_dir(&dir)
}

fn read_export_dir(dir: &Path) -> Result<Vec<ExportEntry>, String> {
    let mut out: Vec<ExportEntry> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if ext != "epub" {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let meta = fs::metadata(&path).ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_ms = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        out.push(ExportEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            size_bytes,
            modified_ms,
        });
    }
    out.sort_by(|a, b| b.modified_ms.unwrap_or(0).cmp(&a.modified_ms.unwrap_or(0)));
    Ok(out)
}

const CSS_TEMPLATE: &str = include_str!("epub_style.css");

fn page_rule_for(template: &str, override_margin: Option<&str>) -> String {
    let (size, default_margin) = match template {
        "5x8" => ("5in 8in", "0.4in"),
        "a5" => ("A5", "12mm"),
        _ => ("6in 9in", "0.5in"),
    };
    let margin = override_margin
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(default_margin);
    format!("@page {{ size: {}; margin: {}; }}", size, margin)
}

fn build_font_face_block(fonts: &[FontEmbed]) -> String {
    if fonts.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for f in fonts {
        // Match Reedsy CSS exactamente: keywords (normal/bold), sin format().
        // KFX converter de Kindle valida estricto y rechaza format() inesperado.
        let weight = if f.weight >= 700 { "bold" } else { "normal" };
        out.push_str(&format!(
            "@font-face {{\n  font-family: \"{}\";\n  font-style: {};\n  font-weight: {};\n  src: url(\"fonts/{}\");\n}}\n",
            f.family, f.style, weight, f.filename,
        ));
    }
    out
}

fn build_theme_rules_block(theme: &ResolvedTheme) -> String {
    let mut out = String::new();

    let body_family = theme.body_font.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let body_size = theme.body_size.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let line_height = theme.line_height.as_deref().map(str::trim).filter(|s| !s.is_empty());

    // body como root, único lugar donde se setea body family. Reedsy hace lo
    // mismo. Sumar selectores extra confunde al converter KFX de Kindle.
    if body_family.is_some() || body_size.is_some() || line_height.is_some() {
        out.push_str("body {\n");
        if let Some(f) = body_family {
            out.push_str(&format!("  font-family: \"{}\", serif;\n", f));
        }
        if let Some(s) = body_size {
            out.push_str(&format!("  font-size: {};\n", s));
        }
        if let Some(lh) = line_height {
            out.push_str(&format!("  line-height: {};\n", lh));
        }
        out.push_str("}\n");
    }

    let heading_family = theme.heading_font.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(hf) = heading_family {
        // Headings de capítulo solamente. nav h1 + parte-headings del TOC NO van
        // acá — esos son editoriales (ver bloque editorial_heading abajo).
        out.push_str(
            "h1.chapter-title, .chapter-prefix, h2.part-label, span.dropcap {\n",
        );
        out.push_str(&format!("  font-family: \"{}\", sans-serif;\n", hf));
        out.push_str("}\n");
    }

    // Editorial fonts: aplican a páginas no-autor (title page, copyright,
    // dedicatoria, TOC, sobre el autor). Si el tema no las setea, las páginas
    // editoriales heredan body_font/heading_font como antes (cero regresión).
    let editorial_body = theme
        .editorial_body_font
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(ef) = editorial_body {
        out.push_str(
            "body.title-body, body.copyright-body, body.dedication-body, body.nav-body, body.about-author-body {\n",
        );
        out.push_str(&format!("  font-family: \"{}\", serif;\n", ef));
        out.push_str("}\n");
    }
    let editorial_heading = theme
        .editorial_heading_font
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(eh) = editorial_heading {
        // Emitido DESPUÉS del bloque heading_font para pisar `nav h1` y
        // `nav ol.toc > li.toc-part > a` cuando editorial está set (mismo
        // selector pelado en specificity, gana orden de cascada).
        out.push_str(
            "p.title-page-title, nav h1, nav ol.toc > li.toc-part > a, h1.about-author-title {\n",
        );
        out.push_str(&format!("  font-family: \"{}\", sans-serif;\n", eh));
        out.push_str("}\n");
    }

    let heading_size = theme.heading_size.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if heading_size.is_some() || heading_has_bold(theme) {
        out.push_str("h1.chapter-title {\n");
        if let Some(s) = heading_size {
            out.push_str(&format!("  font-size: {};\n", s));
        }
        if heading_has_bold(theme) {
            out.push_str("  font-weight: 700;\n");
        }
        out.push_str("}\n");
    }

    // Per-style overrides para body. Cada slot tiene su propio face dedicado
    // que pisa el auto-pick de la familia base. Útil cuando la italic auto
    // de la familia es muy sutil (e.g. usar IBMPlexSans-MediumItalic en vez
    // de IBMPlexSans-Italic).
    let body_fallback = body_family.unwrap_or("");
    if let Some(fam) = theme.body_italic_family.as_deref() {
        out.push_str("em, i {\n");
        if !body_fallback.is_empty() {
            out.push_str(&format!(
                "  font-family: \"{}\", \"{}\", serif;\n",
                fam, body_fallback
            ));
        } else {
            out.push_str(&format!("  font-family: \"{}\", serif;\n", fam));
        }
        out.push_str("  font-style: italic;\n");
        out.push_str("}\n");
    }
    if let Some(fam) = theme.body_bold_family.as_deref() {
        out.push_str("strong, b {\n");
        if !body_fallback.is_empty() {
            out.push_str(&format!(
                "  font-family: \"{}\", \"{}\", serif;\n",
                fam, body_fallback
            ));
        } else {
            out.push_str(&format!("  font-family: \"{}\", serif;\n", fam));
        }
        out.push_str("  font-weight: bold;\n");
        out.push_str("}\n");
    }
    if let Some(fam) = theme.body_bold_italic_family.as_deref() {
        out.push_str(
            "strong em, strong i, em strong, em b, b em, b i, i strong, i b {\n",
        );
        if !body_fallback.is_empty() {
            out.push_str(&format!(
                "  font-family: \"{}\", \"{}\", serif;\n",
                fam, body_fallback
            ));
        } else {
            out.push_str(&format!("  font-family: \"{}\", serif;\n", fam));
        }
        out.push_str("  font-weight: bold;\n");
        out.push_str("  font-style: italic;\n");
        out.push_str("}\n");
    }

    // Posición vertical del título de capítulo: solo `top` y `bottom` emiten
    // override. `center` o ausente → CSS base (table-cell + fallback @media
    // amzn-kf8 en epub_style.css). Whitelist explícito para evitar inyección
    // de CSS arbitrario desde un theme.json editado a mano.
    let position = theme
        .chapter_title_position
        .as_deref()
        .map(str::trim)
        .filter(|s| matches!(*s, "top" | "bottom"));
    if let Some(pos) = position {
        if pos == "top" {
            out.push_str(
                "body.chapter-title-body {\n  display: block;\n  height: auto;\n  min-height: 0;\n  padding-top: 2em;\n}\n",
            );
            out.push_str(".chapter-heading-inner {\n  display: block;\n}\n");
        } else {
            out.push_str(
                ".chapter-heading-inner {\n  vertical-align: bottom;\n  padding-bottom: 2em;\n}\n",
            );
            out.push_str(
                "@media amzn-kf8 {\n  body.chapter-title-body {\n    display: block;\n    padding-top: 80%;\n  }\n  .chapter-heading-inner {\n    display: block;\n  }\n}\n",
            );
        }
    }

    out
}

fn heading_has_bold(theme: &ResolvedTheme) -> bool {
    let Some(hf) = theme.heading_font.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let target = hf.to_ascii_lowercase();
    theme
        .fonts
        .iter()
        .any(|f| f.family.to_ascii_lowercase() == target && f.weight >= 700 && f.style == "normal")
}

fn build_css(template: &str, theme: &ResolvedTheme) -> String {
    let page_rule = page_rule_for(template, theme.page_margin.as_deref());
    let font_face = build_font_face_block(&theme.fonts);
    let theme_rules = build_theme_rules_block(theme);
    CSS_TEMPLATE
        .replace("/* @PAGE_SIZE */", &page_rule)
        .replace("/* @FONT_FACE */", &font_face)
        .replace("/* @THEME_RULES */", &theme_rules)
}

/// Sube hasta el padre del book buscando saga.json. Retorna (saga_dir, root_dir).
/// Si no hay saga.json, libro standalone: saga_dir=None, root_dir = parent del book.
fn find_saga_and_root(book_dir: &Path) -> (Option<PathBuf>, PathBuf) {
    let parent = match book_dir.parent() {
        Some(p) => p.to_path_buf(),
        None => return (None, book_dir.to_path_buf()),
    };
    if parent.join("saga.json").is_file() {
        let root = parent
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| parent.clone());
        return (Some(parent), root);
    }
    (None, parent)
}

const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;

/// Una entrada del spine/manifest. id único, href dentro de OEBPS/.
struct Item {
    id: String,
    href: String,
    media_type: String,
    /// Si es xhtml, va al spine en este orden. None = no spine (imágenes, css, ncx).
    spine_order: Option<u32>,
    /// Properties OPF (ej: "cover-image", "nav").
    properties: Option<String>,
}

/// Exporta un libro a EPUB en `<book>/exports/<title>.epub`.
#[tauri::command]
pub async fn export_book(book_path: String) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || export_impl(&book_path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn export_impl(book_path: &str) -> Result<ExportResult, String> {
    let book_dir = PathBuf::from(book_path);
    if !book_dir.is_dir() {
        tracing::error!(target: "epub", path = %book_path, "export_book: no es directorio");
        return Err(format!("no es directorio: {}", book_path));
    }
    let cfg = read_or_default_config(&book_dir);
    tracing::info!(target: "epub", titulo = %cfg.titulo, "iniciando export");

    let (chapters, epilogo) = collect_chapters(&book_dir, cfg.epilogo.as_deref())?;
    if chapters.is_empty() && epilogo.is_none() {
        tracing::error!(target: "epub", titulo = %cfg.titulo, "libro sin capítulos .html");
        return Err("libro sin capítulos .html".to_string());
    }
    tracing::info!(target: "epub", titulo = %cfg.titulo, capitulos = chapters.len(), epilogo = epilogo.is_some(), "capítulos recolectados");

    let exports_dir = book_dir.join("Exportados");
    fs::create_dir_all(&exports_dir).map_err(|e| e.to_string())?;
    let safe_title = sanitize_filename(&cfg.titulo);
    let epub_path = exports_dir.join(format!("{}.epub", safe_title));

    let file = File::create(&epub_path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);

    // mimetype STORED primero
    let mimetype_opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file("mimetype", mimetype_opts).map_err(|e| e.to_string())?;
    zip.write_all(b"application/epub+zip").map_err(|e| e.to_string())?;

    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // META-INF/container.xml
    zip.start_file("META-INF/container.xml", opts).map_err(|e| e.to_string())?;
    zip.write_all(CONTAINER_XML.as_bytes()).map_err(|e| e.to_string())?;

    // Resolver tema (saga + book + base) ANTES del CSS para inyectar @font-face.
    let (saga_dir, root_dir) = find_saga_and_root(&book_dir);
    let resolved_theme = resolve_theme(&book_dir, saga_dir.as_deref(), &root_dir);

    // OEBPS/style.css
    let template = cfg.template.as_deref().unwrap_or("6x9");
    let css = build_css(template, &resolved_theme);
    zip.start_file("OEBPS/style.css", opts).map_err(|e| e.to_string())?;
    zip.write_all(css.as_bytes()).map_err(|e| e.to_string())?;

    let mut items: Vec<Item> = Vec::new();
    items.push(Item {
        id: "css".into(),
        href: "style.css".into(),
        media_type: "text/css".into(),
        spine_order: None,

        properties: None,
    });

    // Embebido de fuentes referenciadas por el tema. Cada FontEmbed va a OEBPS/fonts/<filename>
    // y entra al manifest OPF con el media-type EPUB-3 correspondiente.
    for (idx, font) in resolved_theme.fonts.iter().enumerate() {
        let bytes = match fs::read(&font.abs_path) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(target: "theme", font = %font.abs_path.display(), error = %e, "no pude leer fuente, salteo");
                continue;
            }
        };
        let dest = format!("OEBPS/fonts/{}", font.filename);
        zip.start_file(&dest, opts).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
        items.push(Item {
            id: format!("font-{}", idx),
            href: format!("fonts/{}", font.filename),
            media_type: font.media_type.clone(),
            spine_order: None,
            properties: None,
        });
    }

    let mut spine_idx = 0u32;
    let mut total_chapter_files = 0u32;

    // 1) Cover (si hay imagen)
    if let Some(cover_rel) = &cfg.tapa {
        if let Some((cover_filename, cover_mime)) =
            embed_image(&book_dir, cover_rel, "cover", &mut zip, opts)?
        {
            items.push(Item {
                id: "cover-image".into(),
                href: cover_filename.clone(),
                media_type: cover_mime,
                spine_order: None,

                properties: Some("cover-image".into()),
            });
            spine_idx += 1;
            let xhtml = build_cover_xhtml(&cover_filename);
            zip.start_file("OEBPS/0_cover.xhtml", opts).map_err(|e| e.to_string())?;
            zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
            items.push(Item {
                id: "cover".into(),
                href: "0_cover.xhtml".into(),
                media_type: "application/xhtml+xml".into(),
                spine_order: Some(spine_idx),

                properties: None,
            });
        }
    }

    // 2) Title page
    spine_idx += 1;
    let xhtml = build_title_xhtml(&cfg);
    zip.start_file("OEBPS/1_title.xhtml", opts).map_err(|e| e.to_string())?;
    zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
    items.push(Item {
        id: "title".into(),
        href: "1_title.xhtml".into(),
        media_type: "application/xhtml+xml".into(),
        spine_order: Some(spine_idx),

        properties: None,
    });

    // 3) Copyright
    spine_idx += 1;
    let xhtml = build_copyright_xhtml(&cfg);
    zip.start_file("OEBPS/2_copyright.xhtml", opts).map_err(|e| e.to_string())?;
    zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
    items.push(Item {
        id: "copyright".into(),
        href: "2_copyright.xhtml".into(),
        media_type: "application/xhtml+xml".into(),
        spine_order: Some(spine_idx),

        properties: None,
    });

    // 4) Dedicatoria (opcional)
    if let Some(ded) = cfg.dedicatoria.as_deref().filter(|s| !s.trim().is_empty()) {
        spine_idx += 1;
        let xhtml = build_dedication_xhtml(ded);
        zip.start_file("OEBPS/3_dedication.xhtml", opts).map_err(|e| e.to_string())?;
        zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
        items.push(Item {
            id: "dedication".into(),
            href: "3_dedication.xhtml".into(),
            media_type: "application/xhtml+xml".into(),
            spine_order: Some(spine_idx),

            properties: None,
        });
    }

    // 5) Chapters: title page + parts (collect TOC entries en paralelo)
    let show_chapter_title = cfg.mostrar_titulo_capitulo.unwrap_or(true);
    let prefix_style = cfg.prefijo_capitulo.as_deref().unwrap_or("none");
    let use_dropcap = cfg.dropcap.unwrap_or(false);
    let show_part_num = cfg.mostrar_numero_parte.unwrap_or(false);
    let part_format = cfg.formato_parte.as_deref().unwrap_or("raw");

    let lang_str = cfg.idioma.as_deref().unwrap_or("es").to_string();
    let is_en = lang_str == "en";

    let mut toc_entries: Vec<TocEntry> = Vec::new();
    let mut file_seq = 10u32;
    for (ch_idx, chapter) in chapters.iter().enumerate() {
        // Chapter title page
        spine_idx += 1;
        file_seq += 1;
        let title_href = format!("{}_ch{}_title.xhtml", file_seq, ch_idx + 1);
        let prefix = chapter_prefix(prefix_style, (ch_idx + 1) as u32);
        let title_xhtml = build_chapter_title_xhtml(
            &chapter.title,
            show_chapter_title,
            prefix.as_deref(),
        );
        zip.start_file(format!("OEBPS/{}", title_href), opts).map_err(|e| e.to_string())?;
        zip.write_all(title_xhtml.as_bytes()).map_err(|e| e.to_string())?;
        items.push(Item {
            id: format!("ch{}_title", ch_idx + 1),
            href: title_href.clone(),
            media_type: "application/xhtml+xml".into(),
            spine_order: Some(spine_idx),
            properties: None,
        });
        let toc_label = match (&prefix, show_chapter_title) {
            (Some(p), true) => format!("{} {}", p, chapter.title),
            (Some(p), false) => p.clone(),
            (None, true) => chapter.title.clone(),
            (None, false) => {
                let word = if is_en { "Chapter" } else { "Capítulo" };
                format!("{} {}", word, ch_idx + 1)
            }
        };
        let mut entry = TocEntry {
            href: title_href,
            label: toc_label,
            children: Vec::new(),
        };

        // Parts
        for (p_idx, part) in chapter.parts.iter().enumerate() {
            spine_idx += 1;
            file_seq += 1;
            total_chapter_files += 1;
            let part_href = format!("{}_ch{}_p{}.xhtml", file_seq, ch_idx + 1, p_idx + 1);
            let is_first = p_idx == 0;
            let part_label = part_label(part, part_format, &lang_str);
            let toc_label = part
                .meta_title
                .clone()
                .unwrap_or_else(|| part_label.clone());
            let header_html = if show_part_num {
                Some(format!(
                    r#"<h2 class="part-label">{}</h2>"#,
                    xml_escape(&part_label)
                ))
            } else {
                None
            };
            let part_xhtml = build_part_xhtml(
                &toc_label,
                header_html.as_deref(),
                &part.content_html,
                use_dropcap && is_first,
            );
            zip.start_file(format!("OEBPS/{}", part_href), opts).map_err(|e| e.to_string())?;
            zip.write_all(part_xhtml.as_bytes()).map_err(|e| e.to_string())?;
            items.push(Item {
                id: format!("ch{}_p{}", ch_idx + 1, p_idx + 1),
                href: part_href.clone(),
                media_type: "application/xhtml+xml".into(),
                spine_order: Some(spine_idx),
                properties: None,
            });
            entry.children.push(TocEntry {
                href: part_href,
                label: toc_label,
                children: Vec::new(),
            });
        }
        toc_entries.push(entry);
    }

    // 5a) Epílogo (sin prefijo de número, va al final del cuerpo).
    if let Some(ep) = epilogo.as_ref() {
        spine_idx += 1;
        file_seq += 1;
        let title_href = format!("{}_epilog_title.xhtml", file_seq);
        let title_xhtml =
            build_chapter_title_xhtml(&ep.title, show_chapter_title, None);
        zip.start_file(format!("OEBPS/{}", title_href), opts).map_err(|e| e.to_string())?;
        zip.write_all(title_xhtml.as_bytes()).map_err(|e| e.to_string())?;
        items.push(Item {
            id: "epilog_title".into(),
            href: title_href.clone(),
            media_type: "application/xhtml+xml".into(),
            spine_order: Some(spine_idx),
            properties: None,
        });
        let toc_label = if show_chapter_title {
            ep.title.clone()
        } else if is_en {
            "Epilogue".to_string()
        } else {
            "Epílogo".to_string()
        };
        let mut entry = TocEntry {
            href: title_href,
            label: toc_label,
            children: Vec::new(),
        };

        for (p_idx, part) in ep.parts.iter().enumerate() {
            spine_idx += 1;
            file_seq += 1;
            total_chapter_files += 1;
            let part_href = format!("{}_epilog_p{}.xhtml", file_seq, p_idx + 1);
            let is_first = p_idx == 0;
            let part_label = part_label(part, part_format, &lang_str);
            let toc_label = part
                .meta_title
                .clone()
                .unwrap_or_else(|| part_label.clone());
            let header_html = if show_part_num {
                Some(format!(
                    r#"<h2 class="part-label">{}</h2>"#,
                    xml_escape(&part_label)
                ))
            } else {
                None
            };
            let part_xhtml = build_part_xhtml(
                &toc_label,
                header_html.as_deref(),
                &part.content_html,
                use_dropcap && is_first,
            );
            zip.start_file(format!("OEBPS/{}", part_href), opts).map_err(|e| e.to_string())?;
            zip.write_all(part_xhtml.as_bytes()).map_err(|e| e.to_string())?;
            items.push(Item {
                id: format!("epilog_p{}", p_idx + 1),
                href: part_href.clone(),
                media_type: "application/xhtml+xml".into(),
                spine_order: Some(spine_idx),
                properties: None,
            });
            entry.children.push(TocEntry {
                href: part_href,
                label: toc_label,
                children: Vec::new(),
            });
        }
        toc_entries.push(entry);
    }

    // 5a-bis) Sobre el autor (si hay bio). Va después del último capítulo /
    // epílogo y antes de la contratapa.
    if cfg
        .sobre_el_autor
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
    {
        let photo_filename: Option<String> = if let Some(rel) = &cfg.foto_autor {
            embed_image(&book_dir, rel, "author", &mut zip, opts)?.map(|(name, mime)| {
                items.push(Item {
                    id: "author-image".into(),
                    href: name.clone(),
                    media_type: mime,
                    spine_order: None,
                    properties: None,
                });
                name
            })
        } else {
            None
        };
        spine_idx += 1;
        let xhtml = build_about_author_xhtml(&cfg, photo_filename.as_deref());
        zip.start_file("OEBPS/8_about_author.xhtml", opts).map_err(|e| e.to_string())?;
        zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
        items.push(Item {
            id: "about-author".into(),
            href: "8_about_author.xhtml".into(),
            media_type: "application/xhtml+xml".into(),
            spine_order: Some(spine_idx),
            properties: None,
        });
    }

    // 5b) Back cover (si hay imagen)
    if let Some(back_rel) = &cfg.contratapa {
        if let Some((bc_filename, bc_mime)) =
            embed_image(&book_dir, back_rel, "back-cover", &mut zip, opts)?
        {
            spine_idx += 1;
            items.push(Item {
                id: "back-cover-image".into(),
                href: bc_filename.clone(),
                media_type: bc_mime,
                spine_order: None,

                properties: None,
            });
            let xhtml = build_back_cover_xhtml(&bc_filename);
            zip.start_file("OEBPS/9_back_cover.xhtml", opts).map_err(|e| e.to_string())?;
            zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
            items.push(Item {
                id: "back-cover".into(),
                href: "9_back_cover.xhtml".into(),
                media_type: "application/xhtml+xml".into(),
                spine_order: Some(spine_idx),

                properties: None,
            });
        }
    }

    // 6) toc.xhtml (visible nav + EPUB 3 properties="nav"). Lo metemos al spine
    //    después del frontmatter para que el lector pueda navegar a él.
    //    Lo agregamos al final del array para que aparezca al final, pero su
    //    spine_order lo lleva entre frontmatter y capítulos.
    let toc_xhtml = build_toc_xhtml(&cfg, &toc_entries);
    zip.start_file("OEBPS/toc.xhtml", opts).map_err(|e| e.to_string())?;
    zip.write_all(toc_xhtml.as_bytes()).map_err(|e| e.to_string())?;
    // El TOC visible va justo después del frontmatter; reasignamos spine_order
    // para insertarlo. Hack: lo ponemos al inicio del rango de chapters.
    // Más simple: lo dejamos al final del frontmatter usando un nuevo spine slot.
    // Para esta versión, lo metemos ANTES de los chapters: re-bumpeamos los
    // chapters spine_order. Solución pragmática: lo agregamos al inicio del
    // bloque de chapters via un offset.
    // Implementación sencilla: lo ponemos en spine_order = (último_frontmatter + 0.5)
    // pero usamos enteros, así que añadimos +1000 a chapters spine y dejamos
    // espacio. Ya hicimos chapters con spine_idx incremental — refactorizar
    // sería invasivo. Más fácil: poner el TOC justo antes de los chapters
    // moviendo todos los chapter spine_orders +1.
    let toc_spine_pos = items
        .iter()
        .filter(|i| i.spine_order.is_some())
        .filter(|i| {
            // primer chapter spine
            i.id.starts_with("ch") && i.id.ends_with("_title")
        })
        .map(|i| i.spine_order.unwrap())
        .min()
        .unwrap_or(spine_idx + 1);
    // Bump todos los items con spine_order >= toc_spine_pos en +1
    for it in items.iter_mut() {
        if let Some(o) = it.spine_order {
            if o >= toc_spine_pos {
                it.spine_order = Some(o + 1);
            }
        }
    }
    items.push(Item {
        id: "toc".into(),
        href: "toc.xhtml".into(),
        media_type: "application/xhtml+xml".into(),
        spine_order: Some(toc_spine_pos),
        properties: Some("nav".into()),
    });

    // 7) toc.ncx (legacy)
    let book_uuid = Uuid::new_v4().to_string();
    let ncx = build_ncx_with_entries(&cfg, &toc_entries, &book_uuid);
    zip.start_file("OEBPS/toc.ncx", opts).map_err(|e| e.to_string())?;
    zip.write_all(ncx.as_bytes()).map_err(|e| e.to_string())?;
    items.push(Item {
        id: "ncx".into(),
        href: "toc.ncx".into(),
        media_type: "application/x-dtbncx+xml".into(),
        spine_order: None,

        properties: None,
    });

    // 8) content.opf
    let opf = build_opf(&cfg, &items, &book_uuid);
    zip.start_file("OEBPS/content.opf", opts).map_err(|e| e.to_string())?;
    zip.write_all(opf.as_bytes()).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| {
        tracing::error!(target: "epub", error = %e, "zip finish falló");
        e.to_string()
    })?;

    tracing::info!(target: "epub", path = %epub_path.display(), capitulos = total_chapter_files, "export listo");
    Ok(ExportResult {
        epub_path: epub_path.to_string_lossy().into_owned(),
        chapters: total_chapter_files,
    })
}

// ───────── Recolección ─────────

struct Chapter {
    title: String,
    parts: Vec<ChapterPart>,
}

struct ChapterPart {
    /// Stem del archivo (ej: "1") — siempre presente.
    stem: String,
    /// Título de meta.json si existe, para mostrar como header.
    meta_title: Option<String>,
    content_html: String,
}

struct TocEntry {
    href: String,
    label: String,
    children: Vec<TocEntry>,
}

fn collect_chapters(
    book_dir: &Path,
    epilogo_name: Option<&str>,
) -> Result<(Vec<Chapter>, Option<Chapter>), String> {
    let mut subdirs: Vec<PathBuf> = fs::read_dir(book_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(|e| e.path())
        .filter(|p| {
            if !p.is_dir() {
                return false;
            }
            if is_excluded_dir(p) {
                return false;
            }
            p.file_name()
                .and_then(|s| s.to_str())
                .map(|n| {
                    !["exports", "Exportados", "Revisiones", "convertidos", ".git", "extras", "notas", "fonts"]
                        .contains(&n)
                })
                .unwrap_or(true)
        })
        .collect();
    subdirs.sort_by(|a, b| {
        let na = leading_num(a.file_name().and_then(|s| s.to_str()).unwrap_or(""));
        let nb = leading_num(b.file_name().and_then(|s| s.to_str()).unwrap_or(""));
        na.cmp(&nb)
    });

    let epilogo_match = epilogo_name.map(|s| s.trim()).filter(|s| !s.is_empty());

    let mut chapters = Vec::new();
    let mut epilogo: Option<Chapter> = None;
    for d in &subdirs {
        let dir_name = d.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let ch_title = strip_numeric_prefix(dir_name);
        let mut parts = collect_html_parts(d)?;
        parts.sort();
        if parts.is_empty() {
            continue;
        }
        let mut chapter_parts = Vec::new();
        for p in &parts {
            chapter_parts.push(load_part(p)?);
        }
        let is_epilogo = epilogo_match.map(|e| e == dir_name).unwrap_or(false);
        if is_epilogo {
            epilogo = Some(Chapter { title: ch_title, parts: chapter_parts });
        } else {
            chapters.push(Chapter { title: ch_title, parts: chapter_parts });
        }
    }

    // Si no había secciones, tratamos el libro entero como un solo capítulo
    if chapters.is_empty() && epilogo.is_none() {
        let mut direct = collect_html_parts(book_dir)?;
        direct.sort();
        if !direct.is_empty() {
            let title = strip_numeric_prefix(
                book_dir.file_name().and_then(|s| s.to_str()).unwrap_or(""),
            );
            let mut chapter_parts = Vec::new();
            for p in &direct {
                chapter_parts.push(load_part(p)?);
            }
            chapters.push(Chapter { title, parts: chapter_parts });
        }
    }
    Ok((chapters, epilogo))
}

fn load_part(html_path: &Path) -> Result<ChapterPart, String> {
    let stem = html_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let content = fs::read_to_string(html_path).map_err(|e| e.to_string())?;
    let meta_title = read_part_meta_title(html_path);
    Ok(ChapterPart {
        stem,
        meta_title,
        content_html: content,
    })
}

fn read_part_meta_title(html_path: &Path) -> Option<String> {
    let parent = html_path.parent()?;
    let stem = html_path.file_stem().and_then(|s| s.to_str())?;
    let meta = parent.join(format!("{}.meta.json", stem));
    if !meta.exists() {
        return None;
    }
    let raw = fs::read_to_string(&meta).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let t = v.get("titulo")?.as_str()?.trim().to_string();
    if t.is_empty() || t == stem {
        return None;
    }
    Some(t)
}

fn collect_html_parts(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = e.map_err(|e| e.to_string())?;
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().and_then(|s| s.to_str()) != Some("html") {
            continue;
        }
        out.push(p);
    }
    Ok(out)
}

// ───────── Imágenes (cover / back-cover) ─────────

fn embed_image(
    book_dir: &Path,
    image_rel: &str,
    dest_stem: &str,
    zip: &mut ZipWriter<File>,
    opts: SimpleFileOptions,
) -> Result<Option<(String, String)>, String> {
    let candidate = if Path::new(image_rel).is_absolute() {
        PathBuf::from(image_rel)
    } else {
        book_dir.join(image_rel)
    };
    if !candidate.is_file() {
        return Ok(None);
    }
    let ext = candidate
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let (mime, dest_ext) = match ext.as_str() {
        "png" => ("image/png", "png"),
        "jpg" | "jpeg" => ("image/jpeg", "jpg"),
        "webp" => ("image/webp", "webp"),
        "gif" => ("image/gif", "gif"),
        _ => return Ok(None),
    };
    let bytes = fs::read(&candidate).map_err(|e| e.to_string())?;
    let dest = format!("{}.{}", dest_stem, dest_ext);
    zip.start_file(format!("OEBPS/{}", dest), opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(Some((dest, mime.to_string())))
}

// ───────── XHTML builders ─────────

fn xhtml_shell(title: &str, body: &str, lang: &str, body_class: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{}">
<head>
<meta charset="UTF-8" />
<title>{}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body class="{}">
{}
</body>
</html>
"#,
        xml_escape(lang),
        xml_escape(title),
        body_class,
        body
    )
}

fn build_cover_xhtml(cover_filename: &str) -> String {
    let body = format!(
        r#"<img src="{}" alt="Cover"/>"#,
        xml_escape(cover_filename)
    );
    xhtml_shell("Cover", &body, "es", "cover-body")
}

fn build_back_cover_xhtml(filename: &str) -> String {
    let body = format!(
        r#"<img src="{}" alt="Back cover"/>"#,
        xml_escape(filename)
    );
    xhtml_shell("Back cover", &body, "es", "cover-body")
}

fn build_title_xhtml(cfg: &BookConfig) -> String {
    let mut body = String::new();
    if let Some(autor) = cfg.autor.as_deref().filter(|s| !s.is_empty()) {
        body.push_str(&format!(
            r#"<p class="title-page-author">{}</p>
"#,
            xml_escape(autor)
        ));
    }
    body.push_str(&format!(
        r#"<p class="title-page-title">{}</p>
"#,
        xml_escape(&cfg.titulo)
    ));
    if let Some(sub) = cfg.subtitulo.as_deref().filter(|s| !s.is_empty()) {
        body.push_str(&format!(
            r#"<p class="title-page-subtitle">{}</p>
"#,
            xml_escape(sub)
        ));
    } else if let (Some(serie), Some(num)) = (cfg.serie.as_deref(), cfg.numero_en_serie) {
        body.push_str(&format!(
            r#"<p class="title-page-subtitle">{} #{}</p>
"#,
            xml_escape(serie),
            num
        ));
    }
    xhtml_shell(
        &cfg.titulo,
        body.trim_end(),
        cfg.idioma.as_deref().unwrap_or("es"),
        "title-body",
    )
}

fn build_copyright_xhtml(cfg: &BookConfig) -> String {
    let autor = cfg.autor.as_deref().unwrap_or("");
    let anio = cfg.copyright_anio.unwrap_or_else(current_year);
    let lang = cfg.idioma.as_deref().unwrap_or("es");
    let is_en = lang == "en";
    let imprenta = cfg
        .imprenta
        .as_deref()
        .unwrap_or(if is_en { "Independent" } else { "Independiente" });

    let mut body = String::new();
    let by_word = if is_en { "by" } else { "por" };
    body.push_str(&format!(
        "<p>Copyright \u{00A9} {} {} {}</p>\n",
        anio,
        by_word,
        xml_escape(autor)
    ));
    if cfg.derechos_reservados.unwrap_or(true) {
        if is_en {
            body.push_str(
                "<p>All rights reserved. No part of this publication may be reproduced, stored or transmitted in any form or by any means, electronic, mechanical, photocopying, recording or otherwise, without the prior written permission of the author.</p>\n",
            );
            body.push_str(
                "<p>This novel is entirely a work of fiction. The names, characters and incidents portrayed in it are the work of the author's imagination. Any resemblance to actual persons, living or dead, events or localities is entirely coincidental.</p>\n",
            );
        } else {
            body.push_str(
                "<p>Todos los derechos reservados. Ninguna parte de esta publicación puede ser reproducida, almacenada ni transmitida en forma alguna por medio electrónico, mecánico, fotocopia, grabación u otros sin autorización escrita del autor.</p>\n",
            );
            body.push_str(
                "<p>Esta novela es enteramente una obra de ficción. Los nombres, personajes y eventos retratados son producto de la imaginación del autor. Cualquier parecido con personas reales, vivas o fallecidas, eventos o lugares es enteramente coincidencia.</p>\n",
            );
        }
    }
    if let Some(isbn) = cfg.isbn.as_deref().filter(|s| !s.is_empty()) {
        body.push_str(&format!("<p>ISBN: {}</p>\n", xml_escape(isbn)));
    }
    let publicado = if is_en {
        format!("Published by {}", imprenta)
    } else {
        format!("Publicado por {}", imprenta)
    };
    body.push_str(&format!("<p>{}</p>\n", xml_escape(&publicado)));
    let edited = if is_en {
        "Edited with tWriter"
    } else {
        "Editado con tWriter"
    };
    body.push_str(&format!("<p>{}</p>", edited));

    xhtml_shell(&cfg.titulo, &body, lang, "copyright-body")
}

fn build_dedication_xhtml(text: &str) -> String {
    let body = text
        .lines()
        .map(|l| format!("<p>{}</p>", xml_escape(l.trim())))
        .collect::<Vec<_>>()
        .join("\n");
    xhtml_shell("Dedicatoria", &body, "es", "dedication-body")
}

fn build_about_author_xhtml(cfg: &BookConfig, photo_filename: Option<&str>) -> String {
    let lang = cfg.idioma.as_deref().unwrap_or("es");
    let heading = if lang == "en" {
        "About the author"
    } else {
        "Sobre el autor"
    };
    let bio = cfg.sobre_el_autor.as_deref().unwrap_or("");
    let bio_paragraphs: String = bio
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| format!("<p>{}</p>", xml_escape(l)))
        .collect::<Vec<_>>()
        .join("\n");
    let photo_html = match photo_filename {
        Some(name) => format!(
            r#"<img class="about-author-photo" src="{}" alt="{}"/>"#,
            xml_escape(name),
            xml_escape(cfg.autor.as_deref().unwrap_or(""))
        ),
        None => String::new(),
    };
    let body = format!(
        r#"<div class="about-author">
<h1 class="about-author-title">{}</h1>
{}
<div class="about-author-bio">
{}
</div>
</div>"#,
        xml_escape(heading),
        photo_html,
        bio_paragraphs,
    );
    xhtml_shell(heading, &body, lang, "about-author-body")
}

fn build_chapter_title_xhtml(title: &str, show_title: bool, prefix: Option<&str>) -> String {
    let mut inner = String::new();
    if let Some(p) = prefix {
        inner.push_str(&format!(
            r#"<p class="chapter-prefix">{}</p>"#,
            xml_escape(p)
        ));
    }
    if show_title {
        inner.push_str(&format!(
            r#"<h1 class="chapter-title">{}</h1>"#,
            xml_escape(title)
        ));
    }
    if inner.is_empty() {
        inner.push_str(r#"<h1 class="chapter-title">&nbsp;</h1>"#);
    }
    let body = format!(r#"<div class="chapter-heading-inner">{}</div>"#, inner);
    xhtml_shell(title, &body, "es", "chapter-title-body")
}

fn build_part_xhtml(
    title: &str,
    header_html: Option<&str>,
    content_html: &str,
    dropcap: bool,
) -> String {
    let content = if dropcap {
        apply_dropcap(content_html.trim())
    } else {
        content_html.trim().to_string()
    };
    let header_part = header_html.unwrap_or("");
    let body = format!(
        r#"{}<div class="chapter-content">
{}
</div>"#,
        header_part, content
    );
    xhtml_shell(title, &body, "es", "chapter-content-body")
}

fn part_label(part: &ChapterPart, format: &str, lang: &str) -> String {
    if let Some(t) = &part.meta_title {
        return t.clone();
    }
    // Fallback: usar stem con formato
    let stem = &part.stem;
    let is_numeric = stem.chars().all(|c| c.is_ascii_digit());
    let parte_word = if lang == "en" { "Part" } else { "Parte" };
    match format {
        "parte" if is_numeric => format!("{} {}", parte_word, stem),
        "punto" if is_numeric => format!("{}.", stem),
        _ => stem.clone(),
    }
}

/// Envuelve la primera letra del primer <p> en <span class="dropcap">.
/// Marca ese <p> con class="no-indent".
fn apply_dropcap(html: &str) -> String {
    // Buscar el primer <p ... > y la primera letra alfabética después
    let lower = html.to_ascii_lowercase();
    let Some(p_open_start) = lower.find("<p") else {
        return html.to_string();
    };
    let Some(p_open_end_rel) = lower[p_open_start..].find('>') else {
        return html.to_string();
    };
    let p_open_end = p_open_start + p_open_end_rel;
    let opening_tag = &html[p_open_start..=p_open_end];
    let after_open = &html[p_open_end + 1..];

    // Encontrar primera letra alfabética en after_open (saltando tags inline y puntuación)
    let mut in_tag = false;
    let mut first_letter_byte: Option<usize> = None;
    for (i, ch) in after_open.char_indices() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            continue;
        }
        if in_tag {
            continue;
        }
        if ch.is_alphabetic() {
            first_letter_byte = Some(i);
            break;
        }
    }
    let Some(letter_idx) = first_letter_byte else {
        return html.to_string();
    };
    let letter_end = after_open[letter_idx..]
        .char_indices()
        .nth(1)
        .map(|(i, _)| letter_idx + i)
        .unwrap_or(after_open.len());

    let letter = &after_open[letter_idx..letter_end];
    let before = &after_open[..letter_idx];
    let after = &after_open[letter_end..];

    // Reemplazar opening_tag con uno que tenga class="no-indent"
    let new_opening = if opening_tag.contains("class=") {
        // Append "no-indent" en la class existente
        opening_tag.replacen("class=\"", "class=\"no-indent ", 1)
    } else {
        opening_tag.replacen(
            "<p",
            "<p class=\"no-indent\"",
            1,
        )
    };

    let prefix = &html[..p_open_start];
    format!(
        "{}{}{}<span class=\"dropcap\">{}</span>{}",
        prefix, new_opening, before, letter, after
    )
}

fn chapter_prefix(style: &str, idx: u32) -> Option<String> {
    match style {
        "decimal" => Some(format!("{}", idx)),
        "roman" => Some(to_roman(idx)),
        _ => None,
    }
}

fn to_roman(mut n: u32) -> String {
    if n == 0 {
        return "0".into();
    }
    const PAIRS: &[(u32, &str)] = &[
        (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
        (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
        (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
    ];
    let mut out = String::new();
    for (v, s) in PAIRS {
        while n >= *v {
            out.push_str(s);
            n -= v;
        }
    }
    out
}

fn build_toc_xhtml(cfg: &BookConfig, entries: &[TocEntry]) -> String {
    let mut lis = String::new();
    for e in entries {
        lis.push_str(&format!(
            "<li class=\"toc-part toc-body\"><a href=\"{}\">{}</a>",
            xml_escape(&e.href),
            xml_escape(&e.label)
        ));
        if !e.children.is_empty() {
            lis.push_str("<ol class=\"toc-sub\">\n");
            for child in &e.children {
                lis.push_str(&format!(
                    "<li class=\"toc-chapter toc-body\"><a href=\"{}\">{}</a></li>\n",
                    xml_escape(&child.href),
                    xml_escape(&child.label)
                ));
            }
            lis.push_str("</ol>");
        }
        lis.push_str("</li>\n");
    }
    let lang = cfg.idioma.as_deref().unwrap_or("es");
    let toc_label = if lang == "en" { "Contents" } else { "Índice" };
    let body = format!(
        r#"<nav id="toc" epub:type="toc" role="doc-toc">
<h1>{}</h1>
<ol class="toc">
{}
</ol>
</nav>"#,
        xml_escape(toc_label),
        lis
    );
    xhtml_shell(&cfg.titulo, &body, lang, "nav-body")
}

// ───────── NCX (legacy) ─────────

fn build_ncx_with_entries(cfg: &BookConfig, entries: &[TocEntry], book_uuid: &str) -> String {
    let mut nav_points = String::new();
    let mut order = 1u32;
    for entry in entries {
        let chapter_order = order;
        nav_points.push_str(&format!(
            r#"<navPoint id="np-{}" playOrder="{}">
<navLabel><text>{}</text></navLabel>
<content src="{}"/>
"#,
            chapter_order,
            chapter_order,
            xml_escape(&entry.label),
            xml_escape(&entry.href)
        ));
        order += 1;
        for child in &entry.children {
            nav_points.push_str(&format!(
                r#"<navPoint id="np-{}" playOrder="{}">
<navLabel><text>{}</text></navLabel>
<content src="{}"/>
</navPoint>
"#,
                order,
                order,
                xml_escape(&child.label),
                xml_escape(&child.href)
            ));
            order += 1;
        }
        nav_points.push_str("</navPoint>\n");
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="urn:uuid:{}"/>
<meta name="dtb:depth" content="2"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>{}</text></docTitle>
<navMap>
{}
</navMap>
</ncx>
"#,
        book_uuid,
        xml_escape(&cfg.titulo),
        nav_points
    )
}

// ───────── OPF ─────────

fn build_opf(cfg: &BookConfig, items: &[Item], book_uuid: &str) -> String {
    let lang = cfg.idioma.as_deref().unwrap_or("es");
    let modified = current_iso();

    let mut manifest = String::new();
    for it in items {
        let props = it
            .properties
            .as_deref()
            .map(|p| format!(" properties=\"{}\"", p))
            .unwrap_or_default();
        manifest.push_str(&format!(
            "<item id=\"{}\" href=\"{}\" media-type=\"{}\"{}/>\n",
            xml_escape(&it.id),
            xml_escape(&it.href),
            xml_escape(&it.media_type),
            props
        ));
    }

    let mut spine_entries: Vec<&Item> = items.iter().filter(|i| i.spine_order.is_some()).collect();
    spine_entries.sort_by_key(|i| i.spine_order.unwrap());
    let mut spine = String::new();
    for it in spine_entries {
        spine.push_str(&format!("<itemref idref=\"{}\"/>\n", xml_escape(&it.id)));
    }

    let creator = cfg
        .autor
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|a| format!("<dc:creator id=\"creator\">{}</dc:creator>", xml_escape(a)))
        .unwrap_or_default();

    let cover_meta = if items.iter().any(|i| i.id == "cover-image") {
        "<meta name=\"cover\" content=\"cover-image\"/>"
    } else {
        ""
    };

    let isbn_id = cfg
        .isbn
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|i| format!("<dc:identifier>{}</dc:identifier>", xml_escape(i)))
        .unwrap_or_default();

    let serie_meta = match (cfg.serie.as_deref(), cfg.numero_en_serie) {
        (Some(s), Some(n)) if !s.is_empty() => format!(
            "<meta name=\"calibre:series\" content=\"{}\"/>\n<meta name=\"calibre:series_index\" content=\"{}\"/>",
            xml_escape(s),
            n
        ),
        _ => String::new(),
    };

    // Si hay fuentes embebidas, declarar `ibooks:specified-fonts` para que
    // Apple Books / Kindle KFX activen "Publisher Font" en vez de pisar la
    // tipografía con la del lector.
    let has_fonts = items.iter().any(|i| {
        let mt = &i.media_type;
        mt.starts_with("font/")
            || mt == "application/vnd.ms-opentype"
            || mt == "application/font-woff"
    });
    let (package_prefix, fonts_meta) = if has_fonts {
        (
            r#" prefix="ibooks: http://vocabulary.itunes.apple.com/rdf/ibooks/vocabulary-extensions-1.0/""#,
            "<meta property=\"ibooks:specified-fonts\">true</meta>",
        )
    } else {
        ("", "")
    };

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" xml:lang="{}"{}>
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="BookId">urn:uuid:{}</dc:identifier>
{}
<dc:title>{}</dc:title>
{}
<dc:language>{}</dc:language>
<meta property="dcterms:modified">{}</meta>
{}
{}
{}
</metadata>
<manifest>
{}
</manifest>
<spine toc="ncx">
{}
</spine>
</package>
"#,
        lang,
        package_prefix,
        book_uuid,
        isbn_id,
        xml_escape(&cfg.titulo),
        creator,
        lang,
        modified,
        cover_meta,
        serie_meta,
        fonts_meta,
        manifest,
        spine
    )
}

// ───────── Helpers ─────────

fn read_or_default_config(book_dir: &Path) -> BookConfig {
    let book_json = book_dir.join("book.json");
    let mut cfg = if let Ok(raw) = fs::read_to_string(&book_json) {
        serde_json::from_str::<BookConfig>(&raw).unwrap_or_else(|_| BookConfig {
            titulo: strip_numeric_prefix(
                book_dir.file_name().and_then(|s| s.to_str()).unwrap_or("Sin título"),
            ),
            idioma: Some("es".to_string()),
            ..Default::default()
        })
    } else {
        BookConfig {
            titulo: strip_numeric_prefix(
                book_dir.file_name().and_then(|s| s.to_str()).unwrap_or("Sin título"),
            ),
            idioma: Some("es".to_string()),
            ..Default::default()
        }
    };
    if cfg.titulo.trim().is_empty() {
        cfg.titulo = strip_numeric_prefix(
            book_dir.file_name().and_then(|s| s.to_str()).unwrap_or("Sin título"),
        );
    }
    // Fallback autor desde saga.json
    if cfg.autor.as_deref().unwrap_or("").is_empty() {
        if let Some(parent) = book_dir.parent() {
            let saga_json = parent.join("saga.json");
            if let Ok(raw) = fs::read_to_string(&saga_json) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(a) = v.get("autor").and_then(|s| s.as_str()) {
                        cfg.autor = Some(a.to_string());
                    }
                }
            }
        }
    }
    // Auto-discovery de cover/back-cover en disco si el JSON no los tiene
    if cfg.tapa.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        if let Some(found) = find_cover_in(book_dir) {
            cfg.tapa = Some(found);
        }
    }
    if cfg.contratapa.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        if let Some(found) = find_back_cover_in(book_dir) {
            cfg.contratapa = Some(found);
        }
    }
    cfg
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string()
}

fn strip_numeric_prefix(s: &str) -> String {
    let trimmed = s.trim_start();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return s.to_string();
    }
    let rest = &trimmed[digits.len()..];
    rest.trim_start_matches(|c: char| c.is_whitespace() || c == '-')
        .to_string()
}

fn leading_num(s: &str) -> u32 {
    let trimmed = s.trim_start();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(u32::MAX)
}

fn current_year() -> u32 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let (y, _, _) = ymd_from_days(days);
    y as u32
}

fn current_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let secs_today = secs % 86_400;
    let h = (secs_today / 3600) as u32;
    let m = ((secs_today / 60) % 60) as u32;
    let s = (secs_today % 60) as u32;
    let (y, mo, d) = ymd_from_days(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, m, s)
}

fn ymd_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{FontEmbed, ResolvedTheme};
    use std::path::PathBuf;

    #[test]
    fn unconfigured_css_keeps_placeholders_empty() {
        let resolved = ResolvedTheme::default();
        let css = build_css("6x9", &resolved);
        // El placeholder de @page se reemplaza, los otros dos deben quedar vacíos.
        assert!(css.contains("@page { size: 6in 9in; margin: 0.5in; }"));
        assert!(!css.contains("/* @PAGE_SIZE */"));
        assert!(!css.contains("/* @FONT_FACE */"));
        assert!(!css.contains("/* @THEME_RULES */"));
        // Sin tema configurado: ningún @font-face debe aparecer.
        assert!(!css.contains("@font-face"));
        // El CSS base debe seguir intacto en sus reglas críticas.
        assert!(css.contains("font-family: serif;"));
        assert!(css.contains("font-family: sans-serif;"));
    }

    #[test]
    fn configured_css_emits_font_face_and_theme_rules() {
        let resolved = ResolvedTheme {
            body_font: Some("Merriweather".into()),
            body_size: Some("11pt".into()),
            heading_font: Some("Lato".into()),
            heading_size: Some("2em".into()),
            line_height: Some("1.6".into()),
            page_margin: Some("0.5in".into()),
            body_italic_family: None,
            body_bold_family: None,
            body_bold_italic_family: None,
            editorial_body_font: None,
            editorial_heading_font: None,
            chapter_title_position: None,
            fonts: vec![
                FontEmbed {
                    family: "Merriweather".into(),
                    weight: 400,
                    style: "normal".into(),
                    filename: "Merriweather-Regular.ttf".into(),
                    abs_path: PathBuf::from("/x/Merriweather-Regular.ttf"),
                    media_type: "font/ttf".into(),
                },
                FontEmbed {
                    family: "Merriweather".into(),
                    weight: 700,
                    style: "normal".into(),
                    filename: "Merriweather-Bold.ttf".into(),
                    abs_path: PathBuf::from("/x/Merriweather-Bold.ttf"),
                    media_type: "font/ttf".into(),
                },
                FontEmbed {
                    family: "Lato".into(),
                    weight: 700,
                    style: "normal".into(),
                    filename: "Lato-Bold.ttf".into(),
                    abs_path: PathBuf::from("/x/Lato-Bold.ttf"),
                    media_type: "font/ttf".into(),
                },
            ],
        };
        let css = build_css("6x9", &resolved);
        // Margen del tema gana sobre el default del template.
        assert!(css.contains("margin: 0.5in"));
        // @font-face por archivo. Sin format() para compatibilidad KFX.
        assert!(css.contains("@font-face"));
        assert!(css.contains("src: url(\"fonts/Merriweather-Regular.ttf\")"));
        assert!(css.contains("src: url(\"fonts/Merriweather-Bold.ttf\")"));
        assert!(css.contains("src: url(\"fonts/Lato-Bold.ttf\")"));
        // Keywords no números.
        assert!(css.contains("font-weight: bold"));
        assert!(css.contains("font-weight: normal"));
        // Theme rules.
        assert!(css.contains("font-family: \"Merriweather\", serif"));
        assert!(css.contains("font-family: \"Lato\", sans-serif"));
        assert!(css.contains("font-size: 11pt"));
        assert!(css.contains("font-size: 2em"));
        assert!(css.contains("line-height: 1.6"));
        // Heading tiene Bold disponible → font-weight: 700.
        assert!(css.contains("font-weight: 700"));
    }

    #[test]
    fn theme_rules_emit_per_style_overrides() {
        let resolved = ResolvedTheme {
            body_font: Some("IBMPlexSans".into()),
            body_italic_family: Some("IBMPlexSans-MediumItalic".into()),
            body_bold_family: Some("IBMPlexSans-Bold".into()),
            body_bold_italic_family: Some("IBMPlexSans-BoldItalic".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        // em rule.
        assert!(block.contains("em, i {"));
        assert!(block.contains(
            "font-family: \"IBMPlexSans-MediumItalic\", \"IBMPlexSans\", serif;"
        ));
        assert!(block.contains("font-style: italic;"));
        // strong rule.
        assert!(block.contains("strong, b {"));
        assert!(block.contains(
            "font-family: \"IBMPlexSans-Bold\", \"IBMPlexSans\", serif;"
        ));
        assert!(block.contains("font-weight: bold;"));
        // bold-italic rule.
        assert!(block.contains("strong em, strong i, em strong"));
        assert!(block.contains(
            "font-family: \"IBMPlexSans-BoldItalic\", \"IBMPlexSans\", serif;"
        ));
    }

    #[test]
    fn theme_rules_no_per_style_when_unset() {
        let resolved = ResolvedTheme {
            body_font: Some("Merriweather".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        // Sin slots per-style: no aparecen las reglas em/strong.
        assert!(!block.contains("em, i {"));
        assert!(!block.contains("strong, b {"));
    }

    #[test]
    fn theme_rules_only_emit_set_fields() {
        let resolved = ResolvedTheme {
            body_size: Some("12pt".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        assert!(block.contains("font-size: 12pt"));
        // Sin font-family configurado, no debe aparecer.
        assert!(!block.contains("font-family"));
        // Sin heading.
        assert!(!block.contains("h1.chapter-title"));
    }

    #[test]
    fn font_face_block_empty_when_no_fonts() {
        let resolved = ResolvedTheme::default();
        assert!(build_font_face_block(&resolved.fonts).is_empty());
    }

    #[test]
    fn page_rule_default_per_template() {
        assert_eq!(page_rule_for("6x9", None), "@page { size: 6in 9in; margin: 0.5in; }");
        assert_eq!(page_rule_for("5x8", None), "@page { size: 5in 8in; margin: 0.4in; }");
        assert_eq!(page_rule_for("a5", None), "@page { size: A5; margin: 12mm; }");
    }

    #[test]
    fn page_rule_override_margin() {
        assert_eq!(
            page_rule_for("6x9", Some("1in")),
            "@page { size: 6in 9in; margin: 1in; }"
        );
        // String vacío cae al default.
        assert_eq!(
            page_rule_for("6x9", Some("")),
            "@page { size: 6in 9in; margin: 0.5in; }"
        );
    }

    fn read_epub_entries(epub_path: &std::path::Path) -> std::collections::HashMap<String, Vec<u8>> {
        use std::io::Read;
        let f = std::fs::File::open(epub_path).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        let mut out: std::collections::HashMap<String, Vec<u8>> = std::collections::HashMap::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            let name = entry.name().to_string();
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).ok();
            out.insert(name, buf);
        }
        out
    }

    #[test]
    fn export_impl_unconfigured_does_not_embed_fonts() {
        let tmp = tempdir();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(book.join("book.json"), r#"{"titulo":"Test"}"#).unwrap();
        std::fs::write(
            book.join("Cap1").join("1.html"),
            "<p>Hello world.</p>",
        )
        .unwrap();
        let result = export_impl(book.to_str().unwrap()).expect("export ok");
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        // Sin entries OEBPS/fonts/.
        assert!(
            !entries.keys().any(|k| k.starts_with("OEBPS/fonts/")),
            "no debería haber OEBPS/fonts/ en EPUB sin tema"
        );
        let css = String::from_utf8(entries.get("OEBPS/style.css").unwrap().clone()).unwrap();
        assert!(!css.contains("@font-face"), "CSS no debería tener @font-face sin tema");
        assert!(css.contains("font-family: serif;"), "CSS base intacto");
        // OPF no menciona ningún media-type de fuentes.
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(!opf.contains("application/vnd.ms-opentype"));
        assert!(!opf.contains("font/woff2"));
    }

    #[test]
    fn export_impl_with_theme_embeds_fonts() {
        let tmp = tempdir();
        let theme_fonts = tmp.join("themes").join("classic").join("fonts");
        std::fs::create_dir_all(&theme_fonts).unwrap();
        std::fs::write(theme_fonts.join("Merriweather-Regular.ttf"), b"FAKE_TTF_DATA").unwrap();
        std::fs::write(theme_fonts.join("Merriweather-Bold.ttf"), b"FAKE_TTF_BOLD").unwrap();
        std::fs::write(
            tmp.join("themes").join("classic").join("theme.json"),
            r#"{"id":"classic","body_font":"Merriweather","body_size":"11pt"}"#,
        )
        .unwrap();
        let saga = tmp.join("Saga");
        let book = saga.join("Book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(saga.join("saga.json"), r#"{"nombre":"Saga"}"#).unwrap();
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"Test","theme":{"base":"classic"}}"#,
        )
        .unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>Hello.</p>").unwrap();

        let result = export_impl(book.to_str().unwrap()).expect("export ok");
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        // Fonts embebidas.
        assert!(entries.contains_key("OEBPS/fonts/Merriweather-Regular.ttf"));
        assert!(entries.contains_key("OEBPS/fonts/Merriweather-Bold.ttf"));
        // CSS con @font-face y theme rules.
        let css = String::from_utf8(entries.get("OEBPS/style.css").unwrap().clone()).unwrap();
        assert!(css.contains("@font-face"));
        assert!(css.contains("font-family: \"Merriweather\""));
        assert!(css.contains("font-size: 11pt"));
        // OPF manifest tiene los items con media-type legacy
        // (`application/vnd.ms-opentype` para TTF/OTF — compat con Okular y
        // lectores Qt sin perder Kindle/Calibre/Apple Books).
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(opf.contains("application/vnd.ms-opentype"));
        assert!(opf.contains("fonts/Merriweather-Regular.ttf"));
        assert!(opf.contains("fonts/Merriweather-Bold.ttf"));
        // Activa "Publisher Font" en Apple Books / Kindle KFX.
        assert!(opf.contains("ibooks:specified-fonts"));
        assert!(opf.contains("vocabulary.itunes.apple.com"));
    }

    #[test]
    fn export_impl_with_per_style_face_embeds_explicit_italic() {
        let tmp = tempdir();
        let theme_fonts = tmp.join("themes").join("classic").join("fonts");
        std::fs::create_dir_all(&theme_fonts).unwrap();
        std::fs::write(theme_fonts.join("Plex-Regular.ttf"), b"REGULAR").unwrap();
        std::fs::write(theme_fonts.join("Plex-Italic.ttf"), b"ITALIC_AUTO").unwrap();
        std::fs::write(theme_fonts.join("Plex-MediumItalic.ttf"), b"MEDIUM_ITALIC").unwrap();
        std::fs::write(
            tmp.join("themes").join("classic").join("theme.json"),
            r#"{"id":"classic","body_font":"Plex","body_font_italic":"Plex-MediumItalic"}"#,
        )
        .unwrap();
        let book = tmp.join("Book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"X","theme":{"base":"classic"}}"#,
        )
        .unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>Hi.</p>").unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        // Auto-detect (Plex-Regular y Plex-Italic) + explicit (Plex-MediumItalic).
        assert!(entries.contains_key("OEBPS/fonts/Plex-Regular.ttf"));
        assert!(entries.contains_key("OEBPS/fonts/Plex-Italic.ttf"));
        assert!(entries.contains_key("OEBPS/fonts/Plex-MediumItalic.ttf"));
        let css = String::from_utf8(entries.get("OEBPS/style.css").unwrap().clone()).unwrap();
        // @font-face de Medium Italic con style italic.
        assert!(css.contains("font-family: \"Plex-MediumItalic\""));
        assert!(css.contains("src: url(\"fonts/Plex-MediumItalic.ttf\")"));
        // Override CSS rule.
        assert!(css.contains("em, i {"));
        assert!(css.contains(
            "font-family: \"Plex-MediumItalic\", \"Plex\", serif;"
        ));
    }

    #[test]
    fn theme_rules_emit_editorial_fonts_when_set() {
        let resolved = ResolvedTheme {
            editorial_body_font: Some("Cormorant".into()),
            editorial_heading_font: Some("Playfair".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        assert!(block.contains(
            "body.title-body, body.copyright-body, body.dedication-body, body.nav-body, body.about-author-body {"
        ));
        assert!(block.contains("font-family: \"Cormorant\", serif;"));
        assert!(block.contains(
            "p.title-page-title, nav h1, nav ol.toc > li.toc-part > a, h1.about-author-title {"
        ));
        assert!(block.contains("font-family: \"Playfair\", sans-serif;"));
    }

    #[test]
    fn theme_rules_no_chapter_position_when_unset() {
        let resolved = ResolvedTheme::default();
        let block = build_theme_rules_block(&resolved);
        assert!(!block.contains("padding-top: 2em"));
        assert!(!block.contains("vertical-align: bottom"));
        assert!(!block.contains("amzn-kf8"));
    }

    #[test]
    fn theme_rules_emit_chapter_position_top() {
        let resolved = ResolvedTheme {
            chapter_title_position: Some("top".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        assert!(block.contains("body.chapter-title-body {"));
        assert!(block.contains("display: block;"));
        assert!(block.contains("padding-top: 2em;"));
        assert!(block.contains(".chapter-heading-inner {"));
        assert!(!block.contains("amzn-kf8"));
    }

    #[test]
    fn theme_rules_emit_chapter_position_bottom() {
        let resolved = ResolvedTheme {
            chapter_title_position: Some("bottom".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        assert!(block.contains("vertical-align: bottom;"));
        assert!(block.contains("padding-bottom: 2em;"));
        assert!(block.contains("@media amzn-kf8 {"));
        assert!(block.contains("padding-top: 80%;"));
    }

    #[test]
    fn theme_rules_ignore_invalid_chapter_position() {
        for val in ["center", "garbage", "TOP", " top", ""] {
            let resolved = ResolvedTheme {
                chapter_title_position: Some(val.into()),
                ..Default::default()
            };
            let block = build_theme_rules_block(&resolved);
            // "center" y valores fuera del whitelist → comportamiento default
            // (CSS base centra; nada emitido acá). " top" tiene whitespace
            // alrededor: el trim lo acepta, así que ese caso sí emite. Ajuste:
            if val.trim() == "top" {
                assert!(block.contains("padding-top: 2em;"), "expected top for '{}'", val);
            } else {
                assert!(
                    !block.contains("padding-top: 2em") && !block.contains("vertical-align: bottom"),
                    "expected no override for '{}'", val
                );
            }
        }
    }

    #[test]
    fn theme_rules_chapter_position_does_not_collide_with_font_rules() {
        let resolved = ResolvedTheme {
            body_font: Some("Merriweather".into()),
            chapter_title_position: Some("top".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        assert!(block.contains("font-family: \"Merriweather\", serif;"));
        assert!(block.contains("padding-top: 2em;"));
    }

    #[test]
    fn heading_font_excludes_nav_selectors() {
        let resolved = ResolvedTheme {
            heading_font: Some("Lato".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        // Chapter heading selectors permanecen.
        assert!(block.contains("h1.chapter-title, .chapter-prefix, h2.part-label, span.dropcap {"));
        // nav h1 + parte-headings ya NO viven en el bloque heading_font — son
        // editorial. Cuando editorial NO se setea, nav cae al cascade del body.
        assert!(!block.contains("nav h1"));
        assert!(!block.contains("nav ol.toc > li.toc-part > a"));
    }

    #[test]
    fn copyright_localizes_by_idioma() {
        let cfg_es = BookConfig {
            titulo: "Test".into(),
            autor: Some("Ignacio".into()),
            idioma: Some("es".into()),
            copyright_anio: Some(2026),
            derechos_reservados: Some(true),
            imprenta: Some("Mi Imprenta".into()),
            ..Default::default()
        };
        let xhtml_es = build_copyright_xhtml(&cfg_es);
        assert!(xhtml_es.contains("Copyright \u{00A9} 2026 por Ignacio"));
        assert!(xhtml_es.contains("Todos los derechos reservados"));
        assert!(xhtml_es.contains("Publicado por Mi Imprenta"));
        assert!(xhtml_es.contains("Editado con tWriter"));
        assert!(!xhtml_es.contains(" by Ignacio"));

        let cfg_en = BookConfig {
            titulo: "Test".into(),
            autor: Some("Ignacio".into()),
            idioma: Some("en".into()),
            copyright_anio: Some(2026),
            derechos_reservados: Some(true),
            imprenta: Some("My Press".into()),
            ..Default::default()
        };
        let xhtml_en = build_copyright_xhtml(&cfg_en);
        assert!(xhtml_en.contains("Copyright \u{00A9} 2026 by Ignacio"));
        assert!(xhtml_en.contains("All rights reserved"));
        assert!(xhtml_en.contains("Published by My Press"));
        assert!(xhtml_en.contains("Edited with tWriter"));
        assert!(!xhtml_en.contains(" por Ignacio"));
    }

    #[test]
    fn toc_heading_localizes_and_drops_chapter_class() {
        let cfg_es = BookConfig {
            titulo: "Test".into(),
            idioma: Some("es".into()),
            ..Default::default()
        };
        let xhtml_es = build_toc_xhtml(&cfg_es, &[]);
        assert!(xhtml_es.contains("<h1>Índice</h1>"));
        // El heading del TOC ya no usa `class="chapter-title"`. Sin esa clase,
        // no se contagia el font del chapter heading.
        assert!(!xhtml_es.contains(r#"<h1 class="chapter-title">"#));

        let cfg_en = BookConfig {
            titulo: "Test".into(),
            idioma: Some("en".into()),
            ..Default::default()
        };
        let xhtml_en = build_toc_xhtml(&cfg_en, &[]);
        assert!(xhtml_en.contains("<h1>Contents</h1>"));
    }

    #[test]
    fn theme_rules_no_editorial_when_unset() {
        let resolved = ResolvedTheme {
            body_font: Some("Merriweather".into()),
            heading_font: Some("Lato".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        // Sin slots editoriales: no aparecen las reglas dedicadas.
        assert!(!block.contains("body.copyright-body, body.dedication-body"));
        assert!(!block.contains("h1.about-author-title"));
    }

    #[test]
    fn about_author_xhtml_renders_heading_photo_and_bio() {
        let cfg = BookConfig {
            titulo: "Test".into(),
            autor: Some("Ignacio".into()),
            idioma: Some("es".into()),
            sobre_el_autor: Some("Nací en Cipolletti.\nVivo escribiendo.".into()),
            ..Default::default()
        };
        let xhtml = build_about_author_xhtml(&cfg, Some("author.jpg"));
        assert!(xhtml.contains("<body class=\"about-author-body\">"));
        assert!(xhtml.contains("<h1 class=\"about-author-title\">Sobre el autor</h1>"));
        assert!(xhtml.contains("<img class=\"about-author-photo\" src=\"author.jpg\""));
        assert!(xhtml.contains("<p>Nací en Cipolletti.</p>"));
        assert!(xhtml.contains("<p>Vivo escribiendo.</p>"));
    }

    #[test]
    fn about_author_xhtml_english_heading() {
        let cfg = BookConfig {
            titulo: "Test".into(),
            idioma: Some("en".into()),
            sobre_el_autor: Some("Bio.".into()),
            ..Default::default()
        };
        let xhtml = build_about_author_xhtml(&cfg, None);
        assert!(xhtml.contains("About the author"));
        // Sin photo: no aparece <img>.
        assert!(!xhtml.contains("<img"));
    }

    #[test]
    fn part_label_localizes_parte_format() {
        let part = ChapterPart {
            stem: "1".into(),
            meta_title: None,
            content_html: String::new(),
        };
        assert_eq!(part_label(&part, "parte", "es"), "Parte 1");
        assert_eq!(part_label(&part, "parte", "en"), "Part 1");
        // "punto" no varía por idioma.
        assert_eq!(part_label(&part, "punto", "es"), "1.");
        assert_eq!(part_label(&part, "punto", "en"), "1.");
    }

    #[test]
    fn export_impl_localizes_chapter_label_in_english() {
        let tmp = tempdir();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        // idioma=en, sin prefijo y sin mostrar título → fallback "Chapter N".
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"X","idioma":"en","mostrar_titulo_capitulo":false}"#,
        )
        .unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let toc = String::from_utf8(entries.get("OEBPS/toc.xhtml").unwrap().clone()).unwrap();
        assert!(toc.contains(">Chapter 1<"));
        assert!(!toc.contains("Capítulo"));
    }

    #[test]
    fn export_impl_with_about_author_inserts_page() {
        let tmp = tempdir();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"Test","autor":"X","sobre_el_autor":"Una bio."}"#,
        )
        .unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>Hi.</p>").unwrap();
        let result = export_impl(book.to_str().unwrap()).expect("export ok");
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        assert!(entries.contains_key("OEBPS/8_about_author.xhtml"));
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(opf.contains("8_about_author.xhtml"));
        assert!(opf.contains(r#"id="about-author""#));
    }

    #[test]
    fn export_impl_without_bio_skips_about_author() {
        let tmp = tempdir();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(book.join("book.json"), r#"{"titulo":"Test"}"#).unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>Hi.</p>").unwrap();
        let result = export_impl(book.to_str().unwrap()).expect("export ok");
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        assert!(!entries.contains_key("OEBPS/8_about_author.xhtml"));
    }

    #[test]
    fn export_impl_unconfigured_no_ibooks_meta() {
        let tmp = tempdir();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(book.join("book.json"), r#"{"titulo":"X"}"#).unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        // Sin fuentes embebidas: no se declara el namespace ibooks ni el meta.
        assert!(!opf.contains("ibooks:specified-fonts"));
        assert!(!opf.contains("vocabulary.itunes.apple.com"));
    }

    fn tempdir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let suffix: u128 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("twriter-epub-test-{}", suffix));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
