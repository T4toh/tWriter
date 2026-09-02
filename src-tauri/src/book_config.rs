use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::theme::ThemeRef;
use crate::util::strip_numeric_prefix;

// Sin "webp"/"gif" a propósito: `image` se compila con `features = ["png", "jpeg"]`
// nomás (Cargo.toml), así que `embebido_reescalado` no puede decodificarlas — ver
// findings-finales.md, Important 4. Ofrecerlas acá sería prometer un formato que
// el decoder no sabe abrir.
pub(crate) const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png"];

/// Busca `cover.<ext>` en `dir`. Devuelve el nombre relativo (ej: "cover.jpg") si existe.
pub fn find_cover_in(dir: &Path) -> Option<String> {
    find_named_image(dir, "cover")
}

/// Busca `back-cover.<ext>` en `dir`. Devuelve el nombre relativo si existe.
pub fn find_back_cover_in(dir: &Path) -> Option<String> {
    find_named_image(dir, "back-cover")
}

/// Busca `author.<ext>` o `autor.<ext>` en `dir`. Devuelve el nombre relativo
/// si existe. Permite ambas convenciones (en/es).
pub fn find_author_photo_in(dir: &Path) -> Option<String> {
    find_named_image(dir, "author").or_else(|| find_named_image(dir, "autor"))
}

/// Única resolución de campos de imagen del repo: dado el valor crudo de un
/// campo tipo `tapa`/`foto`/`qr` (relativo a `dir` o absoluto), devuelve el
/// path absoluto si apunta a un archivo que existe en esta máquina. `None`
/// si el campo está vacío o el archivo no está (el caso de un `book.json`
/// viejo con un path absoluto de otra PC).
pub fn resolver_imagen(dir: &Path, campo: Option<&str>) -> Option<PathBuf> {
    let value = campo.map(str::trim).filter(|s| !s.is_empty())?;
    let p = Path::new(value);
    let full = if p.is_absolute() { p.to_path_buf() } else { dir.join(p) };
    full.is_file().then_some(full)
}

/// `true` si el field de imagen no sirve y conviene autodescubrir: está vacío,
/// **o** apunta a un archivo que no está en esta máquina — el caso de los
/// `book.json` viejos con un path absoluto de otra PC. Sin esto el EPUB se
/// exportaba sin portada en silencio teniendo el `cover.png` al lado.
pub fn image_field_unusable(dir: &Path, field: Option<&str>) -> bool {
    resolver_imagen(dir, field).is_none()
}

/// Stems canónicos de las imágenes que vive al lado de un `book.json`/`saga.json`
/// (`cover`, `back-cover`, `author`) o de `autor.json` en la raíz del repo
/// (`autor`, `qr`) — estos dos últimos son los que manda el modal del autor.
const IMAGE_STEMS: &[&str] = &["cover", "back-cover", "author", "autor", "qr"];

