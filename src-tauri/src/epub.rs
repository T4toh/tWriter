use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

#[derive(Serialize, Debug)]
pub struct ExportResult {
    pub epub_path: String,
    pub chapters: u32,
}

#[derive(Debug, Default)]
struct BookMeta {
    titulo: String,
    autor: String,
    idioma: String,
}

struct ChapterPart {
    id: String,
    href: String,
    section_title: Option<String>,
    title: String,
    content_html: String,
}

const CSS: &str = include_str!("epub_style.css");

const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;

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

    let meta = read_book_meta(&book_dir);
    let parts = collect_parts(&book_dir)?;
    if parts.is_empty() {
        return Err("libro sin capítulos .html".to_string());
    }

    let exports_dir = book_dir.join("exports");
    fs::create_dir_all(&exports_dir).map_err(|e| e.to_string())?;
    let safe_title = sanitize_filename(&meta.titulo);
    let epub_path = exports_dir.join(format!("{}.epub", safe_title));

    let file = File::create(&epub_path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);

    // mimetype: STORED (no compression), primero
    let mimetype_opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored);
    zip.start_file("mimetype", mimetype_opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(b"application/epub+zip")
        .map_err(|e| e.to_string())?;

    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // META-INF/container.xml
    zip.start_file("META-INF/container.xml", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(CONTAINER_XML.as_bytes())
        .map_err(|e| e.to_string())?;

    // OEBPS/style.css
    zip.start_file("OEBPS/style.css", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(CSS.as_bytes()).map_err(|e| e.to_string())?;

    // OEBPS/<part>.xhtml
    for p in &parts {
        zip.start_file(format!("OEBPS/{}", p.href), opts)
            .map_err(|e| e.to_string())?;
        let xhtml = build_chapter_xhtml(p);
        zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
    }

    // OEBPS/nav.xhtml
    zip.start_file("OEBPS/nav.xhtml", opts)
        .map_err(|e| e.to_string())?;
    let nav_xhtml = build_nav_xhtml(&meta, &parts);
    zip.write_all(nav_xhtml.as_bytes())
        .map_err(|e| e.to_string())?;

    // OEBPS/content.opf
    zip.start_file("OEBPS/content.opf", opts)
        .map_err(|e| e.to_string())?;
    let opf = build_opf(&meta, &parts);
    zip.write_all(opf.as_bytes()).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;

    Ok(ExportResult {
        epub_path: epub_path.to_string_lossy().into_owned(),
        chapters: parts.len() as u32,
    })
}

fn read_book_meta(book_dir: &Path) -> BookMeta {
    let mut meta = BookMeta {
        titulo: strip_numeric_prefix(
            book_dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Sin título"),
        ),
        autor: "".to_string(),
        idioma: "es".to_string(),
    };
    let book_json = book_dir.join("book.json");
    if let Ok(raw) = fs::read_to_string(&book_json) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(t) = v.get("titulo").and_then(|s| s.as_str()) {
                meta.titulo = t.to_string();
            }
            if let Some(a) = v.get("autor").and_then(|s| s.as_str()) {
                meta.autor = a.to_string();
            }
            if let Some(l) = v.get("idioma").and_then(|s| s.as_str()) {
                meta.idioma = l.to_string();
            }
        }
    }
    // Fallback: leer saga.json del padre
    if meta.autor.is_empty() {
        if let Some(parent) = book_dir.parent() {
            let saga_json = parent.join("saga.json");
            if let Ok(raw) = fs::read_to_string(&saga_json) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(a) = v.get("autor").and_then(|s| s.as_str()) {
                        meta.autor = a.to_string();
                    }
                }
            }
        }
    }
    meta
}

