use git2::Repository;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Backend de almacenamiento del root de novelas.
///
/// Detección automática por path → ningún setting persistido. Prioridad:
/// 1. Si es repo git (libgit2 lo descubre) → `Git`. Esto incluye el caso
///    "git repo adentro de Dropbox" — git gana, Dropbox queda como sync invisible.
/// 2. Si algún componente del path matchea un patrón conocido de cloud sync
///    (Dropbox, pCloud, Nextcloud, etc) → ese backend.
/// 3. Fallback → `Local`.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StorageBackend {
    Git,
    Dropbox,
    PCloud,
    Nextcloud,
    OneDrive,
    #[serde(rename = "gdrive")]
    GoogleDrive,
    ICloud,
    Sync,
    Mega,
    Local,
}

#[tauri::command]
pub async fn detect_storage_backend(path: String) -> Result<StorageBackend, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(detect_backend(Path::new(&path))))
        .await
        .map_err(|e| format!("task: {}", e))?
}

pub fn detect_backend(path: &Path) -> StorageBackend {
    // Una raíz de guion es el repo del juego: git lo maneja el autor desde
    // ahí, así que para tWriter es una carpeta local aunque sea repo.
    if path.join(crate::fs::GUION_MARKER).is_file() {
        let b = StorageBackend::Local;
        tracing::info!(target: "storage", backend = ?b, path = %path.display(), "raíz de guion: git apagado");
        return b;
    }
    if is_git_repo(path) {
        let b = StorageBackend::Git;
        tracing::info!(target: "storage", backend = ?b, path = %path.display(), "backend detectado");
        return b;
    }
    let cloud = cloud_match(path);
    let b = cloud.unwrap_or(StorageBackend::Local);
    tracing::info!(target: "storage", backend = ?b, path = %path.display(), "backend detectado");
    b
}

fn is_git_repo(path: &Path) -> bool {
    Repository::discover(PathBuf::from(path)).is_ok()
}

fn cloud_match(path: &Path) -> Option<StorageBackend> {
    // Iteramos los componentes del path de afuera hacia adentro y
    // matcheamos por nombre exacto (lowercase). Componentes con substrings
    // que arruinen el match (e.g. "syncthing-data") quedan filtrados por
    // depender de igualdad estricta donde corresponde.
    for comp in path.components() {
        let name = comp.as_os_str().to_string_lossy().to_lowercase();
        if name.is_empty() {
            continue;
        }
        if let Some(b) = match_component(&name) {
            return Some(b);
        }
    }
    None
}

fn match_component(name: &str) -> Option<StorageBackend> {
    // Patrones canónicos primero (nombre exacto del folder default del cliente).
    match name {
        "dropbox" => return Some(StorageBackend::Dropbox),
        "pcloud" | "pcloud drive" | "pclouddrive" => return Some(StorageBackend::PCloud),
        "nextcloud" | "owncloud" => return Some(StorageBackend::Nextcloud),
        "onedrive" => return Some(StorageBackend::OneDrive),
        "google drive" | "googledrive" | "gdrive" => return Some(StorageBackend::GoogleDrive),
        "icloud drive" | "icloud" | "mobile documents" => return Some(StorageBackend::ICloud),
        "syncthing" | "sync" => return Some(StorageBackend::Sync),
        "mega" | "megasync" => return Some(StorageBackend::Mega),
        _ => {}
    }

    // Variantes con sufijo de cuenta (e.g. "OneDrive - Personal", "Dropbox (Empresa)").
    if name.starts_with("dropbox") {
        return Some(StorageBackend::Dropbox);
    }
    if name.starts_with("onedrive") {
        return Some(StorageBackend::OneDrive);
    }
    if name.starts_with("nextcloud") {
        return Some(StorageBackend::Nextcloud);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn raiz_de_guion_es_local_aunque_sea_repo_git() {
        let tmp = tempfile::tempdir().unwrap();
        Repository::init(tmp.path()).unwrap();
        assert_eq!(detect_backend(tmp.path()), StorageBackend::Git);
        std::fs::write(tmp.path().join(crate::fs::GUION_MARKER), "").unwrap();
        assert_eq!(detect_backend(tmp.path()), StorageBackend::Local);
    }

    #[test]
    fn detect_dropbox() {
        assert_eq!(
            cloud_match(&p("/home/user/Dropbox/Novelas")),
            Some(StorageBackend::Dropbox)
        );
    }

    #[test]
    fn detect_dropbox_business_suffix() {
        assert_eq!(
            cloud_match(&p("/home/user/Dropbox (Empresa)/Novelas")),
            Some(StorageBackend::Dropbox)
        );
    }

    #[test]
    fn detect_pcloud() {
        assert_eq!(
            cloud_match(&p("/home/user/pCloudDrive/escritos")),
            Some(StorageBackend::PCloud)
        );
    }

    #[test]
    fn detect_onedrive_with_account() {
        assert_eq!(
            cloud_match(&p("/home/user/OneDrive - Personal/libros")),
            Some(StorageBackend::OneDrive)
        );
    }

    #[test]
    fn detect_gdrive() {
        assert_eq!(
            cloud_match(&p("/home/user/Google Drive/My Drive/x")),
            Some(StorageBackend::GoogleDrive)
        );
    }

    #[test]
    fn detect_nextcloud() {
        assert_eq!(
            cloud_match(&p("/home/user/Nextcloud/escritos")),
            Some(StorageBackend::Nextcloud)
        );
    }

    #[test]
    fn detect_icloud_mac() {
        assert_eq!(
            cloud_match(&p(
                "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Novelas"
            )),
            Some(StorageBackend::ICloud)
        );
    }

    #[test]
    fn detect_local_plain() {
        assert_eq!(cloud_match(&p("/tmp/foo/bar")), None);
        assert_eq!(cloud_match(&p("/home/user/Repos/Novelas")), None);
    }

    #[test]
    fn detect_local_does_not_match_syncthing_data() {
        // "syncthing-data" no debe matchear "sync" (no son iguales).
        assert_eq!(cloud_match(&p("/home/user/syncthing-data/x")), None);
    }
}
