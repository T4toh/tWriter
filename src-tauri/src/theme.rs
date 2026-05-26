use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const FONT_EXTS: &[&str] = &["ttf", "otf", "woff", "woff2"];

/// Tema reutilizable. Vive en `<root>/themes/<id>/theme.json`. Todos los
/// campos visuales son opcionales para permitir overrides parciales desde
/// `saga.json` y `book.json`.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Theme {
    /// Identificador (slug). Útil al deserializar para round-trip; el dir
    /// es la fuente de verdad.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Nombre human-readable para la UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nombre: Option<String>,
    /// Familia para body. Coincide con la base parsed de los filenames en `fonts/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_font: Option<String>,
    /// Tamaño CSS del body (e.g. `11pt`, `1em`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_size: Option<String>,
    /// Familia para títulos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_font: Option<String>,
    /// Tamaño CSS de `h1.chapter-title`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_size: Option<String>,
    /// `line-height` del body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<String>,
    /// Margen del `@page` (CSS shorthand).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_margin: Option<String>,
    /// Filename stem (sin extensión) del face explícito para `<em>`/`<i>`.
    /// Pisa el auto-pick de italic dentro de la familia base. Útil cuando la
    /// italic de la familia base es muy sutil (ej: usar `IBMPlexSans-MediumItalic`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_font_italic: Option<String>,
    /// Filename stem del face explícito para `<strong>`/`<b>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_font_bold: Option<String>,
    /// Filename stem del face explícito para combinaciones `<strong><em>` etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_font_bold_italic: Option<String>,
    /// Familia para texto de páginas editoriales (copyright, dedicatoria, TOC,
    /// title page, sobre el autor). Se resuelve igual que `body_font` (auto-pick
    /// por sufijo). None = cae al `body_font` del tema (cero regresión).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editorial_body_font: Option<String>,
    /// Familia para títulos de páginas editoriales (TÍTULO de la title page,
    /// "Índice" del TOC, parte-headings del TOC, encabezado de about-author).
    /// None = cae al `heading_font` del tema (cero regresión).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editorial_heading_font: Option<String>,
    /// Posición vertical del bloque título+prefix en la página de chapter-title.
    /// Valores válidos: `top` | `center` | `bottom`. None o cualquier otro valor
    /// = `center` (default — CSS base ya centra vía table-cell + fallback Kindle
    /// vía @media amzn-kf8 en epub_style.css).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_title_position: Option<String>,
    /// Prefijo del capítulo: `none` | `decimal` | `roman`. Default: `none`.
    /// Antes vivía en book.json/saga.json; ahora pertenece al tema para que
    /// múltiples libros que comparten tema tengan el mismo formato.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefijo_capitulo: Option<String>,
    /// Mostrar el título del capítulo en la chapter title page. Default: true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_titulo_capitulo: Option<bool>,
    /// Letrina (dropcap) en la primera letra del primer párrafo de cada capítulo. Default: false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropcap: Option<bool>,
    /// Mostrar número/título de la parte arriba de su contenido. Default: false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_numero_parte: Option<bool>,
    /// Formato de etiqueta de parte: `raw` (1) | `parte` (Parte 1) | `punto` (1.). Default: `raw`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formato_parte: Option<String>,
    /// Tamaño de página EPUB: `6x9` | `5x8` | `a5`. Default: `6x9`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Ángulo en grados para la oblique sintética de `<em>`/`<i>`. Si está set,
    /// el CSS del EPUB emite `font-style: oblique Ndeg` en vez del default
    /// `font-style: italic`. Útil para fuentes donde la italic estándar se ve
    /// muy poco. Rango razonable: 8-20deg.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic_oblique_deg: Option<f32>,
    /// Peso numérico para `<em>`/`<i>` (100-900). None = peso del regular. Útil
    /// si querés italic más fuerte que la regular pero sin ser bold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic_weight: Option<u32>,
    /// Peso numérico para `<strong>`/`<b>` (100-900). Si está set, el CSS del
    /// EPUB emite `font-weight: N` en vez del default `font-weight: bold` (700).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold_weight: Option<u32>,
}

/// Referencia a un tema en saga.json/book.json. `base` es el id del tema,
/// `overrides` los campos que se sobreescriben sobre el base.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct ThemeRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Theme>,
}

