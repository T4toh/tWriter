//! Per-chapter volatile stats: `palabras` + `ultima_edicion`.
//!
//! Antes vivían en `<n>.meta.json` y mutaban en cada autosave → cada commit
//! incluía 2 archivos (html + meta.json) aunque el contenido editorial real
//! solo fuera el html. Se sacaron a `.twriter/stats.json` (gitignored) para
//! que `meta.json` solo cambie cuando renombrás/reordenás/cambiás status.
//!
//! El archivo es `{ "<rel/path>.html": { palabras, ultima_edicion } }`.
//! Keys son paths relativos al root, separador `/` siempre (cross-platform).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::import::count_words;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ChapterStat {
    #[serde(default)]
    pub palabras: u32,
    #[serde(default)]
    pub ultima_edicion: Option<String>,
}

pub type StatsMap = HashMap<String, ChapterStat>;

fn stats_path(root: &Path) -> PathBuf {
    root.join(".twriter").join("stats.json")
}

/// Convierte un path absoluto (capítulo) a la key relativa con separador `/`.
pub fn relative_key(root: &Path, chapter_path: &Path) -> Option<String> {
    let rel = chapter_path.strip_prefix(root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    Some(s)
}

/// Lee `.twriter/stats.json`. Si no existe devuelve mapa vacío (no es error).
pub fn read_stats(root: &Path) -> StatsMap {
    let p = stats_path(root);
    let Ok(raw) = fs::read_to_string(&p) else {
        return StatsMap::new();
    };
    serde_json::from_str::<StatsMap>(&raw).unwrap_or_default()
}

/// Sobrescribe `.twriter/stats.json` de forma atómica (tmp + rename).
pub fn write_stats(root: &Path, stats: &StatsMap) -> Result<(), String> {
    let p = stats_path(root);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir .twriter: {}", e))?;
    }
    let raw = serde_json::to_string_pretty(stats).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// True si `a` y `b` son el mismo path salvo por **un** segmento de carpeta.
/// Esa es exactamente la firma de un rename de carpeta. El nombre del archivo
/// tiene que coincidir: sin esa condición, `Libro/1.html` y `Libro/2.html`
/// —dos capítulos distintos— pasarían por "rename".
fn difiere_en_una_carpeta(a: &[&str], b: &[&str]) -> bool {
    if a.len() != b.len() || a.len() < 2 {
        return false;
    }
    if a[a.len() - 1] != b[b.len() - 1] {
        return false;
    }
    a.iter().zip(b).filter(|(x, y)| x != y).count() == 1
}

/// Un rename de carpeta hecho fuera de la app —a mano, por la otra PC, o por
/// el servicio de sync— deja claves de `stats.json` apuntando a paths que ya no
/// existen, y con eso se evaporan las palabras y la última edición de esos
/// capítulos. Acá se reconcilian.
///
/// Se remapea solo cuando hay **un** capítulo real que difiere en un segmento
/// de carpeta y que todavía no tiene stat propio. Con dos o más candidatos se
/// deja como está: adivinar mal mezcla el histórico de dos capítulos.
///
/// A propósito **no** se borran las claves que no matchean con nada. Un
/// checkout de otra rama hace desaparecer capítulos, y ahí borrarlas sería
/// tirar histórico real para ahorrar unos kilobytes.
///
/// No se apoya en git: el mismo bug pasa en roots de Dropbox, pCloud, iCloud o
/// locales, donde no hay repo del que leer los renames.
///
/// Devuelve cuántas claves se remapearon.
pub fn reconciliar_stats(root: &Path) -> usize {
    let stats = read_stats(root);
    if stats.is_empty() {
        return 0;
    }
    // Detectar huérfanas son N `is_file()`; el walk de abajo se paga solo si
    // efectivamente hay alguna, o sea casi nunca.
    let huerfanas: Vec<String> = stats
        .keys()
        .filter(|k| !root.join(k.as_str()).is_file())
        .cloned()
        .collect();
    if huerfanas.is_empty() {
        return 0;
    }

    let reales: Vec<String> = crate::search::collect_indexable(root)
        .into_iter()
        .filter(|(_, kind)| kind == "chapter")
        .filter_map(|(p, _)| relative_key(root, &p))
        .filter(|k| !stats.contains_key(k))
        .collect();

    // ponytail: O(huérfanas × capítulos sin stat). Con el corpus real son
    // 294 × 533 de comparaciones de Vec<&str> cortos y solo en el camino de
    // error; si alguna vez molesta, indexar `reales` por nombre de archivo.
    //
    // La correspondencia tiene que ser única en LOS DOS sentidos. Con "el
    // primero que llega se lo lleva" alcanzaba que dos huérfanas —`A/L/3.html`
    // y `B/L/3.html`— apuntaran al mismo `C/L/3.html`: una se lo quedaba y la
    // otra no, sin forma de saber cuál era el rename de verdad. Y como
    // `huerfanas` sale de las claves de un HashMap, ni siquiera era estable
    // entre corridas: la misma situación podía darle las palabras a una o a
    // otra. Antes que asignarle el histórico al capítulo equivocado, no se
    // toca ninguna de las dos.
    let mut candidata_de: Vec<(&str, &str)> = Vec::new();
    for vieja in &huerfanas {
        let segs_v: Vec<&str> = vieja.split('/').collect();
        let mut unica: Option<&str> = None;
        for real in &reales {
            let segs_r: Vec<&str> = real.split('/').collect();
            if !difiere_en_una_carpeta(&segs_v, &segs_r) {
                continue;
            }
            if unica.is_some() {
                unica = None;
                break;
            }
            unica = Some(real.as_str());
        }
        if let Some(nueva) = unica {
            candidata_de.push((vieja.as_str(), nueva));
        }
    }
    // Descartar los destinos reclamados por más de una huérfana.
    let mut reclamos: HashMap<&str, u32> = HashMap::new();
    for (_, nueva) in &candidata_de {
        *reclamos.entry(nueva).or_insert(0) += 1;
    }
    let movidas: Vec<(String, String)> = candidata_de
        .into_iter()
        .filter(|(_, nueva)| reclamos.get(nueva) == Some(&1))
        .map(|(vieja, nueva)| (vieja.to_string(), nueva.to_string()))
        .collect();

    if movidas.is_empty() {
        return 0;
    }
    let mut nuevas = stats;
    for (vieja, nueva) in &movidas {
        if let Some(stat) = nuevas.remove(vieja) {
            nuevas.insert(nueva.clone(), stat);
        }
    }
    if let Err(e) = write_stats(root, &nuevas) {
        tracing::warn!(target: "stats", error = %e, "no pude reescribir stats.json reconciliado");
        return 0;
    }
    tracing::info!(
        target: "stats",
        remapeadas = movidas.len(),
        huerfanas = huerfanas.len(),
        "stats.json reconciliado tras un rename de carpeta afuera de la app"
    );
    movidas.len()
}

/// Actualiza un stat puntual.
pub fn upsert_stat(
    root: &Path,
    chapter_path: &Path,
    palabras: u32,
    ultima_edicion: Option<String>,
) -> Result<(), String> {
    let key = relative_key(root, chapter_path)
        .ok_or_else(|| format!("chapter fuera del root: {}", chapter_path.display()))?;
    let mut stats = read_stats(root);
    stats.insert(
        key,
        ChapterStat {
            palabras,
            ultima_edicion,
        },
    );
    write_stats(root, &stats)
}

/// Comando del frontend para persistir stats en cada save de capítulo.
#[tauri::command]
pub fn write_chapter_stats(
    root: String,
    chapter_path: String,
    palabras: u32,
    ultima_edicion: Option<String>,
) -> Result<(), String> {
    let root_p = PathBuf::from(&root);
    let chap_p = PathBuf::from(&chapter_path);
    upsert_stat(&root_p, &chap_p, palabras, ultima_edicion)
}

/// Migración one-shot: scanea todos los `*.meta.json` del repo. Si traen
/// `palabras` o `ultima_edicion`, los mueve a `.twriter/stats.json` y los
/// strippea del meta.json. Genera UN commit ruidoso al primer arranque
/// post-deploy y deja el repo limpio.
///
/// Devuelve la cantidad de meta.json migrados.
pub fn migrate_meta_to_stats(root: &Path) -> Result<u32, String> {
    if !root.is_dir() {
        return Ok(0);
    }
    let mut stats = read_stats(root);
    let mut migrated: u32 = 0;
    walk_metas(root, &mut |meta_path| {
        if let Some((palabras_opt, ultima_opt, stripped)) = strip_volatile(meta_path) {
            // Si había datos volátiles, los guardamos en stats. Si el meta es
            // huérfano (sin html sibling) saltamos.
            let html_path = sibling_html(meta_path);
            if let Some(html) = html_path {
                if html.is_file() {
                    if let Some(key) = relative_key(root, &html) {
                        let entry = stats.entry(key).or_default();
                        if let Some(p) = palabras_opt {
                            entry.palabras = p;
                        }
                        if let Some(u) = ultima_opt {
                            entry.ultima_edicion = Some(u);
                        }
                    }
                }
            }
            if stripped {
                migrated += 1;
            }
        }
    });
    write_stats(root, &stats)?;
    Ok(migrated)
}

fn sibling_html(meta_path: &Path) -> Option<PathBuf> {
    let name = meta_path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".meta.json")?;
    let parent = meta_path.parent()?;
    Some(parent.join(format!("{}.html", stem)))
}

