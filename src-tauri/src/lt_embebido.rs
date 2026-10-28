//! LanguageTool sin Docker: la app baja los jars de LT (Maven Central) y un JRE
//! de Temurin, verificados contra `lt-lock.json`, y corre LT como proceso
//! propio. La lista la arma `scripts/armar-lt-lock.mjs`; acá se compila
//! adentro con `include_str!` y es el ancla de confianza: lo que no está ahí no
//! se baja ni se ejecuta.
//!
//! En disco, bajo `app_data_dir()/languagetool/`:
//! `lt-<versión>/libs/*.jar` y `jre-<versión>/<lo que trae el archivo>`, cada
//! uno con un `.ok` que se escribe al final. Van separados para que un parche
//! del JRE baje ~50 MB y no los ~142 de todo.

use serde::Deserialize;
use std::collections::HashMap;
use std::net::TcpListener;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
pub struct Archivo {
    pub url: String,
    pub file: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
pub struct Jre {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// Ruta del `java` relativa al directorio donde se extrae el archivo.
    pub java: String,
}

#[derive(Debug, Deserialize)]
pub struct Lock {
    pub lt: String,
    pub jre: String,
    pub jars: Vec<Archivo>,
    /// Por triple de Rust (`aarch64-apple-darwin`, …).
    pub jres: HashMap<String, Jre>,
}

pub fn lock() -> &'static Lock {
    static LOCK: OnceLock<Lock> = OnceLock::new();
    LOCK.get_or_init(|| {
        serde_json::from_str(include_str!("../lt-lock.json")).expect("lt-lock.json inválido")
    })
}

/// El triple del lock para el target con el que se compiló este binario. Las
/// dos builds de Mac salen del mismo runner ARM, así que tiene que ser el
/// target de compilación y no la máquina.
pub fn target_actual() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

pub fn jre_del_target(lock: &Lock) -> Option<&Jre> {
    lock.jres.get(target_actual())
}

/// La versión instalada de `prefijo` (`"lt"` o `"jre"`): el directorio
/// `<prefijo>-<versión>` que tiene `.ok`. Los que no lo tienen son restos de
/// una descarga cortada y se borran. Si hay más de uno con `.ok` (una
/// actualización a medio limpiar), gana el más reciente.
pub fn instalado(base: &Path, prefijo: &str) -> Option<String> {
    let cabeza = format!("{prefijo}-");
    let mut mejor: Option<(std::time::SystemTime, String)> = None;
    for entrada in std::fs::read_dir(base).ok()?.flatten() {
        let nombre = entrada.file_name().to_string_lossy().into_owned();
        let Some(version) = nombre.strip_prefix(&cabeza) else {
            continue;
        };
        let ok = entrada.path().join(".ok");
        let Ok(meta) = std::fs::metadata(&ok) else {
            let _ = std::fs::remove_dir_all(entrada.path());
            continue;
        };
        let cuando = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        if mejor.as_ref().is_none_or(|(t, _)| cuando > *t) {
            mejor = Some((cuando, version.to_string()));
        }
    }
    mejor.map(|(_, v)| v)
}

/// El primer puerto libre en localhost desde `desde`.
pub fn puerto_libre(desde: u16) -> Option<u16> {
    (desde..desde.saturating_add(100)).find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lock_compilado_parsea_y_tiene_el_target_actual() {
        assert!(!lock().lt.is_empty());
        assert!(lock().jars.len() > 100, "jars: {}", lock().jars.len());
        assert!(jre_del_target(lock()).is_some(), "sin JRE para {}", target_actual());
    }

    #[test]
    fn instalado_devuelve_la_version_con_ok() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("lt-6.8")).unwrap();
        fs::write(base.path().join("lt-6.8/.ok"), "").unwrap();
        assert_eq!(instalado(base.path(), "lt").as_deref(), Some("6.8"));
        assert_eq!(instalado(base.path(), "jre"), None);
    }

    #[test]
    fn instalado_borra_directorios_sin_ok() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("lt-6.9/libs")).unwrap();
        fs::create_dir_all(base.path().join("lt-6.8")).unwrap();
        fs::write(base.path().join("lt-6.8/.ok"), "").unwrap();
        assert_eq!(instalado(base.path(), "lt").as_deref(), Some("6.8"));
        assert!(!base.path().join("lt-6.9").exists());
    }

    #[test]
    fn instalado_sin_nada_es_none() {
        let base = tempfile::tempdir().unwrap();
        assert_eq!(instalado(&base.path().join("no-existe"), "lt"), None);
    }

    #[test]
    fn puerto_libre_saltea_ocupado() {
        let ocupado = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let p = ocupado.local_addr().unwrap().port();
        let libre = puerto_libre(p).expect("algún puerto libre");
        assert_ne!(libre, p);
        assert!(libre > p);
    }
}
