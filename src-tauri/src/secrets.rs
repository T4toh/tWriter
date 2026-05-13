//! Almacenamiento de secretos sensibles (LT Premium apiKey, futuras tokens).
//!
//! Estrategia: keyring del OS primero (libsecret en Linux, Keychain en macOS,
//! Credential Manager en Windows), con fallback a `settings.json` plaintext
//! si el keyring no responde. El fallback existe porque CachyOS / sistemas
//! minimal pueden no tener un daemon de Secret Service corriendo.
//!
//! El frontend NUNCA recibe el valor del apiKey. Solo consulta presencia + backend
//! vía `lt_api_key_status` para mostrar UI; el valor se inyecta server-side en
//! el form POST a LanguageTool desde `grammar::post_check`.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "twriter";
const KEYRING_USER_APIKEY: &str = "languagetool-apikey";

/// Dónde quedó guardado el secreto, para mostrar al usuario en la UI.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SecretBackend {
    /// Wallet del sistema (recomendado).
    Keyring,
    /// Fallback en settings.json plaintext.
    Plain,
    /// No hay secreto guardado.
    None,
}

#[derive(Serialize, Debug, Clone)]
pub struct SecretStatus {
    pub present: bool,
    pub backend: SecretBackend,
    /// `true` si el keyring del OS está disponible (libsecret/KWallet/Keychain/CredMan).
    /// `false` significa que cualquier valor que se guarde va a caer al plaintext fallback.
    pub keyring_available: bool,
}

fn fallback_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    Ok(dir.join("secrets-fallback.json"))
}

fn read_fallback(app: &AppHandle) -> Option<String> {
    let path = fallback_path(app).ok()?;
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("lt_api_key")
        .and_then(|x| x.as_str())
        .map(String::from)
}

fn write_fallback(app: &AppHandle, key: Option<&str>) -> Result<(), String> {
    let path = fallback_path(app)?;
    match key {
        Some(k) if !k.is_empty() => {
            let obj = serde_json::json!({ "lt_api_key": k });
            fs::write(
                &path,
                serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            // Permisos 0600 en Unix para que solo el dueño lo lea.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
            }
            Ok(())
        }
        _ => {
            if path.exists() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

fn keyring_entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_APIKEY)
}

fn keyring_available() -> bool {
    // Probe: intentar leer (NotFound es válido — significa que el backend
    // responde y solo no hay valor todavía). Cualquier otro error indica
    // que el daemon de Secret Service / KWallet / etc. no está disponible.
    match keyring_entry() {
        Ok(entry) => match entry.get_password() {
            Ok(_) => true,
            Err(keyring::Error::NoEntry) => true,
            Err(_) => false,
        },
        Err(_) => false,
    }
}

/// Lee el apiKey de donde sea que esté. Devuelve None si no hay nada guardado.
pub fn load_lt_api_key(app: &AppHandle) -> Option<String> {
    if let Ok(entry) = keyring_entry() {
        match entry.get_password() {
            Ok(v) if !v.is_empty() => return Some(v),
            Ok(_) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(e) => {
                tracing::warn!(target: "secrets", error = %e, "keyring read falló, intentando fallback");
            }
        }
    }
    read_fallback(app)
}

#[tauri::command]
pub fn lt_api_key_status(app: AppHandle) -> SecretStatus {
    let kr_available = keyring_available();
    let in_keyring = kr_available
        && keyring_entry()
            .ok()
            .and_then(|e| e.get_password().ok())
            .filter(|v| !v.is_empty())
            .is_some();
    let in_plain = read_fallback(&app).filter(|v| !v.is_empty()).is_some();
    let (present, backend) = match (in_keyring, in_plain) {
        (true, _) => (true, SecretBackend::Keyring),
        (false, true) => (true, SecretBackend::Plain),
        (false, false) => (false, SecretBackend::None),
    };
    SecretStatus {
        present,
        backend,
        keyring_available: kr_available,
    }
}

/// Guarda o borra el apiKey. Valor vacío = borrar.
#[tauri::command]
pub fn lt_api_key_save(app: AppHandle, value: String) -> Result<SecretStatus, String> {
    let trimmed = value.trim();
    let kr_available = keyring_available();

    if kr_available {
        let entry = keyring_entry().map_err(|e| format!("keyring entry: {e}"))?;
        if trimmed.is_empty() {
            // Borrar de keyring si existía. NoEntry es ok.
            match entry.delete_credential() {
                Ok(_) => tracing::info!(target: "secrets", "apiKey LT borrada del keyring"),
                Err(keyring::Error::NoEntry) => {}
                Err(e) => {
                    tracing::warn!(target: "secrets", error = %e, "delete keyring falló");
                }
            }
            // También borrar fallback si quedó algo viejo.
            let _ = write_fallback(&app, None);
        } else {
            entry
                .set_password(trimmed)
                .map_err(|e| format!("guardar en keyring: {e}"))?;
            tracing::info!(target: "secrets", "apiKey LT guardada en keyring del sistema");
            // Si había fallback plain, limpiarlo (ya migró al keyring).
            let _ = write_fallback(&app, None);
        }
    } else {
        // Sin keyring → fallback plain con warning loggeado.
        if trimmed.is_empty() {
            write_fallback(&app, None)?;
            tracing::info!(target: "secrets", "apiKey LT borrada del fallback plain");
        } else {
            write_fallback(&app, Some(trimmed))?;
            tracing::warn!(
                target: "secrets",
                "apiKey LT guardada en plain fallback — keyring del sistema no disponible"
            );
        }
    }

    Ok(lt_api_key_status(app))
}