/// Deja la imagen elegida **dentro** de la carpeta del libro/saga y devuelve el
/// nombre relativo para guardar en el JSON. Si ya estaba adentro, no copia nada
/// y solo devuelve la ruta relativa. Guardar el path absoluto que devuelve el
/// file dialog no sirve: la imagen no viaja por git y el EPUB sale sin portada
/// en la otra PC. Mismo criterio que la normalización del import wizard.
pub fn adopt_image(dir: &Path, source: &Path, stem: &str) -> Result<String, String> {
    if !IMAGE_STEMS.contains(&stem) {
        return Err(format!("stem no permitido: {}", stem));
    }
    if !dir.is_dir() {
        return Err(format!("no es carpeta: {}", dir.display()));
    }
    if !source.is_file() {
        return Err(format!("la imagen no existe: {}", source.display()));
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !COVER_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "formato no soportado: .{} (usar {})",
            ext,
            COVER_EXTS.join(", ")
        ));
    }
    // Ya vive adentro: alcanza con guardarla relativa.
    if let (Ok(canon_dir), Ok(canon_src)) = (dir.canonicalize(), source.canonicalize()) {
        if let Ok(rel) = canon_src.strip_prefix(&canon_dir) {
            return Ok(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    let dest_name = format!("{}.{}", stem, ext);
    fs::copy(source, dir.join(&dest_name)).map_err(|e| format!("copiar imagen: {}", e))?;
    // La elegida pasa a ser LA tapa: barrer las otras extensiones del mismo
    // stem, o queda un `cover.png` viejo al lado del `cover.jpg` nuevo y
    // `find_cover_in` puede levantar el equivocado.
    for otra in COVER_EXTS.iter().filter(|e| **e != ext) {
        let _ = fs::remove_file(dir.join(format!("{}.{}", stem, otra)));
    }
    Ok(dest_name)
}

/// Rectángulo de recorte cuadrado, en píxeles de la imagen original elegida
/// por el autor. Lo arma el cropper a mano de `autor-modal.ts` — no hay
/// detección de cara, el autor mueve el cuadro.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub side: u32,
}

/// Wrapper de `adopt_image`/`adopt_image_cropped` para los modales de config
/// (libro, saga y autor). `crop` es `None` para los tres llamadores viejos
/// (tapa/contratapa/QR) — el comportamiento no cambia. El modal del autor lo
/// manda cuando la foto no es cuadrada y hubo que recortarla a mano.
#[tauri::command]
pub fn adopt_config_image(
    dir_path: String,
    source_path: String,
    stem: String,
    crop: Option<CropRect>,
) -> Result<String, String> {
    let dir = Path::new(&dir_path);
    let source = Path::new(&source_path);
    match crop {
        None => adopt_image(dir, source, &stem),
        Some(rect) => adopt_image_cropped(dir, source, &stem, rect),
    }
}

/// Como `adopt_image`, pero recorta `source` al cuadrado `rect` antes de
/// escribir. A diferencia de `adopt_image`, siempre reescribe el archivo aunque
/// `source` ya viva adentro de `dir`: el contenido cambia, no solo la
/// ubicación, así que el atajo "ya está adentro, no copiar nada" no aplica acá.
pub fn adopt_image_cropped(
    dir: &Path,
    source: &Path,
    stem: &str,
    rect: CropRect,
) -> Result<String, String> {
    if !IMAGE_STEMS.contains(&stem) {
        return Err(format!("stem no permitido: {}", stem));
    }
    if !dir.is_dir() {
        return Err(format!("no es carpeta: {}", dir.display()));
    }
    if !source.is_file() {
        return Err(format!("la imagen no existe: {}", source.display()));
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !COVER_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "formato no soportado: .{} (usar {})",
            ext,
            COVER_EXTS.join(", ")
        ));
    }
    let bytes = fs::read(source).map_err(|e| format!("leer imagen: {}", e))?;
    let img = ::image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let recortada = img.crop_imm(rect.x, rect.y, rect.side, rect.side);
    let dest_name = format!("{}.{}", stem, ext);
    let dest_path = dir.join(&dest_name);
    if ext == "png" {
        recortada
            .save_with_format(&dest_path, ::image::ImageFormat::Png)
            .map_err(|e| format!("guardar imagen: {}", e))?;
    } else {
        // jpg/jpeg: mismo encoder y calidad que `reescalar_jpeg` en image.rs.
        let mut out = fs::File::create(&dest_path).map_err(|e| format!("guardar imagen: {}", e))?;
        recortada
            .to_rgb8()
            .write_with_encoder(::image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82))
            .map_err(|e| format!("guardar imagen: {}", e))?;
    }
    // Mismo criterio que `adopt_image`: la elegida reemplaza cualquier otra
    // extensión del mismo stem.
    for otra in COVER_EXTS.iter().filter(|e| **e != ext) {
        let _ = fs::remove_file(dir.join(format!("{}.{}", stem, otra)));
    }
    Ok(dest_name)
}

