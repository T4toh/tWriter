use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::fs::{
    chapter_exts, classify_top_level_pub, compare_names, leading_number, note_exts,
    notes_dir_name, NodeKind,
};
use crate::search;

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

    let result = if p.is_file() {
        move_file(&p, parent, direction)
    } else if p.is_dir() {
        move_dir(&p, parent, direction)
    } else {
        return Err("no es archivo ni directorio".to_string());
    };

    match &result {
        Ok(mv) => tracing::info!(target: "reorder", from = %mv.from, to = %mv.to, dir = ?direction, "movido"),
        Err(e) => tracing::error!(target: "reorder", path = %path, dir = ?direction, error = %e, "move falló"),
    }
    result
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

// ═════════════════════════════════════════════════════════════════
//   relocate_node: DnD reorder + cross-parent moves
// ═════════════════════════════════════════════════════════════════

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RelocateArgs {
    pub src_path: String,
    pub dest_parent_path: String,
    /// 0-based slot entre los siblings reordenables del destino.
    pub dest_index: usize,
    /// Root del repo de novelas (para distinguir el contenedor raíz).
    pub root: String,
}

#[derive(Serialize, Debug)]
pub struct RelocateResult {
    pub from: String,
    pub to: String,
    /// (old_path, new_path). Incluye el propio nodo y todos los siblings renumerados.
    pub renamed: Vec<(String, String)>,
}

