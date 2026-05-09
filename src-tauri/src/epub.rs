use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

use crate::book_config::{find_back_cover_in, find_cover_in, BookConfig};
use crate::fs::is_excluded_dir;

#[derive(Serialize, Debug)]
pub struct ExportResult {
    pub epub_path: String,
    pub chapters: u32,
}

const CSS_TEMPLATE: &str = include_str!("epub_style.css");

fn build_css(template: &str) -> String {
    let page_rule = match template {
        "5x8" => "@page { size: 5in 8in; margin: 0.6in; }",
        "a5" => "@page { size: A5; margin: 18mm; }",
        _ => "@page { size: 6in 9in; margin: 0.75in; }",
    };
    CSS_TEMPLATE.replace("/* @PAGE_SIZE */", page_rule)
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
        return Err(format!("no es directorio: {}", book_path));
    }
    let cfg = read_or_default_config(&book_dir);

    let chapters = collect_chapters(&book_dir)?;
    if chapters.is_empty() {
        return Err("libro sin capítulos .html".to_string());
    }

    let exports_dir = book_dir.join("exports");
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

    // OEBPS/style.css
    let template = cfg.template.as_deref().unwrap_or("6x9");
    let css = build_css(template);
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
            (None, false) => format!("Capítulo {}", ch_idx + 1),
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
            let part_label = part_label(part, part_format);
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

    zip.finish().map_err(|e| e.to_string())?;

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

fn collect_chapters(book_dir: &Path) -> Result<Vec<Chapter>, String> {
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
                .map(|n| !["exports", "Revisiones", "convertidos", ".git"].contains(&n))
                .unwrap_or(true)
        })
        .collect();
    subdirs.sort_by(|a, b| {
        let na = leading_num(a.file_name().and_then(|s| s.to_str()).unwrap_or(""));
        let nb = leading_num(b.file_name().and_then(|s| s.to_str()).unwrap_or(""));
        na.cmp(&nb)
    });

    let mut chapters = Vec::new();
    for d in &subdirs {
        let ch_title = strip_numeric_prefix(
            d.file_name().and_then(|s| s.to_str()).unwrap_or(""),
        );
        let mut parts = collect_html_parts(d)?;
        parts.sort();
        if parts.is_empty() {
            continue;
        }
        let mut chapter_parts = Vec::new();
        for p in &parts {
            chapter_parts.push(load_part(p)?);
        }
        chapters.push(Chapter { title: ch_title, parts: chapter_parts });
    }

    // Si no había secciones, tratamos el libro entero como un solo capítulo
    if chapters.is_empty() {
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
    Ok(chapters)
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
    let imprenta = cfg.imprenta.as_deref().unwrap_or("Independiente");
    let mut body = String::new();
    body.push_str(&format!(
        "<p>Copyright \u{00A9} {} by {}</p>\n",
        anio,
        xml_escape(autor)
    ));
    if cfg.derechos_reservados.unwrap_or(true) {
        body.push_str(
            "<p>Todos los derechos reservados. Ninguna parte de esta publicación puede ser reproducida, almacenada ni transmitida en forma alguna por medio electrónico, mecánico, fotocopia, grabación u otros sin autorización escrita del autor.</p>\n",
        );
        body.push_str(
            "<p>Esta novela es enteramente una obra de ficción. Los nombres, personajes y eventos retratados son producto de la imaginación del autor. Cualquier parecido con personas reales, vivas o fallecidas, eventos o lugares es enteramente coincidencia.</p>\n",
        );
    }
    if let Some(isbn) = cfg.isbn.as_deref().filter(|s| !s.is_empty()) {
        body.push_str(&format!("<p>ISBN: {}</p>\n", xml_escape(isbn)));
    }
    body.push_str(&format!(
        "<p>{}</p>\n",
        xml_escape(&format!("Publicado por {}", imprenta))
    ));
    body.push_str("<p>Editado con tWriter</p>");

    xhtml_shell(
        &cfg.titulo,
        &body,
        cfg.idioma.as_deref().unwrap_or("es"),
        "copyright-body",
    )
}

fn build_dedication_xhtml(text: &str) -> String {
    let body = text
        .lines()
        .map(|l| format!("<p>{}</p>", xml_escape(l.trim())))
        .collect::<Vec<_>>()
        .join("\n");
    xhtml_shell("Dedicatoria", &body, "es", "dedication-body")
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

fn part_label(part: &ChapterPart, format: &str) -> String {
    if let Some(t) = &part.meta_title {
        return t.clone();
    }
    // Fallback: usar stem con formato
    let stem = &part.stem;
    let is_numeric = stem.chars().all(|c| c.is_ascii_digit());
    match format {
        "parte" if is_numeric => format!("Parte {}", stem),
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
    let body = format!(
        r#"<nav id="toc" epub:type="toc" role="doc-toc">
<h1 class="chapter-title">Índice</h1>
<ol class="toc">
{}
</ol>
</nav>"#,
        lis
    );
    xhtml_shell(
        &cfg.titulo,
        &body,
        cfg.idioma.as_deref().unwrap_or("es"),
        "nav-body",
    )
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

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" xml:lang="{}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="BookId">urn:uuid:{}</dc:identifier>
{}
<dc:title>{}</dc:title>
{}
<dc:language>{}</dc:language>
<meta property="dcterms:modified">{}</meta>
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
        book_uuid,
        isbn_id,
        xml_escape(&cfg.titulo),
        creator,
        lang,
        modified,
        cover_meta,
        serie_meta,
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
