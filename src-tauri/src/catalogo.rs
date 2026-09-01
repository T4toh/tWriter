//! Catálogo de libros publicados del autor, para la sección "Otros libros"
//! del back matter del EPUB.
//!
//! La fuente es el filesystem: un libro está publicado si su `book.json`
//! tiene `link` cargado. No hay lista manual que mantener — el título, el
//! subtítulo, la tapa y el número de serie ya están en disco.

use std::fs;
use std::path::{Path, PathBuf};

use crate::book_config::{resolver_imagen, BookConfig};
use crate::saga_config::SagaConfig;

#[derive(Debug, Clone, PartialEq)]
pub struct LibroPublicado {
    pub titulo: String,
    pub subtitulo: Option<String>,
    pub link: String,
    /// Absoluto, ya resuelto contra el book dir. None si el campo estaba
    /// vacío o el archivo no existe en disco.
    pub tapa: Option<PathBuf>,
    pub numero_en_serie: Option<u32>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Catalogo {
    /// Otros libros publicados de la misma saga que el que se exporta.
    pub misma_saga: Vec<LibroPublicado>,
    /// Publicados del resto de las sagas.
    pub otros: Vec<LibroPublicado>,
    /// Nombre de la saga actual, para el encabezado del primer bloque.
    pub saga_actual: Option<String>,
}

pub fn escanear(root: &Path, libro_actual: &Path) -> Catalogo {
    let actual = canonicalizar(libro_actual);
    let saga_actual_dir = libro_actual.parent().map(canonicalizar);

    let mut cat = Catalogo::default();
    for saga_dir in subdirectorios(root) {
        if !saga_dir.join("saga.json").is_file() {
            continue;
        }
        let es_la_actual = saga_actual_dir
            .as_ref()
            .is_some_and(|d| *d == canonicalizar(&saga_dir));
        let mut libros = publicados_de(&saga_dir, &actual);
        if es_la_actual {
            cat.saga_actual = nombre_de_saga(&saga_dir);
            cat.misma_saga.append(&mut libros);
        } else {
            cat.otros.append(&mut libros);
        }
    }
    cat
}

/// Subdirectorios inmediatos, ordenados por nombre. El repo numera las
/// carpetas ("1 - Meridian"), así que el orden alfabético es el del autor.
fn subdirectorios(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect(),
        Err(_) => return Vec::new(),
    };
    out.sort();
    out
}

/// Libros publicados de una saga, ordenados por `numero_en_serie` y, cuando
/// falta, por nombre de carpeta (que ya viene numerado en disco).
fn publicados_de(saga_dir: &Path, actual: &Path) -> Vec<LibroPublicado> {
    let mut con_clave: Vec<(u32, PathBuf, LibroPublicado)> = Vec::new();
    for libro_dir in subdirectorios(saga_dir) {
        if canonicalizar(&libro_dir) == *actual {
            continue;
        }
        let Some(cfg) = leer_book_config(&libro_dir) else {
            continue;
        };
        let Some(link) = cfg.link.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let tapa = resolver_imagen(&libro_dir, cfg.tapa.as_deref());
        let libro = LibroPublicado {
            titulo: cfg.titulo.clone(),
            subtitulo: cfg.subtitulo.clone().filter(|s| !s.trim().is_empty()),
            link: link.to_string(),
            tapa,
            numero_en_serie: cfg.numero_en_serie,
        };
        con_clave.push((cfg.numero_en_serie.unwrap_or(u32::MAX), libro_dir, libro));
    }
    con_clave.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    con_clave.into_iter().map(|(_, _, l)| l).collect()
}

fn leer_book_config(libro_dir: &Path) -> Option<BookConfig> {
    let raw = fs::read_to_string(libro_dir.join("book.json")).ok()?;
    serde_json::from_str::<BookConfig>(&raw).ok()
}

fn nombre_de_saga(saga_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(saga_dir.join("saga.json")).ok()?;
    let cfg: SagaConfig = serde_json::from_str(&raw).ok()?;
    Some(cfg.nombre).filter(|n| !n.trim().is_empty())
}

