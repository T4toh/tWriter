use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::book_config::BookConfig;
use crate::saga_config::SagaConfig;
use crate::search;
use crate::util::strip_numeric_prefix;

#[derive(Serialize, Debug)]
pub struct CreateResult {
    pub path: String,
}

/// Crea un capítulo .html vacío + su .meta.json en `parent_dir`.
/// Usa el próximo número entero disponible (1.html, 2.html…).
#[tauri::command]
pub async fn create_chapter(
    parent_dir: String,
    idioma: Option<String>,
    titulo: Option<String>,
) -> Result<CreateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_chapter_impl(&parent_dir, idioma.as_deref(), titulo.as_deref())
    })
    .await
    .map_err(|e| format!("task: {}", e))?
}

fn create_chapter_impl(
    parent: &str,
    idioma: Option<&str>,
    titulo: Option<&str>,
) -> Result<CreateResult, String> {
    let parent = PathBuf::from(parent);
    if !parent.is_dir() {
        return Err(format!("no es directorio: {}", parent.display()));
    }
    let n = next_chapter_num(&parent)?;
    let html = parent.join(format!("{}.html", n));
    let meta = parent.join(format!("{}.meta.json", n));
    if html.exists() {
        return Err(format!("ya existe: {}", html.display()));
    }
    fs::write(&html, "<p></p>\n").map_err(|e| e.to_string())?;
    let lang = idioma.unwrap_or("es");
    let title = titulo
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}", n));
    let meta_json = serde_json::json!({
        "orden": n,
        "titulo": title,
        "status": "draft",
        "idioma": lang,
    });
    fs::write(&meta, serde_json::to_string_pretty(&meta_json).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    tracing::info!(target: "create", path = %html.display(), idioma = %lang, "capítulo creado");
    let path_str = html.to_string_lossy().into_owned();
    search::index_path_best_effort(&path_str, "chapter");
    Ok(CreateResult { path: path_str })
}

/// Inserta una parte nueva (vacía) inmediatamente después de la parte cuyo
/// path se pasa. Las partes existentes con número mayor se renumeran +1
/// (`<n>.html` → `<n+1>.html`, idem `.meta.json`, y `orden` en meta).
///
/// Requiere stem numérico (`<N>.html`). Shift hecho en orden descendente
/// para evitar colisiones intermedias. Si falla mid-shift, revierte los
/// renames hechos hasta el punto de falla.
#[tauri::command]
pub async fn insert_part_after(part_path: String) -> Result<CreateResult, String> {
    tauri::async_runtime::spawn_blocking(move || insert_part_after_impl(&part_path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn insert_part_after_impl(part_path: &str) -> Result<CreateResult, String> {
    let src = PathBuf::from(part_path);
    let parent = src
        .parent()
        .ok_or_else(|| "sin directorio padre".to_string())?
        .to_path_buf();
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "path sin filename".to_string())?;
    let current_num: u32 = stem
        .parse()
        .map_err(|_| format!("no es parte numerada: {}", stem))?;
    let new_num = current_num + 1;

    // Listar partes con número mayor al actual, ordenadas DESC para shift.
    let mut to_shift: Vec<u32> = fs::read_dir(&parent)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("html") {
                return None;
            }
            let s = p.file_stem().and_then(|x| x.to_str())?;
            let n: u32 = s.parse().ok()?;
            if n > current_num { Some(n) } else { None }
        })
        .collect();
    to_shift.sort_by(|a, b| b.cmp(a));

    let new_html = parent.join(format!("{}.html", new_num));
    let new_meta = parent.join(format!("{}.meta.json", new_num));

    // Tracking de renames hechos para revertir en caso de error.
    let mut renames: Vec<(PathBuf, PathBuf)> = Vec::new();

    for n in &to_shift {
        let old_html = parent.join(format!("{}.html", n));
        let new_html_dst = parent.join(format!("{}.html", n + 1));
        let old_meta = parent.join(format!("{}.meta.json", n));
        let new_meta_dst = parent.join(format!("{}.meta.json", n + 1));

        if let Err(e) = fs::rename(&old_html, &new_html_dst) {
            revert_renames(&renames);
            return Err(format!(
                "renombrar {}: {}",
                old_html.display(),
                e
            ));
        }
        renames.push((old_html, new_html_dst));

        if old_meta.is_file() {
            if let Err(e) = fs::rename(&old_meta, &new_meta_dst) {
                revert_renames(&renames);
                return Err(format!(
                    "renombrar {}: {}",
                    old_meta.display(),
                    e
                ));
            }
            renames.push((old_meta, new_meta_dst.clone()));

            // Actualizar `orden` en meta movida.
            if let Err(e) = bump_orden_in_meta(&new_meta_dst, n + 1) {
                revert_renames(&renames);
                return Err(e);
            }
        }
    }

    // Crear la parte nueva (vacía) heredando idioma del entorno.
    let idioma = crate::import::inherit_idioma(&parent).unwrap_or_else(|| "es".to_string());
    if let Err(e) = fs::write(&new_html, "<p></p>\n") {
        revert_renames(&renames);
        return Err(format!("escribir {}: {}", new_html.display(), e));
    }
    let meta_json = serde_json::json!({
        "orden": new_num,
        "titulo": new_num.to_string(),
        "status": "draft",
        "idioma": idioma,
    });
    if let Err(e) = fs::write(
        &new_meta,
        serde_json::to_string_pretty(&meta_json).unwrap_or_default(),
    ) {
        let _ = fs::remove_file(&new_html);
        revert_renames(&renames);
        return Err(format!("escribir {}: {}", new_meta.display(), e));
    }

    let path_str = new_html.to_string_lossy().into_owned();
    tracing::info!(target: "create", path = %new_html.display(), shifted = to_shift.len(), "parte insertada");
    search::index_path_best_effort(&path_str, "chapter");
    Ok(CreateResult { path: path_str })
}

