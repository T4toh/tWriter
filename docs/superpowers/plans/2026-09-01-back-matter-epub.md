# Back matter del EPUB — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el final del EPUB venda: una sección "Otros libros" que se arma sola escaneando el repo, un perfil de autor único con QR, una página legal con incisos elegibles y editables, y un índice que incluya todo eso sin estorbar a los capítulos.

**Architecture:** Dos módulos Rust nuevos y chicos — `catalogo.rs` (escaneo puro del filesystem) y `autor.rs` (config global, patrón `saga_config.rs`) — más un helper de reescalado en `image.rs`. `epub.rs` solo consume: arma las páginas nuevas y las suma al spine, al OPF y al índice. En el frontend, dos agregados al modal de libro y un modal nuevo para el autor.

**Tech Stack:** Rust (Tauri 2, `zip`, `serde`, crate nuevo `image`), Angular 21 standalone + signals.

**Spec:** `docs/superpowers/specs/2026-09-01-back-matter-epub-design.md`

## Global Constraints

- **Idioma de los identificadores**: español para sustantivos de dominio que son campos de JSON o carpetas en disco (`autor`, `libro`, `saga`, `tapa`, `link`, `catalogo`), inglés para verbos y mecánica de framework. Los nombres mixtos (`build_otros_libros_xhtml`, `escanear`) son correctos — así ya está el resto del repo. Ver `CLAUDE.md`.
- **Sin sufijo `Component`** en clases Angular, archivos sin `.component.ts`, standalone, signals, `@if`/`@for`, `inject()`, return types explícitos, sin `public`.
- **Toda la copy visible al usuario va en español.** El EPUB además emite en inglés cuando el libro es `idioma: "en"`.
- **Dependencia nueva**: solo `image`, con `default-features = false` y features `png` + `jpeg`. Verificar que la versión elegida tenga **más de 7 días** publicada antes de sumarla (norma de supply chain de la organización).
- **Compatibilidad hacia atrás obligatoria**: los 21 `book.json` que hoy existen en `~/novelas` tienen que exportar la misma página legal que antes de este cambio. Hay un test que lo fija (Task 4).
- **Tests Rust**: `cargo test --manifest-path src-tauri/Cargo.toml`. No hay runner de tests para el frontend — lo que toca DOM se valida con `pnpm build` más verificación manual del autor.
- **El remedio se da adentro de la app**: si falta una imagen, el mensaje dice qué path faltó, no un error genérico.
- **Sin firmar commits como co-autor.**

---

### Task 1: `catalogo.rs` — escaneo de libros publicados

**Files:**
- Create: `src-tauri/src/catalogo.rs`
- Modify: `src-tauri/src/lib.rs:1-31` (agregar `mod catalogo;` en orden alfabético, entre `mod book_config;` y `mod create;`)

**Interfaces:**
- Consumes: `crate::book_config::BookConfig`, `crate::saga_config::SagaConfig` (ambos ya existen y deserializan con `#[serde(default)]` en todos los campos, así que un `book.json` parcial no rompe).
- Produces: `catalogo::escanear(root: &Path, libro_actual: &Path) -> Catalogo`, con `Catalogo { misma_saga: Vec<LibroPublicado>, otros: Vec<LibroPublicado>, saga_actual: Option<String> }` y `LibroPublicado { titulo: String, subtitulo: Option<String>, link: String, tapa: Option<PathBuf>, numero_en_serie: Option<u32> }`. `tapa` ya viene resuelta a path absoluto contra el book dir. Task 5 la consume.

- [ ] **Step 1: Escribir el módulo con los tipos y la firma, sin lógica**

Crear `src-tauri/src/catalogo.rs`:

```rust
//! Catálogo de libros publicados del autor, para la sección "Otros libros"
//! del back matter del EPUB.
//!
//! La fuente es el filesystem: un libro está publicado si su `book.json`
//! tiene `link` cargado. No hay lista manual que mantener — el título, el
//! subtítulo, la tapa y el número de serie ya están en disco.

use std::fs;
use std::path::{Path, PathBuf};

use crate::book_config::BookConfig;
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

pub fn escanear(_root: &Path, _libro_actual: &Path) -> Catalogo {
    Catalogo::default()
}
```

Y en `src-tauri/src/lib.rs`, sumar la línea `mod catalogo;` después de `mod book_config;`.

- [ ] **Step 2: Escribir los tests que fallan**

Al final de `src-tauri/src/catalogo.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Mismo patrón que el helper de `epub.rs`: tempdir a mano, sin depender
    /// de que el test corra con `tempfile`.
    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        let suffix: u128 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("twriter-catalogo-test-{}", suffix));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

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
        let root = tempdir();
        let s = saga(&root, "1 - Meridian");
        let actual = libro(&s, "1 - Uno", r#"{"titulo":"Uno"}"#);
        libro(&s, "2 - Dos", r#"{"titulo":"Dos"}"#);
        libro(&s, "3 - Tres", r#"{"titulo":"Tres","link":"https://x/3"}"#);

        let cat = escanear(&root, &actual);
        assert_eq!(cat.misma_saga.len(), 1);
        assert_eq!(cat.misma_saga[0].titulo, "Tres");
        assert!(cat.otros.is_empty());
    }

    #[test]
    fn excluye_el_libro_que_se_esta_exportando() {
        let root = tempdir();
        let s = saga(&root, "1 - Meridian");
        let actual = libro(&s, "1 - Uno", r#"{"titulo":"Uno","link":"https://x/1"}"#);
        libro(&s, "2 - Dos", r#"{"titulo":"Dos","link":"https://x/2"}"#);

        let cat = escanear(&root, &actual);
        assert_eq!(cat.misma_saga.len(), 1);
        assert_eq!(cat.misma_saga[0].titulo, "Dos");
    }

    #[test]
    fn separa_misma_saga_de_otras_y_nombra_la_actual() {
        let root = tempdir();
        let s1 = saga(&root, "1 - Meridian");
        let s2 = saga(&root, "2 - Buenos Aires");
        let actual = libro(&s1, "1 - Uno", r#"{"titulo":"Uno","link":"https://x/1"}"#);
        libro(&s1, "2 - Dos", r#"{"titulo":"Dos","link":"https://x/2"}"#);
        libro(&s2, "1 - Luces", r#"{"titulo":"Luces","link":"https://x/l"}"#);

        let cat = escanear(&root, &actual);
        assert_eq!(cat.saga_actual.as_deref(), Some("Meridian"));
        assert_eq!(cat.misma_saga.len(), 1);
        assert_eq!(cat.misma_saga[0].titulo, "Dos");
        assert_eq!(cat.otros.len(), 1);
        assert_eq!(cat.otros[0].titulo, "Luces");
    }

    #[test]
    fn ordena_por_numero_en_serie_y_cae_al_nombre_de_carpeta() {
        let root = tempdir();
        let s = saga(&root, "1 - Meridian");
        let actual = libro(&s, "9 - Actual", r#"{"titulo":"Actual","link":"https://x/9"}"#);
        libro(&s, "3 - C", r#"{"titulo":"C","link":"https://x/c","numero_en_serie":3}"#);
        libro(&s, "1 - A", r#"{"titulo":"A","link":"https://x/a","numero_en_serie":1}"#);
        // Sin numero_en_serie: va al final, ordenado por carpeta.
        libro(&s, "2 - B", r#"{"titulo":"B","link":"https://x/b"}"#);

        let cat = escanear(&root, &actual);
        let titulos: Vec<&str> = cat.misma_saga.iter().map(|l| l.titulo.as_str()).collect();
        assert_eq!(titulos, vec!["A", "C", "B"]);
    }

    #[test]
    fn ignora_carpetas_sin_book_json() {
        let root = tempdir();
        let s = saga(&root, "1 - Meridian");
        let actual = libro(&s, "1 - Uno", r#"{"titulo":"Uno","link":"https://x/1"}"#);
        fs::create_dir_all(s.join("extras")).unwrap();
        fs::create_dir_all(s.join("notas")).unwrap();
        // Carpetas del root que no son sagas.
        fs::create_dir_all(root.join("fonts")).unwrap();
        fs::create_dir_all(root.join("themes")).unwrap();
        fs::write(root.join("README.md"), "x").unwrap();

        let cat = escanear(&root, &actual);
        assert!(cat.misma_saga.is_empty());
        assert!(cat.otros.is_empty());
    }

    #[test]
    fn resuelve_la_tapa_a_path_absoluto_y_la_omite_si_no_existe() {
        let root = tempdir();
        let s = saga(&root, "1 - Meridian");
        let actual = libro(&s, "1 - Uno", r#"{"titulo":"Uno","link":"https://x/1"}"#);
        let con = libro(&s, "2 - Con", r#"{"titulo":"Con","link":"https://x/2","tapa":"cover.png"}"#);
        fs::write(con.join("cover.png"), b"fake").unwrap();
        libro(&s, "3 - Sin", r#"{"titulo":"Sin","link":"https://x/3","tapa":"cover.png"}"#);

        let cat = escanear(&root, &actual);
        let con_tapa = cat.misma_saga.iter().find(|l| l.titulo == "Con").unwrap();
        assert_eq!(con_tapa.tapa.as_deref(), Some(con.join("cover.png").as_path()));
        let sin_tapa = cat.misma_saga.iter().find(|l| l.titulo == "Sin").unwrap();
        assert_eq!(sin_tapa.tapa, None);
    }
}
```

- [ ] **Step 3: Correr los tests y ver que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml catalogo -- --nocapture`
Expected: FAIL — los seis tests fallan porque `escanear` devuelve `Catalogo::default()`.

- [ ] **Step 4: Implementar `escanear`**

Reemplazar el stub en `src-tauri/src/catalogo.rs`:

```rust
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
        let tapa = cfg
            .tapa
            .as_deref()
            .map(|rel| resolver(&libro_dir, rel))
            .filter(|p| p.is_file());
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

fn resolver(base: &Path, rel: &str) -> PathBuf {
    let p = Path::new(rel);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}

/// `canonicalize` falla si el path no existe; en ese caso el path tal cual
/// sirve igual para comparar.
fn canonicalizar(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}
```

Este código usa `cfg.link`, que todavía no existe en `BookConfig` — lo agrega el paso siguiente.

- [ ] **Step 5: Agregar el campo `link` a `BookConfig`**

En `src-tauri/src/book_config.rs`, después del campo `numero_en_serie` (`src-tauri/src/book_config.rs:135`):

```rust
    /// URL pública del libro (la página del autor, o la ficha de la tienda).
    /// Tenerla cargada es lo que mete al libro en la sección "Otros libros"
    /// de los EPUB de los demás libros. Ver `catalogo.rs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
