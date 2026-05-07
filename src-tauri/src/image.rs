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
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
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
