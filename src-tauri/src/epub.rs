use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

use crate::book_config::{
    find_back_cover_in, find_cover_in, image_field_unusable, resolver_imagen, BookConfig,
};
use crate::fs::is_excluded_dir;
use crate::util::strip_numeric_prefix;
use crate::theme::{resolve_theme, FontEmbed, ResolvedTheme};

#[derive(Serialize, Debug)]
pub struct ExportResult {
    pub epub_path: String,
    pub chapters: u32,
    /// Problemas que no abortaron el export pero que el autor tiene que ver
    /// (tapas que faltan, imágenes que no se pudieron procesar).
    pub avisos: Vec<String>,
}

/// Un paso del export, para que la UI diga en qué anda en vez de mostrar un
/// spinner ciego. `hecho`/`total` solo tienen sentido en la fase de capítulos;
/// en las demás van en 0 y la UI muestra solo el texto.
#[derive(Serialize, Clone, Debug)]
pub struct ExportProgress {
    pub fase: String,
    pub hecho: u32,
    pub total: u32,
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
    out.sort_by_key(|a| std::cmp::Reverse(a.modified_ms.unwrap_or(0)));
    Ok(out)
}

const CSS_REL: &str = "resources/epub_style.css";

/// La hoja del EPUB en el repo. En dev se lee de acá y no de la copia que
/// `tauri-build` deja en `target/`: editarla y exportar de nuevo alcanza.
fn css_template_dev_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(CSS_REL)
}