/// Lee meta.json, si trae palabras o ultima_edicion los extrae y reescribe
/// el archivo sin ellos. Retorna (palabras, ultima_edicion, hubo_cambios).
fn strip_volatile(meta_path: &Path) -> Option<(Option<u32>, Option<String>, bool)> {
    let raw = fs::read_to_string(meta_path).ok()?;
    let mut v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let obj = v.as_object_mut()?;
    let palabras = obj
        .remove("palabras")
        .and_then(|n| n.as_u64().map(|x| x as u32));
    let ultima = obj.remove("ultima_edicion").and_then(|n| match n {
        serde_json::Value::String(s) => Some(s),
        _ => None,
    });
    let changed = palabras.is_some() || ultima.is_some();
    if changed {
        if let Ok(out) = serde_json::to_string_pretty(&v) {
            let _ = fs::write(meta_path, out);
        }
    }
    Some((palabras, ultima, changed))
}

/// Walk recursivo del root buscando archivos `*.meta.json`. Salta `.twriter/`,
/// `.git/`, `node_modules`, etc.
fn walk_metas(dir: &Path, cb: &mut dyn FnMut(&Path)) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            walk_metas(&p, cb);
        } else if p.is_file() && name.ends_with(".meta.json") {
            cb(&p);
        }
    }
}