pub(crate) fn find_named_image(dir: &Path, stem: &str) -> Option<String> {
    for ext in COVER_EXTS {
        let candidate = dir.join(format!("{}.{}", stem, ext));
        if candidate.is_file() {
            return Some(format!("{}.{}", stem, ext));
        }
    }
    None
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BookConfig {
    #[serde(default)]
    pub titulo: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitulo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autor: Option<String>,
    #[serde(default)]
    pub idioma: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    /// Path relativo al book dir (ej: "cover.png") o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tapa: Option<String>,
    /// Contratapa. Path relativo al book dir (ej: "back-cover.png") o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contratapa: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copyright_anio: Option<u32>,
    #[serde(default)]
    pub derechos_reservados: Option<bool>,
    /// Inciso "obra de ficción" de la página legal. Si está ausente hereda
    /// `derechos_reservados`, que es lo que lo prendía antes de que los
    /// incisos se separaran — así los book.json viejos exportan igual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obra_de_ficcion: Option<bool>,
    /// Inciso que aclara que la IA se usó solo para generar imágenes y que
    /// el texto es del autor. Default: apagado.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nota_ia: Option<bool>,
    /// Redacción propia por inciso, con las claves "reserva", "ficcion" e
    /// "ia". Solo se guarda lo que el autor haya editado; lo que falta usa
    /// el texto default del idioma del libro.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub textos_legales: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedicatoria: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imprenta: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serie: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numero_en_serie: Option<u32>,
    /// URL pública del libro (la página del autor, o la ficha de la tienda).
    /// Tenerla cargada es lo que mete al libro en la sección "Otros libros"
    /// de los EPUB de los demás libros. Ver `catalogo.rs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// Mostrar el título del capítulo en la chapter title page. Default: true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_titulo_capitulo: Option<bool>,
    /// Prefijo del capítulo: "none" | "decimal" | "roman". Default: "none".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefijo_capitulo: Option<String>,
    /// Letrina (drop cap) en primera letra del primer párrafo de cada capítulo. Default: false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropcap: Option<bool>,
    /// Mostrar número/título de la parte arriba de su contenido. Default: false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_numero_parte: Option<bool>,
    /// Formato de etiqueta de parte: "raw" (1) | "parte" (Parte 1) | "punto" (1.). Default: "raw".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formato_parte: Option<String>,
    /// Template de tamaño de página para export EPUB: "6x9" | "5x8" | "a5". Default: "6x9".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Marca la novela como finalizada (sin más capítulos por agregar). Oculta el creador de capítulos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalizada: Option<bool>,
    /// Path relativo al book dir del directorio del epílogo (ej: "Epílogo"). Único por novela.
    /// El epílogo se trata como un capítulo independiente al final del libro, fuera del TOC principal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epilogo: Option<String>,
    /// Tema base + overrides per-campo. Sobrescribe lo heredado de la saga.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemeRef>,
    /// Bio del autor para la página "Sobre el autor" del EPUB. Plain text;
    /// cada línea no vacía se renderea como un `<p>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sobre_el_autor: Option<String>,
    /// Path relativo al book dir (ej: "author.jpg") o absoluto. Si es absoluto,
    /// el builder lo copia al EPUB; si es relativo, se busca en `<book>/`.
    /// Auto-detecta `author.*`/`autor.*` en disco si está vacío.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foto_autor: Option<String>,
}

#[tauri::command]
pub fn get_book_config(book_path: String) -> Result<BookConfig, String> {
    let book_dir = PathBuf::from(&book_path);
    let p = book_dir.join("book.json");
    let mut cfg = if p.exists() {
        let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        serde_json::from_str::<BookConfig>(&raw).map_err(|e| e.to_string())?
    } else {
        let dir_name = book_dir
            .file_name()
            .and_then(|s| s.to_str())
            .map(strip_numeric_prefix)
            .unwrap_or_default();
        BookConfig {
            titulo: dir_name,
            idioma: Some("es".to_string()),
            ..Default::default()
        }
    };
    if image_field_unusable(&book_dir, cfg.tapa.as_deref()) {
        if let Some(found) = find_cover_in(&book_dir) {
            cfg.tapa = Some(found);
        }
    }
    if image_field_unusable(&book_dir, cfg.contratapa.as_deref()) {
        if let Some(found) = find_back_cover_in(&book_dir) {
            cfg.contratapa = Some(found);
        }
    }
    if image_field_unusable(&book_dir, cfg.foto_autor.as_deref()) {
        if let Some(found) = find_author_photo_in(&book_dir) {
            cfg.foto_autor = Some(found);
        }
    }
    Ok(cfg)
}

#[tauri::command]
pub fn set_book_config(book_path: String, config: BookConfig) -> Result<(), String> {
    let p = PathBuf::from(&book_path);
    if !p.is_dir() {
        return Err(format!("no es directorio: {}", book_path));
    }
    let target = p.join("book.json");
    let mut json =
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&target, json).map_err(|e| e.to_string())
}

