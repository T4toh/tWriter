//! Perfil del autor, global al repo. Un repo de novelas = un escritor, así
//! que la bio, la foto, la web y el QR viven una sola vez en `autor.json`
//! en la raíz, en vez de repetidos en cada `book.json`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::book_config::resolver_imagen;

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct AutorConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nombre: Option<String>,
    /// Bio por idioma: `{"es": "...", "en": "..."}`. BTreeMap y no HashMap
    /// para que el JSON salga siempre en el mismo orden y no genere diffs
    /// espurios en el repo de novelas, que va por git.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub bio: BTreeMap<String, String>,
    /// Path relativo a la raíz (ej: "autor.jpg") o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foto: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web: Option<String>,
    /// Imagen del QR que apunta a `web`. Path relativo a la raíz o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qr: Option<String>,
}

/// Bases de nombre que se buscan en disco cuando el campo está vacío o
/// apunta a un archivo que ya no está. Mismo criterio que usa
/// `book_config::find_author_photo_in` para la foto per-libro.
const FOTO_STEMS: &[&str] = &["autor", "author"];
const QR_STEMS: &[&str] = &["qr"];
const EXTS: &[&str] = &["png", "jpg", "jpeg", "webp"];

impl AutorConfig {
    /// Bio del idioma pedido; si no está, la de cualquier otro idioma
    /// cargado. Las bios en blanco no cuentan.
    pub fn bio_en(&self, idioma: &str) -> Option<&str> {
        let util = |s: &&String| !s.trim().is_empty();
        self.bio
            .get(idioma)
            .filter(util)
            .or_else(|| self.bio.values().find(util))
            .map(|s| s.trim())
    }
}

pub fn leer(root: &Path) -> AutorConfig {
    let mut cfg = fs::read_to_string(root.join("autor.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<AutorConfig>(&raw).ok())
        .unwrap_or_default();
    if resolver_imagen(root, cfg.foto.as_deref()).is_none() {
        cfg.foto = buscar(root, FOTO_STEMS);
    }
    if resolver_imagen(root, cfg.qr.as_deref()).is_none() {
        cfg.qr = buscar(root, QR_STEMS);
    }
    cfg
}

pub fn escribir(root: &Path, cfg: &AutorConfig) -> Result<(), String> {
    let mut json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(root.join("autor.json"), json).map_err(|e| e.to_string())
}

fn buscar(root: &Path, stems: &[&str]) -> Option<String> {
    for stem in stems {
        for ext in EXTS {
            let nombre = format!("{}.{}", stem, ext);
            if root.join(&nombre).is_file() {
                return Some(nombre);
            }
        }
    }
    None
}

#[tauri::command]
pub fn get_autor_config(root: String) -> Result<AutorConfig, String> {
    Ok(leer(Path::new(&root)))
}

#[tauri::command]
pub fn set_autor_config(root: String, config: AutorConfig) -> Result<(), String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("no es directorio: {}", root));
    }
    escribir(&p, &config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        let suffix: u128 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("twriter-autor-test-{}", suffix));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn sin_archivo_devuelve_config_vacia() {
        let root = tempdir();
        assert_eq!(leer(&root), AutorConfig::default());
    }

    #[test]
    fn lee_el_archivo_cuando_existe() {
        let root = tempdir();
        fs::write(
            root.join("autor.json"),
            r#"{"nombre":"Tatoh","bio":{"es":"hola"},"web":"https://tatoh.ar"}"#,
        )
        .unwrap();
        let cfg = leer(&root);
        assert_eq!(cfg.nombre.as_deref(), Some("Tatoh"));
        assert_eq!(cfg.web.as_deref(), Some("https://tatoh.ar"));
        assert_eq!(cfg.bio.get("es").map(String::as_str), Some("hola"));
    }

    #[test]
    fn bio_cae_al_otro_idioma_cuando_falta_el_pedido() {
        let mut cfg = AutorConfig::default();
        cfg.bio.insert("es".into(), "bio en español".into());
        assert_eq!(cfg.bio_en("es"), Some("bio en español"));
        assert_eq!(cfg.bio_en("en"), Some("bio en español"));
    }

    #[test]
    fn bio_prefiere_el_idioma_pedido_cuando_estan_los_dos() {
        let mut cfg = AutorConfig::default();
        cfg.bio.insert("es".into(), "español".into());
        cfg.bio.insert("en".into(), "english".into());
        assert_eq!(cfg.bio_en("en"), Some("english"));
        assert_eq!(cfg.bio_en("es"), Some("español"));
    }

    #[test]
    fn bio_vacia_no_cuenta_como_bio() {
        let mut cfg = AutorConfig::default();
        cfg.bio.insert("es".into(), "   ".into());
        assert_eq!(cfg.bio_en("es"), None);
    }

    #[test]
    fn autodetecta_foto_y_qr_en_disco() {
        let root = tempdir();
        fs::write(root.join("autor.json"), r#"{"nombre":"Tatoh"}"#).unwrap();
        fs::write(root.join("autor.jpg"), b"fake").unwrap();
        fs::write(root.join("qr.png"), b"fake").unwrap();
        let cfg = leer(&root);
        assert_eq!(cfg.foto.as_deref(), Some("autor.jpg"));
        assert_eq!(cfg.qr.as_deref(), Some("qr.png"));
    }

    #[test]
    fn no_autodetecta_si_el_campo_ya_apunta_a_un_archivo_que_existe() {
        let root = tempdir();
        fs::write(root.join("autor.json"), r#"{"qr":"mi-qr.png"}"#).unwrap();
        fs::write(root.join("mi-qr.png"), b"fake").unwrap();
        fs::write(root.join("qr.png"), b"fake").unwrap();
        assert_eq!(leer(&root).qr.as_deref(), Some("mi-qr.png"));
    }

    #[test]
    fn round_trip_de_escritura() {
        let root = tempdir();
        let mut cfg = AutorConfig::default();
        cfg.nombre = Some("Tatoh".into());
        cfg.bio.insert("es".into(), "hola".into());
        escribir(&root, &cfg).unwrap();
        assert_eq!(leer(&root), cfg);
    }
}