/// Tema resuelto al exportar EPUB. Todos los `*_font` quedan como nombre de
/// familia; los archivos a embeber se listan en `fonts`.
#[derive(Debug, Clone, Default)]
pub struct ResolvedTheme {
    pub body_font: Option<String>,
    pub body_size: Option<String>,
    pub heading_font: Option<String>,
    pub heading_size: Option<String>,
    pub line_height: Option<String>,
    pub page_margin: Option<String>,
    pub fonts: Vec<FontEmbed>,
    /// Familia CSS para texto de páginas editoriales. None = sin override.
    pub editorial_body_font: Option<String>,
    /// Familia CSS para títulos de páginas editoriales. None = sin override.
    pub editorial_heading_font: Option<String>,
    /// Posición vertical del bloque título+prefix en la página de chapter-title.
    /// `top` | `bottom`. None = default (center vía CSS base).
    pub chapter_title_position: Option<String>,
    /// Estilo de capítulos: prefijo (`none`/`decimal`/`roman`). None = `none`.
    pub prefijo_capitulo: Option<String>,
    /// Mostrar el título del capítulo en chapter title page. None = true.
    pub mostrar_titulo_capitulo: Option<bool>,
    /// Letrina (dropcap) en primera letra de cada capítulo. None = false.
    pub dropcap: Option<bool>,
    /// Mostrar header de parte. None = false.
    pub mostrar_numero_parte: Option<bool>,
    /// Formato de etiqueta de parte (`raw`/`parte`/`punto`). None = `raw`.
    pub formato_parte: Option<String>,
    /// Tamaño de página EPUB (`6x9`/`5x8`/`a5`). None = `6x9`.
    pub template: Option<String>,
    /// Ángulo de la oblique sintética para `em`/`i`. None = `font-style: italic` (default UA).
    pub italic_oblique_deg: Option<f32>,
    /// Peso numérico para `em`/`i`. None = peso del regular.
    pub italic_weight: Option<u32>,
    /// Peso numérico para `strong`/`b`. None = `font-weight: bold` (700).
    pub bold_weight: Option<u32>,
}

impl ResolvedTheme {
    /// True si el tema no aporta nada (sin fields, sin fonts). Cuando esto
    /// pasa, el EPUB sale con `serif`/`sans-serif` genéricos como antes.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.body_font.is_none()
            && self.body_size.is_none()
            && self.heading_font.is_none()
            && self.heading_size.is_none()
            && self.line_height.is_none()
            && self.page_margin.is_none()
            && self.fonts.is_empty()
            && self.editorial_body_font.is_none()
            && self.editorial_heading_font.is_none()
            && self.chapter_title_position.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontEmbed {
    /// Nombre de familia CSS.
    pub family: String,
    /// 400 (regular) | 700 (bold).
    pub weight: u32,
    /// `normal` | `italic`.
    pub style: String,
    /// Filename original (e.g. `Merriweather-Bold.ttf`).
    pub filename: String,
    /// Path absoluto al archivo en disco.
    pub abs_path: PathBuf,
    /// MIME type EPUB-3.
    pub media_type: String,
}

/// Media type a declarar en el OPF manifest para un archivo de fuente.
/// Usamos los nombres legacy (`application/vnd.ms-opentype`, `application/font-woff`)
/// porque varios lectores (Okular, lectores Qt-basados, lectores Android viejos)
/// no reconocen los mimes nuevos `font/*` de EPUB 3.1. Kindle + Calibre +
/// Apple Books aceptan ambos sin problema.
pub fn font_media_type(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "ttf" | "otf" => Some("application/vnd.ms-opentype"),
        "woff" => Some("application/font-woff"),
        "woff2" => Some("font/woff2"),
        _ => None,
    }
}

pub fn is_font_ext(ext: &str) -> bool {
    let lower = ext.to_ascii_lowercase();
    FONT_EXTS.iter().any(|e| *e == lower)
}

