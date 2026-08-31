use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::search;

#[derive(Serialize, Debug)]
pub struct CreateNoteResult {
    pub path: String,
}

const NOTE_EXTS: &[&str] = &["md", "markdown"];

fn is_note_path(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_lowercase();
    NOTE_EXTS.contains(&ext.as_str())
}

#[tauri::command]
pub fn read_note(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("no es archivo: {}", path));
    }
    if !is_note_path(&p) {
        return Err(format!("no es markdown: {}", path));
    }
    fs::read_to_string(&p).map_err(|e| {
        tracing::error!(target: "note", path = %path, error = %e, "read_note falló");
        e.to_string()
    })
}

#[tauri::command]
pub fn write_note(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !is_note_path(&p) {
        return Err(format!("no es markdown: {}", path));
    }
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            tracing::error!(target: "note", path = %path, "write_note: carpeta padre no existe");
            return Err(format!("carpeta padre no existe: {}", parent.display()));
        }
    }
    let mut content = content;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    let bytes = content.len();
    fs::write(&p, content).map_err(|e| {
        tracing::error!(target: "note", path = %path, error = %e, "write_note falló");
        e.to_string()
    })?;
    tracing::info!(target: "note", path = %path, bytes, "nota guardada");
    search::index_path_best_effort(&path, "note");
    Ok(())
}

/// Crea `<parent_dir>/<name>.md`. Si `body` viene (plantilla renderizada en
/// el front), se escribe tal cual; si no, un `# <name>` inicial. Si
/// `parent_dir` es una carpeta `notas/` que no existe todavía, la crea.
#[tauri::command]
pub fn create_note(
    parent_dir: String,
    name: String,
    body: Option<String>,
) -> Result<CreateNoteResult, String> {
    let parent = PathBuf::from(&parent_dir);
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("nombre vacío".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("nombre no puede contener separadores de path".to_string());
    }
    if !parent.exists() {
        fs::create_dir_all(&parent).map_err(|e| {
            tracing::error!(target: "note", path = %parent_dir, error = %e, "create_note: no pude crear carpeta padre");
            e.to_string()
        })?;
    } else if !parent.is_dir() {
        return Err(format!("no es directorio: {}", parent.display()));
    }
    let stem_input = PathBuf::from(trimmed);
    let has_md_ext = stem_input
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false);
    let filename = if has_md_ext {
        trimmed.to_string()
    } else {
        format!("{}.md", trimmed)
    };
    let target = parent.join(&filename);
    if target.exists() {
        return Err(format!("ya existe: {}", target.display()));
    }
    let title = PathBuf::from(&filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(trimmed)
        .to_string();
    let mut body = body.unwrap_or_else(|| format!("# {}\n\n", title));
    if !body.ends_with('\n') {
        body.push('\n');
    }
    fs::write(&target, body).map_err(|e| {
        tracing::error!(target: "note", path = %target.display(), error = %e, "create_note: write falló");
        e.to_string()
    })?;
    tracing::info!(target: "note", path = %target.display(), "nota creada");
    let result_path = target.to_string_lossy().into_owned();
    search::index_path_best_effort(&result_path, "note");
    Ok(CreateNoteResult { path: result_path })
}

#[tauri::command]
pub fn delete_note(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("no es archivo: {}", path));
    }
    if !is_note_path(&p) {
        return Err(format!("no es markdown: {}", path));
    }
    fs::remove_file(&p).map_err(|e| {
        tracing::error!(target: "note", path = %path, error = %e, "delete_note falló");
        e.to_string()
    })?;
    tracing::info!(target: "note", path = %path, "nota borrada");
    search::remove_path_best_effort(&path);
    Ok(())
}