```

- [ ] **Step 6: Correr los tests y ver que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml catalogo`
Expected: PASS, los seis.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/catalogo.rs src-tauri/src/book_config.rs src-tauri/src/lib.rs
git commit -m "feat(catalogo): escanear los libros publicados del repo"
```

---

### Task 2: `autor.rs` — perfil global del autor

**Files:**
- Create: `src-tauri/src/autor.rs`
- Modify: `src-tauri/src/lib.rs` (`mod autor;` como primera línea de mods, y los dos comandos al `invoke_handler`)

**Interfaces:**
- Consumes: nada de tasks anteriores.
- Produces: `autor::AutorConfig { nombre: Option<String>, bio: BTreeMap<String, String>, foto: Option<String>, web: Option<String>, qr: Option<String> }`, `autor::leer(root: &Path) -> AutorConfig` (para el builder de EPUB, Task 6), y los comandos Tauri `get_autor_config(root: String)` / `set_autor_config(root: String, config: AutorConfig)` (para el modal, Task 10). `AutorConfig::bio_en(&self, idioma: &str) -> Option<&str>` devuelve la bio del idioma pedido y cae a la otra si falta.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `src-tauri/src/autor.rs` con el módulo de tests primero, y arriba solo lo mínimo para que compile:

```rust
//! Perfil del autor, global al repo. Un repo de novelas = un escritor, así
//! que la bio, la foto, la web y el QR viven una sola vez en `autor.json`
//! en la raíz, en vez de repetidos en cada `book.json`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct AutorConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nombre: Option<String>,
    /// Bio por idioma: `{"es": "...", "en": "..."}`. BTreeMap y no HashMap
    /// para que el JSON salga siempre en el mismo orden y no genere diffs
    /// espurios en el repo de novelas, que va por git.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub bio: BTreeMap<String, String>,
    /// Path relativo a la raíz (ej: "autor.jpg") o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foto: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web: Option<String>,
    /// Imagen del QR que apunta a `web`. Path relativo a la raíz o absoluto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qr: Option<String>,
}

impl AutorConfig {
    pub fn bio_en(&self, _idioma: &str) -> Option<&str> {
        None
    }
}

