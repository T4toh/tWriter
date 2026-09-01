use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::book_config::{find_cover_in, image_field_unusable};
use crate::theme::ThemeRef;

/// Archivo dedicado del diccionario per-saga. Una palabra por línea, ordenado.
/// Vive separado de `saga.json` para que git lo fusione por unión entre PCs
/// (ver `.gitattributes` + `git_ensure_dict_union_merge`). Reemplaza al campo
/// legacy `diccionario` de saga.json (que se sigue leyendo solo para migrar).
const DICT_FILE: &str = "diccionario.txt";

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SagaConfig {
    #[serde(default)]
    pub nombre: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idioma: Option<String>,
    /// Variante regional ES para LanguageTool. Ej: "es-AR", "es-ES". Si está
    /// vacío, cae al global `settings.json::grammar_variant_es`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variante_es: Option<String>,
    /// Variante regional EN para LanguageTool. Ej: "en-US", "en-GB". Si está
    /// vacío, cae al global `settings.json::grammar_variant_en`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variante_en: Option<String>,
    /// Tapa de la serie. Path relativo al saga dir (ej: "cover.png") o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tapa: Option<String>,
    /// Glosario compartido por todos los libros de la saga (nombres propios, neologismos).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diccionario: Option<Vec<String>>,
    /// Imprenta heredada a libros nuevos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imprenta: Option<String>,
    /// Defaults EPUB heredados a libros nuevos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_titulo_capitulo: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefijo_capitulo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropcap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mostrar_numero_parte: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formato_parte: Option<String>,
    /// Marca la saga como finalizada (sin más novelas por agregar). Oculta el creador de novelas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalizada: Option<bool>,
    /// Tema base + overrides per-campo. Heredado por libros que no definan `theme` propio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemeRef>,
}

#[tauri::command]
pub fn find_saga_dir(path: String) -> Option<String> {
    let mut p = PathBuf::from(&path);
    if p.is_file() {
        p = p.parent()?.to_path_buf();
    }
    let mut book_dir: Option<PathBuf> = None;
    loop {
        if p.join("saga.json").is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
        if book_dir.is_none() && p.join("book.json").is_file() {
            book_dir = Some(p.clone());
        }
        let parent = p.parent()?.to_path_buf();
        if parent == p {
            break;
        }
        p = parent;
    }
    // Sin saga.json en el árbol: caer al padre del book dir como saga implícita.
    book_dir.and_then(|b| b.parent().map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn get_saga_config(saga_path: String) -> Result<SagaConfig, String> {
    let saga_dir = PathBuf::from(&saga_path);
    let p = saga_dir.join("saga.json");
    let mut cfg = if p.exists() {
        let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        serde_json::from_str::<SagaConfig>(&raw).map_err(|e| e.to_string())?
    } else {
        let nombre = saga_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        SagaConfig {
            nombre,
            ..Default::default()
        }
    };
    if image_field_unusable(&saga_dir, cfg.tapa.as_deref()) {
        if let Some(found) = find_cover_in(&saga_dir) {
            cfg.tapa = Some(found);
        }
    }
    Ok(cfg)
}

#[tauri::command]
pub fn set_saga_config(saga_path: String, mut config: SagaConfig) -> Result<(), String> {
    let p = PathBuf::from(&saga_path);
    if !p.is_dir() {
        return Err(format!("no es directorio: {}", saga_path));
    }
    // El diccionario vive en `diccionario.txt`, no en saga.json. Antes de
    // escribir, migramos cualquier palabra legacy (la que venga en la config
    // y/o la que aún esté en saga.json en disco) al .txt para no perder datos
    // en este round-trip; `take()` deja el campo en None para que saga.json
    // nunca lo vuelva a persistir.
    let mut legacy: Vec<String> = config.diccionario.take().unwrap_or_default();
    if let Some(on_disk) = read_legacy_dict(&p) {
        legacy.extend(on_disk);
    }
    if !legacy.is_empty() {
        let mut merged = read_dict_file(&p).unwrap_or_default();
        merged.extend(legacy);
        write_dict_file(&p, &normalize_words(merged))?;
    }
    let target = p.join("saga.json");
    let mut json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&target, json).map_err(|e| e.to_string())
}

// ─────────────────────────── Diccionario per-saga ───────────────────────────

/// Normaliza una lista de palabras: trim, descarta vacías, deduplica
/// case-insensitive (primera ocurrencia gana) y ordena case-insensitive.
/// Determinista para que el archivo no genere diffs espurios entre escrituras.
fn normalize_words<I: IntoIterator<Item = String>>(input: I) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for w in input {
        let trimmed = w.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_lowercase()) {
            out.push(trimmed.to_string());
        }
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
    out
}

/// Lee `diccionario.txt` si existe. None si el archivo no está (gatilla la
/// migración desde saga.json en `get_saga_dictionary`).
fn read_dict_file(saga_dir: &Path) -> Option<Vec<String>> {
    let raw = fs::read_to_string(saga_dir.join(DICT_FILE)).ok()?;
    Some(normalize_words(raw.lines().map(|l| l.to_string())))
}