/// Detecta sufijo `-Regular|-Bold|-Italic|-BoldItalic|-Roman|-Oblique`
/// (case-insensitive, separador `-` o `_`). Sin sufijo → `(stem, 400, "normal")`.
pub fn parse_face_suffix(stem: &str) -> (String, u32, &'static str) {
    if let Some(idx) = stem.rfind(['-', '_']) {
        let base = &stem[..idx];
        let suffix = &stem[idx + 1..];
        let lower = suffix.to_ascii_lowercase();
        let (weight, style) = match lower.as_str() {
            "regular" | "roman" | "normal" | "book" => (400, "normal"),
            "italic" | "oblique" => (400, "italic"),
            "bold" => (700, "normal"),
            "bolditalic" | "boldoblique" => (700, "italic"),
            _ => return (stem.to_string(), 400, "normal"),
        };
        if !base.is_empty() {
            return (base.to_string(), weight, style);
        }
    }
    (stem.to_string(), 400, "normal")
}

fn scan_fonts(dir: &Path) -> Vec<(String, u32, &'static str, PathBuf)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !is_font_ext(ext) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let (family, weight, style) = parse_face_suffix(stem);
        out.push((family, weight, style, path));
    }
    out
}

/// Busca todos los faces de la familia `family` en `dirs` (en orden). El
/// primer dir donde aparezca al menos un face es el dueño y devuelve TODOS
/// sus faces. Mezclar faces entre niveles produciría resultados raros, por
/// eso solo un dir gana.
pub fn collect_faces(family: &str, dirs: &[&Path]) -> Vec<FontEmbed> {
    let target_lower = family.to_ascii_lowercase();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        let scanned = scan_fonts(dir);
        let matching: Vec<_> = scanned
            .into_iter()
            .filter(|(fam, _, _, _)| fam.to_ascii_lowercase() == target_lower)
            .collect();
        if matching.is_empty() {
            continue;
        }
        return matching
            .into_iter()
            .filter_map(|(_, weight, style, path)| {
                let filename = path.file_name()?.to_str()?.to_string();
                let ext = path.extension()?.to_str()?;
                let media_type = font_media_type(ext)?.to_string();
                Some(FontEmbed {
                    family: family.to_string(),
                    weight,
                    style: style.to_string(),
                    filename,
                    abs_path: path,
                    media_type,
                })
            })
            .collect();
    }
    Vec::new()
}