/// Mueve un nodo a un padre (mismo o distinto) y lo inserta en `dest_index`
/// renumerando hermanos del origen y del destino para mantener `1..N` gap-free.
#[tauri::command]
pub async fn relocate_node(args: RelocateArgs) -> Result<RelocateResult, String> {
    tauri::async_runtime::spawn_blocking(move || relocate_impl(args))
        .await
        .map_err(|e| format!("task: {}", e))?
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DestKind {
    Root,
    Kind(NodeKind),
}

#[derive(Debug, Clone)]
struct SiblingEntry {
    /// Número actual del prefijo, si tiene.
    num: Option<u32>,
    /// Resto del nombre tras el prefijo `N - `. Para archivos incluye el ".ext".
    suffix: String,
    /// Path al archivo principal (para chapters: el .html/.odt/.docx).
    path: PathBuf,
    /// Path al .meta.json sibling, si es chapter.
    meta_path: Option<PathBuf>,
}

fn relocate_impl(args: RelocateArgs) -> Result<RelocateResult, String> {
    let src = PathBuf::from(&args.src_path);
    let dest_parent = PathBuf::from(&args.dest_parent_path);
    let root = PathBuf::from(&args.root);

    if !src.exists() {
        return Err(format!("origen no existe: {}", src.display()));
    }
    if !dest_parent.is_dir() {
        return Err(format!("destino no es directorio: {}", dest_parent.display()));
    }
    if !root.is_dir() {
        return Err(format!("root no es directorio: {}", root.display()));
    }

    let canon_src = src.canonicalize().map_err(|e| e.to_string())?;
    let canon_dest_parent = dest_parent.canonicalize().map_err(|e| e.to_string())?;
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;

    if canon_dest_parent == canon_src {
        return Err("no se puede mover un nodo a sí mismo".to_string());
    }
    if is_descendant_or_self(&canon_dest_parent, &canon_src) {
        return Err("destino es descendiente del origen".to_string());
    }

    let src_kind = detect_kind(&canon_src, &canon_root)?;
    let dest_kind = detect_dest_kind(&canon_dest_parent, &canon_root)?;

    validate_compat(src_kind, dest_kind)?;

    let src_parent = canon_src
        .parent()
        .ok_or_else(|| "origen sin parent".to_string())?
        .to_path_buf();
    let same_parent = src_parent == canon_dest_parent;

    let mut renamed: Vec<(String, String)> = Vec::new();

    // ─── 1. Ensure-numbered en src.parent y dest_parent (siblings del kind src).
    let mut src_siblings = list_siblings_of_kind(&src_parent, src_kind, &canon_root)?;
    let migrations_src = ensure_numbered(&src_parent, &mut src_siblings, src_kind)?;
    renamed.extend(migrations_src.iter().cloned());
    // Mover canon_src si fue renumerado por la migración.
    let canon_src = find_remapped(&canon_src, &renamed);

    if !same_parent {
        let mut dest_siblings = list_siblings_of_kind(&canon_dest_parent, src_kind, &canon_root)?;
        let migrations_dest = ensure_numbered(&canon_dest_parent, &mut dest_siblings, src_kind)?;
        renamed.extend(migrations_dest.iter().cloned());
    }

    // ─── 2. Re-listar siblings post-migración para tener números válidos.
    let mut src_siblings = list_siblings_of_kind(&src_parent, src_kind, &canon_root)?;
    let dest_siblings = if same_parent {
        src_siblings.clone()
    } else {
        list_siblings_of_kind(&canon_dest_parent, src_kind, &canon_root)?
    };

    // Encontrar índice del src dentro de su lista.
    let src_idx = src_siblings
        .iter()
        .position(|s| paths_equal(&s.path, &canon_src))
        .ok_or_else(|| format!("origen no aparece en siblings de {}", src_parent.display()))?;

    // ─── 3. Mover.
    let dest_index = args.dest_index.min(dest_siblings.len());

    if same_parent {
        if src_idx == dest_index {
            return Ok(RelocateResult {
                from: src.to_string_lossy().into_owned(),
                to: canon_src.to_string_lossy().into_owned(),
                renamed,
            });
        }
        let extra = reorder_same_parent(
            &canon_dest_parent,
            &mut src_siblings,
            src_idx,
            dest_index,
            src_kind,
        )?;
        renamed.extend(extra.iter().cloned());
        let final_path = find_remapped(&canon_src, &renamed);
        mirror_orden_in_siblings(&src_siblings);
        for (old, new) in &renamed {
            sync_search(old, new, src_kind);
        }
        return Ok(RelocateResult {
            from: src.to_string_lossy().into_owned(),
            to: final_path.to_string_lossy().into_owned(),
            renamed,
        });
    }

    // Cross-parent: sacar de src_siblings, insertar en dest_siblings @ dest_index.
    let mut working_src = src_siblings.clone();
    let moved = working_src.remove(src_idx);
    let mut working_dest = dest_siblings.clone();

    let extra = cross_parent_move(
        &canon_dest_parent,
        &canon_src,
        &moved,
        &mut working_dest,
        dest_index,
        src_kind,
    )?;
    renamed.extend(extra.iter().cloned());

    // Renumerar src restantes (gap-free).
    let extra_src = renumber_after_remove(&src_parent, &mut working_src, src_kind)?;
    renamed.extend(extra_src.iter().cloned());

    let final_path = find_remapped(&canon_src, &renamed);

    // Espejar `orden` y sync search en ambos lados.
    mirror_orden_in_siblings(&working_dest);
    mirror_orden_in_siblings(&working_src);
    for (old, new) in &renamed {
        sync_search(old, new, src_kind);
    }

    Ok(RelocateResult {
        from: src.to_string_lossy().into_owned(),
        to: final_path.to_string_lossy().into_owned(),
        renamed,
    })
}

// ─── Validación ──────────────────────────────────────────────────

fn validate_compat(src_kind: NodeKind, dest_kind: DestKind) -> Result<(), String> {
    use NodeKind as N;
    let ok = match (src_kind, dest_kind) {
        (N::Saga, DestKind::Root) => true,
        (N::Book, DestKind::Kind(N::Saga)) => true,
        (N::Section, DestKind::Kind(N::Book)) => true,
        (N::Chapter, DestKind::Kind(N::Book | N::Section)) => true,
        (N::Note, DestKind::Kind(N::Notes | N::Section | N::Book | N::Saga | N::Folder)) => true,
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "movimiento no permitido: {:?} → {:?}",
            src_kind, dest_kind
        ))
    }
}