pub fn leer(_root: &Path) -> AutorConfig {
    AutorConfig::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        let suffix: u128 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("twriter-autor-test-{}", suffix));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn sin_archivo_devuelve_config_vacia() {
        let root = tempdir();
        assert_eq!(leer(&root), AutorConfig::default());
    }

    #[test]
    fn lee_el_archivo_cuando_existe() {
        let root = tempdir();
        fs::write(
            root.join("autor.json"),
            r#"{"nombre":"Tatoh","bio":{"es":"hola"},"web":"https://tatoh.ar"}"#,
        )
        .unwrap();
        let cfg = leer(&root);
        assert_eq!(cfg.nombre.as_deref(), Some("Tatoh"));
        assert_eq!(cfg.web.as_deref(), Some("https://tatoh.ar"));
        assert_eq!(cfg.bio.get("es").map(String::as_str), Some("hola"));
    }

    #[test]
    fn bio_cae_al_otro_idioma_cuando_falta_el_pedido() {
        let mut cfg = AutorConfig::default();
        cfg.bio.insert("es".into(), "bio en español".into());
        assert_eq!(cfg.bio_en("es"), Some("bio en español"));
        assert_eq!(cfg.bio_en("en"), Some("bio en español"));
    }

    #[test]
    fn bio_prefiere_el_idioma_pedido_cuando_estan_los_dos() {
        let mut cfg = AutorConfig::default();
        cfg.bio.insert("es".into(), "español".into());
        cfg.bio.insert("en".into(), "english".into());
        assert_eq!(cfg.bio_en("en"), Some("english"));
        assert_eq!(cfg.bio_en("es"), Some("español"));
    }

    #[test]
    fn bio_vacia_no_cuenta_como_bio() {
        let mut cfg = AutorConfig::default();
        cfg.bio.insert("es".into(), "   ".into());
        assert_eq!(cfg.bio_en("es"), None);
    }

    #[test]
    fn autodetecta_foto_y_qr_en_disco() {
        let root = tempdir();
        fs::write(root.join("autor.json"), r#"{"nombre":"Tatoh"}"#).unwrap();
        fs::write(root.join("autor.jpg"), b"fake").unwrap();
        fs::write(root.join("qr.png"), b"fake").unwrap();
        let cfg = leer(&root);
        assert_eq!(cfg.foto.as_deref(), Some("autor.jpg"));
        assert_eq!(cfg.qr.as_deref(), Some("qr.png"));
    }

    #[test]
    fn no_autodetecta_si_el_campo_ya_apunta_a_un_archivo_que_existe() {
        let root = tempdir();
        fs::write(root.join("autor.json"), r#"{"qr":"mi-qr.png"}"#).unwrap();
        fs::write(root.join("mi-qr.png"), b"fake").unwrap();
        fs::write(root.join("qr.png"), b"fake").unwrap();
        assert_eq!(leer(&root).qr.as_deref(), Some("mi-qr.png"));
    }

    #[test]
    fn round_trip_de_escritura() {
        let root = tempdir();
        let mut cfg = AutorConfig::default();
        cfg.nombre = Some("Tatoh".into());
        cfg.bio.insert("es".into(), "hola".into());
        escribir(&root, &cfg).unwrap();
        assert_eq!(leer(&root), cfg);
    }
}
```

- [ ] **Step 2: Correr los tests y ver que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml autor`
Expected: FAIL — no compila, `escribir` no existe, y los tests de lectura fallan contra los stubs.

- [ ] **Step 3: Implementar el módulo**

Reemplazar el `impl AutorConfig` y `leer` de arriba por:

```rust
/// Bases de nombre que se buscan en disco cuando el campo está vacío o
/// apunta a un archivo que ya no está. Mismo criterio que usa
/// `book_config::find_author_photo_in` para la foto per-libro.
const FOTO_STEMS: &[&str] = &["autor", "author"];
const QR_STEMS: &[&str] = &["qr"];
const EXTS: &[&str] = &["png", "jpg", "jpeg", "webp"];

impl AutorConfig {
    /// Bio del idioma pedido; si no está, la de cualquier otro idioma
    /// cargado. Las bios en blanco no cuentan.
    pub fn bio_en(&self, idioma: &str) -> Option<&str> {
        let util = |s: &&String| !s.trim().is_empty();
        self.bio
            .get(idioma)
            .filter(util)
            .or_else(|| self.bio.values().find(util))
            .map(|s| s.trim())
    }
}

pub fn leer(root: &Path) -> AutorConfig {
    let mut cfg = fs::read_to_string(root.join("autor.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<AutorConfig>(&raw).ok())
        .unwrap_or_default();
    if !apunta_a_un_archivo(root, cfg.foto.as_deref()) {
        cfg.foto = buscar(root, FOTO_STEMS);
    }
    if !apunta_a_un_archivo(root, cfg.qr.as_deref()) {
        cfg.qr = buscar(root, QR_STEMS);
    }
    cfg
}

pub fn escribir(root: &Path, cfg: &AutorConfig) -> Result<(), String> {
    let mut json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(root.join("autor.json"), json).map_err(|e| e.to_string())
}

/// Path absoluto de un campo de imagen, o None si está vacío o no existe.
pub fn resolver_imagen(root: &Path, campo: Option<&str>) -> Option<PathBuf> {
    let rel = campo.map(str::trim).filter(|s| !s.is_empty())?;
    let p = Path::new(rel);
    let abs = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    abs.is_file().then_some(abs)
}

fn apunta_a_un_archivo(root: &Path, campo: Option<&str>) -> bool {
    resolver_imagen(root, campo).is_some()
}

fn buscar(root: &Path, stems: &[&str]) -> Option<String> {
    for stem in stems {
        for ext in EXTS {
            let nombre = format!("{}.{}", stem, ext);
            if root.join(&nombre).is_file() {
                return Some(nombre);
            }
        }
    }
    None
}

#[tauri::command]
pub fn get_autor_config(root: String) -> Result<AutorConfig, String> {
    Ok(leer(Path::new(&root)))
}

#[tauri::command]
pub fn set_autor_config(root: String, config: AutorConfig) -> Result<(), String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("no es directorio: {}", root));
    }
    escribir(&p, &config)
}
```

- [ ] **Step 4: Registrar el módulo y los comandos**

En `src-tauri/src/lib.rs`: agregar `mod autor;` como primera línea de los mods (antes de `mod audit;`), y sumar `autor::get_autor_config, autor::set_autor_config` a la lista del `invoke_handler!`, siguiendo el formato de las entradas que ya están ahí.

- [ ] **Step 5: Correr los tests y ver que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml autor`
Expected: PASS, los ocho.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/autor.rs src-tauri/src/lib.rs
git commit -m "feat(autor): perfil global del autor en autor.json"
```

---

### Task 3: Reescalado de imágenes en `image.rs`

**Files:**
- Modify: `src-tauri/Cargo.toml` (dependencia `image`)
- Modify: `src-tauri/src/image.rs` (helpers nuevos + tests)

**Interfaces:**
- Consumes: nada.
- Produces: `image::reescalar_jpeg(bytes: &[u8], ancho_max: u32) -> Result<Vec<u8>, String>` (decodifica, reescala con Lanczos3 si hace falta y devuelve JPEG calidad 82) y `image::reescalar_png_nitido(bytes: &[u8], ancho_max: u32) -> Result<Vec<u8>, String>` (reescala con vecino más cercano y devuelve PNG; para QR). Ambas devuelven los bytes originales sin tocar si la imagen ya entra en `ancho_max`. Tasks 5, 6 y 8 las consumen.

- [ ] **Step 1: Verificar el crate antes de sumarlo**

Run: `cargo search image --limit 1` y después `cargo info image` (o abrir `https://crates.io/crates/image`).
Verificar y anotar en el mensaje del commit: versión elegida, fecha de publicación **más de 7 días atrás**, y que el crate sea el oficial del grupo `image-rs`. Si la última versión es más nueva que 7 días, elegir la anterior.

- [ ] **Step 2: Sumar la dependencia**

En `src-tauri/Cargo.toml`, dentro de `[dependencies]`, después de la línea de `fontdb`:

```toml
# Decodificar y reescalar tapas para el EPUB: las del repo son PNG de
# imprenta (hasta 7 MB) y embeberlas tal cual infla el archivo y el costo
# de delivery de KDP. default-features=false deja solo png+jpeg — nada de
# formatos exóticos ni deps C.
image = { version = "<la verificada>", default-features = false, features = ["png", "jpeg"] }
```

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: compila.

- [ ] **Step 3: Escribir los tests que fallan**

Al final de `src-tauri/src/image.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// PNG sólido de `w`x`h`, generado en memoria para no meter fixtures
    /// binarios al repo.
    fn png_de(w: u32, h: u32) -> Vec<u8> {
        let buf = ::image::RgbImage::from_pixel(w, h, ::image::Rgb([200, 30, 30]));
        let mut out = std::io::Cursor::new(Vec::new());
        ::image::DynamicImage::ImageRgb8(buf)
            .write_to(&mut out, ::image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn dimensiones(bytes: &[u8]) -> (u32, u32) {
        let img = ::image::load_from_memory(bytes).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn reescala_a_lo_ancho_y_conserva_la_proporcion() {
        let grande = png_de(2000, 3000);
        let chico = reescalar_jpeg(&grande, 400).unwrap();
        assert_eq!(dimensiones(&chico), (400, 600));
    }

    #[test]
    fn el_reescalado_achica_el_archivo() {
        let grande = png_de(2000, 3000);
        let chico = reescalar_jpeg(&grande, 400).unwrap();
        assert!(
            chico.len() < grande.len(),
            "esperaba menos bytes: {} vs {}",
            chico.len(),
            grande.len()
        );
        assert!(chico.len() < 100 * 1024, "la miniatura pesa {} bytes", chico.len());
    }

    #[test]
    fn una_imagen_que_ya_entra_vuelve_intacta() {
        let chica = png_de(300, 450);
        let out = reescalar_jpeg(&chica, 400).unwrap();
        assert_eq!(out, chica, "no debería recomprimir lo que ya entra");
    }

    #[test]
    fn el_qr_sale_png_y_no_jpeg() {
        let qr = png_de(1200, 1200);
        let out = reescalar_png_nitido(&qr, 600).unwrap();
        assert_eq!(&out[1..4], b"PNG", "el QR tiene que seguir siendo PNG");
        assert_eq!(dimensiones(&out), (600, 600));
    }

    #[test]
    fn bytes_que_no_son_imagen_dan_error_con_el_motivo() {
        let err = reescalar_jpeg(b"no soy una imagen", 400).unwrap_err();
        assert!(!err.is_empty());
    }
}
```

- [ ] **Step 4: Correr los tests y ver que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml image`
Expected: FAIL — `reescalar_jpeg` y `reescalar_png_nitido` no existen.

- [ ] **Step 5: Implementar los helpers**

Agregar a `src-tauri/src/image.rs`, antes del módulo de tests:

```rust
use ::image::imageops::FilterType;
use ::image::ImageFormat;

/// Reescala a `ancho_max` conservando proporción y devuelve JPEG calidad 82.
/// Si la imagen ya entra, devuelve los bytes originales sin recomprimir —
/// recomprimir de gusto solo agrega artefactos.
pub fn reescalar_jpeg(bytes: &[u8], ancho_max: u32) -> Result<Vec<u8>, String> {
    let img = ::image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    if img.width() <= ancho_max {
        return Ok(bytes.to_vec());
    }
    let alto = (img.height() as f64 * ancho_max as f64 / img.width() as f64).round() as u32;
    let chica = img.resize_exact(ancho_max, alto.max(1), FilterType::Lanczos3);
    let mut out = std::io::Cursor::new(Vec::new());
    chica
        .to_rgb8()
        .write_with_encoder(::image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82))
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Reescala a `ancho_max` y devuelve PNG. Usa vecino más cercano y no pasa
/// por JPEG: los bordes de los módulos de un QR tienen que quedar duros, y
/// los artefactos del JPEG hacen que algunos lectores fallen al escanear.
pub fn reescalar_png_nitido(bytes: &[u8], ancho_max: u32) -> Result<Vec<u8>, String> {
    let img = ::image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    if img.width() <= ancho_max {
        return Ok(bytes.to_vec());
    }
    let alto = (img.height() as f64 * ancho_max as f64 / img.width() as f64).round() as u32;
    let chica = img.resize_exact(ancho_max, alto.max(1), FilterType::Nearest);
    let mut out = std::io::Cursor::new(Vec::new());
    chica.write_to(&mut out, ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}
```

- [ ] **Step 6: Correr los tests y ver que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml image`
Expected: PASS, los cinco.

- [ ] **Step 7: Commit**

Incluir en el cuerpo del commit la versión de `image` y su fecha de publicación, que es la evidencia del chequeo de supply chain.

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/image.rs
git commit -m "feat(image): reescalar imágenes para el EPUB"
```

---

### Task 4: Página legal por incisos

**Files:**
- Modify: `src-tauri/src/book_config.rs` (tres campos nuevos)
- Modify: `src-tauri/src/epub.rs:1030-1080` aprox. (`build_copyright_xhtml`)

**Interfaces:**
- Consumes: nada de tasks anteriores.
- Produces: `epub::texto_inciso_default(clave: &str, is_en: bool) -> &'static str` con las claves `"reserva"`, `"ficcion"`, `"ia"`. Task 9 la necesita replicada en TypeScript para precargar los textareas — los strings tienen que ser idénticos.

- [ ] **Step 1: Escribir los tests que fallan**

En el módulo `tests` de `src-tauri/src/epub.rs`:

```rust
#[test]
fn copyright_back_compat_con_derechos_reservados_solo() {
    // Un book.json de los que ya existen en el repo: sin los campos nuevos.
    let cfg: BookConfig = serde_json::from_str(
        r#"{"titulo":"X","autor":"A","copyright_anio":2026,"derechos_reservados":true}"#,
    )
    .unwrap();
    let xhtml = build_copyright_xhtml(&cfg);
    assert!(xhtml.contains("Todos los derechos reservados."));
    assert!(xhtml.contains("Esta novela es enteramente una obra de ficción."));
    assert!(!xhtml.contains("inteligencia artificial"));
}

#[test]
fn copyright_permite_apagar_solo_el_inciso_de_ficcion() {
    let cfg: BookConfig = serde_json::from_str(
        r#"{"titulo":"X","derechos_reservados":true,"obra_de_ficcion":false}"#,
    )
    .unwrap();
    let xhtml = build_copyright_xhtml(&cfg);
    assert!(xhtml.contains("Todos los derechos reservados."));
    assert!(!xhtml.contains("obra de ficción"));
}

#[test]
fn copyright_suma_la_nota_de_ia_cuando_esta_prendida() {
    let cfg: BookConfig =
        serde_json::from_str(r#"{"titulo":"X","nota_ia":true}"#).unwrap();
    let xhtml = build_copyright_xhtml(&cfg);
    assert!(xhtml.contains(
        "Las imágenes de esta obra fueron generadas con inteligencia artificial."
    ));
    assert!(xhtml.contains("El texto es obra exclusiva del autor."));
}

#[test]
fn copyright_nota_de_ia_en_ingles() {
    let cfg: BookConfig =
        serde_json::from_str(r#"{"titulo":"X","idioma":"en","nota_ia":true}"#).unwrap();
    let xhtml = build_copyright_xhtml(&cfg);
    assert!(xhtml.contains("The images in this work were generated with artificial intelligence."));
}

#[test]
fn copyright_usa_el_texto_editado_en_vez_del_default() {
    let cfg: BookConfig = serde_json::from_str(
        r#"{"titulo":"X","nota_ia":true,"textos_legales":{"ia":"Las tapas las hizo una máquina."}}"#,
    )
    .unwrap();
    let xhtml = build_copyright_xhtml(&cfg);
    assert!(xhtml.contains("Las tapas las hizo una máquina."));
    assert!(!xhtml.contains("inteligencia artificial"));
}

#[test]
fn copyright_ignora_un_texto_editado_de_un_inciso_apagado() {
    let cfg: BookConfig = serde_json::from_str(
        r#"{"titulo":"X","derechos_reservados":false,"textos_legales":{"reserva":"No copiar."}}"#,
    )
    .unwrap();
    let xhtml = build_copyright_xhtml(&cfg);
    assert!(!xhtml.contains("No copiar."));
}
```

- [ ] **Step 2: Correr los tests y ver que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml copyright`
Expected: FAIL — no compila: `obra_de_ficcion`, `nota_ia` y `textos_legales` no existen en `BookConfig`.

- [ ] **Step 3: Agregar los campos**

En `src-tauri/src/book_config.rs`, junto a `derechos_reservados`, y sumando `use std::collections::BTreeMap;` arriba:

```rust
    /// Inciso "obra de ficción" de la página legal. Si está ausente hereda
    /// `derechos_reservados`, que es lo que lo prendía antes de que los
    /// incisos se separaran — así los book.json viejos exportan igual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obra_de_ficcion: Option<bool>,
    /// Inciso que aclara que la IA se usó solo para generar imágenes y que
    /// el texto es del autor. Default: apagado.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nota_ia: Option<bool>,
    /// Redacción propia por inciso, con las claves "reserva", "ficcion" e
    /// "ia". Solo se guarda lo que el autor haya editado; lo que falta usa
    /// el texto default del idioma del libro.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub textos_legales: Option<BTreeMap<String, String>>,
```

- [ ] **Step 4: Reescribir `build_copyright_xhtml`**

En `src-tauri/src/epub.rs`, reemplazar el bloque `if cfg.derechos_reservados.unwrap_or(true) { ... }` de `build_copyright_xhtml` por:

```rust
    let reserva = cfg.derechos_reservados.unwrap_or(true);
    // Sin campo propio, el inciso de ficción sigue a `derechos_reservados`:
    // es lo que hacía antes de separarlos.
    let ficcion = cfg.obra_de_ficcion.unwrap_or(reserva);
    let ia = cfg.nota_ia.unwrap_or(false);
    for (clave, activo) in [("reserva", reserva), ("ficcion", ficcion), ("ia", ia)] {
        if !activo {
            continue;
        }
        let texto = cfg
            .textos_legales
            .as_ref()
            .and_then(|m| m.get(clave))
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| texto_inciso_default(clave, is_en));
        body.push_str(&format!("<p>{}</p>\n", xml_escape(texto)));
    }
```

Y agregar, al lado de `build_copyright_xhtml`:

```rust
/// Redacción default de cada inciso de la página legal. Las claves son las
/// mismas que usa `BookConfig::textos_legales` y las que precarga el modal
/// de configuración del libro.
pub fn texto_inciso_default(clave: &str, is_en: bool) -> &'static str {
    match (clave, is_en) {
        ("reserva", false) => "Todos los derechos reservados. Ninguna parte de esta publicación puede ser reproducida, almacenada ni transmitida en forma alguna por medio electrónico, mecánico, fotocopia, grabación u otros sin autorización escrita del autor.",
        ("reserva", true) => "All rights reserved. No part of this publication may be reproduced, stored or transmitted in any form or by any means, electronic, mechanical, photocopying, recording or otherwise, without the prior written permission of the author.",
        ("ficcion", false) => "Esta novela es enteramente una obra de ficción. Los nombres, personajes y eventos retratados son producto de la imaginación del autor. Cualquier parecido con personas reales, vivas o fallecidas, eventos o lugares es enteramente coincidencia.",
        ("ficcion", true) => "This novel is entirely a work of fiction. The names, characters and incidents portrayed in it are the work of the author's imagination. Any resemblance to actual persons, living or dead, events or localities is entirely coincidental.",
        ("ia", false) => "Las imágenes de esta obra fueron generadas con inteligencia artificial. El texto es obra exclusiva del autor.",
        ("ia", true) => "The images in this work were generated with artificial intelligence. The text is the sole work of the author.",
        _ => "",
    }
}
```

- [ ] **Step 5: Correr toda la suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS. Los tests viejos de copyright siguen pasando sin tocarlos — eso es lo que prueba la compatibilidad.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/book_config.rs src-tauri/src/epub.rs
git commit -m "feat(epub): incisos de la página legal elegibles y editables"
```