/// `canonicalize` falla si el path no existe; en ese caso el path tal cual
/// sirve igual para comparar.
fn canonicalizar(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn saga(root: &Path, nombre: &str) -> PathBuf {
        let dir = root.join(nombre);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("saga.json"),
            format!(r#"{{"nombre":"{}"}}"#, nombre.trim_start_matches(|c: char| c.is_ascii_digit() || c == ' ' || c == '-')),
        )
        .unwrap();
        dir
    }

    fn libro(saga_dir: &Path, nombre: &str, json: &str) -> PathBuf {
        let dir = saga_dir.join(nombre);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("book.json"), json).unwrap();
        dir
    }

    #[test]
    fn descarta_los_libros_sin_link() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let s = saga(root, "1 - Meridian");
        let actual = libro(&s, "1 - Uno", r#"{"titulo":"Uno"}"#);
        libro(&s, "2 - Dos", r#"{"titulo":"Dos"}"#);
        libro(&s, "3 - Tres", r#"{"titulo":"Tres","link":"https://x/3"}"#);

        let cat = escanear(root, &actual);
        assert_eq!(cat.misma_saga.len(), 1);
        assert_eq!(cat.misma_saga[0].titulo, "Tres");
        assert!(cat.otros.is_empty());
    }

    #[test]
    fn excluye_el_libro_que_se_esta_exportando() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let s = saga(root, "1 - Meridian");
        let actual = libro(&s, "1 - Uno", r#"{"titulo":"Uno","link":"https://x/1"}"#);
        libro(&s, "2 - Dos", r#"{"titulo":"Dos","link":"https://x/2"}"#);

        let cat = escanear(root, &actual);
        assert_eq!(cat.misma_saga.len(), 1);
        assert_eq!(cat.misma_saga[0].titulo, "Dos");
    }

    #[test]
    fn separa_misma_saga_de_otras_y_nombra_la_actual() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let s1 = saga(root, "1 - Meridian");
        let s2 = saga(root, "2 - Buenos Aires");
        let actual = libro(&s1, "1 - Uno", r#"{"titulo":"Uno","link":"https://x/1"}"#);
        libro(&s1, "2 - Dos", r#"{"titulo":"Dos","link":"https://x/2"}"#);
        libro(&s2, "1 - Luces", r#"{"titulo":"Luces","link":"https://x/l"}"#);

        let cat = escanear(root, &actual);
        assert_eq!(cat.saga_actual.as_deref(), Some("Meridian"));
        assert_eq!(cat.misma_saga.len(), 1);
        assert_eq!(cat.misma_saga[0].titulo, "Dos");
        assert_eq!(cat.otros.len(), 1);
        assert_eq!(cat.otros[0].titulo, "Luces");
    }

    #[test]
    fn ordena_por_numero_en_serie_y_cae_al_nombre_de_carpeta() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let s = saga(root, "1 - Meridian");
        let actual = libro(&s, "9 - Actual", r#"{"titulo":"Actual","link":"https://x/9"}"#);
        libro(&s, "3 - C", r#"{"titulo":"C","link":"https://x/c","numero_en_serie":3}"#);
        libro(&s, "1 - A", r#"{"titulo":"A","link":"https://x/a","numero_en_serie":1}"#);
        // Sin numero_en_serie: va al final, ordenado por carpeta.
        libro(&s, "2 - B", r#"{"titulo":"B","link":"https://x/b"}"#);

        let cat = escanear(root, &actual);
        let titulos: Vec<&str> = cat.misma_saga.iter().map(|l| l.titulo.as_str()).collect();
        assert_eq!(titulos, vec!["A", "C", "B"]);
    }

    #[test]
    fn ignora_carpetas_sin_book_json() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let s = saga(root, "1 - Meridian");
        let actual = libro(&s, "1 - Uno", r#"{"titulo":"Uno","link":"https://x/1"}"#);
        libro(&s, "2 - Dos", r#"{"titulo":"Dos","link":"https://x/2"}"#);
        fs::create_dir_all(s.join("extras")).unwrap();
        fs::create_dir_all(s.join("notas")).unwrap();
        // Carpetas del root que no son sagas.
        fs::create_dir_all(root.join("fonts")).unwrap();
        fs::create_dir_all(root.join("themes")).unwrap();
        fs::write(root.join("README.md"), "x").unwrap();

        let cat = escanear(root, &actual);
        assert_eq!(cat.misma_saga.len(), 1);
        assert_eq!(cat.misma_saga[0].titulo, "Dos");
        assert!(cat.otros.is_empty());
    }

    #[test]
    fn resuelve_la_tapa_a_path_absoluto_y_la_omite_si_no_existe() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let s = saga(root, "1 - Meridian");
        let actual = libro(&s, "1 - Uno", r#"{"titulo":"Uno","link":"https://x/1"}"#);
        let con = libro(&s, "2 - Con", r#"{"titulo":"Con","link":"https://x/2","tapa":"cover.png"}"#);
        fs::write(con.join("cover.png"), b"fake").unwrap();
        libro(&s, "3 - Sin", r#"{"titulo":"Sin","link":"https://x/3","tapa":"cover.png"}"#);

        let cat = escanear(root, &actual);
        let con_tapa = cat.misma_saga.iter().find(|l| l.titulo == "Con").unwrap();
        assert_eq!(con_tapa.tapa.as_deref(), Some(con.join("cover.png").as_path()));
        let sin_tapa = cat.misma_saga.iter().find(|l| l.titulo == "Sin").unwrap();
        assert_eq!(sin_tapa.tapa, None);
    }
}