fn is_descendant_or_self(maybe_descendant: &Path, ancestor: &Path) -> bool {
    maybe_descendant == ancestor || maybe_descendant.starts_with(ancestor)
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    // Comparación tolerante (canonicalize si existe).
    let ca = a.canonicalize().ok();
    let cb = b.canonicalize().ok();
    match (ca, cb) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

// ─── Detección de kind ───────────────────────────────────────────

fn detect_kind(path: &Path, root: &Path) -> Result<NodeKind, String> {
    if path == root {
        return Err("root no es un nodo relocable".to_string());
    }
    if path.is_file() {
        let fname = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if fname.ends_with(".meta.json") {
            return Err(".meta.json no es relocable directo".to_string());
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        if chapter_exts().contains(&ext.as_str()) {
            return Ok(NodeKind::Chapter);
        }
        if note_exts().contains(&ext.as_str()) {
            return Ok(NodeKind::Note);
        }
        return Err(format!("archivo no relocable: .{}", ext));
    }
    if !path.is_dir() {
        return Err("ni archivo ni directorio".to_string());
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if name == notes_dir_name() {
        return Ok(NodeKind::Notes);
    }
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "fuera de root".to_string())?;
    let comps: Vec<_> = rel.components().collect();
    if comps.is_empty() {
        return Err("root no relocable".to_string());
    }
    if comps.len() == 1 {
        return Ok(classify_top_level_pub(path));
    }
    // Descender desde root deduciendo kind por nivel.
    let mut cur = root.to_path_buf();
    cur.push(comps[0]);
    let mut cur_kind = classify_top_level_pub(&cur);
    for comp in &comps[1..] {
        cur.push(comp);
        let next_name = comp.as_os_str().to_string_lossy().into_owned();
        if next_name == notes_dir_name() {
            cur_kind = NodeKind::Notes;
            continue;
        }
        cur_kind = match cur_kind {
            NodeKind::Saga => NodeKind::Book,
            NodeKind::Book => NodeKind::Section,
            NodeKind::Notes => NodeKind::Notes,
            NodeKind::Folder => NodeKind::Folder,
            _ => NodeKind::Folder,
        };
    }
    Ok(cur_kind)
}

fn detect_dest_kind(path: &Path, root: &Path) -> Result<DestKind, String> {
    if path == root {
        return Ok(DestKind::Root);
    }
    let k = detect_kind(path, root)?;
    Ok(DestKind::Kind(k))
}

// ─── Listado de siblings reordenables ────────────────────────────

fn list_siblings_of_kind(
    parent: &Path,
    kind: NodeKind,
    root: &Path,
) -> Result<Vec<SiblingEntry>, String> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(parent)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    entries.sort_by(|a, b| {
        compare_names(
            &a.file_name().to_string_lossy(),
            &b.file_name().to_string_lossy(),
        )
    });

    let mut out: Vec<SiblingEntry> = Vec::new();
    let mut seen_chapter_nums: Vec<u32> = Vec::new();

    for e in entries {
        let p = e.path();
        let fname = e.file_name().to_string_lossy().into_owned();
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            // Filtrar skip dirs y notas excepto si buscamos notas.
            if fname.starts_with('.') {
                continue;
            }
            if fname == notes_dir_name() {
                continue;
            }
            let dir_kind = match detect_kind(&p, root) {
                Ok(k) => k,
                Err(_) => continue,
            };
            if dir_kind != kind {
                continue;
            }
            let (num, suffix) = match parse_numbered_dir(&fname) {
                Some((n, s)) => (Some(n), s),
                None => (None, fname.clone()),
            };
            out.push(SiblingEntry {
                num,
                suffix,
                path: p,
                meta_path: None,
            });
        } else if ft.is_file() {
            match kind {
                NodeKind::Chapter => {
                    if !is_chapter_file(&p) {
                        continue;
                    }
                    let stem = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let ext = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|s| s.to_string())
                        .unwrap_or_default();
                    let num = stem.parse::<u32>().ok();
                    let suffix = if num.is_some() {
                        format!(".{}", ext)
                    } else {
                        format!("{}.{}", stem, ext)
                    };
                    let meta = parent.join(format!("{}.meta.json", stem));
                    let meta_path = if meta.is_file() { Some(meta) } else { None };
                    if let Some(n) = num {
                        if seen_chapter_nums.contains(&n) {
                            // Duplicado raro — saltear (priorizamos primer hit).
                            continue;
                        }
                        seen_chapter_nums.push(n);
                    }
                    out.push(SiblingEntry {
                        num,
                        suffix,
                        path: p,
                        meta_path,
                    });
                }
                NodeKind::Note => {
                    let ext = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase())
                        .unwrap_or_default();
                    if !note_exts().contains(&ext.as_str()) {
                        continue;
                    }
                    let stem = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let (num, base_stem) = match leading_number(&stem) {
                        Some(n) => {
                            let trimmed = stem.trim_start_matches(|c: char| c.is_ascii_digit());
                            let trimmed = trimmed
                                .trim_start_matches(|c: char| c.is_whitespace() || c == '-');
                            (Some(n), trimmed.to_string())
                        }
                        None => (None, stem.clone()),
                    };
                    let suffix = if num.is_some() {
                        format!(" - {}.{}", base_stem, ext)
                    } else {
                        format!("{}.{}", base_stem, ext)
                    };
                    out.push(SiblingEntry {
                        num,
                        suffix,
                        path: p,
                        meta_path: None,
                    });
                }
                _ => continue,
            }
        }
    }
    Ok(out)
}