/// Crea una carpeta vacía `<parent_dir>/<name>/`. Si `parent_dir` no existe, lo crea
/// recursivo. Usado desde el tree para crear carpetas libres en root o anidadas.
#[tauri::command]
pub fn create_folder(parent_dir: String, name: String) -> Result<String, String> {
    let parent = PathBuf::from(&parent_dir);
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("nombre vacío".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("nombre no puede contener separadores de path".to_string());
    }
    if !parent.exists() {
        fs::create_dir_all(&parent).map_err(|e| {
            tracing::error!(target: "note", path = %parent_dir, error = %e, "create_folder: no pude crear carpeta padre");
            e.to_string()
        })?;
    } else if !parent.is_dir() {
        return Err(format!("no es directorio: {}", parent.display()));
    }
    let target = parent.join(trimmed);
    if target.exists() {
        return Err(format!("ya existe: {}", target.display()));
    }
    fs::create_dir(&target).map_err(|e| {
        tracing::error!(target: "note", path = %target.display(), error = %e, "create_folder falló");
        e.to_string()
    })?;
    tracing::info!(target: "note", path = %target.display(), "carpeta creada");
    Ok(target.to_string_lossy().into_owned())
}

/// Carpeta de plantillas del autor. Está en `SKIP_DIRS` de `fs.rs`, así que no
/// aparece en el árbol; sí se commitea con el resto del repo de novelas.
const TEMPLATES_DIR_NAME: &str = "Plantillas";

#[derive(Serialize, Debug)]
pub struct NoteTemplateFile {
    pub nombre: String,
    pub path: String,
    pub markdown: String,
}

fn templates_dir(root: &str) -> PathBuf {
    PathBuf::from(root).join(TEMPLATES_DIR_NAME)
}

