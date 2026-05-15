use std::sync::Mutex;

use fontdb::{Database, Source, Style, Weight};
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    pub family: String,
    pub path: String,
    pub has_bold: bool,
    pub has_italic: bool,
}

static CACHE: Mutex<Option<Vec<SystemFont>>> = Mutex::new(None);

#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<SystemFont>, String> {
    {
        let guard = CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = guard.as_ref() {
            return Ok(cached.clone());
        }
    }
    let fonts = scan_system_fonts();
    let mut guard = CACHE.lock().map_err(|e| e.to_string())?;
    *guard = Some(fonts.clone());
    Ok(fonts)
}

#[tauri::command]
pub fn refresh_system_fonts() -> Result<Vec<SystemFont>, String> {
    let fonts = scan_system_fonts();
    let mut guard = CACHE.lock().map_err(|e| e.to_string())?;
    *guard = Some(fonts.clone());
    Ok(fonts)
}

fn scan_system_fonts() -> Vec<SystemFont> {
    let mut db = Database::new();
    db.load_system_fonts();
    families_from_db(&db)
}

/// Agrupa los faces del fontdb por familia, eligiendo el path del face Regular
/// (Normal + Weight::NORMAL) cuando existe; sino el primero. Detecta si hay
/// face Bold (weight >= 600) y/o Italic. Devuelve la lista ordenada alfabéticamente.
fn families_from_db(db: &Database) -> Vec<SystemFont> {
    use std::collections::BTreeMap;

    struct Acc {
        regular_path: Option<String>,
        any_path: Option<String>,
        has_bold: bool,
        has_italic: bool,
    }

    let mut by_family: BTreeMap<String, Acc> = BTreeMap::new();
    for face in db.faces() {
        let family = match face.families.first() {
            Some((name, _)) => name.clone(),
            None => continue,
        };
        if family.trim().is_empty() {
            continue;
        }
        let path = match &face.source {
            Source::File(p) => p.to_string_lossy().into_owned(),
            _ => continue,
        };
        let is_italic = matches!(face.style, Style::Italic | Style::Oblique);
        let is_bold = face.weight.0 >= Weight::SEMIBOLD.0;
        let is_regular = !is_italic && face.weight == Weight::NORMAL;

        let acc = by_family.entry(family).or_insert(Acc {
            regular_path: None,
            any_path: None,
            has_bold: false,
            has_italic: false,
        });
        if is_regular && acc.regular_path.is_none() {
            acc.regular_path = Some(path.clone());
        }
        if acc.any_path.is_none() {
            acc.any_path = Some(path);
        }
        if is_bold {
            acc.has_bold = true;
        }
        if is_italic {
            acc.has_italic = true;
        }
    }

    by_family
        .into_iter()
        .filter_map(|(family, acc)| {
            let path = acc.regular_path.or(acc.any_path)?;
            Some(SystemFont {
                family,
                path,
                has_bold: acc.has_bold,
                has_italic: acc.has_italic,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_path(name: &str) -> PathBuf {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("..");
        p.push("src");
        p.push("assets");
        p.push("fonts");
        p.push(name);
        p
    }

    #[test]
    fn empty_db_returns_empty() {
        let db = Database::new();
        assert!(families_from_db(&db).is_empty());
    }

    /// Carga las 4 caras de Merriweather embebidas en el repo y verifica
    /// que se agrupen en una sola entry con has_bold + has_italic.
    #[test]
    fn dedupes_by_family() {
        let mut db = Database::new();
        for name in [
            "Merriweather-Regular.ttf",
            "Merriweather-Italic.ttf",
            "Merriweather-Bold.ttf",
            "Merriweather-BoldItalic.ttf",
        ] {
            let p = fixture_path(name);
            if !p.exists() {
                eprintln!("skip: fixture {} missing", p.display());
                return;
            }
            db.load_font_file(&p).expect("load font");
        }
        let out = families_from_db(&db);
        let merri: Vec<_> = out.iter().filter(|f| f.family == "Merriweather").collect();
        assert_eq!(merri.len(), 1, "una sola entry para la familia");
        let m = merri[0];
        assert!(m.has_bold, "detecta bold");
        assert!(m.has_italic, "detecta italic");
        assert!(m.path.ends_with("Merriweather-Regular.ttf"), "elige Regular como path: {}", m.path);
    }

    #[test]
    fn sorted_alphabetically() {
        let mut db = Database::new();
        for name in ["Roboto-Bold.ttf", "Merriweather-Regular.ttf", "Lato-Regular.ttf"] {
            let p = fixture_path(name);
            if !p.exists() {
                eprintln!("skip: fixture {} missing", p.display());
                return;
            }
            db.load_font_file(&p).expect("load font");
        }
        let out = families_from_db(&db);
        let names: Vec<&str> = out.iter().map(|f| f.family.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "salida ordenada alfa");
    }
}