/// La hoja se lee en runtime, no con `include_str!`. Con `include_str!` el CSS
/// quedaba adentro del binario y el watcher de `tauri dev` solo mira `.rs`, así
/// que tocarla no cambiaba nada en la app corriendo: se editaba, se exportaba,
/// no pasaba nada, y uno terminaba "arreglando" un CSS que ya estaba bien.
fn css_template(app: &AppHandle) -> Result<String, String> {
    let ruta = if cfg!(debug_assertions) {
        css_template_dev_path()
    } else {
        app.path()
            .resolve(CSS_REL, BaseDirectory::Resource)
            .map_err(|e| format!("no pude resolver {}: {}", CSS_REL, e))?
    };
    fs::read_to_string(&ruta).map_err(|e| {
        format!(
            "no pude leer la hoja de estilos del EPUB en {}: {}. El bundle está incompleto — reinstalá la app.",
            ruta.display(),
            e
        )
    })
}

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
            "body.title-body, body.copyright-body, body.dedication-body, body.nav-body, body.about-author-body, body.otros-libros-body {\n",
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
            "p.title-page-title, nav h1, nav ol.toc > li.toc-part > a, h1.about-author-title, .otros-libros h1 {\n",
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

    // Italic/bold se sintetizan en el reader desde la regular embebida. Por
    // default no emitimos overrides CSS — el UA stylesheet del reader aplica
    // `font-style: italic` y `font-weight: bold` a `<em>`/`<strong>`. Si el
    // tema tiene tunings explícitos (oblique angle / bold weight), emitimos
    // overrides puntuales solo para esas propiedades.
    // Italic weight cascade: italic_weight gana; si vacío, hereda bold_weight
    // (con bold_weight bumped, italic también queda bumped — el caso clásico
    // de "esta fuente la italic se confunde con la regular").
    let italic_w = theme
        .italic_weight
        .or(theme.bold_weight)
        .map(|w| w.clamp(100, 900));
    if theme.italic_oblique_deg.is_some() || italic_w.is_some() {
        out.push_str("em, i {\n");
        if let Some(deg) = theme.italic_oblique_deg {
            out.push_str(&format!("  font-style: oblique {:.1}deg;\n", deg));
        }
        if let Some(w) = italic_w {
            out.push_str(&format!("  font-weight: {};\n", w));
        }
        out.push_str("}\n");
    }
    if let Some(w) = theme.bold_weight {
        let w = w.clamp(100, 900);
        out.push_str(&format!(
            "strong, b {{\n  font-weight: {};\n}}\n",
            w
        ));
        // Combo bold+italic: bold_weight gana sobre italic_weight para que
        // <strong><em> se vea bold sin importar el orden de anidamiento.
        out.push_str(&format!(
            "strong em, strong i, em strong, em b, b em, b i, i strong, i b {{\n  font-weight: {};\n}}\n",
            w
        ));
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

fn build_css(plantilla: &str, template: &str, theme: &ResolvedTheme) -> String {
    let page_rule = page_rule_for(template, theme.page_margin.as_deref());
    let font_face = build_font_face_block(&theme.fonts);
    let theme_rules = build_theme_rules_block(theme);
    plantilla
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
pub async fn export_book(app: AppHandle, book_path: String) -> Result<ExportResult, String> {
    let plantilla_css = css_template(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut emit_cb = |p: ExportProgress| {
            let _ = app.emit("epub-export-progress", p);
        };
        export_impl(&book_path, &plantilla_css, Some(&mut emit_cb))
    })
    .await
    .map_err(|e| format!("task: {}", e))?
}

fn export_impl(
    book_path: &str,
    plantilla_css: &str,
    mut progreso: Option<&mut dyn FnMut(ExportProgress)>,
) -> Result<ExportResult, String> {
    // Mismo patrón que `search::full_reindex`: el impl no conoce Tauri, así que
    // sigue siendo testeable sin AppHandle.
    macro_rules! avisar {
        ($fase:expr) => {
            avisar!($fase, 0, 0)
        };
        ($fase:expr, $hecho:expr, $total:expr) => {
            if let Some(cb) = progreso.as_deref_mut() {
                cb(ExportProgress {
                    fase: $fase.to_string(),
                    hecho: $hecho,
                    total: $total,
                });
            }
        };
    }
    let book_dir = PathBuf::from(book_path);
    if !book_dir.is_dir() {
        tracing::error!(target: "epub", path = %book_path, "export_book: no es directorio");
        return Err(format!("no es directorio: {}", book_path));
    }
    let cfg = read_or_default_config(&book_dir);
    tracing::info!(target: "epub", titulo = %cfg.titulo, "iniciando export");

    avisar!("Leyendo capítulos");
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
    // El template (tamaño de página) ahora vive en el tema. Legacy fallback
    // a cfg.template lo cubre resolve_theme.
    let template = resolved_theme
        .template
        .as_deref()
        .or(cfg.template.as_deref())
        .unwrap_or("6x9");
    let css = build_css(plantilla_css, template, &resolved_theme);
    zip.start_file("OEBPS/style.css", opts).map_err(|e| e.to_string())?;
    zip.write_all(css.as_bytes()).map_err(|e| e.to_string())?;

    let mut items: Vec<Item> = Vec::new();
    let mut avisos: Vec<String> = Vec::new();
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

    avisar!("Embebiendo tapas e imágenes");
    // 1) Cover (si hay imagen). Reescalada: las tapas del repo son PNG de
    // imprenta de varios MB y KDP cobra delivery por MB. 1600 px de ancho es
    // lo que recomienda Amazon para la portada de un ebook.
    if let Some(origen) = resolver_imagen(&book_dir, cfg.tapa.as_deref()) {
        if let Some(cover_filename) = embebido_reescalado(
            &origen,
            "cover",
            1600,
            false,
            &mut zip,
            opts,
            &mut items,
            "cover-image",
            &mut avisos,
        )? {
            // `embebido_reescalado` no sabe de `properties`; se la ponemos acá.
            // `last_mut` alcanza: el item de la tapa es el que `embebido_reescalado`
            // acaba de pushear a `items`, así que siempre es el último.
            if let Some(it) = items.last_mut() {
                it.properties = Some("cover-image".into());
            }
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
    // Estilo de capítulos viene del tema (con legacy fallback a cfg.* aplicado
    // dentro de resolve_theme para repos sin tema configurado).
    let show_chapter_title = resolved_theme.mostrar_titulo_capitulo.unwrap_or(true);
    let prefix_style = resolved_theme
        .prefijo_capitulo
        .as_deref()
        .unwrap_or("none");
    let use_dropcap = resolved_theme.dropcap.unwrap_or(false);
    let show_part_num = resolved_theme.mostrar_numero_parte.unwrap_or(false);
    let part_format = resolved_theme.formato_parte.as_deref().unwrap_or("raw");

    let lang_str = cfg.idioma.as_deref().unwrap_or("es").to_string();
    let is_en = lang_str == "en";

    let mut toc_entries: Vec<TocEntry> = Vec::new();
    let mut file_seq = 10u32;
    let total_caps = chapters.len() as u32;
    for (ch_idx, chapter) in chapters.iter().enumerate() {
        avisar!("Escribiendo capítulos", ch_idx as u32, total_caps);
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
            editorial: false,
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
                editorial: false,
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
            editorial: false,
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
                editorial: false,
            });
        }
        toc_entries.push(entry);
    }

    // 5a-ter) Página en blanco que cierra la novela. Solo va si después
    // viene back matter (catálogo o "Sobre el autor"); si no hay nada
    // detrás, la página en blanco sería un defecto visual sin propósito.
    // No entra al índice (ni toc.xhtml ni toc.ncx): no es un destino de
    // navegación, es un cierre visual.
    let catalogo = crate::catalogo::escanear(&root_dir, &book_dir);
    let perfil = crate::autor::leer(&root_dir);
    let bio_libro = cfg
        .sobre_el_autor
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let bio = bio_libro.or_else(|| perfil.bio_en(cfg.idioma.as_deref().unwrap_or("es")));
    let hay_back_matter =
        !catalogo.misma_saga.is_empty() || !catalogo.otros.is_empty() || bio.is_some();
    if hay_back_matter {
        spine_idx += 1;
        let xhtml = xhtml_shell("", "", &lang_str, "blank-body");
        zip.start_file("OEBPS/6_blank.xhtml", opts).map_err(|e| e.to_string())?;
        zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
        items.push(Item {
            id: "blank-separator".into(),
            href: "6_blank.xhtml".into(),
            media_type: "application/xhtml+xml".into(),
            spine_order: Some(spine_idx),
            properties: None,
        });
    }

    // 5c) Otros libros del autor. El catálogo sale de escanear el root: un
    // libro está publicado si su book.json tiene `link`.
    if !catalogo.misma_saga.is_empty() || !catalogo.otros.is_empty() {
        // Indexado por posición y no por `link`: dos libros publicados pueden
        // compartir el mismo link (ej: placeholder mientras no existe la
        // página del libro), y un HashMap<link, _> haría que el segundo pise
        // la miniatura del primero.
        let total = catalogo.misma_saga.len() + catalogo.otros.len();
        let mut tapas: Vec<Option<String>> = vec![None; total];
        for (idx, libro) in catalogo
            .misma_saga
            .iter()
            .chain(catalogo.otros.iter())
            .enumerate()
        {
            let Some(origen) = &libro.tapa else {
                // El libro está publicado pero su imagen no está en disco.
                // No es motivo para abortar el export, pero sí para decirlo.
                avisos.push(format!(
                    "\"{}\" se listó sin tapa: no encontré la imagen al lado de su book.json",
                    libro.titulo
                ));
                continue;
            };
            let Some(dest) = embebido_reescalado(
                origen,
                &format!("cat-{}", idx),
                400,
                false,
                &mut zip,
                opts,
                &mut items,
                &format!("cat-image-{}", idx),
                &mut avisos,
            )?
            else {
                continue;
            };
            tapas[idx] = Some(dest);
        }

        spine_idx += 1;
        let xhtml = build_otros_libros_xhtml(&cfg, &catalogo, &tapas);
        zip.start_file("OEBPS/7_otros_libros.xhtml", opts).map_err(|e| e.to_string())?;
        zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
        items.push(Item {
            id: "otros-libros".into(),
            href: "7_otros_libros.xhtml".into(),
            media_type: "application/xhtml+xml".into(),
            spine_order: Some(spine_idx),
            properties: None,
        });
    }

    // 5a-bis) Sobre el autor. La bio, la foto, la web y el QR salen de
    // autor.json en la raíz; el book.json puede pisar bio y foto. `perfil`
    // y `bio` ya se calcularon arriba para decidir la página en blanco.
    if let Some(bio) = bio {
        // Foto: la del libro gana; si no, la del perfil global.
        let foto_origen = resolver_imagen(&book_dir, cfg.foto_autor.as_deref())
            .or_else(|| resolver_imagen(&root_dir, perfil.foto.as_deref()));

        let foto_filename = match foto_origen {
            Some(origen) => embebido_reescalado(
                &origen,
                "author",
                600,
                false,
                &mut zip,
                opts,
                &mut items,
                "author-image",
                &mut avisos,
            )?,
            None => None,
        };

        // El QR solo tiene sentido junto a la web: el builder no lo referencia
        // sin `web`, así que embeberlo igual dejaría un recurso colgado en el
        // manifest. Misma condición que usa build_about_author_xhtml.
        let hay_web = perfil.web.as_deref().map(str::trim).is_some_and(|s| !s.is_empty());
        let qr_filename = match hay_web
            .then(|| crate::book_config::resolver_imagen(&root_dir, perfil.qr.as_deref()))
            .flatten()
        {
            Some(origen) => embebido_reescalado(
                &origen,
                "author-qr",
                600,
                true,
                &mut zip,
                opts,
                &mut items,
                "author-qr-image",
                &mut avisos,
            )?,
            None => None,
        };

        spine_idx += 1;
        let xhtml = build_about_author_xhtml(
            &cfg,
            bio,
            foto_filename.as_deref(),
            perfil.web.as_deref(),
            qr_filename.as_deref(),
        );
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

    // 5b) Back cover (si hay imagen). Reescalada por el mismo motivo que la
    // tapa: sale del mismo repo, a la misma resolución de imprenta.
    if let Some(origen) = resolver_imagen(&book_dir, cfg.contratapa.as_deref()) {
        if let Some(bc_filename) = embebido_reescalado(
            &origen,
            "back-cover",
            1600,
            false,
            &mut zip,
            opts,
            &mut items,
            "back-cover-image",
            &mut avisos,
        )? {
            spine_idx += 1;
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

    // Índice: las páginas editoriales van agrupadas, delante y detrás de los
    // capítulos. Solo entran las que efectivamente se generaron.
    let ed = |href: &str, label: &str| TocEntry {
        href: href.to_string(),
        label: label.to_string(),
        children: Vec::new(),
        editorial: true,
    };
    let mut front: Vec<TocEntry> = vec![ed("2_copyright.xhtml", "Copyright")];
    if items.iter().any(|i| i.id == "dedication") {
        front.push(ed(
            "3_dedication.xhtml",
            if is_en { "Dedication" } else { "Dedicatoria" },
        ));
    }
    if items.iter().any(|i| i.id == "otros-libros") {
        toc_entries.push(ed(
            "7_otros_libros.xhtml",
            if is_en { "Also by the Author" } else { "Otros libros" },
        ));
    }
    if items.iter().any(|i| i.id == "about-author") {
        toc_entries.push(ed(
            "8_about_author.xhtml",
            if is_en { "About the Author" } else { "Sobre el autor" },
        ));
    }
    front.append(&mut toc_entries);
    let toc_entries = front;

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

    avisar!("Armando índice y empaquetando");
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
        avisos,
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
    /// Página editorial (copyright, dedicatoria, catálogo, bio) en vez de
    /// capítulo. Se renderea atenuada y agrupada, para que el listado de
    /// capítulos siga dominando la pantalla.
    editorial: bool,
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
        sort_parts(&mut parts);
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
        sort_parts(&mut direct);
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
        content_html: close_void_elements(&content),
    })
}

/// Autocierra `<br>` y `<hr>` sueltos (`<br/>`) para que el XHTML sea válido.
/// El editor todavía escribe HTML sin autocerrar en los .html de capítulo
/// (ver TODO.md); Apple Books usa un parser estricto y aborta con "Opening
/// and ending tag mismatch" apenas encuentra el primero, mientras que
/// Thorium es tolerante y lo deja pasar. Se arregla acá, a la salida del
/// EPUB, sin tocar el archivo fuente.
///
/// Solo toca las etiquetas `br`/`hr` (los únicos void elements del subset de
/// HTML del proyecto además de `img`, que ya sale bien formado). Cualquier
/// tag ya autocerrado (`<br/>`, `<br />`) se deja tal cual byte a byte; el
/// resto del markup y el texto no se tocan.
fn close_void_elements(html: &str) -> String {
    let re = regex::Regex::new(r"(?i)<(br|hr)\b[^<>]*>").expect("regex de void elements válida");
    re.replace_all(html, |caps: &regex::Captures| {
        let full = &caps[0];
        let sin_cierre = full.trim_end_matches('>');
        if sin_cierre.trim_end().ends_with('/') {
            // Ya autocerrado (con o sin espacio antes de la barra): no tocar.
            full.to_string()
        } else {
            format!("{}/>", sin_cierre)
        }
    })
    .into_owned()
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

fn sort_parts(parts: &mut [PathBuf]) {
    parts.sort_by(|a, b| {
        let sa = a.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let sb = b.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        leading_num(sa).cmp(&leading_num(sb)).then_with(|| sa.cmp(sb))
    });
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

/// Lee una imagen de disco, la reescala y la mete al zip + al manifest.
/// `nitido` usa el camino PNG sin recomprimir (QR); si no, va a JPEG.
/// Devuelve el nombre del archivo dentro del EPUB, o None si no se pudo —
/// nunca aborta el export por una imagen.
#[allow(clippy::too_many_arguments)]
fn embebido_reescalado(
    origen: &Path,
    stem: &str,
    ancho_max: u32,
    nitido: bool,
    zip: &mut ZipWriter<File>,
    opts: SimpleFileOptions,
    items: &mut Vec<Item>,
    item_id: &str,
    avisos: &mut Vec<String>,
) -> Result<Option<String>, String> {
    let bytes = match fs::read(origen) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(target: "epub", path = %origen.display(), error = %e, "no pude leer la imagen, sigo sin ella");
            avisos.push(format!(
                "No pude leer el archivo de imagen \"{}\": revisá que exista y que la app tenga permiso para abrirlo.",
                origen.display()
            ));
            return Ok(None);
        }
    };
    let procesada = if nitido {
        crate::image::reescalar_png_nitido(&bytes, ancho_max)
    } else {
        crate::image::reescalar_jpeg(&bytes, ancho_max)
    };
    let procesada = match procesada {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(target: "epub", path = %origen.display(), error = %e, "no pude procesar la imagen, sigo sin ella");
            avisos.push(format!(
                "No pude procesar la imagen \"{}\": puede estar dañada o en un formato no soportado (usá PNG o JPEG).",
                origen.display()
            ));
            return Ok(None);
        }
    };
    // Sniff por firma y no por `nitido`: tanto `reescalar_png_nitido` como
    // `reescalar_jpeg` devuelven los bytes originales sin tocar cuando la
    // imagen ya entra en `ancho_max` (rama "ya entra"), así que una tapa PNG
    // chica sale PNG aunque nitido sea false. Inferir JPEG por descarte
    // cuando no es PNG es válido únicamente porque `image` se compila con
    // `features = ["png", "jpeg"]` nomás (Cargo.toml): no hay un tercer
    // formato de salida posible.
    let es_png = procesada.len() >= 4 && &procesada[1..4] == b"PNG";
    let (dest, mime) = if es_png {
        (format!("{}.png", stem), "image/png")
    } else {
        (format!("{}.jpg", stem), "image/jpeg")
    };
    zip.start_file(format!("OEBPS/{}", dest), opts).map_err(|e| e.to_string())?;
    zip.write_all(&procesada).map_err(|e| e.to_string())?;
    items.push(Item {
        id: item_id.to_string(),
        href: dest.clone(),
        media_type: mime.into(),
        spine_order: None,
        properties: None,
    });
    Ok(Some(dest))
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
    let reserva = cfg.derechos_reservados.unwrap_or(true);
    // Sin campo propio, el inciso de ficción sigue a `derechos_reservados`:
    // es lo que hacía antes de separarlos.
    let ficcion = cfg.obra_de_ficcion.unwrap_or(reserva);
    let ia = cfg.nota_ia.unwrap_or(false);
    for (clave, activo) in [("reserva", reserva), ("ficcion", ficcion), ("ia", ia)] {
        if !activo {
            continue;
        }
        let texto = cfg
            .textos_legales
            .as_ref()
            .and_then(|m| m.get(clave))
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| texto_inciso_default(clave, is_en));
        body.push_str(&format!("<p>{}</p>\n", xml_escape(texto)));
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

/// Redacción default de cada inciso de la página legal. Las claves son las
/// mismas que usa `BookConfig::textos_legales` y las que precarga el modal
/// de configuración del libro.
pub fn texto_inciso_default(clave: &str, is_en: bool) -> &'static str {
    match (clave, is_en) {
        ("reserva", false) => "Todos los derechos reservados. Ninguna parte de esta publicación puede ser reproducida, almacenada ni transmitida en forma alguna por medio electrónico, mecánico, fotocopia, grabación u otros sin autorización escrita del autor.",
        ("reserva", true) => "All rights reserved. No part of this publication may be reproduced, stored or transmitted in any form or by any means, electronic, mechanical, photocopying, recording or otherwise, without the prior written permission of the author.",
        ("ficcion", false) => "Esta novela es enteramente una obra de ficción. Los nombres, personajes y eventos retratados son producto de la imaginación del autor. Cualquier parecido con personas reales, vivas o fallecidas, eventos o lugares es enteramente coincidencia.",
        ("ficcion", true) => "This novel is entirely a work of fiction. The names, characters and incidents portrayed in it are the work of the author's imagination. Any resemblance to actual persons, living or dead, events or localities is entirely coincidental.",
        ("ia", false) => "Las imágenes de esta obra fueron generadas con inteligencia artificial. El texto es obra exclusiva del autor.",
        ("ia", true) => "The images in this work were generated with artificial intelligence. The text is the sole work of the author.",
        _ => "",
    }
}

