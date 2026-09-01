use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Debug)]
pub struct ImageData {
    pub mime: String,
    pub base64: String,
}

/// Lee un archivo de imagen y devuelve mime + base64 para usar como data URL.
/// Más confiable que asset:// en WebKitGTK con paths con espacios o acentos.
#[tauri::command]
pub async fn read_image(path: String) -> Result<ImageData, String> {
    tauri::async_runtime::spawn_blocking(move || read_impl(&path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn read_impl(path: &str) -> Result<ImageData, String> {
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err(format!("no es archivo: {}", path));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return Err(format!("formato no soportado: .{}", ext)),
    };
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    let base64 = base64_encode(&bytes);
    Ok(ImageData {
        mime: mime.to_string(),
        base64,
    })
}

fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut chunks = input.chunks_exact(3);
    for chunk in &mut chunks {
        let b0 = chunk[0] as u32;
        let b1 = chunk[1] as u32;
        let b2 = chunk[2] as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
        out.push(ALPHABET[((n >> 6) & 0x3F) as usize] as char);
        out.push(ALPHABET[(n & 0x3F) as usize] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        1 => {
            let b0 = rem[0] as u32;
            let n = b0 << 16;
            out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let b0 = rem[0] as u32;
            let b1 = rem[1] as u32;
            let n = (b0 << 16) | (b1 << 8);
            out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
            out.push(ALPHABET[((n >> 6) & 0x3F) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

use ::image::imageops::FilterType;
use ::image::ImageFormat;

/// Reescala a `ancho_max` conservando proporción y devuelve JPEG calidad 82.
/// Si la imagen ya entra, devuelve los bytes originales sin recomprimir —
/// recomprimir de gusto solo agrega artefactos.
pub fn reescalar_jpeg(bytes: &[u8], ancho_max: u32) -> Result<Vec<u8>, String> {
    let img = ::image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    if img.width() <= ancho_max {
        return Ok(bytes.to_vec());
    }
    let alto = (img.height() as f64 * ancho_max as f64 / img.width() as f64).round() as u32;
    let chica = img.resize_exact(ancho_max, alto.max(1), FilterType::Lanczos3);
    let mut out = std::io::Cursor::new(Vec::new());
    chica
        .to_rgb8()
        .write_with_encoder(::image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82))
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Reescala a `ancho_max` y devuelve PNG. Usa vecino más cercano y no pasa
/// por JPEG: los bordes de los módulos de un QR tienen que quedar duros, y
/// los artefactos del JPEG hacen que algunos lectores fallen al escanear.
pub fn reescalar_png_nitido(bytes: &[u8], ancho_max: u32) -> Result<Vec<u8>, String> {
    let img = ::image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    if img.width() <= ancho_max {
        return Ok(bytes.to_vec());
    }
    let alto = (img.height() as f64 * ancho_max as f64 / img.width() as f64).round() as u32;
    let chica = img.resize_exact(ancho_max, alto.max(1), FilterType::Nearest);
    let mut out = std::io::Cursor::new(Vec::new());
    chica.write_to(&mut out, ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PNG sólido de `w`x`h`, generado en memoria para no meter fixtures
    /// binarios al repo.
    fn png_de(w: u32, h: u32) -> Vec<u8> {
        let buf = ::image::RgbImage::from_pixel(w, h, ::image::Rgb([200, 30, 30]));
        let mut out = std::io::Cursor::new(Vec::new());
        ::image::DynamicImage::ImageRgb8(buf)
            .write_to(&mut out, ::image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn dimensiones(bytes: &[u8]) -> (u32, u32) {
        let img = ::image::load_from_memory(bytes).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn reescala_a_lo_ancho_y_conserva_la_proporcion() {
        let grande = png_de(2000, 3000);
        let chico = reescalar_jpeg(&grande, 400).unwrap();
        assert_eq!(dimensiones(&chico), (400, 600));
    }

    #[test]
    fn el_reescalado_achica_el_archivo() {
        let grande = png_de(2000, 3000);
        let chico = reescalar_jpeg(&grande, 400).unwrap();
        assert!(
            chico.len() < grande.len(),
            "esperaba menos bytes: {} vs {}",
            chico.len(),
            grande.len()
        );
        assert!(chico.len() < 100 * 1024, "la miniatura pesa {} bytes", chico.len());
    }

    #[test]
    fn una_imagen_que_ya_entra_vuelve_intacta() {
        let chica = png_de(300, 450);
        let out = reescalar_jpeg(&chica, 400).unwrap();
        assert_eq!(out, chica, "no debería recomprimir lo que ya entra");
    }

    #[test]
    fn el_qr_sale_png_y_no_jpeg() {
        let qr = png_de(1200, 1200);
        let out = reescalar_png_nitido(&qr, 600).unwrap();
        assert_eq!(&out[1..4], b"PNG", "el QR tiene que seguir siendo PNG");
        assert_eq!(dimensiones(&out), (600, 600));
    }

    #[test]
    fn bytes_que_no_son_imagen_dan_error_con_el_motivo() {
        let err = reescalar_jpeg(b"no soy una imagen", 400).unwrap_err();
        assert!(!err.is_empty());
    }
}