fn is_chapter_file(p: &Path) -> bool {
    let Some(ext) = p.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_lowercase();
    if !chapter_exts().contains(&ext.as_str()) {
        return false;
    }
    !p.file_name()
        .and_then(|s| s.to_str())
        .map(|n| n.ends_with(".meta.json"))
        .unwrap_or(false)
}

// ─── Migración: asignar prefijos numéricos `1..N` ────────────────

fn ensure_numbered(
    parent: &Path,
    siblings: &mut Vec<SiblingEntry>,
    kind: NodeKind,
) -> Result<Vec<(String, String)>, String> {
    let needs_migration = siblings.iter().any(|s| s.num.is_none());
    if !needs_migration {
        // Renumerar para que sea gap-free `1..N`.
        return renumber_to_sequential(parent, siblings, kind);
    }
    // Renumerar todos secuencialmente, manteniendo orden actual.
    renumber_to_sequential(parent, siblings, kind)
}

/// Renumera siblings para que tengan prefijos `1..N` en su orden actual.
/// Usa una carpeta temporal para evitar colisiones intermedias.
fn renumber_to_sequential(
    parent: &Path,
    siblings: &mut Vec<SiblingEntry>,
    kind: NodeKind,
) -> Result<Vec<(String, String)>, String> {
    let mut renamed: Vec<(String, String)> = Vec::new();
    let target_nums: Vec<u32> = (1..=siblings.len() as u32).collect();

    // ¿Hay algún cambio realmente?
    let no_change = siblings
        .iter()
        .zip(target_nums.iter())
        .all(|(s, n)| s.num == Some(*n));
    if no_change {
        return Ok(renamed);
    }

    let pid = std::process::id();
    let temp = parent.join(format!(".__reloc_tmp_{}", pid));
    if temp.exists() {
        let _ = fs::remove_dir_all(&temp);
    }
    fs::create_dir(&temp).map_err(|e| format!("crear temp: {}", e))?;

    let cleanup_temp = |t: &Path| {
        let _ = fs::remove_dir_all(t);
    };

    // Fase 1: mover todo a temp con nombres temporales.
    let mut tmp_paths: Vec<(usize, PathBuf, Option<PathBuf>)> = Vec::new();
    for (i, sib) in siblings.iter().enumerate() {
        let tmp_main = temp.join(format!("entry_{}", i));
        if let Err(e) = fs::rename(&sib.path, &tmp_main) {
            cleanup_temp(&temp);
            return Err(format!(
                "rename {} → tmp: {}",
                sib.path.display(),
                e
            ));
        }
        let tmp_meta = if let Some(mp) = &sib.meta_path {
            let tmp_meta_path = temp.join(format!("entry_{}.meta.json", i));
            if let Err(e) = fs::rename(mp, &tmp_meta_path) {
                cleanup_temp(&temp);
                return Err(format!("rename meta {} → tmp: {}", mp.display(), e));
            }
            Some(tmp_meta_path)
        } else {
            None
        };
        tmp_paths.push((i, tmp_main, tmp_meta));
    }

    // Fase 2: mover desde temp a nombres finales.
    for ((i, tmp_main, tmp_meta), sib) in tmp_paths.iter().zip(siblings.iter_mut()) {
        let new_num = target_nums[*i];
        let new_name = build_name(kind, new_num, &sib.suffix);
        let new_path = parent.join(&new_name);
        if let Err(e) = fs::rename(tmp_main, &new_path) {
            cleanup_temp(&temp);
            return Err(format!("rename tmp → final {}: {}", new_path.display(), e));
        }
        renamed.push((
            sib.path.to_string_lossy().into_owned(),
            new_path.to_string_lossy().into_owned(),
        ));
        let new_meta_path = if let Some(tmp_m) = tmp_meta {
            let new_meta = parent.join(format!("{}.meta.json", new_num));
            if let Err(e) = fs::rename(tmp_m, &new_meta) {
                cleanup_temp(&temp);
                return Err(format!("rename meta tmp → final: {}", e));
            }
            if let Some(old_m) = &sib.meta_path {
                renamed.push((
                    old_m.to_string_lossy().into_owned(),
                    new_meta.to_string_lossy().into_owned(),
                ));
            }
            Some(new_meta)
        } else {
            None
        };
        sib.num = Some(new_num);
        sib.path = new_path;
        sib.meta_path = new_meta_path;
    }

    cleanup_temp(&temp);
    Ok(renamed)
}