---

### Task 5: Página "Otros libros"

**Files:**
- Modify: `src-tauri/src/epub.rs` (builder nuevo, embebido de miniaturas, CSS, alta en el spine)

**Interfaces:**
- Consumes: `catalogo::escanear` (Task 1), `image::reescalar_jpeg` (Task 3).
- Produces: `build_otros_libros_xhtml(cfg: &BookConfig, cat: &Catalogo, tapas: &HashMap<String, String>) -> String`, donde `tapas` mapea `link` → nombre de archivo dentro del EPUB. El archivo se llama `7_otros_libros.xhtml`, id de manifest `otros-libros`. Task 7 lo suma al índice con ese href y ese label.

- [ ] **Step 1: Escribir los tests que fallan**

En el módulo `tests` de `src-tauri/src/epub.rs`:

```rust
/// Arma un repo mínimo: root con dos sagas, y devuelve el path del libro
/// que se va a exportar (que tiene un capítulo).
fn repo_con_publicados() -> (std::path::PathBuf, std::path::PathBuf) {
    let root = tempdir();
    let saga = root.join("1 - Meridian");
    let otra = root.join("2 - Buenos Aires");
    std::fs::create_dir_all(&saga).unwrap();
    std::fs::create_dir_all(&otra).unwrap();
    std::fs::write(saga.join("saga.json"), r#"{"nombre":"Meridian"}"#).unwrap();
    std::fs::write(otra.join("saga.json"), r#"{"nombre":"Buenos Aires 2077"}"#).unwrap();

    let book = saga.join("1 - Actual");
    std::fs::create_dir_all(book.join("Cap1")).unwrap();
    std::fs::write(book.join("book.json"), r#"{"titulo":"Actual"}"#).unwrap();
    std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();

    let hermano = saga.join("2 - Hermano");
    std::fs::create_dir_all(&hermano).unwrap();
    std::fs::write(
        hermano.join("book.json"),
        r#"{"titulo":"Hermano","subtitulo":"Meridian #2","link":"https://tatoh.ar/libros/hermano","numero_en_serie":2}"#,
    )
    .unwrap();

    let ajeno = otra.join("1 - Luces");
    std::fs::create_dir_all(&ajeno).unwrap();
    std::fs::write(
        ajeno.join("book.json"),
        r#"{"titulo":"Luces","link":"https://tatoh.ar/libros/luces"}"#,
    )
    .unwrap();

    (root, book)
}

#[test]
fn export_impl_genera_la_pagina_de_otros_libros_con_los_dos_bloques() {
    let (_root, book) = repo_con_publicados();
    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    let page = String::from_utf8(entries.get("OEBPS/7_otros_libros.xhtml").unwrap().clone()).unwrap();
    assert!(page.contains("Más de Meridian"));
    assert!(page.contains("Otros libros del autor"));
    assert!(page.contains("https://tatoh.ar/libros/hermano"));
    assert!(page.contains("https://tatoh.ar/libros/luces"));
    assert!(page.contains("Meridian #2"));
    // El libro que se exporta no se lista a sí mismo.
    assert!(!page.contains(">Actual<"));
    let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
    assert!(opf.contains(r#"id="otros-libros""#));
}

#[test]
fn export_impl_omite_la_pagina_cuando_no_hay_publicados() {
    let tmp = tempdir();
    let book = tmp.join("book");
    std::fs::create_dir_all(book.join("Cap1")).unwrap();
    std::fs::write(book.join("book.json"), r#"{"titulo":"Solo"}"#).unwrap();
    std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    assert!(!entries.contains_key("OEBPS/7_otros_libros.xhtml"));
}

#[test]
fn otros_libros_omite_el_bloque_de_saga_cuando_esta_vacio() {
    let cat = crate::catalogo::Catalogo {
        misma_saga: Vec::new(),
        otros: vec![crate::catalogo::LibroPublicado {
            titulo: "Luces".into(),
            subtitulo: None,
            link: "https://x/l".into(),
            tapa: None,
            numero_en_serie: None,
        }],
        saga_actual: Some("Meridian".into()),
    };
    let cfg = BookConfig { titulo: "X".into(), ..Default::default() };
    let xhtml = build_otros_libros_xhtml(&cfg, &cat, &std::collections::HashMap::new());
    assert!(!xhtml.contains("Más de Meridian"));
    assert!(xhtml.contains("Otros libros del autor"));
}

#[test]
fn otros_libros_en_ingles() {
    let cat = crate::catalogo::Catalogo {
        misma_saga: vec![crate::catalogo::LibroPublicado {
            titulo: "Deployment".into(),
            subtitulo: None,
            link: "https://x/d".into(),
            tapa: None,
            numero_en_serie: Some(1),
        }],
        otros: Vec::new(),
        saga_actual: Some("Milky Way".into()),
    };
    let cfg = BookConfig {
        titulo: "X".into(),
        idioma: Some("en".into()),
        ..Default::default()
    };
    let xhtml = build_otros_libros_xhtml(&cfg, &cat, &std::collections::HashMap::new());
    assert!(xhtml.contains("More from Milky Way"));
    assert!(xhtml.contains("<h1>Also by the Author</h1>"));
}

#[test]
fn otros_libros_embebe_la_tapa_reescalada() {
    let (_root, book) = repo_con_publicados();
    // Al hermano le ponemos una tapa grande de verdad.
    let hermano = book.parent().unwrap().join("2 - Hermano");
    let grande = ::image::RgbImage::from_pixel(2000, 3000, ::image::Rgb([10, 20, 30]));
    ::image::DynamicImage::ImageRgb8(grande)
        .save(hermano.join("cover.png"))
        .unwrap();
    std::fs::write(
        hermano.join("book.json"),
        r#"{"titulo":"Hermano","link":"https://tatoh.ar/libros/hermano","tapa":"cover.png","numero_en_serie":2}"#,
    )
    .unwrap();

    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    let miniatura = entries
        .keys()
        .find(|k| k.starts_with("OEBPS/cat-"))
        .expect("no se embebió la miniatura");
    let bytes = entries.get(miniatura).unwrap();
    assert!(bytes.len() < 100 * 1024, "la miniatura pesa {} bytes", bytes.len());
    let page = String::from_utf8(entries.get("OEBPS/7_otros_libros.xhtml").unwrap().clone()).unwrap();
    assert!(page.contains("class=\"libro-tapa\""));
}
```

- [ ] **Step 2: Correr los tests y ver que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml otros_libros`
Expected: FAIL — `build_otros_libros_xhtml` no existe.

- [ ] **Step 3: Escribir el builder de la página**

En `src-tauri/src/epub.rs`, al lado de `build_about_author_xhtml`:

```rust
/// Página "Otros libros": los publicados de la misma saga y los del resto.
/// `tapas` mapea el link de cada libro al nombre del archivo de su
/// miniatura ya embebida en el EPUB; un libro sin entrada va sin imagen.
fn build_otros_libros_xhtml(
    cfg: &BookConfig,
    cat: &crate::catalogo::Catalogo,
    tapas: &std::collections::HashMap<String, String>,
) -> String {
    let lang = cfg.idioma.as_deref().unwrap_or("es");
    let is_en = lang == "en";
    let heading = if is_en { "Also by the Author" } else { "Otros libros" };

    let bloque = |titulo: &str, libros: &[crate::catalogo::LibroPublicado]| -> String {
        if libros.is_empty() {
            return String::new();
        }
        let mut s = format!("<h2>{}</h2>\n<ul class=\"libro-list\">\n", xml_escape(titulo));
        for l in libros {
            s.push_str("<li class=\"libro\">");
            if let Some(archivo) = tapas.get(&l.link) {
                s.push_str(&format!(
                    r#"<a href="{}"><img class="libro-tapa" src="{}" alt=""/></a>"#,
                    xml_escape(&l.link),
                    xml_escape(archivo)
                ));
            }
            s.push_str(&format!(
                "<p class=\"libro-titulo\"><a href=\"{}\">{}</a></p>",
                xml_escape(&l.link),
                xml_escape(&l.titulo)
            ));
            if let Some(sub) = &l.subtitulo {
                s.push_str(&format!("<p class=\"libro-subtitulo\">{}</p>", xml_escape(sub)));
            }
            s.push_str("</li>\n");
        }
        s.push_str("</ul>\n");
        s
    };

    let titulo_saga = match (&cat.saga_actual, is_en) {
        (Some(n), false) => format!("Más de {}", n),
        (Some(n), true) => format!("More from {}", n),
        (None, false) => "Más de esta serie".to_string(),
        (None, true) => "More from This Series".to_string(),
    };
    let titulo_otros = if is_en {
        "Other Books by the Author"
    } else {
        "Otros libros del autor"
    };

    let body = format!(
        "<div class=\"otros-libros\">\n<h1>{}</h1>\n{}{}</div>",
        xml_escape(heading),
        bloque(&titulo_saga, &cat.misma_saga),
        bloque(titulo_otros, &cat.otros),
    );
    xhtml_shell(&cfg.titulo, &body, lang, "otros-libros-body")
}
```

- [ ] **Step 4: Embeber las miniaturas y sumar la página al spine**

En `export_impl`, justo **antes** del bloque "5a-bis) Sobre el autor" (`src-tauri/src/epub.rs:643`):

```rust
    // 5a) Otros libros del autor. El catálogo sale de escanear el root: un
    // libro está publicado si su book.json tiene `link`.
    let catalogo = crate::catalogo::escanear(&root_dir, &book_dir);
    if !catalogo.misma_saga.is_empty() || !catalogo.otros.is_empty() {
        let mut tapas: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for (idx, libro) in catalogo
            .misma_saga
            .iter()
            .chain(catalogo.otros.iter())
            .enumerate()
        {
            let Some(origen) = &libro.tapa else { continue };
            let bytes = match fs::read(origen) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(target: "epub", tapa = %origen.display(), error = %e, "no pude leer la tapa del catálogo, va sin miniatura");
                    continue;
                }
            };
            let chica = match crate::image::reescalar_jpeg(&bytes, 400) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(target: "epub", tapa = %origen.display(), error = %e, "no pude reescalar la tapa del catálogo, va sin miniatura");
                    continue;
                }
            };
            let dest = format!("cat-{}.jpg", idx);
            zip.start_file(format!("OEBPS/{}", dest), opts).map_err(|e| e.to_string())?;
            zip.write_all(&chica).map_err(|e| e.to_string())?;
            items.push(Item {
                id: format!("cat-image-{}", idx),
                href: dest.clone(),
                media_type: "image/jpeg".into(),
                spine_order: None,
                properties: None,
            });
            tapas.insert(libro.link.clone(), dest);
        }

        spine_idx += 1;
        let xhtml = build_otros_libros_xhtml(&cfg, &catalogo, &tapas);
        zip.start_file("OEBPS/7_otros_libros.xhtml", opts).map_err(|e| e.to_string())?;
        zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
        items.push(Item {
            id: "otros-libros".into(),
            href: "7_otros_libros.xhtml".into(),
            media_type: "application/xhtml+xml".into(),
            spine_order: Some(spine_idx),
            properties: None,
        });
    }