/// Escribe `diccionario.txt` con las palabras ya normalizadas. Si la lista
/// queda vacía borra el archivo (no dejamos un .txt vacío trackeado).
fn write_dict_file(saga_dir: &Path, words: &[String]) -> Result<(), String> {
    let p = saga_dir.join(DICT_FILE);
    if words.is_empty() {
        if p.exists() {
            fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let mut content = words.join("\n");
    content.push('\n');
    fs::write(&p, content).map_err(|e| e.to_string())
}

/// Lee el campo legacy `diccionario` de saga.json (fuente de migración).
fn read_legacy_dict(saga_dir: &Path) -> Option<Vec<String>> {
    let raw = fs::read_to_string(saga_dir.join("saga.json")).ok()?;
    let cfg: SagaConfig = serde_json::from_str(&raw).ok()?;
    cfg.diccionario
}

/// Borra el campo legacy `diccionario` de saga.json una vez migrado al .txt.
/// Best-effort: si falla, el .txt ya es la fuente de verdad igual.
fn strip_legacy_dict(saga_dir: &Path) -> Result<(), String> {
    let p = saga_dir.join("saga.json");
    let raw = match fs::read_to_string(&p) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    let mut cfg: SagaConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if cfg.diccionario.is_some() {
        cfg.diccionario = None;
        let mut json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
        json.push('\n');
        fs::write(&p, json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_saga_dictionary(saga_path: String) -> Result<Vec<String>, String> {
    let dir = PathBuf::from(&saga_path);
    let from_txt = read_dict_file(&dir);
    let legacy = read_legacy_dict(&dir);
    match (from_txt, legacy) {
        // Hay campo legacy en saga.json: o es pre-migración, o lo escribió una
        // versión vieja de la app (que no conoce diccionario.txt). En ambos
        // casos lo absorbemos al .txt uniéndolo con lo que ya hubiera, y
        // limpiamos el campo. Así viejo→nuevo nunca pierde palabras.
        (txt, Some(legacy_words)) => {
            let mut merged = txt.unwrap_or_default();
            merged.extend(legacy_words);
            let normalized = normalize_words(merged);
            write_dict_file(&dir, &normalized)?;
            let _ = strip_legacy_dict(&dir);
            Ok(normalized)
        }
        (Some(words), None) => Ok(words),
        (None, None) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn set_saga_dictionary(saga_path: String, words: Vec<String>) -> Result<(), String> {
    let dir = PathBuf::from(&saga_path);
    if !dir.is_dir() {
        return Err(format!("no es directorio: {}", saga_path));
    }
    let normalized = normalize_words(words);
    write_dict_file(&dir, &normalized)?;
    // Asegurar que saga.json no quede duplicando la fuente de verdad.
    let _ = strip_legacy_dict(&dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_saga() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("twriter-dict-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn normalize_dedups_case_insensitive_and_sorts() {
        let out = normalize_words(
            ["Zeta", "  ", "alfa", "ALFA", "Beta", "alfa "]
                .iter()
                .map(|s| s.to_string()),
        );
        assert_eq!(out, vec!["alfa", "Beta", "Zeta"]);
    }

    #[test]
    fn set_then_get_round_trips() {
        let dir = temp_saga();
        set_saga_dictionary(dir.to_string_lossy().into(), vec!["Krilar".into(), "aelindor".into()])
            .unwrap();
        let file = fs::read_to_string(dir.join(DICT_FILE)).unwrap();
        assert_eq!(file, "aelindor\nKrilar\n");
        let got = get_saga_dictionary(dir.to_string_lossy().into()).unwrap();
        assert_eq!(got, vec!["aelindor", "Krilar"]);
    }

    #[test]
    fn empty_set_removes_file() {
        let dir = temp_saga();
        set_saga_dictionary(dir.to_string_lossy().into(), vec!["x".into()]).unwrap();
        assert!(dir.join(DICT_FILE).exists());
        set_saga_dictionary(dir.to_string_lossy().into(), vec![]).unwrap();
        assert!(!dir.join(DICT_FILE).exists());
    }

    #[test]
    fn migrates_from_saga_json_and_strips_field() {
        let dir = temp_saga();
        fs::write(
            dir.join("saga.json"),
            r#"{"nombre":"S","diccionario":["Varya","john"]}"#,
        )
        .unwrap();
        let got = get_saga_dictionary(dir.to_string_lossy().into()).unwrap();
        assert_eq!(got, vec!["john", "Varya"]);
        // .txt creado
        assert!(dir.join(DICT_FILE).exists());
        // campo legacy borrado de saga.json
        let cfg: SagaConfig =
            serde_json::from_str(&fs::read_to_string(dir.join("saga.json")).unwrap()).unwrap();
        assert!(cfg.diccionario.is_none());
        assert_eq!(cfg.nombre, "S");
    }

    #[test]
    fn absorbs_legacy_when_txt_already_exists() {
        // Caso cross-version: la app nueva ya tiene un .txt, pero una app vieja
        // pusheó palabras al campo legacy de saga.json. get debe unir ambos.
        let dir = temp_saga();
        fs::write(dir.join(DICT_FILE), "Aelindor\nKrilar\n").unwrap();
        fs::write(
            dir.join("saga.json"),
            r#"{"nombre":"S","diccionario":["Krilar","Varya"]}"#,
        )
        .unwrap();
        let got = get_saga_dictionary(dir.to_string_lossy().into()).unwrap();
        assert_eq!(got, vec!["Aelindor", "Krilar", "Varya"]);
        // legacy absorbido y limpiado
        let cfg: SagaConfig =
            serde_json::from_str(&fs::read_to_string(dir.join("saga.json")).unwrap()).unwrap();
        assert!(cfg.diccionario.is_none());
    }

    #[test]
    fn set_saga_config_never_persists_dictionary() {
        let dir = temp_saga();
        let cfg = SagaConfig {
            nombre: "S".into(),
            diccionario: Some(vec!["fantasma".into()]),
            ..Default::default()
        };
        set_saga_config(dir.to_string_lossy().into(), cfg).unwrap();
        let raw = fs::read_to_string(dir.join("saga.json")).unwrap();
        assert!(!raw.contains("diccionario"), "saga.json no debe llevar el campo");
    }
}
