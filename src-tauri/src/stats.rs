//! Per-chapter volatile stats: `palabras` + `ultima_edicion`.
//!
//! Antes vivían en `<n>.meta.json` y mutaban en cada autosave → cada commit
//! incluía 2 archivos (html + meta.json) aunque el contenido editorial real
//! solo fuera el html. Se sacaron a `.twriter/stats.json` (gitignored) para
//! que `meta.json` solo cambie cuando renombrás/reordenás/cambiás status.
//!
//! El archivo es `{ "<rel/path>.html": { palabras, ultima_edicion } }`.
//! Keys son paths relativos al root, separador `/` siempre (cross-platform).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::import::count_words;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ChapterStat {
    #[serde(default)]
    pub palabras: u32,
    #[serde(default)]
    pub ultima_edicion: Option<String>,
}

pub type StatsMap = HashMap<String, ChapterStat>;

fn stats_path(root: &Path) -> PathBuf {
    root.join(".twriter").join("stats.json")
}

/// Convierte un path absoluto (capítulo) a la key relativa con separador `/`.
pub fn relative_key(root: &Path, chapter_path: &Path) -> Option<String> {
    let rel = chapter_path.strip_prefix(root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    Some(s)
}

/// Lee `.twriter/stats.json`. Si no existe devuelve mapa vacío (no es error).
pub fn read_stats(root: &Path) -> StatsMap {
    let p = stats_path(root);
    let Ok(raw) = fs::read_to_string(&p) else {
        return StatsMap::new();
    };
    serde_json::from_str::<StatsMap>(&raw).unwrap_or_default()
}

/// Sobrescribe `.twriter/stats.json` de forma atómica (tmp + rename).
pub fn write_stats(root: &Path, stats: &StatsMap) -> Result<(), String> {
    let p = stats_path(root);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir .twriter: {}", e))?;
    }
    let raw = serde_json::to_string_pretty(stats).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Actualiza un stat puntual.
pub fn upsert_stat(
    root: &Path,
    chapter_path: &Path,
    palabras: u32,
    ultima_edicion: Option<String>,
) -> Result<(), String> {
    let key = relative_key(root, chapter_path)
        .ok_or_else(|| format!("chapter fuera del root: {}", chapter_path.display()))?;
    let mut stats = read_stats(root);
    stats.insert(
        key,
        ChapterStat {
            palabras,
            ultima_edicion,
        },
    );
    write_stats(root, &stats)
}

/// Comando del frontend para persistir stats en cada save de capítulo.
#[tauri::command]
pub fn write_chapter_stats(
    root: String,
    chapter_path: String,
    palabras: u32,
    ultima_edicion: Option<String>,
) -> Result<(), String> {
    let root_p = PathBuf::from(&root);
    let chap_p = PathBuf::from(&chapter_path);
    upsert_stat(&root_p, &chap_p, palabras, ultima_edicion)
}

/// Migración one-shot: scanea todos los `*.meta.json` del repo. Si traen
/// `palabras` o `ultima_edicion`, los mueve a `.twriter/stats.json` y los
/// strippea del meta.json. Genera UN commit ruidoso al primer arranque
/// post-deploy y deja el repo limpio.
///
/// Devuelve la cantidad de meta.json migrados.
pub fn migrate_meta_to_stats(root: &Path) -> Result<u32, String> {
    if !root.is_dir() {
        return Ok(0);
    }
    let mut stats = read_stats(root);
    let mut migrated: u32 = 0;
    walk_metas(root, &mut |meta_path| {
        if let Some((palabras_opt, ultima_opt, stripped)) = strip_volatile(meta_path) {
            // Si había datos volátiles, los guardamos en stats. Si el meta es
            // huérfano (sin html sibling) saltamos.
            let html_path = sibling_html(meta_path);
            if let Some(html) = html_path {
                if html.is_file() {
                    if let Some(key) = relative_key(root, &html) {
                        let entry = stats.entry(key).or_default();
                        if let Some(p) = palabras_opt {
                            entry.palabras = p;
                        }
                        if let Some(u) = ultima_opt {
                            entry.ultima_edicion = Some(u);
                        }
                    }
                }
            }
            if stripped {
                migrated += 1;
            }
        }
    });
    write_stats(root, &stats)?;
    Ok(migrated)
}

fn sibling_html(meta_path: &Path) -> Option<PathBuf> {
    let name = meta_path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".meta.json")?;
    let parent = meta_path.parent()?;
    Some(parent.join(format!("{}.html", stem)))
}