```

Nota: `reescalar_jpeg` devuelve los bytes tal cual si la imagen ya entra en 400 px — en ese caso el archivo puede no ser JPEG. Para que el media-type nunca mienta, cambiar la firma del helper de Task 3 no es necesario: el `dest` se decide por el resultado. Usar:

```rust
            let (dest, mime) = if chica.len() >= 4 && &chica[1..4] == b"PNG" {
                (format!("cat-{}.png", idx), "image/png")
            } else {
                (format!("cat-{}.jpg", idx), "image/jpeg")
            };
```

y reemplazar el `dest`/`media_type` de arriba por estos dos.

- [ ] **Step 5: Sumar el CSS de la página**

En `build_css` de `src-tauri/src/epub.rs`, dentro del bloque de reglas base (el mismo string donde ya viven `.about-author` y compañía), agregar:

```css
.otros-libros h2 { margin-top: 1.6em; text-align: center; }
ul.libro-list { list-style: none; margin: 0; padding: 0; }
li.libro { margin: 0 0 1.4em 0; }
li.libro:after { content: ""; display: block; clear: both; }
img.libro-tapa { float: left; width: 25%; max-width: 110px; margin: 0 1em 0.5em 0; }
p.libro-titulo { margin: 0; font-weight: bold; }
p.libro-subtitulo { margin: 0.2em 0 0 0; font-size: 0.9em; }
```

Nada de flexbox ni grid: los lectores viejos los ignoran y el resultado queda peor que el apilado.

Y en la lista de selectores de fuentes editoriales (`src-tauri/src/epub.rs:155`), agregar `body.otros-libros-body`; en la de heading (`src-tauri/src/epub.rs:170`), agregar `.otros-libros h1`.

- [ ] **Step 6: Correr los tests y ver que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, incluidos los cinco nuevos.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/epub.rs
git commit -m "feat(epub): sección Otros libros al final del EPUB"
```

---

### Task 6: "Sobre el autor" con `autor.json`, web y QR

**Files:**
- Modify: `src-tauri/src/epub.rs` (`build_about_author_xhtml` y su bloque en `export_impl`)

**Interfaces:**
- Consumes: `autor::leer`, `autor::resolver_imagen` (Task 2), `image::reescalar_png_nitido` y `reescalar_jpeg` (Task 3).
- Produces: `build_about_author_xhtml(cfg: &BookConfig, bio: &str, foto: Option<&str>, web: Option<&str>, qr: Option<&str>) -> String`. **Cambia la firma actual** (hoy es `(cfg, photo_filename)`), así que hay que actualizar los tests existentes `about_author_xhtml_renders_heading_photo_and_bio` y `about_author_xhtml_english_heading`.

- [ ] **Step 1: Escribir los tests que fallan**

En el módulo `tests` de `src-tauri/src/epub.rs`:

```rust
#[test]
fn about_author_usa_la_bio_del_autor_json_cuando_el_libro_no_tiene() {
    let (root, book) = repo_con_publicados();
    std::fs::write(
        root.join("autor.json"),
        r#"{"nombre":"Tatoh","bio":{"es":"Escribe de noche."},"web":"https://tatoh.ar"}"#,
    )
    .unwrap();
    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    let page = String::from_utf8(entries.get("OEBPS/8_about_author.xhtml").unwrap().clone()).unwrap();
    assert!(page.contains("Escribe de noche."));
    assert!(page.contains("https://tatoh.ar"));
}

#[test]
fn about_author_el_libro_pisa_la_bio_global() {
    let (root, book) = repo_con_publicados();
    std::fs::write(root.join("autor.json"), r#"{"bio":{"es":"La global."}}"#).unwrap();
    std::fs::write(
        book.join("book.json"),
        r#"{"titulo":"Actual","sobre_el_autor":"La del libro."}"#,
    )
    .unwrap();
    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    let page = String::from_utf8(entries.get("OEBPS/8_about_author.xhtml").unwrap().clone()).unwrap();
    assert!(page.contains("La del libro."));
    assert!(!page.contains("La global."));
}

#[test]
fn about_author_embebe_el_qr_como_png() {
    let (root, book) = repo_con_publicados();
    std::fs::write(
        root.join("autor.json"),
        r#"{"bio":{"es":"x"},"web":"https://tatoh.ar","qr":"qr.png"}"#,
    )
    .unwrap();
    let qr = ::image::RgbImage::from_pixel(1200, 1200, ::image::Rgb([0, 0, 0]));
    ::image::DynamicImage::ImageRgb8(qr).save(root.join("qr.png")).unwrap();

    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    let bytes = entries.get("OEBPS/author-qr.png").expect("no se embebió el QR");
    assert_eq!(&bytes[1..4], b"PNG", "el QR tiene que quedar PNG");
    let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
    assert!(opf.contains("image/png"));
    let page = String::from_utf8(entries.get("OEBPS/8_about_author.xhtml").unwrap().clone()).unwrap();
    assert!(page.contains("class=\"autor-qr\""));
}

#[test]
fn about_author_sin_web_no_muestra_ni_texto_ni_qr() {
    let cfg = BookConfig { titulo: "X".into(), ..Default::default() };
    let xhtml = build_about_author_xhtml(&cfg, "bio", None, None, Some("author-qr.png"));
    assert!(!xhtml.contains("autor-qr"));
    assert!(!xhtml.contains("autor-web"));
}

#[test]
fn about_author_con_web_y_sin_qr_muestra_solo_el_texto() {
    let cfg = BookConfig { titulo: "X".into(), ..Default::default() };
    let xhtml = build_about_author_xhtml(&cfg, "bio", None, Some("https://tatoh.ar"), None);
    assert!(xhtml.contains("https://tatoh.ar"));
    assert!(!xhtml.contains("autor-qr"));
}
```

Y actualizar los dos tests existentes a la firma nueva: `build_about_author_xhtml(&cfg, "bio de prueba", Some("author.jpg"), None, None)`.

- [ ] **Step 2: Correr los tests y ver que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml about_author`
Expected: FAIL — la firma no coincide.

- [ ] **Step 3: Reescribir el builder**

Reemplazar `build_about_author_xhtml` en `src-tauri/src/epub.rs`:

```rust
/// Página "Sobre el autor". Todas las piezas son opcionales salvo la bio,
/// que es lo que decide si la página existe (lo resuelve el llamador).
fn build_about_author_xhtml(
    cfg: &BookConfig,
    bio: &str,
    foto: Option<&str>,
    web: Option<&str>,
    qr: Option<&str>,
) -> String {
    let lang = cfg.idioma.as_deref().unwrap_or("es");
    let is_en = lang == "en";
    let heading = if is_en { "About the Author" } else { "Sobre el autor" };

    let img = foto
        .map(|f| format!(r#"<img class="about-author-photo" src="{}" alt=""/>"#, xml_escape(f)))
        .unwrap_or_default();

    let parrafos: String = bio
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| format!("<p>{}</p>\n", xml_escape(l)))
        .collect();

    // El QR solo tiene sentido si hay a dónde apuntar. La URL va igual como
    // texto: el que lee en el celular no puede escanear su propia pantalla.
    let enlace = match web {
        Some(w) if !w.trim().is_empty() => {
            let qr_html = qr
                .map(|q| {
                    format!(
                        r#"<a href="{}"><img class="autor-qr" src="{}" alt=""/></a>"#,
                        xml_escape(w),
                        xml_escape(q)
                    )
                })
                .unwrap_or_default();
            format!(
                "<div class=\"autor-web\">{}<p class=\"autor-web-url\"><a href=\"{}\">{}</a></p></div>\n",
                qr_html,
                xml_escape(w),
                xml_escape(w.trim_start_matches("https://").trim_start_matches("http://"))
            )
        }
        _ => String::new(),
    };

    let body = format!(
        r#"<div class="about-author">
<h1 class="about-author-title">{}</h1>
{}
<div class="about-author-bio">
{}</div>
{}</div>"#,
        xml_escape(heading),
        img,
        parrafos,
        enlace
    );
    xhtml_shell(heading, &body, lang, "about-author-body")
}
```

- [ ] **Step 4: Cablear `autor.json` en `export_impl`**

Reemplazar el bloque "5a-bis) Sobre el autor" por:

```rust
    // 5a-bis) Sobre el autor. La bio, la foto, la web y el QR salen de
    // autor.json en la raíz; el book.json puede pisar bio y foto.
    let perfil = crate::autor::leer(&root_dir);
    let bio_libro = cfg
        .sobre_el_autor
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let bio = bio_libro.or_else(|| perfil.bio_en(cfg.idioma.as_deref().unwrap_or("es")));
    if let Some(bio) = bio {
        // Foto: la del libro gana; si no, la del perfil global.
        let foto_origen = cfg
            .foto_autor
            .as_deref()
            .map(|rel| {
                let p = std::path::Path::new(rel);
                if p.is_absolute() { p.to_path_buf() } else { book_dir.join(p) }
            })
            .filter(|p| p.is_file())
            .or_else(|| crate::autor::resolver_imagen(&root_dir, perfil.foto.as_deref()));

        let foto_filename = match foto_origen {
            Some(origen) => embebido_reescalado(
                &origen,
                "author",
                600,
                false,
                &mut zip,
                opts,
                &mut items,
                "author-image",
            )?,
            None => None,
        };

        let qr_filename = match crate::autor::resolver_imagen(&root_dir, perfil.qr.as_deref()) {
            Some(origen) => embebido_reescalado(
                &origen,
                "author-qr",
                600,
                true,
                &mut zip,
                opts,
                &mut items,
                "author-qr-image",
            )?,
            None => None,
        };

        spine_idx += 1;
        let xhtml = build_about_author_xhtml(
            &cfg,
            bio,
            foto_filename.as_deref(),
            perfil.web.as_deref(),
            qr_filename.as_deref(),
        );
        zip.start_file("OEBPS/8_about_author.xhtml", opts).map_err(|e| e.to_string())?;
        zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
        items.push(Item {
            id: "about-author".into(),
            href: "8_about_author.xhtml".into(),
            media_type: "application/xhtml+xml".into(),
            spine_order: Some(spine_idx),
            properties: None,
        });
    }
```

- [ ] **Step 5: Escribir el helper de embebido reescalado**

Al lado de `embed_image` en `src-tauri/src/epub.rs`:

```rust
/// Lee una imagen de disco, la reescala y la mete al zip + al manifest.
/// `nitido` usa el camino PNG sin recomprimir (QR); si no, va a JPEG.
/// Devuelve el nombre del archivo dentro del EPUB, o None si no se pudo —
/// nunca aborta el export por una imagen.
#[allow(clippy::too_many_arguments)]
fn embebido_reescalado(
    origen: &Path,
    stem: &str,
    ancho_max: u32,
    nitido: bool,
    zip: &mut ZipWriter<File>,
    opts: SimpleFileOptions,
    items: &mut Vec<Item>,
    item_id: &str,
) -> Result<Option<String>, String> {
    let bytes = match fs::read(origen) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(target: "epub", path = %origen.display(), error = %e, "no pude leer la imagen, sigo sin ella");
            return Ok(None);
        }
    };
    let procesada = if nitido {
        crate::image::reescalar_png_nitido(&bytes, ancho_max)
    } else {
        crate::image::reescalar_jpeg(&bytes, ancho_max)
    };
    let procesada = match procesada {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(target: "epub", path = %origen.display(), error = %e, "no pude procesar la imagen, sigo sin ella");
            return Ok(None);
        }
    };
    let es_png = procesada.len() >= 4 && &procesada[1..4] == b"PNG";
    let (dest, mime) = if es_png {
        (format!("{}.png", stem), "image/png")
    } else {
        (format!("{}.jpg", stem), "image/jpeg")
    };
    zip.start_file(format!("OEBPS/{}", dest), opts).map_err(|e| e.to_string())?;
    zip.write_all(&procesada).map_err(|e| e.to_string())?;
    items.push(Item {
        id: item_id.to_string(),
        href: dest.clone(),
        media_type: mime.into(),
        spine_order: None,
        properties: None,
    });
    Ok(Some(dest))
}
```

- [ ] **Step 6: CSS de la web y el QR**

En `build_css`, junto a las reglas de `.about-author`:

```css
.autor-web { margin-top: 1.6em; text-align: right; }
img.autor-qr { width: 150px; max-width: 40%; }
p.autor-web-url { margin: 0.3em 0 0 0; font-size: 0.9em; }
```

- [ ] **Step 7: Correr los tests y ver que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/epub.rs
git commit -m "feat(epub): Sobre el autor toma el perfil global y suma web + QR"
```

