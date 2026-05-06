use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
pub struct MoveResult {
    pub from: String,
    pub to: String,
}

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
}

/// Sube o baja un capítulo (archivo numerado) o un dir (`N - Name`).
/// Hace swap del prefijo numérico con el sibling adyacente.
#[tauri::command]
pub async fn move_node(path: String, direction: Direction) -> Result<MoveResult, String> {
    tauri::async_runtime::spawn_blocking(move || move_impl(&path, direction))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn move_impl(path: &str, direction: Direction) -> Result<MoveResult, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!("no existe: {}", path));
    }
    let parent = p.parent().ok_or_else(|| "sin padre".to_string())?;

    if p.is_file() {
        return move_file(&p, parent, direction);
    }
    if p.is_dir() {
        return move_dir(&p, parent, direction);
    }
    Err("no es archivo ni directorio".to_string())
}

// ─────────── Files (capítulos) ───────────

fn move_file(file: &Path, parent: &Path, direction: Direction) -> Result<MoveResult, String> {
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "html" && ext != "odt" && ext != "docx" {
        return Err(format!("solo capítulos (.html/.odt/.docx) — esto es .{}", ext));
    }
    let stem = file
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "sin stem".to_string())?;
    let cur_num: u32 = stem
        .parse()
        .map_err(|_| format!("nombre no numérico: {}", stem))?;

    // Listar siblings con el mismo tipo (numéricos, capítulos)
    let mut siblings: Vec<u32> = Vec::new();
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let ex = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if ex != "html" && ex != "odt" && ex != "docx" {
            continue;
        }
        if let Some(s) = p.file_stem().and_then(|s| s.to_str()) {
            if let Ok(n) = s.parse::<u32>() {
                siblings.push(n);
            }
        }
    }
    siblings.sort_unstable();

    let cur_idx = siblings
        .iter()
        .position(|&n| n == cur_num)
        .ok_or_else(|| "no está en lista".to_string())?;

    let target_idx = match direction {
        Direction::Up => {
            if cur_idx == 0 {
                return Err("ya está al principio".to_string());
            }
            cur_idx - 1
        }
        Direction::Down => {
            if cur_idx + 1 >= siblings.len() {
                return Err("ya está al final".to_string());
            }
            cur_idx + 1
        }
    };
    let other_num = siblings[target_idx];

    swap_chapter_pair(parent, cur_num, other_num)?;

    // El "nuevo" path del archivo movido tiene el número del otro
    let new_file = parent.join(format!("{}.{}", other_num, ext));
    Ok(MoveResult {
        from: file.to_string_lossy().into_owned(),
        to: new_file.to_string_lossy().into_owned(),
    })
}

/// Intercambia los archivos numerados `a` y `b` en `parent`.
/// Renombra todas las extensiones que correspondan + sus .meta.json siblings.
fn swap_chapter_pair(parent: &Path, a: u32, b: u32) -> Result<(), String> {
    if a == b {
        return Ok(());
    }
    // Para evitar choques, listamos primero los archivos que tienen stem `a` o `b`.
    let mut a_files: Vec<PathBuf> = Vec::new();
    let mut b_files: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let stem_num = stem.parse::<u32>().ok();
        match stem_num {
            Some(n) if n == a => a_files.push(p),
            Some(n) if n == b => b_files.push(p),
            _ => {
                // .meta.json: stem viene como "5.meta", no numérico. Chequear con composite.
                if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                    if name == format!("{}.meta.json", a) {
                        a_files.push(p);
                    } else if name == format!("{}.meta.json", b) {
                        b_files.push(p);
                    }
                }
            }
        }
    }

    // Mover a → tmp, b → a, tmp → b
    let temp_dir = parent.join(format!("__swap_{}_{}", a, b));
    fs::create_dir(&temp_dir).map_err(|e| e.to_string())?;
    let cleanup = || {
        let _ = fs::remove_dir_all(&temp_dir);
    };

    // Copiar a-files a temp con nombres de b
    for f in &a_files {
        let new_name = swap_name_in_file(f, a, b);
        let dest = temp_dir.join(&new_name);
        if let Err(e) = fs::rename(f, &dest) {
            cleanup();
            return Err(format!("rename {} → tmp: {}", f.display(), e));
        }
    }
    // Mover b-files a sus nuevos nombres (con número a) en parent
    for f in &b_files {
        let new_name = swap_name_in_file(f, b, a);
        let dest = parent.join(&new_name);
        if let Err(e) = fs::rename(f, &dest) {
            cleanup();
            return Err(format!("rename {} → final: {}", f.display(), e));
        }
    }
    // Mover temp a parent
    for entry in fs::read_dir(&temp_dir).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let from = e.path();
        let dest = parent.join(e.file_name());
        if let Err(err) = fs::rename(&from, &dest) {
            cleanup();
            return Err(format!("temp → final: {}", err));
        }
    }
    cleanup();
    Ok(())
}

fn swap_name_in_file(file: &Path, from: u32, to: u32) -> String {
    let name = file
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let from_str = format!("{}", from);
    let to_str = format!("{}", to);
    // Reemplazo del prefijo: "5.html" -> "6.html", "5.meta.json" -> "6.meta.json"
    if let Some(stripped) = name.strip_prefix(&from_str) {
        format!("{}{}", to_str, stripped)
    } else {
        name
    }
}

// ─────────── Directorios (`N - Name`) ───────────

fn move_dir(dir: &Path, parent: &Path, direction: Direction) -> Result<MoveResult, String> {
    let name = dir
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "sin nombre".to_string())?;
    let (cur_num, suffix) = parse_numbered_dir(name)
        .ok_or_else(|| format!("dir no numerado: {}", name))?;

    let mut siblings: Vec<(u32, String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let n = e.file_name().to_string_lossy().into_owned();
        if let Some((num, suf)) = parse_numbered_dir(&n) {
            siblings.push((num, suf, p));
        }
    }
    siblings.sort_by_key(|s| s.0);

    let cur_idx = siblings
        .iter()
        .position(|s| s.0 == cur_num)
        .ok_or_else(|| "no está en lista".to_string())?;

    let target_idx = match direction {
        Direction::Up => {
            if cur_idx == 0 {
                return Err("ya está al principio".to_string());
            }
            cur_idx - 1
        }
        Direction::Down => {
            if cur_idx + 1 >= siblings.len() {
                return Err("ya está al final".to_string());
            }
            cur_idx + 1
        }
    };

    let cur = &siblings[cur_idx];
    let other = &siblings[target_idx];

    let temp = parent.join(format!("__swap_dir_{}", cur.0));
    fs::rename(&cur.2, &temp).map_err(|e| format!("rename → tmp: {}", e))?;
    let new_other = parent.join(format!("{} - {}", cur.0, other.1));
    fs::rename(&other.2, &new_other).map_err(|e| format!("rename other: {}", e))?;
    let new_cur = parent.join(format!("{} - {}", other.0, suffix));
    fs::rename(&temp, &new_cur).map_err(|e| format!("rename tmp → final: {}", e))?;

    Ok(MoveResult {
        from: dir.to_string_lossy().into_owned(),
        to: new_cur.to_string_lossy().into_owned(),
    })
}

fn parse_numbered_dir(name: &str) -> Option<(u32, String)> {
    let trimmed = name.trim_start();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let num: u32 = digits.parse().ok()?;
    let rest = &trimmed[digits.len()..];
    // Esperamos " - "
    let suffix = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '-');
    Some((num, suffix.to_string()))
}