/// Devuelve las palabras de un capítulo: stats si están, sino computa
/// del HTML lazy. Útil para `get_tree`.
pub fn palabras_for_chapter(stats: &StatsMap, root: &Path, chapter_path: &Path) -> Option<u32> {
    let key = relative_key(root, chapter_path)?;
    if let Some(s) = stats.get(&key) {
        if s.palabras > 0 {
            return Some(s.palabras);
        }
    }
    // Fallback: leer HTML y computar.
    let raw = fs::read_to_string(chapter_path).ok()?;
    Some(count_words(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Arma un root con los capítulos dados y un `stats.json` con las claves
    /// dadas, para no repetir el andamiaje en cada test de reconciliación.
    fn root_con(capitulos: &[&str], claves: &[&str]) -> TempDir {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        for cap in capitulos {
            let p = root.join(cap);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "<p>texto</p>\n").unwrap();
            // saga.json/book.json no hacen falta: el walk junta los .html igual.
        }
        let mut mapa = StatsMap::new();
        for (i, k) in claves.iter().enumerate() {
            mapa.insert(
                (*k).to_string(),
                ChapterStat {
                    palabras: 100 + i as u32,
                    ultima_edicion: Some("2026-08-20T00:00:00Z".into()),
                },
            );
        }
        write_stats(root, &mapa).unwrap();
        tmp
    }

    #[test]
    fn reconciliar_remapea_el_rename_de_una_saga() {
        // El caso real del autor: `Milky Way` pasó a `3 - Milky Way` a mano.
        let tmp = root_con(
            &["3 - Milky Way/1 - Deployment/3.html"],
            &["Milky Way/1 - Deployment/3.html"],
        );
        assert_eq!(reconciliar_stats(tmp.path()), 1);
        let stats = read_stats(tmp.path());
        assert!(!stats.contains_key("Milky Way/1 - Deployment/3.html"));
        assert_eq!(
            stats.get("3 - Milky Way/1 - Deployment/3.html").unwrap().palabras,
            100,
            "el histórico tiene que viajar a la clave nueva, no reiniciarse"
        );
    }

    #[test]
    fn reconciliar_remapea_el_rename_del_padre_inmediato() {
        // El segmento que cambia es el padre del archivo, no el primero.
        let tmp = root_con(&["Saga/1 - Libro/3.html"], &["Saga/Libro/3.html"]);
        assert_eq!(reconciliar_stats(tmp.path()), 1);
        assert!(read_stats(tmp.path()).contains_key("Saga/1 - Libro/3.html"));
    }

    #[test]
    fn reconciliar_no_adivina_cuando_hay_dos_candidatos() {
        // `A/L/3.html` difiere en un segmento tanto de `X/L/3.html` como de
        // `Y/L/3.html`. Elegir uno mezclaría el histórico de dos capítulos.
        let tmp = root_con(&["X/L/3.html", "Y/L/3.html"], &["A/L/3.html"]);
        assert_eq!(reconciliar_stats(tmp.path()), 0);
        assert!(read_stats(tmp.path()).contains_key("A/L/3.html"));
    }

    #[test]
    fn reconciliar_no_confunde_dos_capitulos_del_mismo_libro() {
        // `1.html` y `2.html` difieren en un segmento, pero es el nombre del
        // archivo: son capítulos distintos, no un rename de carpeta.
        let tmp = root_con(&["Saga/Libro/2.html"], &["Saga/Libro/1.html"]);
        assert_eq!(reconciliar_stats(tmp.path()), 0);
    }

    #[test]
    fn reconciliar_conserva_la_huerfana_que_no_matchea_con_nada() {
        // Pasa al cambiar de rama: el capítulo no está en el working tree.
        // Borrar la clave sería tirar histórico real para ahorrar kilobytes.
        let tmp = root_con(&["Saga/Libro/1.html"], &["Otra Saga/Otro/9.html"]);
        assert_eq!(reconciliar_stats(tmp.path()), 0);
        assert!(read_stats(tmp.path()).contains_key("Otra Saga/Otro/9.html"));
    }

    #[test]
    fn reconciliar_no_adivina_cuando_dos_huerfanas_se_pelean_el_mismo_destino() {
        // `A/L/3.html` y `B/L/3.html` cumplen las dos la firma de rename contra
        // el único `C/L/3.html`. Quedarse con la primera es elegir por orden de
        // iteración de un HashMap, o sea al azar: le daría el histórico al
        // capítulo equivocado la mitad de las veces.
        let tmp = root_con(&["C/L/3.html"], &["A/L/3.html", "B/L/3.html"]);
        assert_eq!(reconciliar_stats(tmp.path()), 0);
        let stats = read_stats(tmp.path());
        assert!(stats.contains_key("A/L/3.html"));
        assert!(stats.contains_key("B/L/3.html"));
        assert!(!stats.contains_key("C/L/3.html"));
    }

    #[test]
    fn reconciliar_no_toca_nada_cuando_esta_todo_sano() {
        let tmp = root_con(&["Saga/Libro/1.html"], &["Saga/Libro/1.html"]);
        assert_eq!(reconciliar_stats(tmp.path()), 0);
        assert_eq!(read_stats(tmp.path()).len(), 1);
    }

    #[test]
    fn reconciliar_no_pisa_un_capitulo_que_ya_tiene_stat() {
        // `Saga/Libro/2.html` ya tiene su propia entrada, así que no puede ser
        // el destino del rename de `Saga/Viejo/2.html`.
        let tmp = root_con(
            &["Saga/Libro/2.html"],
            &["Saga/Libro/2.html", "Saga/Viejo/2.html"],
        );
        assert_eq!(reconciliar_stats(tmp.path()), 0);
        let stats = read_stats(tmp.path());
        assert_eq!(stats.get("Saga/Libro/2.html").unwrap().palabras, 100);
    }

    #[test]
    fn migrate_moves_palabras_out_of_meta() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let book = root.join("Saga/Libro");
        fs::create_dir_all(&book).unwrap();
        fs::write(book.join("1.html"), "<p>Hola mundo</p>\n").unwrap();
        let meta_path = book.join("1.meta.json");
        fs::write(
            &meta_path,
            r#"{"orden":1,"titulo":"Cap","palabras":2,"ultima_edicion":"2024-01-01","status":"draft","idioma":"es"}"#,
        )
        .unwrap();

        let n = migrate_meta_to_stats(root).unwrap();
        assert_eq!(n, 1);

        // El meta.json ya no tiene los campos volátiles.
        let raw = fs::read_to_string(&meta_path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(v.get("palabras").is_none(), "palabras debe haberse stripped");
        assert!(
            v.get("ultima_edicion").is_none(),
            "ultima_edicion debe haberse stripped"
        );
        assert_eq!(v.get("titulo").and_then(|x| x.as_str()), Some("Cap"));

        // stats.json contiene los valores.
        let stats = read_stats(root);
        let entry = stats.get("Saga/Libro/1.html").expect("entry missing");
        assert_eq!(entry.palabras, 2);
        assert_eq!(entry.ultima_edicion.as_deref(), Some("2024-01-01"));
    }

    #[test]
    fn upsert_stat_persists_and_overwrites() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let book = root.join("Saga/Libro");
        fs::create_dir_all(&book).unwrap();
        let chap = book.join("1.html");
        fs::write(&chap, "<p>texto</p>").unwrap();

        upsert_stat(root, &chap, 10, Some("t1".into())).unwrap();
        upsert_stat(root, &chap, 20, Some("t2".into())).unwrap();

        let stats = read_stats(root);
        let e = stats.get("Saga/Libro/1.html").unwrap();
        assert_eq!(e.palabras, 20);
        assert_eq!(e.ultima_edicion.as_deref(), Some("t2"));
    }

    #[test]
    fn palabras_for_chapter_falls_back_to_html() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let chap = root.join("1.html");
        fs::write(&chap, "<p>uno dos tres</p>").unwrap();
        let stats = StatsMap::new();
        let n = palabras_for_chapter(&stats, root, &chap).unwrap();
        assert_eq!(n, 3);
    }
}