fn build_name(kind: NodeKind, num: u32, suffix: &str) -> String {
    match kind {
        NodeKind::Chapter => {
            // suffix es ".html" o ".odt" o ".docx" (o legado "name.ext" si era sin prefijo).
            if suffix.starts_with('.') {
                format!("{}{}", num, suffix)
            } else {
                format!("{}_{}", num, suffix)
            }
        }
        NodeKind::Note => {
            // suffix es " - base.ext" o "base.ext"
            if suffix.starts_with(' ') || suffix.starts_with(" - ") {
                format!("{}{}", num, suffix)
            } else {
                format!("{} - {}", num, suffix)
            }
        }
        // Dirs: saga/book/section. suffix sin prefijo.
        _ => format!("{} - {}", num, suffix),
    }
}

// ─── Reorder mismo padre ─────────────────────────────────────────

fn reorder_same_parent(
    parent: &Path,
    siblings: &mut Vec<SiblingEntry>,
    src_idx: usize,
    dest_idx: usize,
    kind: NodeKind,
) -> Result<Vec<(String, String)>, String> {
    // Mover el sibling en el slice y renumerar todo.
    let item = siblings.remove(src_idx);
    let insert_at = dest_idx.min(siblings.len());
    siblings.insert(insert_at, item);
    renumber_to_sequential(parent, siblings, kind)
}

// ─── Cross-parent: mover y renumerar dest ────────────────────────