fn build_dedication_xhtml(text: &str) -> String {
    let body = text
        .lines()
        .map(|l| format!("<p>{}</p>", xml_escape(l.trim())))
        .collect::<Vec<_>>()
        .join("\n");
    xhtml_shell("Dedicatoria", &body, "es", "dedication-body")
}

/// Página "Sobre el autor". Todas las piezas son opcionales salvo la bio,
/// que es lo que decide si la página existe (lo resuelve el llamador).
fn build_about_author_xhtml(
    cfg: &BookConfig,
    bio: &str,
    foto: Option<&str>,
    web: Option<&str>,
    qr: Option<&str>,
) -> String {
    let lang = cfg.idioma.as_deref().unwrap_or("es");
    let is_en = lang == "en";
    let heading = if is_en { "About the Author" } else { "Sobre el autor" };

    let autor_alt = cfg.autor.as_deref().unwrap_or("").trim();
    let img = foto
        .map(|f| {
            format!(
                r#"<img class="about-author-photo" src="{}" alt="{}"/>"#,
                xml_escape(f),
                xml_escape(autor_alt)
            )
        })
        .unwrap_or_default();

    let parrafos: String = bio
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| format!("<p>{}</p>\n", xml_escape(l)))
        .collect();

    // El QR solo tiene sentido si hay a dónde apuntar. La URL va igual como
    // texto: el que lee en el celular no puede escanear su propia pantalla.
    let enlace = match web {
        Some(w) if !w.trim().is_empty() => {
            let qr_html = qr
                .map(|q| {
                    format!(
                        r#"<a href="{}"><img class="autor-qr" src="{}" alt=""/></a>"#,
                        xml_escape(w),
                        xml_escape(q)
                    )
                })
                .unwrap_or_default();
            format!(
                "<div class=\"autor-web\">{}<p class=\"autor-web-url\"><a href=\"{}\">{}</a></p></div>\n",
                qr_html,
                xml_escape(w),
                xml_escape(w.trim_start_matches("https://").trim_start_matches("http://"))
            )
        }
        _ => String::new(),
    };

    let body = format!(
        r#"<div class="about-author">
<h1 class="about-author-title">{}</h1>
{}
<div class="about-author-bio">
{}</div>
{}</div>"#,
        xml_escape(heading),
        img,
        parrafos,
        enlace
    );
    xhtml_shell(heading, &body, lang, "about-author-body")
}