fn read_theme_ref(json_path: &Path) -> Option<ThemeRef> {
    let raw = fs::read_to_string(json_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let theme_v = v.get("theme")?;
    serde_json::from_value(theme_v.clone()).ok()
}

fn load_base_theme(root: &Path, id: &str) -> Option<Theme> {
    let path = root.join("themes").join(id).join("theme.json");
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn merge_overrides(base: &mut Theme, ov: &Theme) {
    if ov.body_font.is_some() {
        base.body_font = ov.body_font.clone();
    }
    if ov.body_size.is_some() {
        base.body_size = ov.body_size.clone();
    }
    if ov.heading_font.is_some() {
        base.heading_font = ov.heading_font.clone();
    }
    if ov.heading_size.is_some() {
        base.heading_size = ov.heading_size.clone();
    }
    if ov.line_height.is_some() {
        base.line_height = ov.line_height.clone();
    }
    if ov.page_margin.is_some() {
        base.page_margin = ov.page_margin.clone();
    }
    if ov.editorial_body_font.is_some() {
        base.editorial_body_font = ov.editorial_body_font.clone();
    }
    if ov.editorial_heading_font.is_some() {
        base.editorial_heading_font = ov.editorial_heading_font.clone();
    }
    if ov.chapter_title_position.is_some() {
        base.chapter_title_position = ov.chapter_title_position.clone();
    }
    if ov.prefijo_capitulo.is_some() {
        base.prefijo_capitulo = ov.prefijo_capitulo.clone();
    }
    if ov.mostrar_titulo_capitulo.is_some() {
        base.mostrar_titulo_capitulo = ov.mostrar_titulo_capitulo;
    }
    if ov.dropcap.is_some() {
        base.dropcap = ov.dropcap;
    }
    if ov.mostrar_numero_parte.is_some() {
        base.mostrar_numero_parte = ov.mostrar_numero_parte;
    }
    if ov.formato_parte.is_some() {
        base.formato_parte = ov.formato_parte.clone();
    }
    if ov.template.is_some() {
        base.template = ov.template.clone();
    }
    if ov.italic_oblique_deg.is_some() {
        base.italic_oblique_deg = ov.italic_oblique_deg;
    }
    if ov.italic_weight.is_some() {
        base.italic_weight = ov.italic_weight;
    }
    if ov.bold_weight.is_some() {
        base.bold_weight = ov.bold_weight;
    }
}

/// Lee los campos de "estilo de capítulos" en el root de un book.json o
/// saga.json legacy (sin envolver en `theme.overrides`). Devuelve un Theme
/// con sólo esos campos populados; el resto queda None. Sirve para back-compat
/// — repos viejos siguen funcionando sin reescribir los JSON.
fn read_legacy_chapter_style(json_path: &Path) -> Theme {
    let Ok(raw) = fs::read_to_string(json_path) else {
        return Theme::default();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Theme::default();
    };
    Theme {
        prefijo_capitulo: v
            .get("prefijo_capitulo")
            .and_then(|x| x.as_str())
            .map(String::from),
        mostrar_titulo_capitulo: v.get("mostrar_titulo_capitulo").and_then(|x| x.as_bool()),
        dropcap: v.get("dropcap").and_then(|x| x.as_bool()),
        mostrar_numero_parte: v.get("mostrar_numero_parte").and_then(|x| x.as_bool()),
        formato_parte: v
            .get("formato_parte")
            .and_then(|x| x.as_str())
            .map(String::from),
        template: v
            .get("template")
            .and_then(|x| x.as_str())
            .map(String::from),
        ..Default::default()
    }
}

/// Aplica fallback de los campos de "estilo de capítulos" desde book.json y
/// saga.json legacy. Estos campos antes vivían en el root de esos JSON; ahora
/// pertenecen al tema. Esta función completa los campos que el tema no definió
/// con los valores legacy, para mantener back-compat con repos viejos.
fn apply_legacy_chapter_style_fallback(theme: &mut Theme, book: &Theme, saga: &Theme) {
    if theme.prefijo_capitulo.is_none() {
        theme.prefijo_capitulo = book
            .prefijo_capitulo
            .clone()
            .or_else(|| saga.prefijo_capitulo.clone());
    }
    if theme.mostrar_titulo_capitulo.is_none() {
        theme.mostrar_titulo_capitulo = book.mostrar_titulo_capitulo.or(saga.mostrar_titulo_capitulo);
    }
    if theme.dropcap.is_none() {
        theme.dropcap = book.dropcap.or(saga.dropcap);
    }
    if theme.mostrar_numero_parte.is_none() {
        theme.mostrar_numero_parte = book.mostrar_numero_parte.or(saga.mostrar_numero_parte);
    }
    if theme.formato_parte.is_none() {
        theme.formato_parte = book
            .formato_parte
            .clone()
            .or_else(|| saga.formato_parte.clone());
    }
    if theme.template.is_none() {
        theme.template = book.template.clone().or_else(|| saga.template.clone());
    }
}

/// Resuelve el tema efectivo para un libro:
/// 1. `effective_base = book.theme.base or saga.theme.base`.
/// 2. Si hay base, carga `<root>/themes/<base>/theme.json` como source de defaults.
/// 3. Aplica `saga.theme.overrides`, después `book.theme.overrides`.
/// 4. Aplica legacy fallback de chapter-style (book.json / saga.json root level).
/// 5. Resuelve archivos de fuentes con search order:
///    `<book>/fonts/` → `<saga>/fonts/` → `<root>/fonts/` → `<root>/themes/<base>/fonts/`.
pub fn resolve_theme(
    book_dir: &Path,
    saga_dir: Option<&Path>,
    root_dir: &Path,
) -> ResolvedTheme {
    let book_ref = read_theme_ref(&book_dir.join("book.json"));
    let saga_ref = saga_dir.and_then(|d| read_theme_ref(&d.join("saga.json")));

    let saga_legacy = saga_dir
        .map(|d| read_legacy_chapter_style(&d.join("saga.json")))
        .unwrap_or_default();
    let book_legacy = read_legacy_chapter_style(&book_dir.join("book.json"));

    let effective_base = book_ref
        .as_ref()
        .and_then(|r| r.base.clone())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            saga_ref
                .as_ref()
                .and_then(|r| r.base.clone())
                .filter(|s| !s.trim().is_empty())
        });

    let mut theme = match effective_base.as_ref() {
        Some(base_id) => match load_base_theme(root_dir, base_id) {
            Some(t) => t,
            None => {
                tracing::warn!(target: "theme", base = %base_id, "tema base dangling — no existe en root/themes/, usando default");
                Theme::default()
            }
        },
        None => Theme::default(),
    };

    if let Some(sr) = saga_ref.as_ref() {
        if let Some(ov) = sr.overrides.as_ref() {
            merge_overrides(&mut theme, ov);
        }
    }
    if let Some(br) = book_ref.as_ref() {
        if let Some(ov) = br.overrides.as_ref() {
            merge_overrides(&mut theme, ov);
        }
    }

    apply_legacy_chapter_style_fallback(&mut theme, &book_legacy, &saga_legacy);

    // Sin tema base ni body_font/heading_font heredado, no hay fuentes que
    // resolver. Devolvemos un ResolvedTheme con los chapter-style fields
    // populados (sirven al EPUB aunque no haya tema configurado).
    if effective_base.is_none() && theme.body_font.is_none() && theme.heading_font.is_none() {
        return ResolvedTheme {
            chapter_title_position: theme.chapter_title_position,
            prefijo_capitulo: theme.prefijo_capitulo,
            mostrar_titulo_capitulo: theme.mostrar_titulo_capitulo,
            dropcap: theme.dropcap,
            mostrar_numero_parte: theme.mostrar_numero_parte,
            formato_parte: theme.formato_parte,
            template: theme.template,
            ..ResolvedTheme::default()
        };
    }

    let base_id_for_fonts = effective_base.clone().unwrap_or_default();
    let theme_fonts_dir = root_dir.join("themes").join(&base_id_for_fonts).join("fonts");
    let book_fonts_dir = book_dir.join("fonts");
    let saga_fonts_dir = saga_dir.map(|d| d.join("fonts"));
    let root_fonts_dir = root_dir.join("fonts");

    // Orden de resolución: book/saga (overrides locales) → root (pool global,
    // canónico) → theme/X/fonts (legacy back-compat).
    let mut search_dirs: Vec<PathBuf> = Vec::new();
    search_dirs.push(book_fonts_dir);
    if let Some(d) = saga_fonts_dir {
        search_dirs.push(d);
    }
    search_dirs.push(root_fonts_dir);
    if !base_id_for_fonts.is_empty() {
        search_dirs.push(theme_fonts_dir);
    }

    let dir_refs: Vec<&Path> = search_dirs.iter().map(|p| p.as_path()).collect();

    let mut fonts: Vec<FontEmbed> = Vec::new();
    let mut seen_families: BTreeSet<String> = BTreeSet::new();

    for family_opt in [
        &theme.body_font,
        &theme.heading_font,
        &theme.editorial_body_font,
        &theme.editorial_heading_font,
    ] {
        let Some(fam) = family_opt
            .as_deref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if !seen_families.insert(fam.to_ascii_lowercase()) {
            continue;
        }
        let faces = collect_faces(&fam, &dir_refs);
        if faces.is_empty() {
            tracing::warn!(target: "theme", family = %fam, "fuente no encontrada en book/saga/root/theme fonts/");
            continue;
        }
        fonts.extend(faces);
    }

    ResolvedTheme {
        body_font: theme.body_font,
        body_size: theme.body_size,
        heading_font: theme.heading_font,
        heading_size: theme.heading_size,
        line_height: theme.line_height,
        page_margin: theme.page_margin,
        fonts,
        editorial_body_font: theme.editorial_body_font,
        editorial_heading_font: theme.editorial_heading_font,
        chapter_title_position: theme.chapter_title_position,
        prefijo_capitulo: theme.prefijo_capitulo,
        mostrar_titulo_capitulo: theme.mostrar_titulo_capitulo,
        dropcap: theme.dropcap,
        mostrar_numero_parte: theme.mostrar_numero_parte,
        formato_parte: theme.formato_parte,
        template: theme.template,
        italic_oblique_deg: theme.italic_oblique_deg,
        italic_weight: theme.italic_weight,
        bold_weight: theme.bold_weight,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_face_suffix_basic() {
        assert_eq!(
            parse_face_suffix("Merriweather-Regular"),
            ("Merriweather".to_string(), 400, "normal")
        );
        assert_eq!(
            parse_face_suffix("Merriweather-Bold"),
            ("Merriweather".to_string(), 700, "normal")
        );
        assert_eq!(
            parse_face_suffix("Merriweather-Italic"),
            ("Merriweather".to_string(), 400, "italic")
        );
        assert_eq!(
            parse_face_suffix("Merriweather-BoldItalic"),
            ("Merriweather".to_string(), 700, "italic")
        );
    }

    #[test]
    fn parse_face_suffix_underscore() {
        assert_eq!(
            parse_face_suffix("Lato_Bold"),
            ("Lato".to_string(), 700, "normal")
        );
    }

    #[test]
    fn parse_face_suffix_case_insensitive() {
        assert_eq!(
            parse_face_suffix("Lato-bold"),
            ("Lato".to_string(), 700, "normal")
        );
        assert_eq!(
            parse_face_suffix("Lato-BOLD"),
            ("Lato".to_string(), 700, "normal")
        );
    }

    #[test]
    fn parse_face_suffix_no_suffix() {
        assert_eq!(
            parse_face_suffix("Merriweather"),
            ("Merriweather".to_string(), 400, "normal")
        );
    }

    #[test]
    fn parse_face_suffix_unknown_keeps_full_stem() {
        assert_eq!(
            parse_face_suffix("Merriweather-Light"),
            ("Merriweather-Light".to_string(), 400, "normal")
        );
    }

    #[test]
    fn parse_face_suffix_oblique_roman() {
        assert_eq!(
            parse_face_suffix("Lato-Oblique"),
            ("Lato".to_string(), 400, "italic")
        );
        assert_eq!(
            parse_face_suffix("Lato-Roman"),
            ("Lato".to_string(), 400, "normal")
        );
    }

    #[test]
    fn parse_face_suffix_compound_family_name() {
        assert_eq!(
            parse_face_suffix("Source-Sans-Pro-Bold"),
            ("Source-Sans-Pro".to_string(), 700, "normal")
        );
    }

    #[test]
    fn font_media_type_known_exts() {
        assert_eq!(font_media_type("ttf"), Some("application/vnd.ms-opentype"));
        assert_eq!(font_media_type("OTF"), Some("application/vnd.ms-opentype"));
        assert_eq!(font_media_type("woff"), Some("application/font-woff"));
        assert_eq!(font_media_type("woff2"), Some("font/woff2"));
        assert_eq!(font_media_type("png"), None);
    }

    #[test]
    fn is_font_ext_works() {
        assert!(is_font_ext("ttf"));
        assert!(is_font_ext("OTF"));
        assert!(is_font_ext("WoFf2"));
        assert!(!is_font_ext("png"));
        assert!(!is_font_ext(""));
    }

    #[test]
    fn resolve_theme_unconfigured_returns_empty() {
        let tmp = tempdir();
        let book = tmp.join("book");
        fs::create_dir_all(&book).unwrap();
        fs::write(book.join("book.json"), "{\"titulo\":\"x\"}").unwrap();
        let resolved = resolve_theme(&book, None, &tmp);
        assert!(resolved.is_empty());
    }

    #[test]
    fn resolve_theme_loads_base() {
        let tmp = tempdir();
        // theme
        let theme_dir = tmp.join("themes").join("classic");
        fs::create_dir_all(theme_dir.join("fonts")).unwrap();
        fs::write(
            theme_dir.join("theme.json"),
            r#"{"id":"classic","nombre":"Classic","body_font":"Merriweather","body_size":"11pt"}"#,
        )
        .unwrap();
        // book
        let book = tmp.join("book");
        fs::create_dir_all(&book).unwrap();
        fs::write(
            book.join("book.json"),
            r#"{"titulo":"x","theme":{"base":"classic"}}"#,
        )
        .unwrap();

        let resolved = resolve_theme(&book, None, &tmp);
        assert_eq!(resolved.body_font.as_deref(), Some("Merriweather"));
        assert_eq!(resolved.body_size.as_deref(), Some("11pt"));
    }

    #[test]
    fn resolve_theme_book_overrides_saga() {
        let tmp = tempdir();
        let theme_dir = tmp.join("themes").join("classic");
        fs::create_dir_all(theme_dir.join("fonts")).unwrap();
        fs::write(
            theme_dir.join("theme.json"),
            r#"{"id":"classic","body_font":"Merriweather","heading_font":"Lato"}"#,
        )
        .unwrap();
        let saga = tmp.join("saga");
        let book = saga.join("book");
        fs::create_dir_all(&book).unwrap();
        fs::write(
            saga.join("saga.json"),
            r#"{"nombre":"S","theme":{"base":"classic","overrides":{"body_size":"12pt"}}}"#,
        )
        .unwrap();
        fs::write(
            book.join("book.json"),
            r#"{"titulo":"B","theme":{"overrides":{"body_size":"13pt"}}}"#,
        )
        .unwrap();

        let resolved = resolve_theme(&book, Some(&saga), &tmp);
        assert_eq!(resolved.body_size.as_deref(), Some("13pt"));
        assert_eq!(resolved.body_font.as_deref(), Some("Merriweather"));
        assert_eq!(resolved.heading_font.as_deref(), Some("Lato"));
    }

    #[test]
    fn resolve_theme_collects_fonts_from_theme_dir() {
        let tmp = tempdir();
        let theme_fonts = tmp.join("themes").join("classic").join("fonts");
        fs::create_dir_all(&theme_fonts).unwrap();
        // Crear archivos vacíos con extensiones válidas.
        fs::write(theme_fonts.join("Merriweather-Regular.ttf"), b"").unwrap();
        fs::write(theme_fonts.join("Merriweather-Bold.ttf"), b"").unwrap();
        fs::write(theme_fonts.join("Merriweather-Italic.ttf"), b"").unwrap();
        fs::write(
            tmp.join("themes").join("classic").join("theme.json"),
            r#"{"id":"classic","body_font":"Merriweather"}"#,
        )
        .unwrap();
        let book = tmp.join("book");
        fs::create_dir_all(&book).unwrap();
        fs::write(
            book.join("book.json"),
            r#"{"titulo":"B","theme":{"base":"classic"}}"#,
        )
        .unwrap();

        let resolved = resolve_theme(&book, None, &tmp);
        assert_eq!(resolved.fonts.len(), 3);
        let weights: Vec<u32> = resolved.fonts.iter().map(|f| f.weight).collect();
        assert!(weights.contains(&400));
        assert!(weights.contains(&700));
    }

    #[test]
    fn resolve_theme_book_fonts_override_theme_fonts() {
        let tmp = tempdir();
        let theme_fonts = tmp.join("themes").join("classic").join("fonts");
        fs::create_dir_all(&theme_fonts).unwrap();
        fs::write(theme_fonts.join("Merriweather-Regular.ttf"), b"").unwrap();
        fs::write(
            tmp.join("themes").join("classic").join("theme.json"),
            r#"{"id":"classic","body_font":"Merriweather"}"#,
        )
        .unwrap();
        let book = tmp.join("book");
        let book_fonts = book.join("fonts");
        fs::create_dir_all(&book_fonts).unwrap();
        // Override en el libro: solo Bold.
        fs::write(book_fonts.join("Merriweather-Bold.ttf"), b"").unwrap();
        fs::write(
            book.join("book.json"),
            r#"{"titulo":"B","theme":{"base":"classic"}}"#,
        )
        .unwrap();

        let resolved = resolve_theme(&book, None, &tmp);
        // El libro gana: solo Bold (1 archivo).
        assert_eq!(resolved.fonts.len(), 1);
        assert_eq!(resolved.fonts[0].weight, 700);
    }

    #[test]
    fn resolve_theme_missing_font_logs_no_crash() {
        let tmp = tempdir();
        let theme_dir = tmp.join("themes").join("classic");
        fs::create_dir_all(theme_dir.join("fonts")).unwrap();
        fs::write(
            theme_dir.join("theme.json"),
            r#"{"id":"classic","body_font":"Ghost"}"#,
        )
        .unwrap();
        let book = tmp.join("book");
        fs::create_dir_all(&book).unwrap();
        fs::write(
            book.join("book.json"),
            r#"{"titulo":"B","theme":{"base":"classic"}}"#,
        )
        .unwrap();

        let resolved = resolve_theme(&book, None, &tmp);
        assert_eq!(resolved.body_font.as_deref(), Some("Ghost"));
        assert_eq!(resolved.fonts.len(), 0);
    }

    #[test]
    fn resolve_theme_chapter_position_book_overrides_saga() {
        let tmp = tempdir();
        let theme_dir = tmp.join("themes").join("classic");
        fs::create_dir_all(theme_dir.join("fonts")).unwrap();
        fs::write(
            theme_dir.join("theme.json"),
            r#"{"id":"classic","chapter_title_position":"center"}"#,
        )
        .unwrap();
        let saga = tmp.join("saga");
        let book = saga.join("book");
        fs::create_dir_all(&book).unwrap();
        fs::write(
            saga.join("saga.json"),
            r#"{"nombre":"S","theme":{"base":"classic","overrides":{"chapter_title_position":"top"}}}"#,
        )
        .unwrap();
        fs::write(
            book.join("book.json"),
            r#"{"titulo":"B","theme":{"overrides":{"chapter_title_position":"bottom"}}}"#,
        )
        .unwrap();

        let resolved = resolve_theme(&book, Some(&saga), &tmp);
        assert_eq!(resolved.chapter_title_position.as_deref(), Some("bottom"));
    }

    #[test]
    fn resolve_theme_chapter_position_from_base() {
        let tmp = tempdir();
        let theme_dir = tmp.join("themes").join("classic");
        fs::create_dir_all(theme_dir.join("fonts")).unwrap();
        fs::write(
            theme_dir.join("theme.json"),
            r#"{"id":"classic","chapter_title_position":"top"}"#,
        )
        .unwrap();
        let book = tmp.join("book");
        fs::create_dir_all(&book).unwrap();
        fs::write(
            book.join("book.json"),
            r#"{"titulo":"B","theme":{"base":"classic"}}"#,
        )
        .unwrap();

        let resolved = resolve_theme(&book, None, &tmp);
        assert_eq!(resolved.chapter_title_position.as_deref(), Some("top"));
    }

    #[test]
    fn resolve_theme_editorial_fonts_cascade() {
        let tmp = tempdir();
        let theme_dir = tmp.join("themes").join("classic");
        fs::create_dir_all(theme_dir.join("fonts")).unwrap();
        fs::write(
            theme_dir.join("theme.json"),
            r#"{"id":"classic","body_font":"Merri","heading_font":"Lato","editorial_body_font":"Cormorant","editorial_heading_font":"Playfair"}"#,
        )
        .unwrap();
        let saga = tmp.join("saga");
        let book = saga.join("book");
        fs::create_dir_all(&book).unwrap();
        fs::write(
            saga.join("saga.json"),
            r#"{"nombre":"S","theme":{"base":"classic","overrides":{"editorial_heading_font":"Bebas"}}}"#,
        )
        .unwrap();
        fs::write(
            book.join("book.json"),
            r#"{"titulo":"B","theme":{"overrides":{"editorial_body_font":"Spectral"}}}"#,
        )
        .unwrap();

        let resolved = resolve_theme(&book, Some(&saga), &tmp);
        assert_eq!(resolved.body_font.as_deref(), Some("Merri"));
        assert_eq!(resolved.heading_font.as_deref(), Some("Lato"));
        assert_eq!(resolved.editorial_body_font.as_deref(), Some("Spectral"));
        assert_eq!(resolved.editorial_heading_font.as_deref(), Some("Bebas"));
    }

    #[test]
    fn resolve_theme_editorial_fonts_collected_in_embed_list() {
        let tmp = tempdir();
        let theme_fonts = tmp.join("themes").join("classic").join("fonts");
        fs::create_dir_all(&theme_fonts).unwrap();
        fs::write(theme_fonts.join("Cormorant-Regular.ttf"), b"").unwrap();
        fs::write(theme_fonts.join("Cormorant-Italic.ttf"), b"").unwrap();
        fs::write(theme_fonts.join("Playfair-Regular.ttf"), b"").unwrap();
        fs::write(
            tmp.join("themes").join("classic").join("theme.json"),
            r#"{"id":"classic","editorial_body_font":"Cormorant","editorial_heading_font":"Playfair"}"#,
        )
        .unwrap();
        let book = tmp.join("book");
        fs::create_dir_all(&book).unwrap();
        fs::write(
            book.join("book.json"),
            r#"{"titulo":"B","theme":{"base":"classic"}}"#,
        )
        .unwrap();

        let resolved = resolve_theme(&book, None, &tmp);
        assert_eq!(resolved.fonts.len(), 3);
        let families: std::collections::BTreeSet<_> =
            resolved.fonts.iter().map(|f| f.family.clone()).collect();
        assert!(families.contains("Cormorant"));
        assert!(families.contains("Playfair"));
    }

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        let suffix: u128 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("twriter-theme-test-{}", suffix));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }
}