fn cross_parent_move(
    dest_parent: &Path,
    src_path: &Path,
    moved: &SiblingEntry,
    dest_siblings: &mut Vec<SiblingEntry>,
    dest_idx: usize,
    kind: NodeKind,
) -> Result<Vec<(String, String)>, String> {
    let mut renamed: Vec<(String, String)> = Vec::new();
    let pid = std::process::id();
    let temp = dest_parent.join(format!(".__reloc_in_tmp_{}", pid));
    if temp.exists() {
        let _ = fs::remove_dir_all(&temp);
    }
    fs::create_dir(&temp).map_err(|e| format!("crear temp dest: {}", e))?;
    let cleanup = |t: &Path| {
        let _ = fs::remove_dir_all(t);
    };

    // Mover src → temp (rename con fallback EXDEV)
    let tmp_main = temp.join("incoming_main");
    if let Err(e) = move_with_exdev_fallback(src_path, &tmp_main) {
        cleanup(&temp);
        return Err(format!("mover origen → tmp dest: {}", e));
    }
    let mut tmp_meta_opt: Option<PathBuf> = None;
    if let Some(mp) = &moved.meta_path {
        if mp.exists() {
            let tmp_meta = temp.join("incoming_meta.meta.json");
            if let Err(e) = move_with_exdev_fallback(mp, &tmp_meta) {
                cleanup(&temp);
                return Err(format!("mover meta origen → tmp dest: {}", e));
            }
            tmp_meta_opt = Some(tmp_meta);
        }
    }

    // Insertar en dest_siblings (con metadata actualizada)
    let mut inserted = moved.clone();
    let insert_at = dest_idx.min(dest_siblings.len());
    inserted.path = tmp_main.clone();
    inserted.meta_path = tmp_meta_opt.clone();
    inserted.num = None; // se asigna en renumber
    dest_siblings.insert(insert_at, inserted);

    // Renumerar destino (mueve todo a sus nombres finales).
    let extra = renumber_to_sequential(dest_parent, dest_siblings, kind)?;
    // El primer rename de `tmp_main` reportará `tmp_main → final`. Reemplazamos por
    // (src_path, final) para que el frontend remap funcione.
    let inserted_old = src_path.to_string_lossy().into_owned();
    let tmp_main_str = tmp_main.to_string_lossy().into_owned();
    let tmp_meta_str = tmp_meta_opt.as_ref().map(|p| p.to_string_lossy().into_owned());
    let moved_old_meta = moved
        .meta_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    for (old, new) in extra {
        if old == tmp_main_str {
            renamed.push((inserted_old.clone(), new));
        } else if let (Some(tmp_m), Some(orig_m)) = (&tmp_meta_str, &moved_old_meta) {
            if &old == tmp_m {
                renamed.push((orig_m.clone(), new));
                continue;
            } else {
                renamed.push((old, new));
            }
        } else {
            renamed.push((old, new));
        }
    }

    cleanup(&temp);
    Ok(renamed)
}

fn move_with_exdev_fallback(src: &Path, dst: &Path) -> std::io::Result<()> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) => {
            // EXDEV: cross-device. Copiar y borrar.
            let xdev = e.raw_os_error().map(|code| code == 18).unwrap_or(false);
            if !xdev {
                return Err(e);
            }
            if src.is_dir() {
                copy_dir_recursive(src, dst)?;
                fs::remove_dir_all(src)?;
            } else {
                fs::copy(src, dst)?;
                fs::remove_file(src)?;
            }
            Ok(())
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let e = entry?;
        let from = e.path();
        let to = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

// ─── Renumerar src tras remover ──────────────────────────────────

fn renumber_after_remove(
    parent: &Path,
    siblings: &mut Vec<SiblingEntry>,
    kind: NodeKind,
) -> Result<Vec<(String, String)>, String> {
    renumber_to_sequential(parent, siblings, kind)
}

// ─── Helpers misc ────────────────────────────────────────────────

fn find_remapped(orig: &Path, renamed: &[(String, String)]) -> PathBuf {
    let s = orig.to_string_lossy().into_owned();
    for (old, new) in renamed.iter().rev() {
        if old == &s {
            return PathBuf::from(new);
        }
    }
    orig.to_path_buf()
}

fn mirror_orden_in_siblings(siblings: &[SiblingEntry]) {
    for sib in siblings {
        let Some(num) = sib.num else { continue };
        let Some(meta_path) = &sib.meta_path else {
            continue;
        };
        let _ = update_meta_orden(meta_path, num);
    }
}

fn update_meta_orden(meta_path: &Path, new_orden: u32) -> Result<(), String> {
    let raw = fs::read_to_string(meta_path).map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "orden".to_string(),
            serde_json::Value::Number(serde_json::Number::from(new_orden)),
        );
        let out = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
        fs::write(meta_path, out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn sync_search(old_path: &str, new_path: &str, kind: NodeKind) {
    search::remove_path_best_effort(old_path);
    let kind_hint = match kind {
        NodeKind::Chapter => Some("chapter"),
        NodeKind::Note => Some("note"),
        _ => None,
    };
    if let Some(k) = kind_hint {
        search::index_path_best_effort(new_path, k);
    }
}
