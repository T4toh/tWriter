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