---

### Task 7: Índice con las páginas editoriales agrupadas

**Files:**
- Modify: `src-tauri/src/epub.rs` (`TocEntry`, sus cuatro sitios de construcción en `epub.rs:521,562,594,634`, `build_toc_xhtml`, `build_ncx_with_entries`, armado del índice en `export_impl`, `build_css`)

**Interfaces:**
- Consumes: los hrefs y labels que fijaron Tasks 5 y 6 (`7_otros_libros.xhtml` / "Otros libros", `8_about_author.xhtml` / "Sobre el autor").
- Produces: `TocEntry` gana el campo `editorial: bool`. Todo constructor existente pasa `editorial: false`.

- [ ] **Step 1: Escribir los tests que fallan**

```rust
#[test]
fn el_indice_incluye_las_paginas_editoriales_agrupadas() {
    let (root, book) = repo_con_publicados();
    std::fs::write(root.join("autor.json"), r#"{"bio":{"es":"x"}}"#).unwrap();
    std::fs::write(
        book.join("book.json"),
        r#"{"titulo":"Actual","dedicatoria":"Para vos"}"#,
    )
    .unwrap();
    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    let toc = String::from_utf8(entries.get("OEBPS/toc.xhtml").unwrap().clone()).unwrap();

    for etiqueta in ["Copyright", "Dedicatoria", "Otros libros", "Sobre el autor"] {
        assert!(toc.contains(etiqueta), "falta {} en el índice", etiqueta);
    }
    assert!(toc.contains("toc-editorial"));
    // El copyright va antes del primer capítulo y el catálogo después.
    let pos_copy = toc.find("Copyright").unwrap();
    let pos_cap = toc.find("Cap").unwrap_or(toc.len());
    let pos_otros = toc.find("Otros libros").unwrap();
    assert!(pos_copy < pos_cap);
    assert!(pos_otros > pos_cap);
    // La portadilla y la contratapa no son destinos de navegación.
    assert!(!toc.contains("1_title.xhtml"));

    let ncx = String::from_utf8(entries.get("OEBPS/toc.ncx").unwrap().clone()).unwrap();
    assert!(ncx.contains("Otros libros"));
    assert!(ncx.contains("Sobre el autor"));
}

#[test]
fn una_pagina_editorial_ausente_no_deja_entrada_en_el_indice() {
    let tmp = tempdir();
    let book = tmp.join("book");
    std::fs::create_dir_all(book.join("Cap1")).unwrap();
    std::fs::write(book.join("book.json"), r#"{"titulo":"Solo"}"#).unwrap();
    std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    let toc = String::from_utf8(entries.get("OEBPS/toc.xhtml").unwrap().clone()).unwrap();
    assert!(!toc.contains("Dedicatoria"));
    assert!(!toc.contains("Otros libros"));
    assert!(!toc.contains("Sobre el autor"));
    assert!(toc.contains("Copyright"), "el copyright siempre está");
}

#[test]
fn el_indice_en_ingles_usa_las_etiquetas_en_ingles() {
    let tmp = tempdir();
    let book = tmp.join("book");
    std::fs::create_dir_all(book.join("Cap1")).unwrap();
    std::fs::write(book.join("book.json"), r#"{"titulo":"Solo","idioma":"en"}"#).unwrap();
    std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    let toc = String::from_utf8(entries.get("OEBPS/toc.xhtml").unwrap().clone()).unwrap();
    assert!(toc.contains("Copyright"));
    assert!(!toc.contains("Índice</h1>"));
}
```

- [ ] **Step 2: Correr los tests y ver que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml indice`
Expected: FAIL — el índice no tiene ninguna entrada editorial.

- [ ] **Step 3: Sumar el campo a `TocEntry`**

En `src-tauri/src/epub.rs:797`:

```rust
struct TocEntry {
    href: String,
    label: String,
    children: Vec<TocEntry>,
    /// Página editorial (copyright, dedicatoria, catálogo, bio) en vez de
    /// capítulo. Se renderea atenuada y agrupada, para que el listado de
    /// capítulos siga dominando la pantalla.
    editorial: bool,
}
```

Y en los cuatro sitios de construcción (`epub.rs:521`, `:562`, `:594`, `:634`) agregar `editorial: false,` al literal.

- [ ] **Step 4: Renderizar la clase en el nav**

En `build_toc_xhtml`, cambiar el `push_str` del `<li>` de nivel superior:

```rust
        let clase = if e.editorial {
            "toc-editorial toc-body"
        } else {
            "toc-part toc-body"
        };
        lis.push_str(&format!(
            "<li class=\"{}\"><a href=\"{}\">{}</a>",
            clase,
            xml_escape(&e.href),
            xml_escape(&e.label)
        ));
```

`build_ncx_with_entries` no cambia: el NCX no soporta clases y los lectores que lo usan tampoco.

- [ ] **Step 5: Armar las entradas editoriales en `export_impl`**

Los `TocEntry` de los capítulos se acumulan en `toc_entries` mientras se recorren los capítulos. Las editoriales de **front matter** hay que insertarlas al principio y las de **back matter** al final, justo antes de generar `toc.xhtml` (`src-tauri/src/epub.rs:711`):

```rust
    // Índice: las páginas editoriales van agrupadas, delante y detrás de los
    // capítulos. Solo entran las que efectivamente se generaron.
    let ed = |href: &str, label: &str| TocEntry {
        href: href.to_string(),
        label: label.to_string(),
        children: Vec::new(),
        editorial: true,
    };
    let mut front: Vec<TocEntry> = vec![ed("2_copyright.xhtml", "Copyright")];
    if items.iter().any(|i| i.id == "dedication") {
        front.push(ed(
            "3_dedication.xhtml",
            if is_en { "Dedication" } else { "Dedicatoria" },
        ));
    }
    if items.iter().any(|i| i.id == "otros-libros") {
        toc_entries.push(ed(
            "7_otros_libros.xhtml",
            if is_en { "Also by the Author" } else { "Otros libros" },
        ));
    }
    if items.iter().any(|i| i.id == "about-author") {
        toc_entries.push(ed(
            "8_about_author.xhtml",
            if is_en { "About the Author" } else { "Sobre el autor" },
        ));
    }
    front.append(&mut toc_entries);
    let toc_entries = front;
```

- [ ] **Step 6: CSS del índice**

En `build_css`, junto a las reglas del nav:

```css
nav ol.toc > li.toc-editorial { font-size: 0.9em; opacity: 0.75; }
nav ol.toc > li.toc-editorial + li.toc-part { margin-top: 0.8em; }
nav ol.toc > li.toc-part + li.toc-editorial { margin-top: 1em; padding-top: 0.8em; border-top: 1px solid currentColor; }
```

- [ ] **Step 7: Correr toda la suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/epub.rs
git commit -m "feat(epub): sumar las páginas editoriales al índice, agrupadas"
```

---

### Task 8: Reescalar también la tapa del propio libro

**Files:**
- Modify: `src-tauri/src/epub.rs` (bloque "1) Cover" en `export_impl`)

**Interfaces:**
- Consumes: `embebido_reescalado` (Task 6), `image::reescalar_jpeg` (Task 3).
- Produces: nada nuevo. La tapa sigue entrando al manifest con `properties: Some("cover-image")`.

- [ ] **Step 1: Escribir el test que falla**

