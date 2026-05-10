use std::path::{Path, PathBuf};

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
