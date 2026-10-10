use std::path::{Path, PathBuf};

/// Saca el prefijo numérico de orden (`"1 - Meridian"` → `"Meridian"`) que
/// usan las carpetas de saga/libro/capítulo para ordenarse en el filesystem.
/// Solo reconoce `-` como separador porque es lo único que la app escribe
/// (`create.rs::format!("{} - {}", ...)` y el rename de book/saga-config-modal
/// que preserva el prefijo). Un nombre que arranca con dígitos pero no tiene
/// ese separador (`"2001 - Odisea"` sin más, o `"2001: Odisea"`) no matchea y
/// se devuelve tal cual.
pub fn strip_numeric_prefix(s: &str) -> String {
    let digits_end = s
        .char_indices()
        .find(|(_, c)| !c.is_ascii_digit())
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    if digits_end == 0 {
        return s.to_string();
    }
    let after_digits = s[digits_end..].trim_start();
    match after_digits.strip_prefix('-') {
        Some(after_dash) => after_dash.trim_start().to_string(),
        None => s.to_string(),
    }
}

/// Renumera el `.meta.json` de una parte que cambió de número (`2.html` →
/// `3.html`): escribe `orden` y, si `titulo` era solo el número viejo (el
/// título automático que pone `create.rs` y el import), lo sigue. Un título
/// real queda como está. Todo shift de partes pasa por acá: con `orden` solo
/// quedaban `3.html` con `titulo: "2"`, y el índice del EPUB los listaba así.
pub fn renumber_part_meta(meta_path: &Path, new_num: u32) -> Result<(), String> {
    let raw = std::fs::read_to_string(meta_path)
        .map_err(|e| format!("leer {}: {}", meta_path.display(), e))?;
    let mut v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {}", meta_path.display(), e))?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("orden".to_string(), serde_json::Value::Number(new_num.into()));
        let automatico = obj
            .get("titulo")
            .and_then(|t| t.as_str())
            .map(|t| !t.trim().is_empty() && t.trim().chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        if automatico {
            obj.insert("titulo".to_string(), serde_json::Value::String(new_num.to_string()));
        }
    }
    let out = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(meta_path, out).map_err(|e| format!("escribir {}: {}", meta_path.display(), e))
}

#[cfg(test)]
mod renumber_part_meta_tests {
    use super::renumber_part_meta;

    fn meta(dir: &std::path::Path, titulo: &str) -> std::path::PathBuf {
        let p = dir.join("3.meta.json");
        std::fs::write(&p, format!(r#"{{"orden":2,"titulo":"{titulo}","status":"draft"}}"#)).unwrap();
        p
    }

    #[test]
    fn un_titulo_que_es_solo_numero_sigue_al_nuevo_numero() {
        let tmp = tempfile::tempdir().unwrap();
        let p = meta(tmp.path(), "2");
        renumber_part_meta(&p, 3).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["orden"], 3);
        assert_eq!(v["titulo"], "3");
    }

    #[test]
    fn un_titulo_real_no_se_toca() {
        let tmp = tempfile::tempdir().unwrap();
        let p = meta(tmp.path(), "La huida");
        renumber_part_meta(&p, 3).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["orden"], 3);
        assert_eq!(v["titulo"], "La huida");
    }
}

#[cfg(test)]
mod strip_numeric_prefix_tests {
    use super::strip_numeric_prefix;

    #[test]
    fn caso_normal() {
        assert_eq!(strip_numeric_prefix("1 - Meridian"), "Meridian");
    }

    #[test]
    fn sin_prefijo() {
        assert_eq!(strip_numeric_prefix("Meridian"), "Meridian");
    }

    #[test]
    fn varios_digitos() {
        assert_eq!(strip_numeric_prefix("123 - Nombre"), "Nombre");
    }

    #[test]
    fn espaciado_irregular() {
        assert_eq!(strip_numeric_prefix("1   -   Nombre"), "Nombre");
        assert_eq!(strip_numeric_prefix("1-Nombre"), "Nombre");
    }

    /// El nombre legítimamente arranca con dígitos pero no tiene el
    /// separador `-`: no hay prefijo de orden que sacar.
    #[test]
    fn digitos_sin_separador_no_se_toca() {
        assert_eq!(strip_numeric_prefix("2001: Odisea"), "2001: Odisea");
    }

    #[test]
    fn digitos_con_separador_si_se_saca() {
        assert_eq!(strip_numeric_prefix("2001 - Odisea"), "Odisea");
    }

    /// Formato estricto: el punto medio NO es un separador reconocido (ver
    /// doc comment). Un nombre así se deja intacto.
    #[test]
    fn punto_medio_no_es_separador() {
        assert_eq!(strip_numeric_prefix("1 · Nombre"), "1 · Nombre");
    }
}

/// Sanea un nombre de archivo: trim, reemplaza separadores y NUL por `_`.
/// Vacío o `.`/`..` cae al fallback dado.
pub fn sanitize_name(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    let cleaned: String = trimmed
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '\0' {
                '_'
            } else {
                c
            }
        })
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// Devuelve un path único en `dir`. Si `name` ya existe, prueba `<stem>-1.<ext>`,
/// `<stem>-2.<ext>`, hasta 999. Fallback: `<name>-many`.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 1..1_000 {
        let new_name = match ext {
            Some(e) => format!("{}-{}.{}", stem, n, e),
            None => format!("{}-{}", stem, n),
        };
        let p = dir.join(new_name);
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{}-many", name))
}