fn revert_renames(renames: &[(PathBuf, PathBuf)]) {
    for (from, to) in renames.iter().rev() {
        let _ = fs::rename(to, from);
    }
}

fn bump_orden_in_meta(meta_path: &Path, new_orden: u32) -> Result<(), String> {
    let raw = fs::read_to_string(meta_path)
        .map_err(|e| format!("leer {}: {}", meta_path.display(), e))?;
    let mut v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {}", meta_path.display(), e))?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "orden".to_string(),
            serde_json::Value::Number(new_orden.into()),
        );
    }
    let out = serde_json::to_string_pretty(&v).unwrap_or(raw);
    fs::write(meta_path, out).map_err(|e| format!("escribir {}: {}", meta_path.display(), e))?;
    Ok(())
}

/// Crea un directorio dentro de `parent_dir` con `name`.
/// Si `numbered` es true y los hermanos siguen el patrón "N - Nombre",
/// prepende el próximo número. Si no, usa name tal cual.
#[tauri::command]
pub async fn create_directory(
    parent_dir: String,
    name: String,
    numbered: bool,
) -> Result<CreateResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_dir_impl(&parent_dir, &name, numbered))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn create_dir_impl(parent: &str, name: &str, numbered: bool) -> Result<CreateResult, String> {
    let parent = PathBuf::from(parent);
    if !parent.is_dir() {
        return Err(format!("no es directorio: {}", parent.display()));
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("nombre vacío".to_string());
    }

    let final_name = if numbered {
        let n = next_dir_num(&parent)?;
        format!("{} - {}", n, trimmed)
    } else {
        trimmed.to_string()
    };
    let path = parent.join(&final_name);
    if path.exists() {
        return Err(format!("ya existe: {}", path.display()));
    }
    fs::create_dir(&path).map_err(|e| e.to_string())?;
    tracing::info!(target: "create", path = %path.display(), "directorio creado");
    Ok(CreateResult {
        path: path.to_string_lossy().into_owned(),
    })
}

/// Crea un libro dentro de `parent_dir` con nombre numerado ("N - Nombre"),
/// inicializa `book.json` heredando `autor`/`idioma` de la saga padre (si existe)
/// y autocompleta `serie` + `numero_en_serie` + defaults EPUB.
#[tauri::command]
pub async fn create_book(parent_dir: String, name: String) -> Result<CreateResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_book_impl(&parent_dir, &name))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn create_book_impl(parent: &str, name: &str) -> Result<CreateResult, String> {
    let parent = PathBuf::from(parent);
    if !parent.is_dir() {
        return Err(format!("no es directorio: {}", parent.display()));
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("nombre vacío".to_string());
    }

    let n = next_dir_num(&parent)?;
    let dir_name = format!("{} - {}", n, trimmed);
    let book_dir = parent.join(&dir_name);
    if book_dir.exists() {
        return Err(format!("ya existe: {}", book_dir.display()));
    }
    fs::create_dir(&book_dir).map_err(|e| e.to_string())?;

    let saga = read_saga_for(&parent);
    let cfg = build_inherited_book_config(trimmed, n, saga.as_ref(), &parent);
    let book_json = book_dir.join("book.json");
    let mut json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&book_json, json).map_err(|e| e.to_string())?;

    tracing::info!(target: "create", path = %book_dir.display(), titulo = trimmed, "libro creado");
    Ok(CreateResult {
        path: book_dir.to_string_lossy().into_owned(),
    })
}

fn read_saga_for(parent: &Path) -> Option<SagaConfig> {
    let saga_json = parent.join("saga.json");
    if !saga_json.is_file() {
        return None;
    }
    let raw = fs::read_to_string(&saga_json).ok()?;
    serde_json::from_str::<SagaConfig>(&raw).ok()
}