/// Página "Otros libros": los publicados de la misma saga y los del resto.
/// `tapas` trae, en el mismo orden que `misma_saga.chain(otros)`, el nombre
/// del archivo de la miniatura de cada libro ya embebida en el EPUB (`None`
/// si no tiene). Indexado por posición y no por `link`: dos libros con el
/// mismo `link` (placeholder mientras no existe su página) no deben colisionar.
fn build_otros_libros_xhtml(
    cfg: &BookConfig,
    cat: &crate::catalogo::Catalogo,
    tapas: &[Option<String>],
) -> String {
    let lang = cfg.idioma.as_deref().unwrap_or("es");
    let is_en = lang == "en";
    let heading = if is_en { "Also by the Author" } else { "Otros libros" };

    let bloque = |titulo: &str, libros: &[crate::catalogo::LibroPublicado], offset: usize| -> String {
        if libros.is_empty() {
            return String::new();
        }
        let mut s = format!("<h2>{}</h2>\n<ul class=\"libro-list\">\n", xml_escape(titulo));
        for (i, l) in libros.iter().enumerate() {
            s.push_str("<li class=\"libro\">");
            if let Some(Some(archivo)) = tapas.get(offset + i) {
                s.push_str(&format!(
                    r#"<a href="{}"><img class="libro-tapa" src="{}" alt="{}"/></a>"#,
                    xml_escape(&l.link),
                    xml_escape(archivo),
                    xml_escape(&l.titulo)
                ));
            }
            s.push_str(&format!(
                "<p class=\"libro-titulo\"><a href=\"{}\">{}</a></p>",
                xml_escape(&l.link),
                xml_escape(&l.titulo)
            ));
            if let Some(sub) = &l.subtitulo {
                s.push_str(&format!("<p class=\"libro-subtitulo\">{}</p>", xml_escape(sub)));
            }
            s.push_str("</li>\n");
        }
        s.push_str("</ul>\n");
        s
    };

    // El nombre publicado de la serie (`serie` en book.json) prevalece sobre
    // el nombre de la carpeta saga: el autor puede organizar su workspace
    // con nombres internos ("Meridian 2.0" para su propia reescritura) que
    // no deben filtrarse al EPUB publicado.
    let nombre_serie = cfg
        .serie
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(cat.saga_actual.as_deref());
    let titulo_saga = match (nombre_serie, is_en) {
        (Some(n), false) => format!("Más de {}", n),
        (Some(n), true) => format!("More from {}", n),
        (None, false) => "Más de esta serie".to_string(),
        (None, true) => "More from This Series".to_string(),
    };
    let titulo_otros = if is_en {
        "Other Books by the Author"
    } else {
        "Otros libros del autor"
    };

    let body = format!(
        "<div class=\"otros-libros\">\n<h1>{}</h1>\n{}{}</div>",
        xml_escape(heading),
        bloque(&titulo_saga, &cat.misma_saga, 0),
        bloque(titulo_otros, &cat.otros, cat.misma_saga.len()),
    );
    xhtml_shell(heading, &body, lang, "otros-libros-body")
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
        let clase = if e.editorial {
            "toc-editorial toc-body"
        } else {
            "toc-part toc-body"
        };
        lis.push_str(&format!(
            "<li class=\"{}\"><a href=\"{}\">{}</a>",
            clase,
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
    // Autor: autor.json (perfil global) pisa a book.json, que pisa al
    // fallback de saga.json. El perfil es la fuente de verdad del nombre
    // desde que existe `autor.json`; el campo en book.json queda solo como
    // fallback para repos que todavía no lo cargaron.
    let (_, root_dir) = find_saga_and_root(book_dir);
    let nombre_perfil = crate::autor::leer(&root_dir)
        .nombre
        .filter(|s| !s.trim().is_empty());
    if let Some(nombre) = nombre_perfil {
        cfg.autor = Some(nombre);
    } else if cfg.autor.as_deref().unwrap_or("").is_empty() {
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
    if image_field_unusable(book_dir, cfg.tapa.as_deref()) {
        if let Some(found) = find_cover_in(book_dir) {
            cfg.tapa = Some(found);
        }
    }
    if image_field_unusable(book_dir, cfg.contratapa.as_deref()) {
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
    use tempfile::TempDir;

    /// Los tests no tienen `AppHandle`, así que leen la hoja del repo. Estos
    /// dos wrappers tapan a los de `super::*` (un item local gana sobre un
    /// glob import) para no repetir el argumento en cada caso.
    fn plantilla_css() -> String {
        fs::read_to_string(css_template_dev_path()).expect("hoja de estilos del EPUB")
    }

    fn export_impl(book_path: &str) -> Result<ExportResult, String> {
        super::export_impl(book_path, &plantilla_css(), None)
    }

    fn build_css(template: &str, theme: &ResolvedTheme) -> String {
        super::build_css(&plantilla_css(), template, theme)
    }

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
            editorial_body_font: None,
            editorial_heading_font: None,
            chapter_title_position: None,
            prefijo_capitulo: None,
            mostrar_titulo_capitulo: None,
            dropcap: None,
            mostrar_numero_parte: None,
            formato_parte: None,
            template: None,
            italic_oblique_deg: None,
            italic_weight: None,
            bold_weight: None,
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
    fn theme_rules_never_emit_em_or_strong_overrides() {
        // Italic/bold se sintetizan en el reader. El CSS del tema nunca debe
        // emitir reglas para `em`/`strong` que pisen la familia base.
        let resolved = ResolvedTheme {
            body_font: Some("Merriweather".into()),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        assert!(!block.contains("em, i {"));
        assert!(!block.contains("strong, b {"));
        assert!(!block.contains("strong em"));
    }

    #[test]
    fn theme_rules_emit_em_block_when_oblique_set() {
        let resolved = ResolvedTheme {
            italic_oblique_deg: Some(14.0),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        assert!(block.contains("em, i {"));
        assert!(block.contains("font-style: oblique 14.0deg;"));
        assert!(!block.contains("strong, b {"));
    }

    #[test]
    fn theme_rules_italic_weight_falls_back_to_bold_weight() {
        // bold_weight set, italic_weight None: el bloque em hereda el bold_weight.
        let resolved = ResolvedTheme {
            bold_weight: Some(800),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        assert!(block.contains("em, i {"));
        assert!(block.contains("font-weight: 800;"));
        assert!(block.contains("strong, b {"));
        // Combo bold+italic emite con bold_weight.
        assert!(block.contains("strong em, strong i, em strong"));
    }

    #[test]
    fn theme_rules_italic_weight_overrides_bold_weight() {
        let resolved = ResolvedTheme {
            italic_weight: Some(500),
            bold_weight: Some(800),
            ..Default::default()
        };
        let block = build_theme_rules_block(&resolved);
        // em usa italic_weight (500).
        let em_idx = block.find("em, i {").unwrap();
        let em_end = block[em_idx..].find('}').unwrap() + em_idx;
        let em_block = &block[em_idx..em_end];
        assert!(em_block.contains("font-weight: 500;"));
        // Combo usa bold_weight (800).
        let combo_idx = block.find("strong em").unwrap();
        let combo_end = block[combo_idx..].find('}').unwrap() + combo_idx;
        let combo_block = &block[combo_idx..combo_end];
        assert!(combo_block.contains("font-weight: 800;"));
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
    fn export_impl_reporta_las_fases_en_orden() {
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::create_dir_all(book.join("Cap2")).unwrap();
        std::fs::write(book.join("book.json"), r#"{"titulo":"Test"}"#).unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>Uno.</p>").unwrap();
        std::fs::write(book.join("Cap2").join("1.html"), "<p>Dos.</p>").unwrap();

        let mut pasos: Vec<ExportProgress> = Vec::new();
        let mut cb = |p: ExportProgress| pasos.push(p);
        super::export_impl(book.to_str().unwrap(), &plantilla_css(), Some(&mut cb))
            .expect("export ok");

        let fases: Vec<&str> = pasos.iter().map(|p| p.fase.as_str()).collect();
        assert_eq!(fases.first(), Some(&"Leyendo capítulos"));
        assert_eq!(fases.last(), Some(&"Armando índice y empaquetando"));
        assert!(fases.contains(&"Embebiendo tapas e imágenes"));
        // Un aviso por capítulo, con el total bien puesto: es lo que la UI usa
        // para decir "3 de 12" en vez de un spinner ciego.
        let caps: Vec<&ExportProgress> = pasos
            .iter()
            .filter(|p| p.fase == "Escribiendo capítulos")
            .collect();
        assert_eq!(caps.len(), 2);
        assert_eq!(caps[0].hecho, 0);
        assert_eq!(caps[1].hecho, 1);
        assert!(caps.iter().all(|p| p.total == 2));
    }

    #[test]
    fn export_impl_unconfigured_does_not_embed_fonts() {
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
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
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
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
    fn export_impl_autocierra_br_y_hr_sueltos_sin_tocar_el_resto() {
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(book.join("book.json"), r#"{"titulo":"Test"}"#).unwrap();
        // <br> suelto en medio de un diálogo (el caso real: salto de línea
        // dentro del párrafo), <hr class="scene-break"> suelto (separador de
        // escena), y de yapa un <br/> y un <hr/> ya bien formados que no
        // tienen que cambiar ni un byte.
        std::fs::write(
            book.join("Cap1").join("1.html"),
            "<p>Dijo:<br>—Hola.</p><hr class=\"scene-break\"><p>Ya<br/>cerrado.</p><hr/>",
        )
        .unwrap();

        let result = export_impl(book.to_str().unwrap()).expect("export ok");
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let xhtml =
            String::from_utf8(entries.get("OEBPS/12_ch1_p1.xhtml").unwrap().clone()).unwrap();

        // Los sueltos quedan autocerrados.
        assert!(xhtml.contains("<br/>—Hola."), "xhtml: {xhtml}");
        assert!(
            xhtml.contains("<hr class=\"scene-break\"/>"),
            "xhtml: {xhtml}"
        );
        // Los que ya venían bien formados no se tocan.
        assert!(xhtml.contains("<br/>cerrado."));
        assert!(xhtml.contains("<hr/>"));
        // No quedó ningún void element sin cerrar (lo que rompía Apple Books).
        assert!(!xhtml.contains("<br>"));
        assert!(!xhtml.contains("<hr class=\"scene-break\">"));
        // El texto y los demás tags alrededor están intactos.
        assert!(xhtml.contains("Dijo:"));
        assert!(xhtml.contains("Hola.</p>"));
        assert!(xhtml.contains("<p>Ya"));
    }

    /// Arma `root/Saga/Book/Cap1/1.html` con los tres niveles de la cadena de
    /// autor (`autor.json`, `book.json`, `saga.json`) cargados a mano, cada
    /// uno con `.autor_json`/`.book_autor`/`.saga_autor` opcionales. Cada
    /// nivel recibe un nombre distinto en los tests de abajo para poder
    /// discriminar cuál ganó.
    ///
    /// Devuelve el guard del tempdir junto con el path del libro — quien
    /// llama tiene que bindearlo con nombre (no `_`) para que el árbol no
    /// se borre antes de que el test termine de usarlo.
    fn armar_libro_con_autores(
        autor_json: Option<&str>,
        book_autor: Option<&str>,
        saga_autor: Option<&str>,
    ) -> (TempDir, std::path::PathBuf) {
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        if let Some(nombre) = autor_json {
            std::fs::write(
                tmp.join("autor.json"),
                format!(r#"{{"nombre":"{}"}}"#, nombre),
            )
            .unwrap();
        }
        let saga = tmp.join("Saga");
        let book = saga.join("Book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        let saga_json = match saga_autor {
            Some(a) => format!(r#"{{"nombre":"Saga","autor":"{}"}}"#, a),
            None => r#"{"nombre":"Saga"}"#.to_string(),
        };
        std::fs::write(saga.join("saga.json"), saga_json).unwrap();
        let book_json = match book_autor {
            Some(a) => format!(r#"{{"titulo":"Test","autor":"{}"}}"#, a),
            None => r#"{"titulo":"Test"}"#.to_string(),
        };
        std::fs::write(book.join("book.json"), book_json).unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>Hello.</p>").unwrap();
        (tmp_guard, book)
    }

    fn copyright_xhtml_de(book: &std::path::Path) -> String {
        let result = export_impl(book.to_str().unwrap()).expect("export ok");
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        String::from_utf8(entries.get("OEBPS/2_copyright.xhtml").unwrap().clone()).unwrap()
    }

    #[test]
    fn autor_json_pisa_a_book_json_y_a_saga_json() {
        let (_guard, book) = armar_libro_con_autores(
            Some("Perfil Nombre"),
            Some("Book Autor"),
            Some("Saga Autor"),
        );
        let copyright = copyright_xhtml_de(&book);
        assert!(copyright.contains("Perfil Nombre"));
        assert!(!copyright.contains("Book Autor"));
        assert!(!copyright.contains("Saga Autor"));
    }

    #[test]
    fn sin_perfil_global_usa_el_autor_de_book_json() {
        let (_guard, book) = armar_libro_con_autores(None, Some("Book Autor"), Some("Saga Autor"));
        let copyright = copyright_xhtml_de(&book);
        assert!(copyright.contains("Book Autor"));
        assert!(!copyright.contains("Saga Autor"));
    }

    #[test]
    fn sin_perfil_ni_autor_en_book_json_cae_a_saga_json() {
        let (_guard, book) = armar_libro_con_autores(None, None, Some("Saga Autor"));
        let copyright = copyright_xhtml_de(&book);
        assert!(copyright.contains("Saga Autor"));
    }

    #[test]
    fn perfil_global_sin_nombre_no_pisa_el_autor_de_book_json() {
        // autor.json existe (para probar bio u otro campo) pero sin `nombre`:
        // no debe ganarle al autor de book.json.
        let tmp_marker = "Book Autor";
        let (_guard, book) = armar_libro_con_autores(None, Some(tmp_marker), Some("Saga Autor"));
        // Reescribe autor.json con bio pero sin nombre, simulando el perfil
        // configurado sin ese campo.
        let root = book.parent().unwrap().parent().unwrap();
        std::fs::write(root.join("autor.json"), r#"{"bio":{"es":"hola"}}"#).unwrap();
        let copyright = copyright_xhtml_de(&book);
        assert!(copyright.contains(tmp_marker));
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
            "body.title-body, body.copyright-body, body.dedication-body, body.nav-body, body.about-author-body, body.otros-libros-body {"
        ));
        assert!(block.contains("font-family: \"Cormorant\", serif;"));
        assert!(block.contains(
            "p.title-page-title, nav h1, nav ol.toc > li.toc-part > a, h1.about-author-title, .otros-libros h1 {"
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
    fn copyright_back_compat_con_derechos_reservados_solo() {
        // Un book.json de los que ya existen en el repo: sin los campos nuevos.
        let cfg: BookConfig = serde_json::from_str(
            r#"{"titulo":"X","autor":"A","copyright_anio":2026,"derechos_reservados":true}"#,
        )
        .unwrap();
        let xhtml = build_copyright_xhtml(&cfg);
        assert!(xhtml.contains("Todos los derechos reservados."));
        assert!(xhtml.contains("Esta novela es enteramente una obra de ficción."));
        assert!(!xhtml.contains("inteligencia artificial"));
    }

    #[test]
    fn copyright_permite_apagar_solo_el_inciso_de_ficcion() {
        let cfg: BookConfig = serde_json::from_str(
            r#"{"titulo":"X","derechos_reservados":true,"obra_de_ficcion":false}"#,
        )
        .unwrap();
        let xhtml = build_copyright_xhtml(&cfg);
        assert!(xhtml.contains("Todos los derechos reservados."));
        assert!(!xhtml.contains("obra de ficción"));
    }

    #[test]
    fn copyright_suma_la_nota_de_ia_cuando_esta_prendida() {
        let cfg: BookConfig =
            serde_json::from_str(r#"{"titulo":"X","nota_ia":true}"#).unwrap();
        let xhtml = build_copyright_xhtml(&cfg);
        assert!(xhtml.contains(
            "Las imágenes de esta obra fueron generadas con inteligencia artificial."
        ));
        assert!(xhtml.contains("El texto es obra exclusiva del autor."));
    }

    #[test]
    fn copyright_nota_de_ia_en_ingles() {
        let cfg: BookConfig =
            serde_json::from_str(r#"{"titulo":"X","idioma":"en","nota_ia":true}"#).unwrap();
        let xhtml = build_copyright_xhtml(&cfg);
        assert!(xhtml.contains("The images in this work were generated with artificial intelligence."));
    }

    #[test]
    fn copyright_usa_el_texto_editado_en_vez_del_default() {
        let cfg: BookConfig = serde_json::from_str(
            r#"{"titulo":"X","nota_ia":true,"textos_legales":{"ia":"Las tapas las hizo una máquina."}}"#,
        )
        .unwrap();
        let xhtml = build_copyright_xhtml(&cfg);
        assert!(xhtml.contains("Las tapas las hizo una máquina."));
        assert!(!xhtml.contains("inteligencia artificial"));
    }

    #[test]
    fn copyright_ignora_un_texto_editado_de_un_inciso_apagado() {
        let cfg: BookConfig = serde_json::from_str(
            r#"{"titulo":"X","derechos_reservados":false,"textos_legales":{"reserva":"No copiar."}}"#,
        )
        .unwrap();
        let xhtml = build_copyright_xhtml(&cfg);
        assert!(!xhtml.contains("No copiar."));
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
            ..Default::default()
        };
        let xhtml = build_about_author_xhtml(
            &cfg,
            "Nací en Cipolletti.\nVivo escribiendo.",
            Some("author.jpg"),
            None,
            None,
        );
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
            ..Default::default()
        };
        let xhtml = build_about_author_xhtml(&cfg, "Bio.", None, None, None);
        assert!(xhtml.contains("About the Author"));
        // Sin photo: no aparece <img>.
        assert!(!xhtml.contains("<img"));
    }

    #[test]
    fn about_author_usa_la_bio_del_autor_json_cuando_el_libro_no_tiene() {
        let (root, book) = repo_con_publicados();
        std::fs::write(
            root.path().join("autor.json"),
            r#"{"nombre":"Tatoh","bio":{"es":"Escribe de noche."},"web":"https://tatoh.ar"}"#,
        )
        .unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let page =
            String::from_utf8(entries.get("OEBPS/8_about_author.xhtml").unwrap().clone()).unwrap();
        assert!(page.contains("Escribe de noche."));
        assert!(page.contains("https://tatoh.ar"));
    }

    #[test]
    fn about_author_el_libro_pisa_la_bio_global() {
        let (root, book) = repo_con_publicados();
        std::fs::write(root.path().join("autor.json"), r#"{"bio":{"es":"La global."}}"#).unwrap();
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"Actual","sobre_el_autor":"La del libro."}"#,
        )
        .unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let page =
            String::from_utf8(entries.get("OEBPS/8_about_author.xhtml").unwrap().clone()).unwrap();
        assert!(page.contains("La del libro."));
        assert!(!page.contains("La global."));
    }

    #[test]
    fn about_author_foto_usa_la_del_perfil_cuando_el_libro_no_tiene() {
        let (root, book) = repo_con_publicados();
        std::fs::write(root.path().join("autor.json"), r#"{"bio":{"es":"x"},"foto":"autor.png"}"#).unwrap();
        let foto = ::image::RgbImage::from_pixel(120, 120, ::image::Rgb([10, 10, 10]));
        ::image::DynamicImage::ImageRgb8(foto).save(root.path().join("autor.png")).unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let bytes = entries.get("OEBPS/author.png").expect("no se embebió la foto del perfil");
        let ancho = ::image::load_from_memory(bytes).unwrap().width();
        assert_eq!(ancho, 120, "tiene que ser la foto del perfil (120px), no otra");
    }

    #[test]
    fn about_author_foto_del_libro_pisa_la_del_perfil() {
        let (root, book) = repo_con_publicados();
        std::fs::write(root.path().join("autor.json"), r#"{"bio":{"es":"x"},"foto":"autor.png"}"#).unwrap();
        let foto_perfil = ::image::RgbImage::from_pixel(120, 120, ::image::Rgb([10, 10, 10]));
        ::image::DynamicImage::ImageRgb8(foto_perfil).save(root.path().join("autor.png")).unwrap();

        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"Actual","foto_autor":"libro.png"}"#,
        )
        .unwrap();
        let foto_libro = ::image::RgbImage::from_pixel(200, 200, ::image::Rgb([10, 10, 10]));
        ::image::DynamicImage::ImageRgb8(foto_libro).save(book.join("libro.png")).unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let bytes = entries.get("OEBPS/author.png").expect("no se embebió la foto");
        let ancho = ::image::load_from_memory(bytes).unwrap().width();
        assert_eq!(ancho, 200, "tiene que ser la foto del libro (200px), que pisa a la del perfil");
    }

    #[test]
    fn about_author_sin_web_no_embebe_el_qr() {
        let (root, book) = repo_con_publicados();
        std::fs::write(root.path().join("autor.json"), r#"{"bio":{"es":"x"},"qr":"qr.png"}"#).unwrap();
        let qr = ::image::RgbImage::from_pixel(120, 120, ::image::Rgb([0, 0, 0]));
        ::image::DynamicImage::ImageRgb8(qr).save(root.path().join("qr.png")).unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        assert!(
            !entries.contains_key("OEBPS/author-qr.png"),
            "sin web no hay a dónde apuntar, no se debería embeber el QR"
        );
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(!opf.contains("author-qr"), "el manifest no debería declarar un QR huérfano");
    }

    #[test]
    fn about_author_embebe_el_qr_como_png() {
        let (root, book) = repo_con_publicados();
        std::fs::write(
            root.path().join("autor.json"),
            r#"{"bio":{"es":"x"},"web":"https://tatoh.ar","qr":"qr.png"}"#,
        )
        .unwrap();
        let qr = ::image::RgbImage::from_pixel(1200, 1200, ::image::Rgb([0, 0, 0]));
        ::image::DynamicImage::ImageRgb8(qr).save(root.path().join("qr.png")).unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let bytes = entries.get("OEBPS/author-qr.png").expect("no se embebió el QR");
        assert_eq!(&bytes[1..4], b"PNG", "el QR tiene que quedar PNG");
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(opf.contains("image/png"));
        let page =
            String::from_utf8(entries.get("OEBPS/8_about_author.xhtml").unwrap().clone()).unwrap();
        assert!(page.contains("class=\"autor-qr\""));
        // El href del QR tiene que ser la web, no el src de la imagen: un
        // swap de argumentos en el format! sería invisible sin esto.
        assert!(
            page.contains(r#"<a href="https://tatoh.ar"><img class="autor-qr""#),
            "page: {}",
            page
        );
    }

    #[test]
    fn about_author_sin_web_no_muestra_ni_texto_ni_qr() {
        let cfg = BookConfig { titulo: "X".into(), ..Default::default() };
        let xhtml = build_about_author_xhtml(&cfg, "bio", None, None, Some("author-qr.png"));
        assert!(!xhtml.contains("autor-qr"));
        assert!(!xhtml.contains("autor-web"));
    }

    #[test]
    fn about_author_con_web_y_sin_qr_muestra_solo_el_texto() {
        let cfg = BookConfig { titulo: "X".into(), ..Default::default() };
        let xhtml = build_about_author_xhtml(&cfg, "bio", None, Some("https://tatoh.ar"), None);
        assert!(xhtml.contains("https://tatoh.ar"));
        assert!(!xhtml.contains("autor-qr"));
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
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
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
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
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
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
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
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
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

    /// Arma un repo mínimo: root con dos sagas, y devuelve el path del libro
    /// que se va a exportar (que tiene un capítulo).
    ///
    /// Devuelve el guard del tempdir junto con el path del libro — quien
    /// llama tiene que bindearlo con nombre (no `_`) para que el árbol no se
    /// borre antes de que el test termine de usarlo. Los call sites que
    /// necesitan el root como path llaman `root.path()`.
    fn repo_con_publicados() -> (TempDir, std::path::PathBuf) {
        let root_guard = TempDir::new().unwrap();
        let root = root_guard.path();
        let saga = root.join("1 - Meridian");
        let otra = root.join("2 - Buenos Aires");
        std::fs::create_dir_all(&saga).unwrap();
        std::fs::create_dir_all(&otra).unwrap();
        std::fs::write(saga.join("saga.json"), r#"{"nombre":"Meridian"}"#).unwrap();
        std::fs::write(otra.join("saga.json"), r#"{"nombre":"Buenos Aires 2077"}"#).unwrap();

        let book = saga.join("1 - Actual");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(book.join("book.json"), r#"{"titulo":"Actual"}"#).unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();

        let hermano = saga.join("2 - Hermano");
        std::fs::create_dir_all(&hermano).unwrap();
        std::fs::write(
            hermano.join("book.json"),
            r#"{"titulo":"Hermano","subtitulo":"Meridian #2","link":"https://tatoh.ar/libros/hermano","numero_en_serie":2}"#,
        )
        .unwrap();

        let ajeno = otra.join("1 - Luces");
        std::fs::create_dir_all(&ajeno).unwrap();
        std::fs::write(
            ajeno.join("book.json"),
            r#"{"titulo":"Luces","link":"https://tatoh.ar/libros/luces"}"#,
        )
        .unwrap();

        (root_guard, book)
    }

    #[test]
    fn export_impl_genera_la_pagina_de_otros_libros_con_los_dos_bloques() {
        let (_root, book) = repo_con_publicados();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let page = String::from_utf8(entries.get("OEBPS/7_otros_libros.xhtml").unwrap().clone()).unwrap();
        assert!(page.contains("Más de Meridian"));
        assert!(page.contains("Otros libros del autor"));
        assert!(page.contains("https://tatoh.ar/libros/hermano"));
        assert!(page.contains("https://tatoh.ar/libros/luces"));
        assert!(page.contains("Meridian #2"));
        // El libro que se exporta no se lista a sí mismo.
        assert!(!page.contains(">Actual<"));
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(opf.contains(r#"id="otros-libros""#));
    }

    #[test]
    fn export_impl_omite_la_pagina_cuando_no_hay_publicados() {
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(book.join("book.json"), r#"{"titulo":"Solo"}"#).unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        assert!(!entries.contains_key("OEBPS/7_otros_libros.xhtml"));
    }

    #[test]
    fn pagina_en_blanco_separa_la_novela_del_back_matter_solo_si_hay_alguno() {
        // Caso 1: hay catálogo (back matter) → la página en blanco existe,
        // va al spine, y NO entra ni a toc.xhtml ni a toc.ncx.
        let (_root, book) = repo_con_publicados();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        assert!(entries.contains_key("OEBPS/6_blank.xhtml"));
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(opf.contains(r#"idref="blank-separator""#));
        let toc = String::from_utf8(entries.get("OEBPS/toc.xhtml").unwrap().clone()).unwrap();
        assert!(!toc.contains("6_blank.xhtml"));
        let ncx = String::from_utf8(entries.get("OEBPS/toc.ncx").unwrap().clone()).unwrap();
        assert!(!ncx.contains("6_blank.xhtml"));

        // Caso 2: ni catálogo ni bio → no hay back matter → no hay página en
        // blanco. Un test que solo mirara el caso 1 pasaría igual si la
        // página se pusiera siempre.
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        let solo = tmp.join("book");
        std::fs::create_dir_all(solo.join("Cap1")).unwrap();
        std::fs::write(solo.join("book.json"), r#"{"titulo":"Solo"}"#).unwrap();
        std::fs::write(solo.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
        let result_solo = export_impl(solo.to_str().unwrap()).unwrap();
        let entries_solo = read_epub_entries(std::path::Path::new(&result_solo.epub_path));
        assert!(!entries_solo.contains_key("OEBPS/6_blank.xhtml"));
        let opf_solo =
            String::from_utf8(entries_solo.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(!opf_solo.contains("blank-separator"));
    }

    #[test]
    fn otros_libros_omite_el_bloque_de_saga_cuando_esta_vacio() {
        let cat = crate::catalogo::Catalogo {
            misma_saga: Vec::new(),
            otros: vec![crate::catalogo::LibroPublicado {
                titulo: "Luces".into(),
                subtitulo: None,
                link: "https://x/l".into(),
                tapa: None,
                numero_en_serie: None,
            }],
            saga_actual: Some("Meridian".into()),
        };
        let cfg = BookConfig { titulo: "X".into(), ..Default::default() };
        let xhtml = build_otros_libros_xhtml(&cfg, &cat, &[]);
        assert!(!xhtml.contains("Más de Meridian"));
        assert!(xhtml.contains("Otros libros del autor"));
    }

    #[test]
    fn otros_libros_en_ingles() {
        let cat = crate::catalogo::Catalogo {
            misma_saga: vec![crate::catalogo::LibroPublicado {
                titulo: "Deployment".into(),
                subtitulo: None,
                link: "https://x/d".into(),
                tapa: None,
                numero_en_serie: Some(1),
            }],
            otros: Vec::new(),
            saga_actual: Some("Milky Way".into()),
        };
        let cfg = BookConfig {
            titulo: "X".into(),
            idioma: Some("en".into()),
            ..Default::default()
        };
        let xhtml = build_otros_libros_xhtml(&cfg, &cat, &[]);
        assert!(xhtml.contains("More from Milky Way"));
        assert!(xhtml.contains("<h1>Also by the Author</h1>"));
    }

    /// `serie` (nombre publicado, en book.json) prevalece sobre el nombre de
    /// la carpeta saga (nombre de workspace del autor, ej. "Meridian 2.0"
    /// para su propia reescritura interna).
    #[test]
    fn otros_libros_prefiere_serie_del_libro_sobre_el_nombre_de_la_saga() {
        let cat = crate::catalogo::Catalogo {
            misma_saga: vec![crate::catalogo::LibroPublicado {
                titulo: "Hermano".into(),
                subtitulo: None,
                link: "https://x/h".into(),
                tapa: None,
                numero_en_serie: Some(2),
            }],
            otros: Vec::new(),
            saga_actual: Some("Meridian 2.0".into()),
        };

        // Con `serie` presente y distinto del nombre de saga, gana `serie`.
        let cfg_con_serie = BookConfig {
            titulo: "X".into(),
            serie: Some("Meridian".into()),
            ..Default::default()
        };
        let xhtml = build_otros_libros_xhtml(&cfg_con_serie, &cat, &[]);
        assert!(xhtml.contains("Más de Meridian<"));
        assert!(!xhtml.contains("Meridian 2.0"));

        // Sin `serie`, cae al nombre de la saga.
        let cfg_sin_serie = BookConfig { titulo: "X".into(), ..Default::default() };
        let xhtml = build_otros_libros_xhtml(&cfg_sin_serie, &cat, &[]);
        assert!(xhtml.contains("Más de Meridian 2.0"));

        // `serie` en blanco cuenta como ausente: cae al nombre de la saga.
        let cfg_serie_blanca = BookConfig {
            titulo: "X".into(),
            serie: Some("   ".into()),
            ..Default::default()
        };
        let xhtml = build_otros_libros_xhtml(&cfg_serie_blanca, &cat, &[]);
        assert!(xhtml.contains("Más de Meridian 2.0"));
    }

    #[test]
    fn otros_libros_embebe_la_tapa_reescalada() {
        let (_root, book) = repo_con_publicados();
        // Al hermano le ponemos una tapa grande de verdad.
        let hermano = book.parent().unwrap().join("2 - Hermano");
        let grande = ::image::RgbImage::from_pixel(2000, 3000, ::image::Rgb([10, 20, 30]));
        ::image::DynamicImage::ImageRgb8(grande)
            .save(hermano.join("cover.png"))
            .unwrap();
        std::fs::write(
            hermano.join("book.json"),
            r#"{"titulo":"Hermano","link":"https://tatoh.ar/libros/hermano","tapa":"cover.png","numero_en_serie":2}"#,
        )
        .unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let miniatura = entries
            .keys()
            .find(|k| k.starts_with("OEBPS/cat-"))
            .expect("no se embebió la miniatura");
        let bytes = entries.get(miniatura).unwrap();
        assert!(bytes.len() < 100 * 1024, "la miniatura pesa {} bytes", bytes.len());
        // El peso solo no discrimina: un PNG de color plano de 2000x3000 ya
        // pesa poco sin reescalar. Lo que prueba que hubo reescalado es el
        // ancho decodificado.
        let decoded = ::image::load_from_memory(bytes).unwrap();
        assert_eq!(decoded.width(), 400, "esperaba 400px de ancho reescalado");
        let page = String::from_utf8(entries.get("OEBPS/7_otros_libros.xhtml").unwrap().clone()).unwrap();
        assert!(page.contains("class=\"libro-tapa\""));
    }

    #[test]
    fn otros_libros_no_recomprime_una_tapa_que_ya_entra() {
        let (_root, book) = repo_con_publicados();
        // Tapa ya chica: entra sin reescalar. Ejercita la rama "ya entra"
        // de embebido_reescalado, que es la razón de ser del sniff — si el
        // sniff mintiera acá, el OPF declararía image/jpeg sobre bytes PNG.
        let hermano = book.parent().unwrap().join("2 - Hermano");
        let chica = ::image::RgbImage::from_pixel(200, 300, ::image::Rgb([10, 20, 30]));
        ::image::DynamicImage::ImageRgb8(chica)
            .save(hermano.join("cover.png"))
            .unwrap();
        std::fs::write(
            hermano.join("book.json"),
            r#"{"titulo":"Hermano","link":"https://tatoh.ar/libros/hermano","tapa":"cover.png","numero_en_serie":2}"#,
        )
        .unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let miniatura = entries
            .keys()
            .find(|k| k.starts_with("OEBPS/cat-"))
            .expect("no se embebió la miniatura");
        assert!(miniatura.ends_with(".png"), "esperaba .png, salió {}", miniatura);
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        let filename = miniatura.trim_start_matches("OEBPS/");
        let media_attr = format!(r#"href="{}" media-type="image/png""#, filename);
        assert!(
            opf.contains(&media_attr),
            "el manifest no declara image/png para {}: {}",
            filename,
            opf
        );
    }

    #[test]
    fn otros_libros_con_link_repetido_no_pisa_la_miniatura_del_otro() {
        // Dos libros publicados pueden compartir el mismo link (el checklist
        // de la spec dice de usar una URL placeholder para los dos "por
        // ahora"). Con un HashMap<link, dest> el segundo insert pisaba al
        // primero: un libro terminaba mostrando la tapa del otro.
        let (_root, book) = repo_con_publicados();
        let hermano = book.parent().unwrap().join("2 - Hermano");
        let ajeno = book
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("2 - Buenos Aires")
            .join("1 - Luces");
        let link_compartido = "https://www.amazon.com/dp/B0G3JTSR43";
        std::fs::write(
            hermano.join("book.json"),
            format!(
                r#"{{"titulo":"Hermano","link":"{}","tapa":"cover.png","numero_en_serie":2}}"#,
                link_compartido
            ),
        )
        .unwrap();
        std::fs::write(
            ajeno.join("book.json"),
            format!(r#"{{"titulo":"Luces","link":"{}","tapa":"cover.png"}}"#, link_compartido),
        )
        .unwrap();
        let roja = ::image::RgbImage::from_pixel(10, 10, ::image::Rgb([200, 0, 0]));
        ::image::DynamicImage::ImageRgb8(roja).save(hermano.join("cover.png")).unwrap();
        let azul = ::image::RgbImage::from_pixel(10, 10, ::image::Rgb([0, 0, 200]));
        ::image::DynamicImage::ImageRgb8(azul).save(ajeno.join("cover.png")).unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let page = String::from_utf8(entries.get("OEBPS/7_otros_libros.xhtml").unwrap().clone()).unwrap();

        let li_hermano = page.split("<li class=\"libro\">").find(|li| li.contains("Hermano")).unwrap();
        let li_luces = page.split("<li class=\"libro\">").find(|li| li.contains("Luces")).unwrap();
        let src_de = |li: &str| -> String {
            let start = li.find("src=\"").expect("sin miniatura") + 5;
            let end = li[start..].find('"').unwrap();
            li[start..start + end].to_string()
        };
        let src_hermano = src_de(li_hermano);
        let src_luces = src_de(li_luces);
        assert_ne!(
            src_hermano, src_luces,
            "las dos miniaturas resolvieron al mismo archivo embebido"
        );
        let px = |src: &str| -> [u8; 3] {
            let bytes = entries.get(&format!("OEBPS/{}", src)).unwrap();
            ::image::load_from_memory(bytes).unwrap().to_rgb8().get_pixel(0, 0).0
        };
        assert_eq!(px(&src_hermano), [200, 0, 0], "Hermano no muestra su propia tapa");
        assert_eq!(px(&src_luces), [0, 0, 200], "Luces no muestra su propia tapa");
    }

    #[test]
    fn la_tapa_del_libro_se_reescala_antes_de_embeberse() {
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"Grande","tapa":"cover.png"}"#,
        )
        .unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
        let grande = ::image::RgbImage::from_pixel(3000, 4500, ::image::Rgb([9, 9, 9]));
        ::image::DynamicImage::ImageRgb8(grande).save(book.join("cover.png")).unwrap();
        let original = std::fs::metadata(book.join("cover.png")).unwrap().len();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let (nombre, bytes) = entries
            .iter()
            .find(|(k, _)| k.starts_with("OEBPS/cover."))
            .expect("no está la tapa");
        assert!(
            (bytes.len() as u64) < original,
            "la tapa embebida ({}) no bajó de la original ({})",
            bytes.len(),
            original
        );
        let img = ::image::load_from_memory(bytes).unwrap();
        assert_eq!(img.width(), 1600);
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(opf.contains(r#"properties="cover-image""#));
        // El XHTML de la portada tiene que apuntar al nombre real del archivo.
        let cover_page = String::from_utf8(entries.get("OEBPS/0_cover.xhtml").unwrap().clone()).unwrap();
        assert!(cover_page.contains(nombre.trim_start_matches("OEBPS/")));
    }

    #[test]
    fn una_tapa_corrupta_deja_aviso_en_vez_de_fallar_muda() {
        // El archivo existe (así que resolver_imagen lo encuentra) pero no es
        // una imagen válida: falla adentro de embebido_reescalado al decodificar.
        // El export no debe abortar, pero el autor tiene que enterarse.
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"Grande","tapa":"cover.png"}"#,
        )
        .unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
        std::fs::write(book.join("cover.png"), b"no soy una imagen").unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        assert!(
            result
                .avisos
                .iter()
                .any(|a| a.contains("No pude procesar la imagen") && a.contains("cover.png")),
            "avisos: {:?}",
            result.avisos
        );
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        assert!(
            !entries.keys().any(|k| k.starts_with("OEBPS/cover.")),
            "no debería haber tapa embebida"
        );
    }

    #[test]
    fn la_contratapa_del_libro_se_reescala_antes_de_embeberse() {
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"Grande","contratapa":"back.png"}"#,
        )
        .unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
        let grande = ::image::RgbImage::from_pixel(3000, 4500, ::image::Rgb([9, 9, 9]));
        ::image::DynamicImage::ImageRgb8(grande).save(book.join("back.png")).unwrap();

        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let (nombre, bytes) = entries
            .iter()
            .find(|(k, _)| k.starts_with("OEBPS/back-cover."))
            .expect("no está la contratapa");
        // El peso solo no discrimina (un PNG de color plano comprime a poco
        // esté reescalado o no); lo que prueba el reescalado es el ancho
        // decodificado.
        let img = ::image::load_from_memory(bytes).unwrap();
        assert_eq!(img.width(), 1600);
        // La contratapa no es portada: no lleva properties="cover-image".
        let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
        assert!(!opf.contains(r#"properties="cover-image""#));
        // El XHTML de la contratapa tiene que apuntar al nombre real del archivo.
        let back_cover_page =
            String::from_utf8(entries.get("OEBPS/9_back_cover.xhtml").unwrap().clone()).unwrap();
        assert!(back_cover_page.contains(nombre.trim_start_matches("OEBPS/")));
    }

    #[test]
    fn el_export_avisa_cuando_un_publicado_no_tiene_tapa_en_disco() {
        let (_root, book) = repo_con_publicados();
        let hermano = book.parent().unwrap().join("2 - Hermano");
        std::fs::write(
            hermano.join("book.json"),
            r#"{"titulo":"Hermano","link":"https://x/h","tapa":"no-existe.png"}"#,
        )
        .unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        assert!(
            result.avisos.iter().any(|a| a.contains("Hermano") && a.contains("sin tapa")),
            "avisos: {:?}",
            result.avisos
        );
    }

    #[test]
    fn el_indice_incluye_las_paginas_editoriales_agrupadas() {
        let (root, book) = repo_con_publicados();
        std::fs::write(root.path().join("autor.json"), r#"{"bio":{"es":"x"}}"#).unwrap();
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"Actual","dedicatoria":"Para vos"}"#,
        )
        .unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let toc = String::from_utf8(entries.get("OEBPS/toc.xhtml").unwrap().clone()).unwrap();

        for etiqueta in ["Copyright", "Dedicatoria", "Otros libros", "Sobre el autor"] {
            assert!(toc.contains(etiqueta), "falta {} en el índice", etiqueta);
        }
        assert!(toc.contains("toc-editorial"));
        // El copyright va antes del primer capítulo y el catálogo después.
        let pos_copy = toc.find("Copyright").unwrap();
        let pos_cap = toc.find("Cap").unwrap_or(toc.len());
        let pos_otros = toc.find("Otros libros").unwrap();
        assert!(pos_copy < pos_cap);
        assert!(pos_otros > pos_cap);
        // La portadilla y la contratapa no son destinos de navegación.
        // (chequeo por atributo href completo: "1_title.xhtml" a secas matchea
        // como substring dentro de "11_ch1_title.xhtml", el href real del
        // capítulo 1 — sin las comillas el assert no discrimina nada.)
        assert!(!toc.contains("href=\"1_title.xhtml\""));

        let ncx = String::from_utf8(entries.get("OEBPS/toc.ncx").unwrap().clone()).unwrap();
        assert!(ncx.contains("Otros libros"));
        assert!(ncx.contains("Sobre el autor"));
    }

    #[test]
    fn una_pagina_editorial_ausente_no_deja_entrada_en_el_indice() {
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(book.join("book.json"), r#"{"titulo":"Solo"}"#).unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let toc = String::from_utf8(entries.get("OEBPS/toc.xhtml").unwrap().clone()).unwrap();
        assert!(!toc.contains("Dedicatoria"));
        assert!(!toc.contains("Otros libros"));
        assert!(!toc.contains("Sobre el autor"));
        assert!(toc.contains("Copyright"), "el copyright siempre está");
    }

    #[test]
    fn el_indice_en_ingles_usa_las_etiquetas_en_ingles() {
        let tmp_guard = TempDir::new().unwrap();
        let tmp = tmp_guard.path();
        let book = tmp.join("book");
        std::fs::create_dir_all(book.join("Cap1")).unwrap();
        std::fs::write(book.join("book.json"), r#"{"titulo":"Solo","idioma":"en"}"#).unwrap();
        std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let toc = String::from_utf8(entries.get("OEBPS/toc.xhtml").unwrap().clone()).unwrap();
        assert!(toc.contains("Copyright"));
        assert!(!toc.contains("Índice</h1>"));
    }


    #[test]
    fn el_indice_en_ingles_usa_las_etiquetas_en_ingles_en_las_cuatro_editoriales() {
        // Cubre las ramas `if is_en` de Dedication / Also by the Author /
        // About the Author, que `el_indice_en_ingles_usa_las_etiquetas_en_ingles`
        // no ejercita (su fixture no tiene dedicatoria, catálogo ni autor.json).
        let (root, book) = repo_con_publicados();
        std::fs::write(root.path().join("autor.json"), r#"{"bio":{"en":"x"}}"#).unwrap();
        std::fs::write(
            book.join("book.json"),
            r#"{"titulo":"Actual","idioma":"en","dedicatoria":"For you"}"#,
        )
        .unwrap();
        let result = export_impl(book.to_str().unwrap()).unwrap();
        let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
        let toc = String::from_utf8(entries.get("OEBPS/toc.xhtml").unwrap().clone()).unwrap();

        for etiqueta in ["Dedication", "Also by the Author", "About the Author"] {
            assert!(toc.contains(etiqueta), "falta {} en el índice en inglés", etiqueta);
        }
        // Discrimina que no se cuelen las etiquetas en español (un bug que
        // emitiera las dos, o que ignorara `is_en`, pasaría si solo
        // chequeáramos presencia de las inglesas).
        for etiqueta in ["Dedicatoria", "Otros libros", "Sobre el autor"] {
            assert!(!toc.contains(etiqueta), "se coló {} en el índice en inglés", etiqueta);
        }
    }

}