```rust
#[test]
fn la_tapa_del_libro_se_reescala_antes_de_embeberse() {
    let tmp = tempdir();
    let book = tmp.join("book");
    std::fs::create_dir_all(book.join("Cap1")).unwrap();
    std::fs::write(
        book.join("book.json"),
        r#"{"titulo":"Grande","tapa":"cover.png"}"#,
    )
    .unwrap();
    std::fs::write(book.join("Cap1").join("1.html"), "<p>x</p>").unwrap();
    let grande = ::image::RgbImage::from_pixel(3000, 4500, ::image::Rgb([9, 9, 9]));
    ::image::DynamicImage::ImageRgb8(grande).save(book.join("cover.png")).unwrap();
    let original = std::fs::metadata(book.join("cover.png")).unwrap().len();

    let result = export_impl(book.to_str().unwrap()).unwrap();
    let entries = read_epub_entries(std::path::Path::new(&result.epub_path));
    let (nombre, bytes) = entries
        .iter()
        .find(|(k, _)| k.starts_with("OEBPS/cover."))
        .expect("no está la tapa");
    assert!(
        (bytes.len() as u64) < original,
        "la tapa embebida ({}) no bajó de la original ({})",
        bytes.len(),
        original
    );
    let img = ::image::load_from_memory(bytes).unwrap();
    assert_eq!(img.width(), 1600);
    let opf = String::from_utf8(entries.get("OEBPS/content.opf").unwrap().clone()).unwrap();
    assert!(opf.contains("cover-image"));
    // El XHTML de la portada tiene que apuntar al nombre real del archivo.
    let cover_page = String::from_utf8(entries.get("OEBPS/0_cover.xhtml").unwrap().clone()).unwrap();
    assert!(cover_page.contains(nombre.trim_start_matches("OEBPS/")));
}
```

- [ ] **Step 2: Correr el test y ver que falla**

Run: `cargo test --manifest-path src-tauri/Cargo.toml la_tapa_del_libro`
Expected: FAIL — hoy la tapa se embebe tal cual, con 3000 px de ancho.

- [ ] **Step 3: Cambiar el bloque de la tapa**

Reemplazar el bloque "1) Cover" de `export_impl` por:

```rust
    // 1) Cover (si hay imagen). Reescalada: las tapas del repo son PNG de
    // imprenta de varios MB y KDP cobra delivery por MB. 1600 px de ancho es
    // lo que recomienda Amazon para la portada de un ebook.
    if let Some(cover_rel) = &cfg.tapa {
        let origen = {
            let p = Path::new(cover_rel);
            if p.is_absolute() { p.to_path_buf() } else { book_dir.join(p) }
        };
        if origen.is_file() {
            if let Some(cover_filename) = embebido_reescalado(
                &origen,
                "cover",
                1600,
                false,
                &mut zip,
                opts,
                &mut items,
                "cover-image",
            )? {
                // `embebido_reescalado` no sabe de `properties`; se la ponemos acá.
                if let Some(it) = items.iter_mut().find(|i| i.id == "cover-image") {
                    it.properties = Some("cover-image".into());
                }
                spine_idx += 1;
                let xhtml = build_cover_xhtml(&cover_filename);
                zip.start_file("OEBPS/0_cover.xhtml", opts).map_err(|e| e.to_string())?;
                zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
                items.push(Item {
                    id: "cover".into(),
                    href: "0_cover.xhtml".into(),
                    media_type: "application/xhtml+xml".into(),
                    spine_order: Some(spine_idx),
                    properties: None,
                });
            }
        }
    }
```

- [ ] **Step 4: Correr toda la suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS. Prestar atención a los tests viejos que asumen `OEBPS/cover.png`: si alguno falla porque ahora el archivo es `cover.jpg`, corregir la aserción para que busque por prefijo (`starts_with("OEBPS/cover.")`), no invertir el cambio.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/epub.rs
git commit -m "fix(epub): reescalar la tapa antes de embeberla"
```

---

### Task 9: Frontend — `link` y sección legal en el modal del libro

**Files:**
- Modify: `src/app/core/book-config-service.ts` (tipos)
- Modify: `src/app/book-config/book-config-modal.ts`
- Modify: `src/app/book-config/book-config-modal.html`
- Modify: `src/app/book-config/book-config-modal.scss`

**Interfaces:**
- Consumes: los campos `link`, `obra_de_ficcion`, `nota_ia`, `textos_legales` de `BookConfig` (Tasks 1 y 4), y los textos default de `texto_inciso_default` (Task 4), replicados en TypeScript **palabra por palabra**.
- Produces: nada para tasks siguientes.

- [ ] **Step 1: Extender el tipo**

En `src/app/core/book-config-service.ts`, en la interfaz `BookConfig`, junto a `derechos_reservados`:

```typescript
  /** URL pública del libro. Cargarla lo publica en el catálogo de los demás EPUB. */
  link?: string | null;
  obra_de_ficcion?: boolean | null;
  nota_ia?: boolean | null;
  textos_legales?: Record<string, string> | null;
```

- [ ] **Step 2: Textos default y estado en el componente**

En `src/app/book-config/book-config-modal.ts`, arriba de la clase:

```typescript
/** Espejo de `epub.rs::texto_inciso_default`. Si cambia allá, cambia acá:
 *  el textarea precarga esto y solo se guarda lo que el autor edite. */
const TEXTOS_LEGALES_DEFAULT: Record<string, { es: string; en: string }> = {
  reserva: {
    es: 'Todos los derechos reservados. Ninguna parte de esta publicación puede ser reproducida, almacenada ni transmitida en forma alguna por medio electrónico, mecánico, fotocopia, grabación u otros sin autorización escrita del autor.',
    en: 'All rights reserved. No part of this publication may be reproduced, stored or transmitted in any form or by any means, electronic, mechanical, photocopying, recording or otherwise, without the prior written permission of the author.',
  },
  ficcion: {
    es: 'Esta novela es enteramente una obra de ficción. Los nombres, personajes y eventos retratados son producto de la imaginación del autor. Cualquier parecido con personas reales, vivas o fallecidas, eventos o lugares es enteramente coincidencia.',
    en: "This novel is entirely a work of fiction. The names, characters and incidents portrayed in it are the work of the author's imagination. Any resemblance to actual persons, living or dead, events or localities is entirely coincidental.",
  },
  ia: {
    es: 'Las imágenes de esta obra fueron generadas con inteligencia artificial. El texto es obra exclusiva del autor.',
    en: 'The images in this work were generated with artificial intelligence. The text is the sole work of the author.',
  },
};

const INCISOS = [
  { clave: 'reserva', label: 'Reserva de derechos' },
  { clave: 'ficcion', label: 'Obra de ficción' },
  { clave: 'ia', label: 'Uso de IA' },
] as const;
```

Dentro de la clase:

```typescript
  protected readonly incisos = INCISOS;
  /** Claves de incisos con el textarea desplegado. */
  protected readonly editandoTexto = signal<Set<string>>(new Set());

  protected incisoActivo(clave: string): boolean {
    const c = this.config();
    if (!c) return false;
    const reserva = c.derechos_reservados ?? true;
    if (clave === 'reserva') return reserva;
    if (clave === 'ficcion') return c.obra_de_ficcion ?? reserva;
    return c.nota_ia ?? false;
  }

  protected setInciso(clave: string, activo: boolean): void {
    const c = this.config();
    if (!c) return;
    if (clave === 'reserva') {
      // Al apagar la reserva, el inciso de ficción tenía que quedar donde
      // estaba: lo materializamos antes de que el default lo arrastre.
      const ficcion = this.incisoActivo('ficcion');
      this.config.set({ ...c, derechos_reservados: activo, obra_de_ficcion: ficcion });
      return;
    }
    if (clave === 'ficcion') this.config.set({ ...c, obra_de_ficcion: activo });
    else this.config.set({ ...c, nota_ia: activo });
  }

  protected textoInciso(clave: string): string {
    const c = this.config();
    const propio = c?.textos_legales?.[clave];
    if (propio) return propio;
    const idioma = c?.idioma === 'en' ? 'en' : 'es';
    return TEXTOS_LEGALES_DEFAULT[clave][idioma];
  }

  protected setTextoInciso(clave: string, valor: string): void {
    const c = this.config();
    if (!c) return;
    const idioma = c.idioma === 'en' ? 'en' : 'es';
    const textos = { ...(c.textos_legales ?? {}) };
    // Si volvió al default, no guardamos nada: el book.json queda limpio y
    // el texto sigue el idioma del libro si mañana cambia.
    if (valor.trim() === TEXTOS_LEGALES_DEFAULT[clave][idioma].trim()) delete textos[clave];
    else textos[clave] = valor;
    this.config.set({
      ...c,
      textos_legales: Object.keys(textos).length ? textos : null,
    });
  }

  protected toggleEdicionTexto(clave: string): void {
    this.editandoTexto.update((set) => {
      const next = new Set(set);
      if (next.has(clave)) next.delete(clave);
      else next.add(clave);
      return next;
    });
  }
```

En el `effect` que carga la config (`book-config-modal.ts:207`) sumar `link: cfg.link ?? ''`, y en el save (`book-config-modal.ts:312`) sumar `link: blank(cfg.link)`.

- [ ] **Step 3: Marcado del modal**

En `src/app/book-config/book-config-modal.html`, junto al campo de ISBN:

```html
<label class="field">
  <span>Link público</span>
  <input
    type="url"
    placeholder="https://tatoh.ar/libros/..."
    [ngModel]="c.link"
    (ngModelChange)="update('link', $event)"
  />
  <small class="hint">
    Con el link cargado, este libro aparece en la sección "Otros libros" de los
    EPUB de tus otras novelas.
  </small>
</label>
```

Y reemplazando el check suelto de derechos reservados:

```html
<fieldset class="legal">
  <legend>Página legal</legend>
  @for (inciso of incisos; track inciso.clave) {
    <div class="inciso">
      <label class="check">
        <input
          type="checkbox"
          [checked]="incisoActivo(inciso.clave)"
          (change)="setInciso(inciso.clave, $any($event.target).checked)"
        />
        <span>{{ inciso.label }}</span>
      </label>
      @if (incisoActivo(inciso.clave)) {
        <button type="button" class="link-btn" (click)="toggleEdicionTexto(inciso.clave)">
          {{ editandoTexto().has(inciso.clave) ? 'Ocultar' : 'Editar redacción' }}
        </button>
      }
      @if (editandoTexto().has(inciso.clave)) {
        <textarea
          rows="4"
          [ngModel]="textoInciso(inciso.clave)"
          (ngModelChange)="setTextoInciso(inciso.clave, $event)"
        ></textarea>
      }
    </div>
  }
