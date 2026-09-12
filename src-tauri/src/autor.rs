//! Perfil del autor, global al repo. Un repo de novelas = un escritor, así
//! que la bio, la foto, la web y el QR viven una sola vez en `autor.json`
//! en la raíz, en vez de repetidos en cada `book.json`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::book_config::{find_named_image, resolver_imagen};

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct AutorConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nombre: Option<String>,
    /// Bio por idioma: `{"es": "...", "en": "..."}`. BTreeMap y no HashMap
    /// para que el JSON salga siempre en el mismo orden y no genere diffs
    /// espurios en el repo de novelas, que va por git.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub bio: BTreeMap<String, String>,
    /// Frase corta que va en itálica bajo el título de "Sobre el autor",
    /// por idioma como la bio. Opcional: sin ella la página arranca en la bio.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub epigrafe: BTreeMap<String, String>,
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
/// apunta a un archivo que ya no está. Mismo criterio (buscar ambas
/// convenciones es/en) que usa `book_config::find_author_photo_in` para la
/// foto per-libro, aunque el orden de prioridad está invertido — no importa,
/// son directorios distintos y no compiten entre sí.
const FOTO_STEMS: &[&str] = &["autor", "author"];
const QR_STEMS: &[&str] = &["qr"];

impl AutorConfig {
    /// Bio del idioma pedido; si no está, la de cualquier otro idioma
    /// cargado. Las bios en blanco no cuentan.
    pub fn bio_en(&self, idioma: &str) -> Option<&str> {
        por_idioma(&self.bio, idioma)
    }

    /// Mismo criterio que `bio_en`.
    pub fn epigrafe_en(&self, idioma: &str) -> Option<&str> {
        por_idioma(&self.epigrafe, idioma)
    }
}

fn por_idioma<'a>(campo: &'a BTreeMap<String, String>, idioma: &str) -> Option<&'a str> {
    let util = |s: &&String| !s.trim().is_empty();
    campo
        .get(idioma)
        .filter(util)
        .or_else(|| campo.values().find(util))
        .map(|s| s.trim())
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
    stems.iter().find_map(|s| find_named_image(root, s))
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
    use tempfile::TempDir;

    #[test]
    fn sin_archivo_devuelve_config_vacia() {
        let root = TempDir::new().unwrap();
        assert_eq!(leer(root.path()), AutorConfig::default());
    }

    #[test]
    fn lee_el_archivo_cuando_existe() {
        let root = TempDir::new().unwrap();
        fs::write(
            root.path().join("autor.json"),
            r#"{"nombre":"Tatoh","bio":{"es":"hola"},"web":"https://tatoh.ar"}"#,
        )
        .unwrap();
        let cfg = leer(root.path());
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
    fn epigrafe_sigue_la_misma_regla_de_idioma_que_la_bio() {
        let mut cfg = AutorConfig::default();
        cfg.epigrafe.insert("es".into(), "frase".into());
        assert_eq!(cfg.epigrafe_en("es"), Some("frase"));
        assert_eq!(cfg.epigrafe_en("en"), Some("frase"));
        assert_eq!(AutorConfig::default().epigrafe_en("es"), None);
    }

    #[test]
    fn epigrafe_ausente_no_se_serializa() {
        let json = serde_json::to_string(&AutorConfig::default()).unwrap();
        assert!(!json.contains("epigrafe"));
    }

    #[test]
    fn bio_vacia_no_cuenta_como_bio() {
        let mut cfg = AutorConfig::default();
        cfg.bio.insert("es".into(), "   ".into());
        assert_eq!(cfg.bio_en("es"), None);
    }

    #[test]
    fn autodetecta_foto_y_qr_en_disco() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("autor.json"), r#"{"nombre":"Tatoh"}"#).unwrap();
        fs::write(root.path().join("autor.jpg"), b"fake").unwrap();
        fs::write(root.path().join("qr.png"), b"fake").unwrap();
        let cfg = leer(root.path());
        assert_eq!(cfg.foto.as_deref(), Some("autor.jpg"));
        assert_eq!(cfg.qr.as_deref(), Some("qr.png"));
    }

    #[test]
    fn no_autodetecta_si_el_campo_ya_apunta_a_un_archivo_que_existe() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("autor.json"), r#"{"qr":"mi-qr.png"}"#).unwrap();
        fs::write(root.path().join("mi-qr.png"), b"fake").unwrap();
        fs::write(root.path().join("qr.png"), b"fake").unwrap();
        assert_eq!(leer(root.path()).qr.as_deref(), Some("mi-qr.png"));
    }

    #[test]
    fn round_trip_de_escritura() {
        let root = TempDir::new().unwrap();
        let mut cfg = AutorConfig::default();
        cfg.nombre = Some("Tatoh".into());
        cfg.bio.insert("es".into(), "hola".into());
        escribir(root.path(), &cfg).unwrap();
        assert_eq!(leer(root.path()), cfg);
    }
}