fn build_inherited_book_config(
    titulo: &str,
    numero: u32,
    saga: Option<&SagaConfig>,
    parent: &Path,
) -> BookConfig {
    let serie = saga
        .map(|s| s.nombre.clone())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            parent
                .file_name()
                .and_then(|s| s.to_str())
                .map(strip_numeric_prefix)
        })
        .filter(|s| !s.trim().is_empty());

    BookConfig {
        titulo: titulo.to_string(),
        autor: saga.and_then(|s| s.autor.clone()).filter(|s| !s.is_empty()),
        idioma: Some(
            saga.and_then(|s| s.idioma.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "es".to_string()),
        ),
        serie,
        numero_en_serie: Some(numero),
        copyright_anio: Some(current_year()),
        derechos_reservados: Some(true),
        template: Some(
            saga.and_then(|s| s.template.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "6x9".to_string()),
        ),
        mostrar_titulo_capitulo: Some(saga.and_then(|s| s.mostrar_titulo_capitulo).unwrap_or(true)),
        prefijo_capitulo: Some(
            saga.and_then(|s| s.prefijo_capitulo.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "none".to_string()),
        ),
        dropcap: Some(saga.and_then(|s| s.dropcap).unwrap_or(false)),
        mostrar_numero_parte: Some(saga.and_then(|s| s.mostrar_numero_parte).unwrap_or(false)),
        formato_parte: Some(
            saga.and_then(|s| s.formato_parte.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "raw".to_string()),
        ),
        imprenta: Some(
            saga.and_then(|s| s.imprenta.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Independiente".to_string()),
        ),
        ..Default::default()
    }
}

fn current_year() -> u32 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if m <= 2 { y + 1 } else { y };
    year as u32
}

fn next_chapter_num(parent: &std::path::Path) -> Result<u32, String> {
    let mut max = 0u32;
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "html" && ext != "odt" && ext != "docx" {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            if let Ok(n) = stem.parse::<u32>() {
                if n > max {
                    max = n;
                }
            }
        }
    }
    Ok(max + 1)
}

fn next_dir_num(parent: &std::path::Path) -> Result<u32, String> {
    let mut max = 0u32;
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let trimmed = name.trim_start();
        let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            if n > max {
                max = n;
            }
        }
    }
    Ok(max + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_part(dir: &Path, n: u32, body: &str) {
        fs::write(dir.join(format!("{}.html", n)), body).unwrap();
        fs::write(
            dir.join(format!("{}.meta.json", n)),
            format!(
                r#"{{"orden":{},"titulo":"{}","status":"draft","idioma":"es"}}"#,
                n, n
            ),
        )
        .unwrap();
    }

    fn read_orden(dir: &Path, n: u32) -> Option<u64> {
        let raw = fs::read_to_string(dir.join(format!("{}.meta.json", n))).ok()?;
        let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
        v.get("orden").and_then(|x| x.as_u64())
    }

    #[test]
    fn insert_part_after_shifts_subsequent() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        write_part(dir, 1, "<p>uno</p>");
        write_part(dir, 2, "<p>dos</p>");
        write_part(dir, 3, "<p>tres</p>");

        let part2 = dir.join("2.html");
        let res = insert_part_after_impl(part2.to_str().unwrap()).unwrap();
        assert!(res.path.ends_with("3.html"));

        assert_eq!(fs::read_to_string(dir.join("1.html")).unwrap(), "<p>uno</p>");
        assert_eq!(fs::read_to_string(dir.join("2.html")).unwrap(), "<p>dos</p>");
        assert_eq!(
            fs::read_to_string(dir.join("3.html")).unwrap().trim(),
            "<p></p>"
        );
        assert_eq!(
            fs::read_to_string(dir.join("4.html")).unwrap(),
            "<p>tres</p>"
        );

        assert_eq!(read_orden(dir, 4), Some(4));
        assert_eq!(read_orden(dir, 3), Some(3));
        assert_eq!(read_orden(dir, 2), Some(2));
    }

    #[test]
    fn insert_part_after_last_no_shift() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        write_part(dir, 1, "<p>uno</p>");
        write_part(dir, 2, "<p>dos</p>");

        let part2 = dir.join("2.html");
        let res = insert_part_after_impl(part2.to_str().unwrap()).unwrap();
        assert!(res.path.ends_with("3.html"));

        assert_eq!(fs::read_to_string(dir.join("1.html")).unwrap(), "<p>uno</p>");
        assert_eq!(fs::read_to_string(dir.join("2.html")).unwrap(), "<p>dos</p>");
        assert_eq!(
            fs::read_to_string(dir.join("3.html")).unwrap().trim(),
            "<p></p>"
        );
        assert_eq!(read_orden(dir, 3), Some(3));
    }

    #[test]
    fn insert_part_after_non_numeric_fails() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let weird = dir.join("intro.html");
        fs::write(&weird, "<p>x</p>").unwrap();

        let res = insert_part_after_impl(weird.to_str().unwrap());
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("no es parte numerada"));
    }
}