</fieldset>
```

- [ ] **Step 4: Estilos**

En `src/app/book-config/book-config-modal.scss`, siguiendo las variables de color que el archivo ya usa:

```scss
.legal {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.8rem;

  .inciso {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;

    textarea {
      flex-basis: 100%;
      font: inherit;
    }
  }

  .link-btn {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.85em;
    padding: 0;
  }
}
```

- [ ] **Step 5: Compilar**

Run: `pnpm build`
Expected: build limpio, sin errores de tipos ni de template.

- [ ] **Step 6: Commit**

```bash
git add src/app/core/book-config-service.ts src/app/book-config/
git commit -m "feat(book-config): campo link e incisos legales editables"
```

---

### Task 10: Frontend — servicio y modal del autor

**Files:**
- Create: `src/app/core/autor-service.ts`
- Create: `src/app/autor/autor-modal.ts`
- Create: `src/app/autor/autor-modal.html`
- Create: `src/app/autor/autor-modal.scss`
- Modify: `src/app/app.html` (montar el modal junto a los otros)
- Modify: `src/app/landing/landing.html` y `src/app/landing/landing.ts` (botón en la vista raíz)

**Interfaces:**
- Consumes: comandos `get_autor_config` / `set_autor_config` (Task 2) y el comando existente `adopt_config_image`.
- Produces: nada para tasks siguientes.

- [ ] **Step 1: El servicio**

Crear `src/app/core/autor-service.ts`:

```typescript
import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from './settings-service';

export interface AutorConfig {
  nombre?: string | null;
  bio?: Record<string, string> | null;
  foto?: string | null;
  web?: string | null;
  qr?: string | null;
}

@Injectable({ providedIn: 'root' })
export class AutorService {
  private settings = inject(SettingsService);

  /** true = modal abierto. El perfil es uno solo, no hay nodo que editar. */
  readonly editing = signal(false);
  readonly savedAt = signal(0);

  async load(): Promise<AutorConfig> {
    const root = this.settings.root();
    if (!root) return {};
    return await invoke<AutorConfig>('get_autor_config', { root });
  }

  async save(config: AutorConfig): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    await invoke('set_autor_config', { root, config });
    this.savedAt.set(Date.now());
  }

  open(): void {
    this.editing.set(true);
  }

  close(): void {
    this.editing.set(false);
  }
}
```

- [ ] **Step 2: El componente**

Crear `src/app/autor/autor-modal.ts`:

```typescript
import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { AutorConfig, AutorService } from '../core/autor-service';
import { NativeDialogsService } from '../core/native-dialogs-service';
import { SettingsService } from '../core/settings-service';

@Component({
  selector: 'app-autor-modal',
  imports: [FormsModule],
  templateUrl: './autor-modal.html',
  styleUrl: './autor-modal.scss',
})
export class AutorModal {
  private svc = inject(AutorService);
  private dialogs = inject(NativeDialogsService);
  private settings = inject(SettingsService);

  protected readonly editing = this.svc.editing;
  protected readonly config = signal<AutorConfig | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (!this.editing()) return;
      void this.svc.load().then((cfg) => this.config.set(cfg));
    });
  }

  protected update<K extends keyof AutorConfig>(key: K, value: AutorConfig[K]): void {
    const cur = this.config();
    if (cur) this.config.set({ ...cur, [key]: value });
  }

  protected bio(idioma: 'es' | 'en'): string {
    return this.config()?.bio?.[idioma] ?? '';
  }

  protected setBio(idioma: 'es' | 'en', valor: string): void {
    const cur = this.config();
    if (!cur) return;
    const bio = { ...(cur.bio ?? {}) };
    if (valor.trim()) bio[idioma] = valor;
    else delete bio[idioma];
    this.config.set({ ...cur, bio: Object.keys(bio).length ? bio : null });
  }

  protected async pickFoto(): Promise<void> {
    await this.pickImagen('foto', 'autor', 'Seleccionar foto del autor');
  }

  protected async pickQr(): Promise<void> {
    await this.pickImagen('qr', 'qr', 'Seleccionar imagen del QR');
  }

  /** Copia la imagen a la raíz del repo y guarda el nombre relativo: el path
   *  absoluto del diálogo no viaja por git y en la otra PC no existe. */
  private async pickImagen(campo: 'foto' | 'qr', stem: string, titulo: string): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    const elegido = await this.dialogs.pickSingleFile({
      title: titulo,
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      defaultPath: root,
    });
    if (!elegido) return;
    try {
      const rel = await invoke<string>('adopt_config_image', {
        dirPath: root,
        source: elegido,
        stem,
      });
      this.update(campo, rel);
    } catch (e) {
      this.error.set(`No pude copiar la imagen: ${e}`);
    }
  }

  protected async save(): Promise<void> {
    const cfg = this.config();
    if (!cfg) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.svc.save(cfg);
      this.svc.close();
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.svc.close();
  }
}
```

Antes de escribir el `invoke('adopt_config_image', ...)`, confirmar los nombres exactos de los parámetros leyendo el método `adoptImage` de `src/app/book-config/book-config-modal.ts:258` y el comando en Rust. Si difieren, usar los del comando.

- [ ] **Step 3: El template**

Crear `src/app/autor/autor-modal.html`, copiando la estructura de overlay/backdrop/botonera de `src/app/saga-config/saga-config-modal.html` para que se vea igual que el resto:

```html
@if (editing()) {
  <div class="backdrop" (click)="close()"></div>
  <div class="modal" role="dialog" aria-label="Perfil del autor">
    <h2>Autor</h2>
    @if (config(); as c) {
      <label class="field">
        <span>Nombre</span>
        <input type="text" [ngModel]="c.nombre" (ngModelChange)="update('nombre', $event)" />
      </label>

      <label class="field">
        <span>Bio en español</span>
        <textarea rows="5" [ngModel]="bio('es')" (ngModelChange)="setBio('es', $event)"></textarea>
      </label>

      <label class="field">
        <span>Bio en inglés</span>
        <textarea rows="5" [ngModel]="bio('en')" (ngModelChange)="setBio('en', $event)"></textarea>
      </label>

      <label class="field">
        <span>Web</span>
        <input
          type="url"
          placeholder="https://tatoh.ar"
          [ngModel]="c.web"
          (ngModelChange)="update('web', $event)"
        />
      </label>

      <div class="field">
        <span>Foto</span>
        <div class="picker">
          <span class="path">{{ c.foto || 'sin foto' }}</span>
          <button type="button" (click)="pickFoto()">Elegir…</button>
        </div>
      </div>

      <div class="field">
        <span>QR de la web</span>
        <div class="picker">
          <span class="path">{{ c.qr || 'sin QR' }}</span>
          <button type="button" (click)="pickQr()">Elegir…</button>
        </div>
        <small class="hint">
          Va al final del EPUB, al lado de la dirección de tu web.
        </small>
      </div>
    }

    @if (error(); as e) {
      <p class="error">{{ e }}</p>
    }

    <div class="actions">
      <button type="button" (click)="close()">Cancelar</button>
      <button type="button" [disabled]="saving()" (click)="save()">Guardar</button>
    </div>
  </div>
}
```

Crear `src/app/autor/autor-modal.scss` copiando los estilos de overlay de `saga-config-modal.scss` y quedándose solo con lo que este modal usa.

- [ ] **Step 4: Montarlo y abrirlo**

En `src/app/app.html`, junto a los otros modales (`src/app/app.html:335`):

```html
<app-autor-modal />
```

con su import en el componente raíz.

En `src/app/landing/landing.html`, arriba de todo, un botón que solo aparece en la vista raíz (sin `currentNode()`, que es cuando se listan las sagas):

```html
@if (!currentNode()) {
  <div class="root-actions">
    <button type="button" class="autor-btn" (click)="abrirAutor()">Autor…</button>
  </div>
}
```

Y en `src/app/landing/landing.ts`, inyectar `AutorService` y agregar:

```typescript
  protected abrirAutor(): void {
    this.autorSvc.open();
  }
```

- [ ] **Step 5: Compilar**

Run: `pnpm build`
Expected: build limpio.

- [ ] **Step 6: Commit**

```bash
git add src/app/core/autor-service.ts src/app/autor/ src/app/app.html src/app/app.ts src/app/landing/
git commit -m "feat(autor): modal de perfil del autor en la vista raíz"
```

---

### Task 11: Cerrar el TODO y dejar la verificación anotada

**Files:**
- Modify: `TODO.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada.

- [ ] **Step 1: Correr la suite completa una vez más**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm build`
Expected: los dos verdes. Pegar el conteo de tests en el mensaje del commit.

- [ ] **Step 2: Actualizar el TODO**

En `TODO.md`, sección EPUB: marcar `[x]` el ítem **"Nota de uso de IA en la página legal"** y el de **"Copyright editable en ambos idiomas"** (los dos los cubre Task 4), y agregar el ítem nuevo del back matter con la referencia a la spec. **No marcar nada como verificado**: la verificación manual la hace el autor.

Redacción para el ítem nuevo:

```markdown
- [x] **Back matter del EPUB: catálogo, perfil de autor y página legal**
  (spec en `docs/superpowers/specs/2026-09-01-back-matter-epub-design.md`).
  Sección "Otros libros" que se arma escaneando el root (`catalogo.rs`: un
  libro está publicado si su `book.json` tiene `link`), perfil global en
  `autor.json` con bio ES/EN, foto, web y QR (`autor.rs`), incisos de la
  página legal elegibles y editables, y todas las páginas editoriales en el
  índice con `class="toc-editorial"`. De yapa, las imágenes ahora se
  reescalan antes de embeberse (crate `image`): la tapa iba a resolución de
  imprenta adentro del EPUB. **Pendiente de verificación manual del autor.**
```

Dejar sin marcar el ítem de "Incisos extra de copyright tipo Reedsy": este cambio deja la infraestructura, pero las cláusulas extra que enumera no están.

- [ ] **Step 3: Commit**

```bash
git add TODO.md
git commit -m "docs(todo): back matter del EPUB implementado, falta verificación manual"
```

- [ ] **Step 4: Verificación manual del autor**

Esto **no** lo hace el agente. Pasarle al autor la lista:

1. Abrir el modal "Autor" desde la vista raíz y cargar nombre, bio en español, web `https://tatoh.ar` y el QR.
2. En *La Caballera Esmeralda*, cargar el link `https://www.amazon.com/dp/B0G3JTSR43`.
3. Exportar *Más que un trabajo* (misma saga) y *Ojos en el Abismo* (otra saga).
4. Abrir los dos en Thorium: que el bloque de saga aparezca solo donde corresponde, que las miniaturas se vean, que el link abra, y que el QR escanee desde el celular.
5. Chequear el índice: copyright, dedicatoria, otros libros y sobre el autor, atenuados y separados de los capítulos.
6. Comparar el peso del EPUB contra la exportación anterior — tiene que haber bajado varios MB por el reescalado de la tapa.