fn collect_parts(book_dir: &Path) -> Result<Vec<ChapterPart>, String> {
    // Estructura: book contiene sections (dirs "N - X") con parts (.html numerados)
    // OR contiene .html numerados directos.
    let mut sections: Vec<(String, Vec<PathBuf>)> = Vec::new();

    // Sections (subdirs ordenados)
    let mut subdirs: Vec<PathBuf> = fs::read_dir(book_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
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

    for d in &subdirs {
        let title = strip_numeric_prefix(
            d.file_name().and_then(|s| s.to_str()).unwrap_or(""),
        );
        let mut parts = collect_html_parts_in(d)?;
        parts.sort();
        if !parts.is_empty() {
            sections.push((title, parts));
        }
    }

    // Si no hay secciones, intentar .html directos en el book
    if sections.is_empty() {
        let mut direct = collect_html_parts_in(book_dir)?;
        direct.sort();
        if !direct.is_empty() {
            sections.push((String::new(), direct));
        }
    }

    let mut out: Vec<ChapterPart> = Vec::new();
    let mut idx = 0u32;
    for (sec_title, paths) in sections {
        for (i, p) in paths.iter().enumerate() {
            idx += 1;
            let id = format!("c{}", idx);
            let href = format!("{}.xhtml", id);
            let part_num = p.file_stem().and_then(|s| s.to_str()).unwrap_or(&id).to_string();
            let content = fs::read_to_string(p).map_err(|e| e.to_string())?;
            out.push(ChapterPart {
                id,
                href,
                section_title: if i == 0 && !sec_title.is_empty() {
                    Some(sec_title.clone())
                } else {
                    None
                },
                title: if i == 0 && !sec_title.is_empty() {
                    sec_title.clone()
                } else {
                    format!("{} · {}", sec_title, part_num).trim_start_matches(" · ").to_string()
                },
                content_html: content,
            });
        }
    }
    Ok(out)
}

fn collect_html_parts_in(dir: &Path) -> Result<Vec<PathBuf>, String> {
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

fn build_chapter_xhtml(p: &ChapterPart) -> String {
    let head = if let Some(sec) = &p.section_title {
        format!(
            "<div class=\"chapter-heading\"><h1 class=\"chapter-title\">{}</h1></div>",
            xml_escape(sec)
        )
    } else {
        String::new()
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
<meta charset="UTF-8" />
<title>{}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
{}
<div class="chapter-content">
{}
</div>
</body>
</html>
"#,
        xml_escape(&p.title),
        head,
        p.content_html.trim()
    )
}

fn build_nav_xhtml(meta: &BookMeta, parts: &[ChapterPart]) -> String {
    let mut entries = String::new();
    for p in parts {
        if let Some(sec) = &p.section_title {
            entries.push_str(&format!(
                "<li><a href=\"{}\">{}</a></li>\n",
                p.href,
                xml_escape(sec)
            ));
        }
    }
    if entries.is_empty() {
        // Sin sección — listamos cada parte
        for p in parts {
            entries.push_str(&format!(
                "<li><a href=\"{}\">{}</a></li>\n",
                p.href,
                xml_escape(&p.title)
            ));
        }
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>{}</title></head>
<body>
<nav epub:type="toc">
<h1>Índice</h1>
<ol>
{}
</ol>
</nav>
</body>
</html>
"#,
        xml_escape(&meta.titulo),
        entries
    )
}

fn build_opf(meta: &BookMeta, parts: &[ChapterPart]) -> String {
    let book_id = format!("urn:uuid:{}", Uuid::new_v4());
    let modified = chrono_iso();
    let mut manifest = String::from(
        r#"<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>"#,
    );
    let mut spine = String::new();
    for p in parts {
        manifest.push_str(&format!(
            "\n<item id=\"{}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>",
            p.id, p.href
        ));
        spine.push_str(&format!("\n<itemref idref=\"{}\"/>", p.id));
    }
    let creator = if meta.autor.is_empty() {
        "".to_string()
    } else {
        format!("<dc:creator>{}</dc:creator>", xml_escape(&meta.autor))
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" xml:lang="{}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="BookId">{}</dc:identifier>
<dc:title>{}</dc:title>
{}
<dc:language>{}</dc:language>
<meta property="dcterms:modified">{}</meta>
</metadata>
<manifest>
{}
</manifest>
<spine>
{}
</spine>
</package>
"#,
        meta.idioma,
        book_id,
        xml_escape(&meta.titulo),
        creator,
        meta.idioma,
        modified,
        manifest,
        spine.trim_start()
    )
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
    // "1 - Foo" → "Foo"
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

fn chrono_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso8601_from_secs(secs)
}

fn iso8601_from_secs(secs: u64) -> String {
    // Implementación mínima sin chrono crate. UTC.
    let days_since_epoch = (secs / 86_400) as i64;
    let secs_today = secs % 86_400;
    let h = (secs_today / 3600) as u32;
    let m = ((secs_today / 60) % 60) as u32;
    let s = (secs_today % 60) as u32;
    let (year, month, day) = ymd_from_days(days_since_epoch);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}

fn ymd_from_days(days: i64) -> (i32, u32, u32) {
    // Algoritmo civil_from_days de Howard Hinnant (Public Domain)
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
