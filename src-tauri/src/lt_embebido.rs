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
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

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

/// Falla si el sha256 de `path` no es `esperado`. Va siempre antes de
/// desempaquetar o mover nada: es código que se va a ejecutar.
pub fn verificar_sha256(path: &Path, esperado: &str) -> Result<(), String> {
    let nombre = path.file_name().unwrap_or_default().to_string_lossy();
    let mut f = File::open(path).map_err(|e| format!("No pude leer {nombre}: {e}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| format!("No pude leer {nombre}: {e}"))?;
    let real = format!("{:x}", hasher.finalize());
    if real.eq_ignore_ascii_case(esperado) {
        Ok(())
    } else {
        Err(format!(
            "El archivo {nombre} no coincide con el esperado. Puede ser una descarga cortada: probá de nuevo."
        ))
    }
}

/// Desempaqueta `.tar.gz` o `.zip` (por la extensión de `archivo`) en
/// `destino`. Extrae a un temporal y renombra al final: si falla, `destino` no
/// existe.
pub fn extraer(archivo: &Path, destino: &Path) -> Result<(), String> {
    let tmp = con_sufijo(destino, ".tmp");
    let _ = fs::remove_dir_all(&tmp);
    let hecho = (|| -> Result<(), String> {
        let f = File::open(archivo).map_err(|e| e.to_string())?;
        if archivo.extension().is_some_and(|e| e == "zip") {
            zip::ZipArchive::new(f)
                .and_then(|mut z| z.extract(&tmp))
                .map_err(|e| e.to_string())?;
        } else {
            let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(f));
            tar.set_preserve_permissions(true);
            tar.unpack(&tmp).map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, destino).map_err(|e| e.to_string())
    })();
    if let Err(e) = hecho {
        let _ = fs::remove_dir_all(&tmp);
        let nombre = archivo.file_name().unwrap_or_default().to_string_lossy();
        return Err(format!("No pude desempaquetar {nombre}: {e}. Probá bajarlo de nuevo."));
    }
    Ok(())
}

/// `lt-6.8` → `lt-6.8.tmp`. No `with_extension`: pisaría el `.8`.
fn con_sufijo(p: &Path, sufijo: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(sufijo);
    PathBuf::from(s)
}

/// Baja lo que falte o difiera del lock a `base`. LT y el JRE se instalan por
/// separado, cada uno con su `.ok` al final; una pieza que falla se borra
/// entera y la otra queda. No borra versiones viejas: eso lo hace quien llama,
/// después de comprobar que la nueva arranca.
pub async fn instalar(
    base: &Path,
    progreso: &(dyn Fn(&'static str, String) + Sync),
) -> Result<(), String> {
    let lock = lock();
    let jre = jre_del_target(lock)
        .ok_or_else(|| format!("No hay Java para {} en la lista de tWriter.", target_actual()))?;
    fs::create_dir_all(base).map_err(|e| format!("No pude crear {}: {e}", base.display()))?;
    let falta_lt = instalado(base, "lt").as_deref() != Some(lock.lt.as_str());
    let falta_jre = instalado(base, "jre").as_deref() != Some(lock.jre.as_str());
    let total = if falta_lt { lock.jars.iter().map(|j| j.size).sum() } else { 0 }
        + if falta_jre { jre.size } else { 0 };
    let mut bajada = Bajada { client: cliente()?, hechos: 0, total, avisado: 0, progreso };

    if falta_lt {
        let dir = base.join(format!("lt-{}", lock.lt));
        let tmp = con_sufijo(&dir, ".tmp");
        let _ = fs::remove_dir_all(&tmp);
        let r = async {
            fs::create_dir_all(tmp.join("libs")).map_err(|e| e.to_string())?;
            for jar in &lock.jars {
                let destino = tmp.join("libs").join(&jar.file);
                bajada.bajar(&jar.url, &destino).await?;
                verificar_sha256(&destino, &jar.sha256)?;
            }
            fs::rename(&tmp, &dir).map_err(|e| e.to_string())?;
            fs::write(dir.join(".ok"), "").map_err(|e| e.to_string())
        }
        .await;
        if let Err(e) = r {
            let _ = fs::remove_dir_all(&tmp);
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
    }

    if falta_jre {
        let dir = base.join(format!("jre-{}", lock.jre));
        let nombre = jre.url.rsplit('/').next().unwrap_or("jre");
        let archivo = base.join(nombre);
        let r = async {
            bajada.bajar(&jre.url, &archivo).await?;
            (bajada.progreso)("verifying", "Verificando Java…".into());
            verificar_sha256(&archivo, &jre.sha256)?;
            (bajada.progreso)("extracting", "Desempaquetando Java…".into());
            let _ = fs::remove_dir_all(&dir);
            extraer(&archivo, &dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(dir.join(&jre.java), fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("No pude marcar java como ejecutable: {e}"))?;
            }
            fs::write(dir.join(".ok"), "").map_err(|e| e.to_string())
        }
        .await;
        let _ = fs::remove_file(&archivo);
        if let Err(e) = r {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
    }
    Ok(())
}

fn cliente() -> Result<reqwest::Client, String> {
    // Sin timeout total: son ~142 MB y una conexión lenta no es un error.
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

struct Bajada<'a> {
    client: reqwest::Client,
    hechos: u64,
    total: u64,
    avisado: u64,
    progreso: &'a (dyn Fn(&'static str, String) + Sync),
}

impl Bajada<'_> {
    async fn bajar(&mut self, url: &str, destino: &Path) -> Result<(), String> {
        let host = url.split('/').nth(2).unwrap_or(url);
        let sin_red = |e: reqwest::Error| format!("No pude bajar de {host}: {e}. Revisá la conexión y probá de nuevo.");
        let mut resp = self.client.get(url).send().await.and_then(|r| r.error_for_status()).map_err(sin_red)?;
        let mut f = File::create(destino).map_err(|e| format!("No pude escribir {}: {e}", destino.display()))?;
        while let Some(chunk) = resp.chunk().await.map_err(sin_red)? {
            f.write_all(&chunk).map_err(|e| format!("No pude escribir {}: {e}", destino.display()))?;
            self.hechos += chunk.len() as u64;
            if self.hechos - self.avisado >= 1 << 20 || self.hechos == self.total {
                self.avisado = self.hechos;
                (self.progreso)(
                    "downloading",
                    format!("Bajando LanguageTool: {} / {} MB", self.hechos >> 20, self.total >> 20),
                );
            }
        }
        Ok(())
    }
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

    #[test]
    fn sha_que_no_coincide_no_extrae() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.jar");
        fs::write(&f, b"hola").unwrap();
        let err = verificar_sha256(&f, &"0".repeat(64)).unwrap_err();
        assert!(err.contains("no coincide"), "{err}");
        assert!(err.contains("a.jar"), "{err}");
    }

    #[test]
    fn sha_correcto_pasa() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.jar");
        fs::write(&f, b"hola").unwrap();
        verificar_sha256(&f, "b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn extraer_tar_gz_preserva_ejecutable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let archivo = dir.path().join("jre.tar.gz");
        let gz = flate2::write::GzEncoder::new(fs::File::create(&archivo).unwrap(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        let mut h = tar::Header::new_gnu();
        h.set_size(4);
        h.set_mode(0o755);
        h.set_cksum();
        tar.append_data(&mut h, "x/bin/java", &b"java"[..]).unwrap();
        tar.into_inner().unwrap().finish().unwrap();

        let destino = dir.path().join("jre-21");
        extraer(&archivo, &destino).unwrap();
        let modo = fs::metadata(destino.join("x/bin/java")).unwrap().permissions().mode();
        assert_eq!(modo & 0o111, 0o111, "modo {modo:o}");
    }

    #[test]
    fn extraer_corrupto_no_deja_destino() {
        let dir = tempfile::tempdir().unwrap();
        let archivo = dir.path().join("jre.tar.gz");
        fs::write(&archivo, b"esto no es un tar.gz").unwrap();
        let destino = dir.path().join("jre-21");
        assert!(extraer(&archivo, &destino).is_err());
        assert!(!destino.exists());
        assert!(!dir.path().join("jre-21.tmp").exists());
    }
}