#[tauri::command]
pub fn list_note_templates(root: String) -> Result<Vec<NoteTemplateFile>, String> {
    let dir = templates_dir(&root);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<NoteTemplateFile> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || !is_note_path(&path) {
            continue;
        }
        let Some(nombre) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if nombre.is_empty() {
            continue;
        }
        let markdown = fs::read_to_string(&path).map_err(|e| {
            tracing::error!(target: "note", path = %path.display(), error = %e, "list_note_templates: read falló");
            e.to_string()
        })?;
        out.push(NoteTemplateFile {
            nombre: nombre.to_string(),
            path: path.to_string_lossy().into_owned(),
            markdown,
        });
    }
    out.sort_by(|a, b| a.nombre.to_lowercase().cmp(&b.nombre.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn save_note_template(
    root: String,
    nombre: String,
    markdown: String,
    overwrite: bool,
) -> Result<String, String> {
    let trimmed = nombre.trim();
    if trimmed.is_empty() {
        return Err("nombre vacío".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("nombre no puede contener separadores de path".to_string());
    }
    // No se pasa por `write_note`: exige que la carpeta padre exista, y la
    // primera plantilla es justamente la que la crea.
    let dir = templates_dir(&root);
    fs::create_dir_all(&dir).map_err(|e| {
        tracing::error!(target: "note", path = %dir.display(), error = %e, "save_note_template: no pude crear la carpeta");
        e.to_string()
    })?;
    let target = dir.join(format!("{}.md", trimmed));
    if target.exists() && !overwrite {
        return Err(format!("ya existe: {}", target.display()));
    }
    let mut markdown = markdown;
    if !markdown.ends_with('\n') {
        markdown.push('\n');
    }
    fs::write(&target, markdown).map_err(|e| {
        tracing::error!(target: "note", path = %target.display(), error = %e, "save_note_template: write falló");
        e.to_string()
    })?;
    tracing::info!(target: "note", path = %target.display(), "plantilla guardada");
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_dir(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("twriter-notes-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn round_trip_write_read() {
        let dir = tmp_dir("rt");
        let file = dir.join("hola.md");
        write_note(file.to_string_lossy().into_owned(), "# Hola\n\nNota\n".into()).unwrap();
        let back = read_note(file.to_string_lossy().into_owned()).unwrap();
        assert!(back.starts_with("# Hola"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_note_makes_dir() {
        let dir = tmp_dir("create");
        let sub = dir.join("notas");
        let res = create_note(sub.to_string_lossy().into_owned(), "intro".into(), None).unwrap();
        assert!(PathBuf::from(&res.path).is_file());
        assert!(res.path.ends_with("intro.md"));
        let body = fs::read_to_string(&res.path).unwrap();
        assert!(body.contains("# intro"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_note_con_body_escribe_la_plantilla() {
        let dir = tmp_dir("create-body");
        let res = create_note(
            dir.to_string_lossy().into_owned(),
            "Aedan".into(),
            Some("## Raza\n- \n## Objetos\n- ".into()),
        )
        .unwrap();
        let body = fs::read_to_string(&res.path).unwrap();
        assert!(body.starts_with("## Raza"), "body: {body:?}");
        assert!(!body.contains("# Aedan"), "no debe prependear título: {body:?}");
        assert!(body.ends_with('\n'), "debe cerrar con newline: {body:?}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_non_markdown() {
        let dir = tmp_dir("reject");
        let file = dir.join("nope.txt");
        assert!(write_note(file.to_string_lossy().into_owned(), "x".into()).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_folder_makes_dir() {
        let dir = tmp_dir("create-folder");
        let res = create_folder(dir.to_string_lossy().into_owned(), "Worldbuilding".into()).unwrap();
        let created = PathBuf::from(&res);
        assert!(created.is_dir());
        assert!(res.ends_with("Worldbuilding"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_folder_rejects_separators() {
        let dir = tmp_dir("folder-sep");
        let res = create_folder(dir.to_string_lossy().into_owned(), "a/b".into());
        assert!(res.is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_folder_rejects_existing() {
        let dir = tmp_dir("folder-existing");
        create_folder(dir.to_string_lossy().into_owned(), "Worldbuilding".into()).unwrap();
        let res = create_folder(dir.to_string_lossy().into_owned(), "Worldbuilding".into());
        assert!(res.is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_note_templates_sin_carpeta_es_lista_vacia() {
        let dir = tmp_dir("tpl-vacio");
        let out = list_note_templates(dir.to_string_lossy().into_owned()).unwrap();
        assert!(out.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_note_templates_ordena_e_ignora_lo_que_no_es_md() {
        let dir = tmp_dir("tpl-list");
        let plantillas = dir.join("Plantillas");
        fs::create_dir_all(plantillas.join("subdir")).unwrap();
        fs::write(plantillas.join("Nave.md"), "## Tripulación\n-\n").unwrap();
        fs::write(plantillas.join("Arma.md"), "## Daño\n").unwrap();
        fs::write(plantillas.join("notas.txt"), "no soy plantilla").unwrap();
        let out = list_note_templates(dir.to_string_lossy().into_owned()).unwrap();
        let nombres: Vec<&str> = out.iter().map(|t| t.nombre.as_str()).collect();
        assert_eq!(nombres, vec!["Arma", "Nave"]);
        assert!(out[1].markdown.contains("Tripulación"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_note_template_crea_la_carpeta_la_primera_vez() {
        let dir = tmp_dir("tpl-save");
        let path = save_note_template(
            dir.to_string_lossy().into_owned(),
            "Nave".into(),
            "## Tripulación\n-".into(),
            false,
        )
        .unwrap();
        assert!(PathBuf::from(&path).is_file());
        assert!(path.ends_with("Nave.md"));
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.ends_with('\n'), "siempre termina en newline: {:?}", body);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_note_template_no_pisa_sin_overwrite() {
        let dir = tmp_dir("tpl-overwrite");
        let root = dir.to_string_lossy().into_owned();
        save_note_template(root.clone(), "Nave".into(), "## Uno\n".into(), false).unwrap();
        let err = save_note_template(root.clone(), "Nave".into(), "## Dos\n".into(), false)
            .unwrap_err();
        assert!(err.contains("ya existe"), "{}", err);
        let path = save_note_template(root, "Nave".into(), "## Dos\n".into(), true).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("Dos"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_note_template_rechaza_nombres_con_separadores() {
        let dir = tmp_dir("tpl-nombre");
        let root = dir.to_string_lossy().into_owned();
        assert!(save_note_template(root.clone(), "  ".into(), "## x\n".into(), false).is_err());
        assert!(save_note_template(root.clone(), "a/b".into(), "## x\n".into(), false).is_err());
        assert!(save_note_template(root, "a\\b".into(), "## x\n".into(), false).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