/// Lee meta.json, si trae palabras o ultima_edicion los extrae y reescribe
/// el archivo sin ellos. Retorna (palabras, ultima_edicion, hubo_cambios).
fn strip_volatile(meta_path: &Path) -> Option<(Option<u32>, Option<String>, bool)> {
    let raw = fs::read_to_string(meta_path).ok()?;
    let mut v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let obj = v.as_object_mut()?;
    let palabras = obj
        .remove("palabras")
        .and_then(|n| n.as_u64().map(|x| x as u32));
    let ultima = obj.remove("ultima_edicion").and_then(|n| match n {
        serde_json::Value::String(s) => Some(s),
        _ => None,
    });
    let changed = palabras.is_some() || ultima.is_some();
    if changed {
        if let Ok(out) = serde_json::to_string_pretty(&v) {
            let _ = fs::write(meta_path, out);
        }
    }
    Some((palabras, ultima, changed))
}

/// Walk recursivo del root buscando archivos `*.meta.json`. Salta `.twriter/`,
/// `.git/`, `node_modules`, etc.
fn walk_metas(dir: &Path, cb: &mut dyn FnMut(&Path)) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            walk_metas(&p, cb);
        } else if p.is_file() && name.ends_with(".meta.json") {
            cb(&p);
        }
    }
}

/// Devuelve las palabras de un capítulo: stats si están, sino computa
/// del HTML lazy. Útil para `get_tree`.
pub fn palabras_for_chapter(stats: &StatsMap, root: &Path, chapter_path: &Path) -> Option<u32> {
    let key = relative_key(root, chapter_path)?;
    if let Some(s) = stats.get(&key) {
        if s.palabras > 0 {
            return Some(s.palabras);
        }
    }
    // Fallback: leer HTML y computar.
    let raw = fs::read_to_string(chapter_path).ok()?;
    Some(count_words(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn migrate_moves_palabras_out_of_meta() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let book = root.join("Saga/Libro");
        fs::create_dir_all(&book).unwrap();
        fs::write(book.join("1.html"), "<p>Hola mundo</p>\n").unwrap();
        let meta_path = book.join("1.meta.json");
        fs::write(
            &meta_path,
            r#"{"orden":1,"titulo":"Cap","palabras":2,"ultima_edicion":"2024-01-01","status":"draft","idioma":"es"}"#,
        )
        .unwrap();

        let n = migrate_meta_to_stats(root).unwrap();
        assert_eq!(n, 1);

        // El meta.json ya no tiene los campos volátiles.
        let raw = fs::read_to_string(&meta_path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(v.get("palabras").is_none(), "palabras debe haberse stripped");
        assert!(
            v.get("ultima_edicion").is_none(),
            "ultima_edicion debe haberse stripped"
        );
        assert_eq!(v.get("titulo").and_then(|x| x.as_str()), Some("Cap"));

        // stats.json contiene los valores.
        let stats = read_stats(root);
        let entry = stats.get("Saga/Libro/1.html").expect("entry missing");
        assert_eq!(entry.palabras, 2);
        assert_eq!(entry.ultima_edicion.as_deref(), Some("2024-01-01"));
    }

    #[test]
    fn upsert_stat_persists_and_overwrites() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let book = root.join("Saga/Libro");
        fs::create_dir_all(&book).unwrap();
        let chap = book.join("1.html");
        fs::write(&chap, "<p>texto</p>").unwrap();

        upsert_stat(root, &chap, 10, Some("t1".into())).unwrap();
        upsert_stat(root, &chap, 20, Some("t2".into())).unwrap();

        let stats = read_stats(root);
        let e = stats.get("Saga/Libro/1.html").unwrap();
        assert_eq!(e.palabras, 20);
        assert_eq!(e.ultima_edicion.as_deref(), Some("t2"));
    }

    #[test]
    fn palabras_for_chapter_falls_back_to_html() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let chap = root.join("1.html");
        fs::write(&chap, "<p>uno dos tres</p>").unwrap();
        let stats = StatsMap::new();
        let n = palabras_for_chapter(&stats, root, &chap).unwrap();
        assert_eq!(n, 3);
    }
}