/// Marca un directorio sección como epílogo de su novela contenedora.
/// Renombra el dir a "Epílogo" / "Epilogue" según `book.json::idioma`,
/// quitando cualquier prefijo numérico, y escribe `book.json::epilogo`.
/// Falla si ya hay epílogo o si la sección no es hija directa de la novela.
#[tauri::command]
pub async fn mark_as_epilogo(section_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mark_as_epilogo_impl(&section_path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn mark_as_epilogo_impl(section_path: &str) -> Result<String, String> {
    let section = PathBuf::from(section_path);
    if !section.is_dir() {
        return Err(format!("no es directorio: {}", section_path));
    }
    let parent = section
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "sección sin parent".to_string())?;
    let book_json = parent.join("book.json");
    if !book_json.is_file() {
        return Err("la sección no es hija directa de una novela (sin book.json)".to_string());
    }
    let raw = fs::read_to_string(&book_json).map_err(|e| e.to_string())?;
    let mut cfg: BookConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if cfg
        .epilogo
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        return Err(format!(
            "la novela ya tiene epílogo: {}",
            cfg.epilogo.as_deref().unwrap_or("")
        ));
    }
    let target_name = match cfg.idioma.as_deref().unwrap_or("es") {
        "en" => "Epilogue",
        _ => "Epílogo",
    };
    let current_name = section
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "nombre de sección inválido".to_string())?
        .to_string();
    let final_path = if current_name == target_name {
        section.clone()
    } else {
        let target = parent.join(target_name);
        if target.exists() {
            return Err(format!("ya existe: {}", target.display()));
        }
        fs::rename(&section, &target).map_err(|e| e.to_string())?;
        target
    };
    cfg.epilogo = Some(target_name.to_string());
    let mut out = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    out.push('\n');
    fs::write(&book_json, out).map_err(|e| e.to_string())?;
    Ok(final_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn png(path: &Path) {
        fs::write(path, b"\x89PNG fake").unwrap();
    }

    #[test]
    fn adopta_imagen_de_afuera_copiandola_con_el_nombre_canonico() {
        let libro = TempDir::new().unwrap();
        let afuera = TempDir::new().unwrap();
        let src = afuera.path().join("Mi Tapa Rev3.png");
        png(&src);

        let rel = adopt_image(libro.path(), &src, "cover").unwrap();

        assert_eq!(rel, "cover.png");
        assert!(libro.path().join("cover.png").is_file());
        assert_eq!(find_cover_in(libro.path()).as_deref(), Some("cover.png"));
    }

    #[test]
    fn imagen_que_ya_vive_adentro_queda_relativa_sin_copiar() {
        let libro = TempDir::new().unwrap();
        let dentro = libro.path().join("extras");
        fs::create_dir(&dentro).unwrap();
        let src = dentro.join("tapa.png");
        png(&src);

        let rel = adopt_image(libro.path(), &src, "cover").unwrap();

        assert_eq!(rel, "extras/tapa.png");
        assert!(!libro.path().join("cover.png").exists(), "no debe copiar");
    }

    #[test]
    fn reemplazar_la_tapa_sobreescribe_la_anterior() {
        let libro = TempDir::new().unwrap();
        let afuera = TempDir::new().unwrap();
        fs::write(libro.path().join("cover.png"), b"vieja").unwrap();
        let src = afuera.path().join("nueva.png");
        fs::write(&src, b"nueva").unwrap();

        let rel = adopt_image(libro.path(), &src, "cover").unwrap();

        assert_eq!(rel, "cover.png");
        assert_eq!(fs::read(libro.path().join("cover.png")).unwrap(), b"nueva");
    }

    #[test]
    fn la_elegida_reemplaza_la_tapa_aunque_cambie_la_extension() {
        let libro = TempDir::new().unwrap();
        let afuera = TempDir::new().unwrap();
        png(&libro.path().join("cover.png"));
        let src = afuera.path().join("nueva.jpg");
        fs::write(&src, b"jpeg nueva").unwrap();

        let rel = adopt_image(libro.path(), &src, "cover").unwrap();

        assert_eq!(rel, "cover.jpg");
        assert!(!libro.path().join("cover.png").exists(), "la vieja se barre");
        assert_eq!(find_cover_in(libro.path()).as_deref(), Some("cover.jpg"));
    }

    #[test]
    fn autodescubre_cuando_el_path_esta_vacio_o_muerto() {
        let libro = TempDir::new().unwrap();
        png(&libro.path().join("cover.png"));

        assert!(image_field_unusable(libro.path(), None));
        assert!(image_field_unusable(libro.path(), Some("  ")));
        // El caso real: absoluto de la PC vieja.
        assert!(image_field_unusable(
            libro.path(),
            Some("/home/tatoh/Downloads/La Princesa V3.png")
        ));
        assert!(image_field_unusable(libro.path(), Some("no-esta.png")));
        assert!(!image_field_unusable(libro.path(), Some("cover.png")));
    }

    #[test]
    fn rechaza_formato_y_stem_invalidos() {
        let libro = TempDir::new().unwrap();
        let afuera = TempDir::new().unwrap();
        let pdf = afuera.path().join("tapa.pdf");
        fs::write(&pdf, b"pdf").unwrap();
        let ok = afuera.path().join("tapa.png");
        png(&ok);

        assert!(adopt_image(libro.path(), &pdf, "cover").is_err());
        assert!(adopt_image(libro.path(), &ok, "../escape").is_err());
        assert!(adopt_image(libro.path(), &afuera.path().join("no-existe.png"), "cover").is_err());
    }

    #[test]
    fn rechaza_webp_porque_el_decoder_no_lo_sabe_abrir() {
        // `image` se compila sin la feature `webp` (Cargo.toml): adoptar un
        // .webp dejaría un archivo que `embebido_reescalado` nunca puede
        // decodificar al exportar. Ver findings-finales.md, Important 4.
        let libro = TempDir::new().unwrap();
        let afuera = TempDir::new().unwrap();
        let webp = afuera.path().join("tapa.webp");
        fs::write(&webp, b"RIFF....WEBP").unwrap();

        let err = adopt_image(libro.path(), &webp, "cover").unwrap_err();
        assert!(err.contains("formato no soportado"), "err: {}", err);
    }

    #[test]
    fn acepta_los_stems_del_modal_del_autor() {
        // El modal del autor manda "autor" y "qr" a adopt_config_image; si
        // IMAGE_STEMS no los incluye, los dos pickers del modal fallan siempre
        // con "stem no permitido" (ver findings-finales.md, Important 1).
        let root = TempDir::new().unwrap();
        let afuera = TempDir::new().unwrap();
        let src = afuera.path().join("qr.png");
        png(&src);

        let rel = adopt_image(root.path(), &src, "qr").unwrap();

        assert_eq!(rel, "qr.png");
        assert!(root.path().join("qr.png").is_file());
    }

    #[test]
    fn recorta_la_region_pedida_no_cualquier_cuadrado() {
        // Apaisada 300x200: mitad izquierda roja, mitad derecha azul — un
        // recorte que agarre la región equivocada (o que solo sea cuadrado
        // de cualquier lado) sale con el color que no es.
        let libro = TempDir::new().unwrap();
        let afuera = TempDir::new().unwrap();
        let mut img = ::image::RgbImage::from_pixel(300, 200, ::image::Rgb([200, 0, 0]));
        for y in 0..200 {
            for x in 150..300 {
                img.put_pixel(x, y, ::image::Rgb([0, 0, 200]));
            }
        }
        let src = afuera.path().join("foto.png");
        ::image::DynamicImage::ImageRgb8(img).save(&src).unwrap();

        let rect = CropRect { x: 160, y: 20, side: 100 };
        let rel = adopt_image_cropped(libro.path(), &src, "autor", rect).unwrap();

        assert_eq!(rel, "autor.png");
        let out = ::image::open(libro.path().join(&rel)).unwrap();
        assert_eq!(
            (out.width(), out.height()),
            (100, 100),
            "el lado tiene que ser el pedido (100), no el lado corto de la fuente (200)"
        );
        let rgb = out.to_rgb8();
        assert_eq!(
            rgb.get_pixel(0, 0).0,
            [0, 0, 200],
            "x=160 cae del lado azul de la fuente; si saliera rojo el recorte agarró otra región"
        );
        assert_eq!(rgb.get_pixel(99, 99).0, [0, 0, 200]);
    }

    #[test]
    fn recortar_reescribe_aunque_la_fuente_ya_viva_adentro() {
        // A diferencia de `adopt_image`, acá el atajo "ya está adentro, no
        // copiar" no puede aplicar: el contenido cambia con el recorte.
        let libro = TempDir::new().unwrap();
        let mut img = ::image::RgbImage::from_pixel(200, 100, ::image::Rgb([10, 10, 10]));
        for y in 0..100 {
            for x in 100..200 {
                img.put_pixel(x, y, ::image::Rgb([250, 250, 0]));
            }
        }
        let src = libro.path().join("autor.png");
        ::image::DynamicImage::ImageRgb8(img).save(&src).unwrap();

        let rect = CropRect { x: 100, y: 0, side: 100 };
        adopt_image_cropped(libro.path(), &src, "autor", rect).unwrap();

        let out = ::image::open(libro.path().join("autor.png")).unwrap();
        assert_eq!((out.width(), out.height()), (100, 100));
        assert_eq!(out.to_rgb8().get_pixel(0, 0).0, [250, 250, 0]);
    }

    #[test]
    fn sin_rect_de_recorte_adopt_config_image_no_cambia_de_comportamiento() {
        let libro = TempDir::new().unwrap();
        let afuera = TempDir::new().unwrap();
        let src = afuera.path().join("Mi Tapa Rev3.png");
        png(&src);

        let rel = adopt_config_image(
            libro.path().to_string_lossy().into_owned(),
            src.to_string_lossy().into_owned(),
            "cover".to_string(),
            None,
        )
        .unwrap();

        assert_eq!(rel, "cover.png");
        assert!(libro.path().join("cover.png").is_file());
    }
}
