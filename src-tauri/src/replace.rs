//! Reemplazo en lote sobre los capítulos `.html` de un scope.
//!
//! El problema central: las ocurrencias se buscan en TEXTO PLANO (que es lo
//! que el autor ve) y se escriben en HTML, y los offsets de los dos no
//! coinciden — los tags no están en el plain, y las entidades cambian de
//! largo (`&amp;` son 5 bytes que valen 1 char).
//!
//! Solución: al leer el HTML se construye el plain junto a una lista de
//! **runs**, cada uno un tramo de plain que se corresponde byte a byte con el
//! HTML. Un tag, una entidad o un cierre de bloque cortan run. Y entonces:
//!
//!   una ocurrencia es reemplazable solo si cae entera dentro de UN run.
//!
//! Esa única regla rechaza los tres casos peligrosos (frase partida por una
//! cursiva, match que abarca una entidad, match que cruza dos párrafos) sin
//! código especial para cada uno, y garantiza que nunca se pise markup.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Por qué un tramo de plain no se corresponde con el HTML byte a byte.
/// Viaja al frontend para explicarle al autor qué ocurrencia se salteó.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MotivoSkip {
    CruzaTag,
    CruzaEntidad,
    CruzaBloque,
}

/// Tramo de plain que se corresponde byte a byte con el HTML.
/// `motivo_gap_previo` es qué cortó el hueco que precede a este run (el tag
/// de apertura del bloque, en el primero).
#[derive(Debug, Clone)]
pub struct Run {
    pub plain_start: usize,
    pub plain_end: usize,
    pub html_start: usize,
    pub motivo_gap_previo: Option<MotivoSkip>,
}

#[derive(Debug, Clone, Default)]
pub struct PlainMap {
    pub plain: String,
    pub runs: Vec<Run>,
}

#[derive(Debug, Clone, Copy)]
pub struct Opciones {
    pub case_sensitive: bool,
    pub whole_word: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ubicacion {
    Reemplazable { html_start: usize, html_end: usize },
    Cruza(MotivoSkip),
}

/// Las seis entidades que el editor puede producir. Mismo set que
/// `search.rs::html_to_text`, y por las mismas razones.
const ENTIDADES: &[(&str, char)] = &[
    ("&nbsp;", ' '),
    ("&amp;", '&'),
    ("&lt;", '<'),
    ("&gt;", '>'),
    ("&quot;", '"'),
    ("&#39;", '\''),
];

/// Tags de cierre de bloque: meten un `\n` en el plain para que dos párrafos
/// no queden pegados y una frase no matchee de punta a punta de dos bloques.
fn es_cierre_de_bloque(tag: &str) -> bool {
    let t = tag.trim_start_matches('<').trim_end_matches('>').trim();
    let t = t.trim_start_matches('/').trim();
    let nombre: String = t
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(nombre.as_str(), "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
        | "blockquote" | "li" | "br" | "hr" | "div")
}

/// Construye el plain y los runs a partir del HTML crudo.
pub fn plain_con_runs(html: &str) -> PlainMap {
    let bytes = html.as_bytes();
    let mut plain = String::with_capacity(html.len());
    let mut runs: Vec<Run> = Vec::new();
    // Run abierto: (plain_start, html_start). None si estamos "fuera" de texto.
    let mut abierto: Option<(usize, usize)> = None;
    let mut motivo_pendiente: Option<MotivoSkip> = None;
    let mut i = 0usize;

    // Cierra el run abierto, si hay, con el largo de plain acumulado.
    macro_rules! cerrar {
        () => {
            if let Some((ps, hs)) = abierto.take() {
                runs.push(Run {
                    plain_start: ps,
                    plain_end: plain.len(),
                    html_start: hs,
                    motivo_gap_previo: motivo_pendiente.take(),
                });
            }
        };
    }

    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Tag: buscar el '>' que lo cierra. Si no hay, es texto literal.
            if let Some(rel) = html[i..].find('>') {
                let tag = &html[i..i + rel + 1];
                cerrar!();
                if motivo_pendiente.is_none() {
                    motivo_pendiente = Some(if es_cierre_de_bloque(tag) {
                        MotivoSkip::CruzaBloque
                    } else {
                        MotivoSkip::CruzaTag
                    });
                }
                if es_cierre_de_bloque(tag) && !plain.ends_with('\n') && !plain.is_empty() {
                    plain.push('\n');
                }
                i += rel + 1;
                continue;
            }
        }
        if bytes[i] == b'&' {
            if let Some((ent, ch)) = ENTIDADES
                .iter()
                .find(|(ent, _)| html[i..].starts_with(*ent))
            {
                cerrar!();
                if motivo_pendiente.is_none() {
                    motivo_pendiente = Some(MotivoSkip::CruzaEntidad);
                }
                plain.push(*ch);
                i += ent.len();
                continue;
            }
            // Entidad no reconocida (ej. `&hellip;`): el `&` NO puede quedar
            // dentro de un run — si fuera reemplazable, cambiar `&` rompería
            // la entidad. Se lo trata como el hueco de una entidad: se cierra
            // el run, el `&` cae afuera, y el resto del texto sigue abriendo
            // run nuevo como de costumbre.
            cerrar!();
            if motivo_pendiente.is_none() {
                motivo_pendiente = Some(MotivoSkip::CruzaEntidad);
            }
            plain.push('&');
            i += 1;
            continue;
        }
        // Char de texto normal: abre run si hacía falta y lo copia tal cual.
        let ch = html[i..].chars().next().unwrap();
        if abierto.is_none() {
            abierto = Some((plain.len(), i));
        }
        plain.push(ch);
        i += ch.len_utf8();
    }
    cerrar!();
    PlainMap { plain, runs }
}

/// True si `c` NO es letra ni número, o sea si sirve como borde de palabra.
/// `is_alphanumeric` es Unicode-aware, así que la `ó` de `casón` cuenta como
/// letra y `cas` no matchea ahí como palabra completa.
fn es_limite(c: Option<char>) -> bool {
    match c {
        None => true,
        Some(ch) => !ch.is_alphanumeric(),
    }
}

fn char_antes(s: &str, idx: usize) -> Option<char> {
    s[..idx].chars().next_back()
}

/// Compara `needle` contra `hay` arrancando en el byte `at`. Devuelve cuántos
/// BYTES de `hay` consumió el match, o None.
///
/// Compara char por char en vez de lowercasear los dos strings enteros: en
/// general `to_lowercase()` no preserva el largo (hay chars que al bajar de
/// caso se convierten en dos), y si el largo cambia los offsets del plain
/// dejan de servir para ubicar el match en el HTML. Acá el largo consumido
/// sale de los chars de `hay` que realmente se comieron, así que siempre es
/// exacto.
///
/// Limitación conocida y aceptada: para el fold de caso se usa el PRIMER char
/// que devuelve `to_lowercase()`. Alcanza para español e inglés; casos como
/// la `İ` turca quedarían mal comparados, y no aparecen en las novelas.
fn matchea_en(hay: &str, at: usize, needle: &str, case_sensitive: bool) -> Option<usize> {
    let mut h = hay[at..].chars();
    let mut consumidos = 0usize;
    for nc in needle.chars() {
        let hc = h.next()?;
        let iguales = if case_sensitive {
            hc == nc
        } else {
            baja(hc) == baja(nc)
        };
        if !iguales {
            return None;
        }
        consumidos += hc.len_utf8();
    }
    Some(consumidos)
}

fn baja(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Todas las ocurrencias de `needle` en `plain` como rangos `[start, end)` de
/// bytes, sin solapamiento (se avanza hasta el final de cada match).
pub fn buscar_ocurrencias(plain: &str, needle: &str, op: &Opciones) -> Vec<(usize, usize)> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < plain.len() {
        if !plain.is_char_boundary(i) {
            i += 1;
            continue;
        }
        if let Some(largo) = matchea_en(plain, i, needle, op.case_sensitive) {
            let fin = i + largo;
            let ok = !op.whole_word
                || (es_limite(char_antes(plain, i)) && es_limite(plain[fin..].chars().next()));
            if ok {
                out.push((i, fin));
                i = fin;
                continue;
            }
        }
        i += plain[i..].chars().next().map(char::len_utf8).unwrap_or(1);
    }
    out
}

/// Traduce un rango de plain a un rango de HTML, o dice qué lo cruzó.
pub fn ubicar(map: &PlainMap, plain_start: usize, plain_end: usize) -> Ubicacion {
    for (idx, r) in map.runs.iter().enumerate() {
        if plain_start < r.plain_start || plain_start >= r.plain_end {
            continue;
        }
        if plain_end <= r.plain_end {
            let delta = plain_start - r.plain_start;
            return Ubicacion::Reemplazable {
                html_start: r.html_start + delta,
                html_end: r.html_start + delta + (plain_end - plain_start),
            };
        }
        // Se pasa del run: el motivo es lo que cortó el run SIGUIENTE.
        let motivo = map
            .runs
            .get(idx + 1)
            .and_then(|n| n.motivo_gap_previo)
            .unwrap_or(MotivoSkip::CruzaTag);
        return Ubicacion::Cruza(motivo);
    }
    // Arranca en un hueco (un tag, una entidad, un cierre de bloque): el
    // motivo real es el del run que sigue al hueco, no un valor fijo.
    map.runs
        .iter()
        .find(|r| r.plain_start > plain_start)
        .and_then(|r| r.motivo_gap_previo)
        .map(Ubicacion::Cruza)
        .unwrap_or(Ubicacion::Cruza(MotivoSkip::CruzaBloque))
}

/// Aplica los reemplazos sobre el HTML. Ordena los ranges y hace el splice de
/// ATRÁS PARA ADELANTE: si fuera al revés, el primer reemplazo de largo
/// distinto desfasaría todos los ranges siguientes.
pub fn aplicar_ranges(
    html: &str,
    mut ranges: Vec<(usize, usize)>,
    replacement: &str,
) -> String {
    ranges.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = html.to_string();
    // `tope` es el `start` del último range aplicado (o el largo total, al
    // arrancar): como se procesa de atrás para adelante, cualquier range que
    // no termine estrictamente antes de `tope` se solapa o duplica al
    // anterior, y se descarta de una sola pasada junto con los offsets fuera
    // de límite o que no caen en borde de char UTF-8 (evita el panic de
    // `replace_range`).
    let mut tope = out.len();
    for (start, end) in ranges {
        if start > end || end > tope || !out.is_char_boundary(start) || !out.is_char_boundary(end)
        {
            continue;
        }
        out.replace_range(start..end, replacement);
        tope = start;
    }
    out
}

/// Tope de ocurrencias que se enumeran antes de cortar. Pasado esto no hay
/// preview útil: son miles de filas que nadie revisa una por una, y la salida
/// honesta es pedir que se acote el scope o el término.
const MAX_OCURRENCIAS: usize = 2000;
const MAX_ARCHIVOS: usize = 500;
/// Contexto a cada lado del match en el snippet.
const SNIPPET_CONTEXTO: usize = 120;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOccurrence {
    /// `<path>#<html_start>`. Estable entre previews del mismo archivo, así
    /// que destildar una ocurrencia sobrevive a un re-preview por debounce.
    pub id: String,
    pub snippet: String,
    pub html_start: usize,
    pub html_end: usize,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSkipped {
    pub snippet: String,
    pub reason: MotivoSkip,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceGroup {
    pub path: String,
    pub title: String,
    pub occurrences: Vec<ReplaceOccurrence>,
    pub skipped: Vec<ReplaceSkipped>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub groups: Vec<ReplaceGroup>,
    pub total: usize,
    pub total_skipped: usize,
    pub truncated: bool,
}

/// Recorte del plain alrededor del match, con ellipsis y los saltos de línea
/// aplanados a espacios (una fila del panel es una línea).
fn snippet(plain: &str, start: usize, end: usize) -> String {
    let desde = plain[..start]
        .char_indices()
        .rev()
        .take(SNIPPET_CONTEXTO)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    let hasta = plain[end..]
        .char_indices()
        .take(SNIPPET_CONTEXTO)
        .last()
        .map(|(i, c)| end + i + c.len_utf8())
        .unwrap_or(plain.len());
    let mut s = String::new();
    if desde > 0 {
        s.push('…');
    }
    s.push_str(plain[desde..hasta].trim());
    if hasta < plain.len() {
        s.push('…');
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn titulo_de(path: &Path) -> String {
    crate::audit::read_meta_field(path, "titulo")
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Enumera las ocurrencias de `needle` en los capítulos del scope.
/// Separado del comando para poder testearlo contra un `TempDir`.
pub fn preview_scope(
    scope: &Path,
    needle: &str,
    op: &Opciones,
) -> Result<ReplacePreview, String> {
    let mut pv = ReplacePreview::default();
    if needle.is_empty() {
        return Ok(pv);
    }
    let paths = crate::audit::chapter_paths(scope)?;
    for path in paths {
        // Este chequeo solo dispara cuando queda al menos un archivo sin
        // procesar (si el tope se completa justo con el último, el `for`
        // termina solo y nunca vuelve a evaluar esto). Caso borde aceptado:
        // si los archivos que quedan sin escanear resultan no tener ninguna
        // ocurrencia, esto igual marca `truncated`, porque no hay forma de
        // saberlo sin escanearlos — que es justo lo que el tope evita. La
        // flag sigue siendo honesta: significa "quedaron archivos sin
        // escanear", no "se descartó una ocurrencia real".
        if pv.groups.len() >= MAX_ARCHIVOS || pv.total >= MAX_OCURRENCIAS {
            pv.truncated = true;
            break;
        }
        let Ok(html) = std::fs::read_to_string(&path) else {
            continue;
        };
        let map = plain_con_runs(&html);
        let hits = buscar_ocurrencias(&map.plain, needle, op);
        if hits.is_empty() {
            continue;
        }
        let path_str = path.to_string_lossy().into_owned();
        let mut occurrences = Vec::new();
        let mut skipped = Vec::new();
        for (a, b) in hits {
            // El tope se aplica también ADENTRO del archivo: sin esto, un
            // capítulo con miles de ocurrencias de un término corto empuja
            // `total` muy por encima de MAX_OCURRENCIAS en una sola
            // iteración, y el chequeo de arriba —que corre recién antes del
            // archivo siguiente— no lo ve nunca.
            if pv.total + occurrences.len() >= MAX_OCURRENCIAS {
                pv.truncated = true;
                break;
            }
            match ubicar(&map, a, b) {
                Ubicacion::Reemplazable { html_start, html_end } => occurrences.push(
                    ReplaceOccurrence {
                        id: format!("{path_str}#{html_start}"),
                        snippet: snippet(&map.plain, a, b),
                        html_start,
                        html_end,
                    },
                ),
                Ubicacion::Cruza(reason) => skipped.push(ReplaceSkipped {
                    snippet: snippet(&map.plain, a, b),
                    reason,
                }),
            }
        }
        pv.total += occurrences.len();
        pv.total_skipped += skipped.len();
        if occurrences.is_empty() && skipped.is_empty() {
            continue;
        }
        pv.groups.push(ReplaceGroup {
            title: titulo_de(&path),
            path: path_str,
            occurrences,
            skipped,
        });
    }
    tracing::info!(
        target: "replace",
        scope = %scope.display(),
        needle,
        grupos = pv.groups.len(),
        total = pv.total,
        skipped = pv.total_skipped,
        truncated = pv.truncated,
        "replace_preview"
    );
    Ok(pv)
}

#[tauri::command]
pub fn replace_preview(
    scope_path: String,
    needle: String,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<ReplacePreview, String> {
    preview_scope(
        Path::new(&scope_path),
        needle.as_str(),
        &Opciones { case_sensitive, whole_word },
    )
}

const UNDO_SUBDIR: &str = ".twriter/undo";

#[derive(Deserialize, Debug, Clone)]
pub struct FileEdit {
    pub path: String,
    pub ranges: Vec<(usize, usize)>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub files: usize,
    pub occurrences: usize,
    /// Paths que cambiaron entre el preview y el apply. No se tocaron.
    pub skipped_files: Vec<String>,
    /// Paths cuya escritura falló (disco lleno, permisos, archivo tomado por
    /// el servicio de sync). Distinto de `skipped_files`: esos no se tocaron
    /// porque cambiaron desde el preview; estos se intentaron y no se
    /// pudieron escribir. El snapshot cubre los que sí se escribieron antes
    /// del fallo. Formato de cada entrada: `"<path>: <error>"`.
    pub failed_files: Vec<String>,
    /// Vacío si no se escribió nada.
    pub snapshot_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    pub rel: String,
    pub occurrences: usize,
    /// mtime en segundos epoch DESPUÉS de escribir. El undo lo usa para no
    /// pisar una edición posterior al reemplazo.
    pub mtime_after_apply: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotManifest {
    pub id: String,
    pub when: String,
    pub needle: String,
    pub replacement: String,
    pub files: Vec<SnapshotFile>,
}

fn mtime_epoch(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Id de snapshot legible y ordenable. Epoch en MILISEGUNDOS: en segundos,
/// dos reemplazos seguidos (o dos casos de test) caen en el mismo id y el
/// segundo pisaría el snapshot del primero. No hace falta una dependencia de
/// fechas para nombrar una carpeta.
fn nuevo_snapshot_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("undo-{millis}")
}

/// Aplica los reemplazos. Ver el contexto de la Task 3 del plan para el orden
/// obligatorio: revalidar todo, después snapshotear, después escribir.
pub fn aplicar(
    root: &Path,
    needle: &str,
    op: &Opciones,
    edits: Vec<FileEdit>,
    replacement: &str,
    ultima_edicion: &str,
) -> Result<ReplaceOutcome, String> {
    let mut out = ReplaceOutcome::default();
    if needle.is_empty() || edits.is_empty() {
        return Ok(out);
    }

    // 0. Plegar por path: dos `FileEdit` para el mismo archivo (el frontend
    // arma uno por selección, no necesariamente uno por grupo) no pueden
    // generar dos `Pendiente` independientes — cada uno calcularía `nuevo`
    // desde el mismo html original y el segundo pisaría al primero.
    // `BTreeMap` da además un orden determinístico entre archivos.
    let mut por_path: std::collections::BTreeMap<String, Vec<(usize, usize)>> =
        std::collections::BTreeMap::new();
    for edit in edits {
        por_path.entry(edit.path).or_default().extend(edit.ranges);
    }

    // 1. Revalidar: cada range pedido tiene que seguir existiendo hoy.
    struct Pendiente {
        path: PathBuf,
        html: String,
        nuevo: String,
        ocurrencias: usize,
        mtime_antes: u64,
    }
    let mut pendientes: Vec<Pendiente> = Vec::new();
    for (path_str, mut ranges) in por_path {
        if ranges.is_empty() {
            continue;
        }
        let path = PathBuf::from(&path_str);
        let Ok(html) = std::fs::read_to_string(&path) else {
            out.skipped_files.push(path_str);
            continue;
        };
        // Mtime al momento de leer: la fase 3 lo vuelve a chequear justo
        // antes de escribir, para no pisar una edición que llegó en la
        // ventana entre este read y esa escritura.
        let mtime_antes = mtime_epoch(&path);
        let map = plain_con_runs(&html);
        let vigentes: Vec<(usize, usize)> = buscar_ocurrencias(&map.plain, needle, op)
            .into_iter()
            .filter_map(|(a, b)| match ubicar(&map, a, b) {
                Ubicacion::Reemplazable { html_start, html_end } => Some((html_start, html_end)),
                Ubicacion::Cruza(_) => None,
            })
            .collect();
        if !ranges.iter().all(|r| vigentes.contains(r)) {
            tracing::warn!(
                target: "replace",
                path = %path_str,
                "el archivo cambió desde el preview, no lo toco"
            );
            out.skipped_files.push(path_str);
            continue;
        }
        // Deduplicar antes de contar: `aplicar_ranges` colapsa los duplicados
        // a una sola escritura, así que contar los ranges PEDIDOS haría que el
        // toast le reporte al autor más reemplazos de los que hubo.
        ranges.sort_unstable();
        ranges.dedup();
        let ocurrencias = ranges.len();
        let nuevo = aplicar_ranges(&html, ranges, replacement);
        pendientes.push(Pendiente { path, html, nuevo, ocurrencias, mtime_antes });
    }
    if pendientes.is_empty() {
        return Ok(out);
    }

    // 2. Snapshot de los sobrevivientes. Nada de esto toca un capítulo real
    // todavía, así que puede abortar con `?`/`return Err` sin dejar al autor
    // sin red: el undo anterior (si hay) sigue intacto hasta el final de
    // este bloque.
    let undo_root = root.join(UNDO_SUBDIR);
    // Id único: si `<id>` ya existiera (dos applies en el mismo milisegundo,
    // o un reloj que retrocedió), sufijarlo hasta encontrar uno libre en vez
    // de abortar. La propiedad que importa —nunca escribir en un directorio
    // que ya es de otro snapshot— se cumple igual, sin el hard-fail.
    let base_id = nuevo_snapshot_id();
    let mut id = base_id.clone();
    let mut snap_dir = undo_root.join(&id);
    let mut sufijo = 1u32;
    while snap_dir.exists() {
        id = format!("{base_id}-{sufijo}");
        snap_dir = undo_root.join(&id);
        sufijo += 1;
    }

    // Resolver todos los `rel` primero: si alguno falla (capítulo fuera del
    // root, o un `..` que sacaría la copia de `snap_dir`), abortar ACÁ, antes
    // de tocar `undo_root` — así el snapshot anterior no se pierde por un
    // request malformado.
    let mut manifest_files: Vec<SnapshotFile> = Vec::new();
    for p in &pendientes {
        let rel = crate::stats::relative_key(root, &p.path)
            .ok_or_else(|| format!("capítulo fuera del root: {}", p.path.display()))?;
        if rel.split('/').any(|seg| seg == "..") {
            return Err(format!("path de capítulo inválido: {}", p.path.display()));
        }
        manifest_files.push(SnapshotFile { rel, occurrences: p.ocurrencias, mtime_after_apply: 0 });
    }

    // Escribir los originales + el manifest inicial (mtimes en 0, se
    // completan en la fase 3). Que el manifest exista ANTES del primer
    // `write_chapter` es lo que evita que un snapshot quede sin él si algo
    // falla a mitad del lote real.
    std::fs::create_dir_all(&snap_dir)
        .map_err(|e| format!("mkdir {}: {}", snap_dir.display(), e))?;
    let escrito = (|| -> Result<(), String> {
        for (p, mf) in pendientes.iter().zip(manifest_files.iter()) {
            let destino = snap_dir.join(&mf.rel);
            if let Some(parent) = destino.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
            }
            std::fs::write(&destino, &p.html)
                .map_err(|e| format!("snapshot {}: {}", destino.display(), e))?;
        }
        let manifest_inicial = SnapshotManifest {
            id: id.clone(),
            when: ultima_edicion.to_string(),
            needle: needle.to_string(),
            replacement: replacement.to_string(),
            files: manifest_files.clone(),
        };
        std::fs::write(
            snap_dir.join("manifest.json"),
            serde_json::to_string_pretty(&manifest_inicial).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("manifest: {e}"))
    })();
    if let Err(e) = escrito {
        // Nada real se tocó todavía: no dejar un snapshot a medio escribir.
        let _ = std::fs::remove_dir_all(&snap_dir);
        return Err(e);
    }

    // El snapshot nuevo está completo (originales + manifest inicial). Recién
    // ahora se borran los hermanos de `<id>` en `undo_root` — si algo de
    // arriba hubiera fallado, el undo anterior seguiría intacto.
    if let Ok(entries) = std::fs::read_dir(&undo_root) {
        for entry in entries.flatten() {
            if entry.file_name() != std::ffi::OsStr::new(id.as_str()) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    // 3. Escribir. `fs::write_chapter` reindexa tantivy por su cuenta. Si una
    // escritura falla a mitad de lote (disco lleno, permisos, archivo tomado
    // por el servicio de sync), CORTAR ahí en vez de seguir con el resto: en
    // un ENOSPC las siguientes van a fallar igual, y lo que ya se escribió
    // queda cubierto por el snapshot y registrado en el manifest. Ninguno de
    // los pasos de acá para abajo puede volver a un `?`/`Err`: los capítulos
    // de arriba ya cambiaron en disco, y perder `snapshot_id` en un `Err` es
    // exactamente lo que dejaba al autor sin red (spec: "se reporta el
    // conteo real, no 'listo'").
    let mut stats = crate::stats::read_stats(root);
    for (idx, p) in pendientes.iter().enumerate() {
        // `nuevo` se calculó en la fase 1 sobre el `html` leído ahí. Entre
        // ese read y este punto puede pasar un autosave, un `git pull` o un
        // write de la otra PC — la misma ventana que justifica la
        // revalidación de la fase 1, pero más chica. Sin este chequeo,
        // `write_chapter` de abajo pisaría esa edición ajena con `nuevo`
        // calculado sobre el html VIEJO, perdiéndola en silencio. Cubierto
        // por inspección, no por test: forzar la carrera de forma
        // determinística exigiría un thread compitiendo por timing contra
        // esta misma llamada, o un hook de test en el camino de escritura —
        // ninguno de los dos vale lo que cuesta un guard de tres líneas
        // sobre un helper (`mtime_epoch`) que ya está ejercitado en el resto
        // del archivo.
        if mtime_epoch(&p.path) != p.mtime_antes {
            // Cambió entre el read de la fase 1 y este punto. Mismo canal y
            // semántica que la revalidación: "cambió desde que lo leí", no
            // se pisa.
            tracing::warn!(
                target: "replace",
                path = %p.path.display(),
                "el archivo cambió justo antes de escribir, no lo piso"
            );
            out.skipped_files.push(p.path.to_string_lossy().into_owned());
            continue;
        }
        match crate::fs::write_chapter(p.path.to_string_lossy().into_owned(), p.nuevo.clone()) {
            Ok(()) => {
                out.files += 1;
                out.occurrences += p.ocurrencias;
                manifest_files[idx].mtime_after_apply = mtime_epoch(&p.path);
                stats.insert(
                    manifest_files[idx].rel.clone(),
                    crate::stats::ChapterStat {
                        palabras: crate::import::count_words(&p.nuevo),
                        ultima_edicion: Some(ultima_edicion.to_string()),
                    },
                );
            }
            Err(e) => {
                out.failed_files.push(format!("{}: {}", p.path.display(), e));
                break;
            }
        }
    }

    // Read-modify-write del mapa entero: si un autosave llama a
    // `write_chapter_stats` justo en esta ventana, ese `insert` se pisa acá.
    // Es cosmético (se autocura en el próximo save de ese capítulo, que
    // vuelve a leer y reescribir el mapa) y un lock para esto no se
    // justifica — el brief ya pide un solo read/write para todo el lote.
    if let Err(e) = crate::stats::write_stats(root, &stats) {
        tracing::error!(target: "replace", error = %e, "no se pudo guardar stats tras el reemplazo");
    }

    let manifest_final = SnapshotManifest {
        id: id.clone(),
        when: ultima_edicion.to_string(),
        needle: needle.to_string(),
        replacement: replacement.to_string(),
        files: manifest_files,
    };
    match serde_json::to_string_pretty(&manifest_final) {
        Ok(json) => {
            if let Err(e) = std::fs::write(snap_dir.join("manifest.json"), json) {
                tracing::error!(target: "replace", error = %e, "no se pudo reescribir el manifest final");
            }
        }
        Err(e) => tracing::error!(target: "replace", error = %e, "no se pudo serializar el manifest final"),
    }
    out.snapshot_id = id;

    tracing::info!(
        target: "replace",
        needle,
        replacement,
        files = out.files,
        occurrences = out.occurrences,
        skipped = out.skipped_files.len(),
        failed = out.failed_files.len(),
        snapshot = %out.snapshot_id,
        "replace_apply"
    );
    Ok(out)
}

#[tauri::command]
pub fn replace_apply(
    root: String,
    needle: String,
    case_sensitive: bool,
    whole_word: bool,
    edits: Vec<FileEdit>,
    replacement: String,
    ultima_edicion: String,
) -> Result<ReplaceOutcome, String> {
    aplicar(
        Path::new(&root),
        needle.as_str(),
        &Opciones { case_sensitive, whole_word },
        edits,
        replacement.as_str(),
        ultima_edicion.as_str(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(case_sensitive: bool, whole_word: bool) -> Opciones {
        Opciones { case_sensitive, whole_word }
    }

    #[test]
    fn plain_saca_tags_y_deja_el_texto() {
        let m = plain_con_runs("<p>Hola <em>mundo</em> cruel</p>\n");
        assert_eq!(m.plain.trim(), "Hola mundo cruel");
    }

    #[test]
    fn los_runs_apuntan_al_html_original() {
        let html = "<p>Hola</p>";
        let m = plain_con_runs(html);
        // El primer run cubre "Hola", que en el HTML arranca en el byte 3.
        let r = &m.runs[0];
        assert_eq!(&html[r.html_start..r.html_start + (r.plain_end - r.plain_start)], "Hola");
    }

    #[test]
    fn una_entidad_corta_el_run() {
        let m = plain_con_runs("<p>Ana &amp; Beto</p>");
        assert_eq!(m.plain.trim(), "Ana & Beto");
        // "Ana ", "&" y " Beto" no pueden estar en un solo run: la entidad
        // ocupa 5 bytes en el HTML y 1 en el plain.
        assert!(m.runs.len() >= 2);
    }

    #[test]
    fn el_cierre_de_bloque_separa_parrafos() {
        let m = plain_con_runs("<p>uno</p><p>dos</p>");
        assert!(m.plain.contains('\n'), "esperaba un salto entre párrafos, hubo {:?}", m.plain);
        assert!(!m.plain.contains("unodos"));
    }

    #[test]
    fn busca_case_insensitive_por_default() {
        let hits = buscar_ocurrencias("Angelica y ANGELICA y angelica", "angelica", &ops(false, true));
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn con_case_sensitive_solo_el_literal() {
        let hits = buscar_ocurrencias("Angelica y ANGELICA y angelica", "Angelica", &ops(true, true));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0], (0, 8));
    }

    #[test]
    fn palabra_completa_no_toca_el_prefijo() {
        let hits = buscar_ocurrencias("la casa y el casarse", "casa", &ops(false, true));
        assert_eq!(hits.len(), 1, "casarse no es palabra completa: {:?}", hits);
        assert_eq!(hits[0], (3, 7));
    }

    #[test]
    fn sin_palabra_completa_el_prefijo_entra() {
        let hits = buscar_ocurrencias("la casa y el casarse", "casa", &ops(false, false));
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn palabra_completa_respeta_acentos_como_letra() {
        // `casa` no debe matchear dentro de `casón`, y el borde tiene que
        // tratar la ó como letra.
        let hits = buscar_ocurrencias("el casón", "cas", &ops(false, true));
        assert!(hits.is_empty(), "cas no es palabra completa en casón: {:?}", hits);
    }

    #[test]
    fn busca_frases_con_espacios() {
        let hits = buscar_ocurrencias("dijo no obstante que sí", "no obstante", &ops(false, true));
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn ubica_el_match_dentro_de_un_run() {
        let html = "<p>la casa grande</p>";
        let m = plain_con_runs(html);
        let hits = buscar_ocurrencias(&m.plain, "casa", &ops(false, true));
        match ubicar(&m, hits[0].0, hits[0].1) {
            Ubicacion::Reemplazable { html_start, html_end } => {
                assert_eq!(&html[html_start..html_end], "casa");
            }
            otro => panic!("esperaba reemplazable, fue {:?}", otro),
        }
    }

    #[test]
    fn el_match_partido_por_una_cursiva_no_es_reemplazable() {
        let html = "<p>la <em>casa</em> grande</p>";
        let m = plain_con_runs(html);
        let hits = buscar_ocurrencias(&m.plain, "casa grande", &ops(false, true));
        assert_eq!(hits.len(), 1, "en el plain la frase existe");
        assert!(matches!(
            ubicar(&m, hits[0].0, hits[0].1),
            Ubicacion::Cruza(MotivoSkip::CruzaTag)
        ));
    }

    #[test]
    fn casa_pegada_a_una_cursiva_no_se_reemplaza() {
        // `<em>casa</em>rse` es "casarse" en el plain: `casa` con palabra
        // completa NO debe matchear, porque el borde se mide en el plain.
        let html = "<p><em>casa</em>rse</p>";
        let m = plain_con_runs(html);
        let hits = buscar_ocurrencias(&m.plain, "casa", &ops(false, true));
        assert!(hits.is_empty(), "el borde se mide en el plain: {:?}", hits);
    }

    #[test]
    fn el_match_que_abarca_una_entidad_no_es_reemplazable() {
        let html = "<p>Ana &amp; Beto</p>";
        let m = plain_con_runs(html);
        let hits = buscar_ocurrencias(&m.plain, "Ana & Beto", &ops(false, true));
        assert_eq!(hits.len(), 1);
        assert!(matches!(
            ubicar(&m, hits[0].0, hits[0].1),
            Ubicacion::Cruza(MotivoSkip::CruzaEntidad)
        ));
    }

    #[test]
    fn el_match_que_cruza_dos_parrafos_no_es_reemplazable() {
        let html = "<p>final uno</p><p>dos principio</p>";
        let m = plain_con_runs(html);
        let hits = buscar_ocurrencias(&m.plain, "uno\ndos", &ops(false, false));
        assert_eq!(hits.len(), 1);
        assert!(matches!(
            ubicar(&m, hits[0].0, hits[0].1),
            Ubicacion::Cruza(MotivoSkip::CruzaBloque)
        ));
    }

    #[test]
    fn aplicar_varios_ranges_no_desfasa() {
        // Tres ocurrencias en un archivo, y el reemplazo es más largo que el
        // original: si el splice fuera de adelante para atrás, el segundo y el
        // tercer range apuntarían al lugar equivocado.
        let html = "<p>Angelica, Angelica y Angelica</p>";
        let m = plain_con_runs(html);
        let hits = buscar_ocurrencias(&m.plain, "Angelica", &ops(false, true));
        assert_eq!(hits.len(), 3);
        let ranges: Vec<(usize, usize)> = hits
            .iter()
            .map(|(a, b)| match ubicar(&m, *a, *b) {
                Ubicacion::Reemplazable { html_start, html_end } => (html_start, html_end),
                otro => panic!("esperaba reemplazable, fue {:?}", otro),
            })
            .collect();
        let out = aplicar_ranges(html, ranges, "Angélica");
        assert_eq!(out, "<p>Angélica, Angélica y Angélica</p>");
    }

    #[test]
    fn aplicar_con_replacement_vacio_borra() {
        let html = "<p>un muy muy largo</p>";
        let m = plain_con_runs(html);
        let hits = buscar_ocurrencias(&m.plain, "muy ", &ops(false, false));
        let ranges: Vec<(usize, usize)> = hits
            .iter()
            .map(|(a, b)| match ubicar(&m, *a, *b) {
                Ubicacion::Reemplazable { html_start, html_end } => (html_start, html_end),
                otro => panic!("{:?}", otro),
            })
            .collect();
        assert_eq!(aplicar_ranges(html, ranges, ""), "<p>un largo</p>");
    }

    #[test]
    fn needle_vacio_no_devuelve_nada() {
        assert!(buscar_ocurrencias("cualquier texto", "", &ops(false, true)).is_empty());
    }

    #[test]
    fn todos_los_runs_mapean_byte_a_byte() {
        let html = "<p>El niño <em>corrió</em> — ayer &amp; hoy 😀</p>";
        let m = plain_con_runs(html);
        assert!(m.runs.len() >= 4);
        for r in &m.runs {
            let n = r.plain_end - r.plain_start;
            assert_eq!(&html[r.html_start..r.html_start + n], &m.plain[r.plain_start..r.plain_end]);
        }
    }

    #[test]
    fn ubica_bien_despues_de_un_char_multibyte() {
        let html = "<p>El niño corrió ayer</p>";
        let m = plain_con_runs(html);
        let h = buscar_ocurrencias(&m.plain, "ayer", &ops(false, true))[0];
        let (html_start, html_end) = match ubicar(&m, h.0, h.1) {
            Ubicacion::Reemplazable { html_start, html_end } => {
                assert_eq!(&html[html_start..html_end], "ayer");
                (html_start, html_end)
            }
            otro => panic!("{:?}", otro),
        };
        // Y el round trip completo no debe tocar los tags.
        assert_eq!(
            aplicar_ranges(html, vec![(html_start, html_end)], "hoy"),
            "<p>El niño corrió hoy</p>"
        );
    }

    #[test]
    fn offset_no_char_boundary_no_panickea() {
        // Repro del hallazgo 1: (6,8) cae a mitad del carácter multibyte de
        // "niño" — antes esto hacía panic en replace_range.
        assert_eq!(aplicar_ranges("<p>niño</p>", vec![(6, 8)], "X"), "<p>niño</p>");
    }

    #[test]
    fn rangos_solapados_se_descartan_sin_corromper() {
        // Repro del hallazgo 2a: (3,8) y (5,10) se solapan. Antes el segundo
        // splice corrompía el primero en vez de descartarse.
        let out = aplicar_ranges("<p>abcdefghij</p>", vec![(3, 8), (5, 10)], "XX");
        assert_eq!(out, "<p>abXXhij</p>");
    }

    #[test]
    fn rangos_duplicados_se_aplican_una_sola_vez() {
        // Repro del hallazgo 2b: el mismo range dos veces (ej. un retry que
        // reenvía la lista). Antes el segundo splice escribía sobre basura.
        let out = aplicar_ranges("<p>abcdefghij</p>", vec![(3, 7), (3, 7)], "ZZZZZZ");
        assert_eq!(out, "<p>ZZZZZZefghij</p>");
    }

    #[test]
    fn entidad_no_reconocida_no_se_puede_pisar() {
        // Repro del hallazgo 3: "&hellip;" no es una de las 6 entidades
        // conocidas. Antes el "&" quedaba dentro de un run reemplazable y
        // pisarlo rompía la entidad ("&hellip;" -> "yhellip;").
        let html = "<p>Ana &hellip; Beto</p>";
        let m = plain_con_runs(html);
        let hits = buscar_ocurrencias(&m.plain, "&", &ops(false, false));
        assert_eq!(hits.len(), 1);
        assert!(matches!(
            ubicar(&m, hits[0].0, hits[0].1),
            Ubicacion::Cruza(MotivoSkip::CruzaEntidad)
        ));
    }

    use std::fs;
    use tempfile::TempDir;

    /// Crea un scope con capítulos. `caps` es `(ruta relativa, html)`.
    fn scope_con(caps: &[(&str, &str)]) -> TempDir {
        let td = TempDir::new().unwrap();
        for (rel, html) in caps {
            let p = td.path().join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, html).unwrap();
        }
        td
    }

    #[test]
    fn preview_encuentra_en_varios_capitulos() {
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica dijo que no</p>"),
            ("libro/2.html", "<p>para Angelica era tarde</p><p>Angelica sonrió</p>"),
            ("libro/3.html", "<p>nada que ver</p>"),
        ]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        assert_eq!(pv.groups.len(), 2, "el 3 no tiene ocurrencias");
        assert_eq!(pv.total, 3);
        assert!(!pv.truncated);
    }

    #[test]
    fn preview_saltea_las_carpetas_que_no_son_capitulos() {
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica</p>"),
            ("libro/notas/idea.html", "<p>Angelica</p>"),
            ("libro/Exportados/viejo.html", "<p>Angelica</p>"),
        ]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        assert_eq!(pv.groups.len(), 1);
        assert!(pv.groups[0].path.ends_with("1.html"));
    }

    #[test]
    fn preview_reporta_las_que_cruzan_markup_aparte() {
        let td = scope_con(&[("libro/1.html", "<p>la <em>casa</em> grande</p>")]);
        let pv = preview_scope(td.path(), "casa grande", &ops(false, true)).unwrap();
        assert_eq!(pv.total, 0);
        assert_eq!(pv.total_skipped, 1);
        assert_eq!(pv.groups[0].skipped[0].reason, MotivoSkip::CruzaTag);
    }

    #[test]
    fn preview_usa_el_titulo_del_meta() {
        let td = scope_con(&[("libro/7.html", "<p>Angelica</p>")]);
        fs::write(
            td.path().join("libro/7.meta.json"),
            r#"{"orden":7,"titulo":"El regreso"}"#,
        )
        .unwrap();
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        assert_eq!(pv.groups[0].title, "El regreso");
    }

    #[test]
    fn preview_cae_al_nombre_del_archivo_sin_meta() {
        let td = scope_con(&[("libro/7.html", "<p>Angelica</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        assert_eq!(pv.groups[0].title, "7");
    }

    #[test]
    fn el_id_de_ocurrencia_incluye_el_offset() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica y Angelica</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let occ = &pv.groups[0].occurrences;
        assert_eq!(occ.len(), 2);
        assert_ne!(occ[0].id, occ[1].id, "dos ocurrencias, dos ids");
        assert!(occ[0].id.ends_with(&format!("#{}", occ[0].html_start)));
    }

    #[test]
    fn preview_de_un_archivo_suelto_como_scope() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica</p>"), ("libro/2.html", "<p>Angelica</p>")]);
        let pv = preview_scope(&td.path().join("libro/1.html"), "Angelica", &ops(false, true)).unwrap();
        assert_eq!(pv.groups.len(), 1, "scope 'archivo actual'");
    }

    #[test]
    fn el_tope_corta_adentro_de_un_solo_archivo() {
        // Un solo capítulo con más ocurrencias que MAX_OCURRENCIAS: el
        // chequeo de arriba del loop (que corre entre archivos) nunca lo ve,
        // así que el corte tiene que pasar adentro del `for (a, b) in hits`.
        let html = format!("<p>{}</p>", "a ".repeat(MAX_OCURRENCIAS + 500));
        let td = scope_con(&[("libro/1.html", html.as_str())]);
        let pv = preview_scope(td.path(), "a", &ops(false, true)).unwrap();
        assert!(pv.total <= MAX_OCURRENCIAS, "no debe pasarse del tope: {}", pv.total);
        assert!(pv.truncated);
    }

    #[test]
    fn el_tope_de_archivos_marca_truncated() {
        let caps: Vec<(String, String)> = (0..MAX_ARCHIVOS + 1)
            .map(|i| (format!("libro/{i}.html"), "<p>Angelica</p>".to_string()))
            .collect();
        let refs: Vec<(&str, &str)> = caps.iter().map(|(p, h)| (p.as_str(), h.as_str())).collect();
        let td = scope_con(&refs);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        assert!(pv.truncated);
        assert!(pv.groups.len() <= MAX_ARCHIVOS);
    }

    #[test]
    fn el_tope_de_ocurrencias_exacto_no_marca_truncado() {
        // Borde: el scope tiene JUSTO MAX_OCURRENCIAS, ni una más. No se
        // descartó nada, así que truncated tiene que quedar en false.
        let html = format!("<p>{}</p>", "a ".repeat(MAX_OCURRENCIAS));
        let td = scope_con(&[("libro/1.html", html.as_str())]);
        let pv = preview_scope(td.path(), "a", &ops(false, true)).unwrap();
        assert_eq!(pv.total, MAX_OCURRENCIAS);
        assert!(!pv.truncated, "no se descartó nada, no debe marcarse truncado");
    }

    #[test]
    fn el_tope_de_archivos_exacto_no_marca_truncado() {
        // Borde: JUSTO MAX_ARCHIVOS capítulos con match, ni uno más.
        let caps: Vec<(String, String)> = (0..MAX_ARCHIVOS)
            .map(|i| (format!("libro/{i}.html"), "<p>Angelica</p>".to_string()))
            .collect();
        let refs: Vec<(&str, &str)> = caps.iter().map(|(p, h)| (p.as_str(), h.as_str())).collect();
        let td = scope_con(&refs);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        assert_eq!(pv.groups.len(), MAX_ARCHIVOS);
        assert!(!pv.truncated, "no se descartó nada, no debe marcarse truncado");
    }

    /// `ultima_edicion` la manda el frontend (ver la nota de la Task 3 sobre
    /// por qué no se genera en Rust). En los tests va fija.
    const AHORA: &str = "2026-09-03T15:21:30.000Z";

    fn aplicar_t(
        root: &Path,
        needle: &str,
        op: &Opciones,
        edits: Vec<FileEdit>,
        replacement: &str,
    ) -> Result<ReplaceOutcome, String> {
        aplicar(root, needle, op, edits, replacement, AHORA)
    }

    fn edits_de(pv: &ReplacePreview) -> Vec<FileEdit> {
        pv.groups
            .iter()
            .map(|g| FileEdit {
                path: g.path.clone(),
                ranges: g.occurrences.iter().map(|o| (o.html_start, o.html_end)).collect(),
            })
            .collect()
    }

    #[test]
    fn apply_escribe_los_capitulos_y_cuenta() {
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica dijo</p>"),
            ("libro/2.html", "<p>Angelica y Angelica</p>"),
        ]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        assert_eq!(out.files, 2);
        assert_eq!(out.occurrences, 3);
        assert!(out.skipped_files.is_empty());
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert!(uno.contains("Angélica dijo"), "quedó {uno:?}");
        let dos = fs::read_to_string(td.path().join("libro/2.html")).unwrap();
        assert!(dos.contains("Angélica y Angélica"), "quedó {dos:?}");
    }

    #[test]
    fn apply_respeta_la_seleccion_parcial() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica y Angelica</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        // Solo la segunda ocurrencia.
        let segunda = pv.groups[0].occurrences[1].clone();
        let edits = vec![FileEdit {
            path: pv.groups[0].path.clone(),
            ranges: vec![(segunda.html_start, segunda.html_end)],
        }];
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits, "Angélica").unwrap();
        assert_eq!(out.occurrences, 1);
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert!(uno.contains("Angelica y Angélica"), "quedó {uno:?}");
    }

    #[test]
    fn apply_saltea_el_archivo_que_cambio_desde_el_preview() {
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica dijo</p>"),
            ("libro/2.html", "<p>Angelica calló</p>"),
        ]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        // Alguien reescribe el 2 entre el preview y el apply.
        fs::write(td.path().join("libro/2.html"), "<p>otro texto sin el nombre</p>").unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        assert_eq!(out.files, 1);
        assert_eq!(out.skipped_files.len(), 1);
        assert!(out.skipped_files[0].ends_with("2.html"));
        // Y no lo pisó.
        let dos = fs::read_to_string(td.path().join("libro/2.html")).unwrap();
        assert_eq!(dos, "<p>otro texto sin el nombre</p>");
    }

    #[test]
    fn apply_con_rango_duplicado_cuenta_una_sola_ocurrencia() {
        // `aplicar_ranges` colapsa el duplicado a una sola escritura; el
        // conteo tiene que coincidir con eso, no con lo pedido.
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let occ = pv.groups[0].occurrences[0].clone();
        let edits = vec![FileEdit {
            path: pv.groups[0].path.clone(),
            ranges: vec![(occ.html_start, occ.html_end), (occ.html_start, occ.html_end)],
        }];
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits, "Angélica").unwrap();
        assert_eq!(out.occurrences, 1, "el duplicado no cuenta dos veces");
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert!(uno.contains("Angélica dijo"), "quedó {uno:?}");
    }

    #[test]
    fn apply_dos_edits_del_mismo_path_se_pliegan_y_no_se_pisan() {
        // Critical 2 de la review r1: dos `FileEdit` para el mismo archivo
        // (uno por selección, no por grupo) no pueden generar dos
        // `Pendiente` independientes calculados sobre el mismo html
        // original — el segundo pisaría al primero y se perdería un
        // reemplazo que el autor tildó.
        let td = scope_con(&[("libro/1.html", "<p>Angelica y Angelica</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let occs = pv.groups[0].occurrences.clone();
        assert_eq!(occs.len(), 2);
        let edits = vec![
            FileEdit {
                path: pv.groups[0].path.clone(),
                ranges: vec![(occs[0].html_start, occs[0].html_end)],
            },
            FileEdit {
                path: pv.groups[0].path.clone(),
                ranges: vec![(occs[1].html_start, occs[1].html_end)],
            },
        ];
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits, "Angélica").unwrap();
        assert_eq!(out.files, 1, "un solo archivo, no dos");
        assert_eq!(out.occurrences, 2, "los dos reemplazos, ninguno pisado");
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert!(uno.contains("Angélica y Angélica"), "quedó {uno:?}");
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(snap.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(
            manifest["files"].as_array().unwrap().len(),
            1,
            "una sola entrada de manifest por archivo, no una por FileEdit"
        );
    }

    #[test]
    #[cfg(unix)]
    fn apply_corta_al_primer_fallo_de_escritura_y_deja_registro() {
        // Critical 1 de la review r1: un fallo de escritura a mitad de lote
        // (acá simulado con permisos, en la realidad disco lleno / archivo
        // tomado por el servicio de sync) no puede tirar el `ReplaceOutcome`
        // entero por un `Err` — el spec pide el conteo real y el
        // `snapshot_id`, que es lo único que le permite al autor deshacer lo
        // que sí se escribió.
        use std::os::unix::fs::PermissionsExt;
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica uno</p>"),
            ("libro/2.html", "<p>Angelica dos</p>"),
            ("libro/3.html", "<p>Angelica tres</p>"),
        ]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let dos = td.path().join("libro/2.html");
        fs::set_permissions(&dos, fs::Permissions::from_mode(0o444)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica");
        // Restaurar permisos antes de cualquier assert que pueda cortar el
        // test, para no dejar basura ilegible en el tmpdir.
        let _ = fs::set_permissions(&dos, fs::Permissions::from_mode(0o644));
        let out = out.expect("un fallo de escritura reporta, no aborta con Err");

        assert_eq!(out.files, 1, "solo 1.html se alcanzó a escribir antes del corte");
        assert_eq!(out.occurrences, 1);
        assert_eq!(out.failed_files.len(), 1);
        assert!(out.failed_files[0].contains("2.html"), "{:?}", out.failed_files);
        assert!(!out.snapshot_id.is_empty(), "sin snapshot_id no hay cómo deshacer");

        // El snapshot cubre los tres originales, incluido el que falló y el
        // que ni se llegó a intentar.
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        assert!(snap.join("manifest.json").exists());
        assert!(fs::read_to_string(snap.join("libro/2.html")).unwrap().contains("Angelica dos"));
        assert!(fs::read_to_string(snap.join("libro/3.html")).unwrap().contains("Angelica tres"));

        // 1.html sí se reescribió; 2.html quedó con el contenido de siempre
        // (los permisos bloquean la escritura, no corrompen lo que había);
        // 3.html ni se tocó.
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert!(uno.contains("Angélica uno"), "quedó {uno:?}");
        let dos_disco = fs::read_to_string(&dos).unwrap();
        assert!(dos_disco.contains("Angelica dos"), "no debe pisarse: {dos_disco:?}");
        let tres = fs::read_to_string(td.path().join("libro/3.html")).unwrap();
        assert!(tres.contains("Angelica tres"), "ni se intenta: {tres:?}");
    }

    #[test]
    fn apply_que_aborta_no_borra_el_snapshot_anterior() {
        // Important 3 de la review r1: el snapshot anterior no puede
        // borrarse hasta que el nuevo esté completo. Repro: un segundo apply
        // que pasa la revalidación (el archivo existe y el needle matchea)
        // pero aborta al resolver `relative_key` porque el capítulo está
        // fuera del root — el undo del primer apply tiene que seguir ahí.
        let td = scope_con(&[("libro/1.html", "<p>uno uno</p>")]);
        let pv1 = preview_scope(td.path(), "uno", &ops(false, true)).unwrap();
        let a = aplicar_t(td.path(), "uno", &ops(false, true), edits_de(&pv1), "dos").unwrap();
        assert!(!a.snapshot_id.is_empty());

        let afuera = TempDir::new().unwrap();
        fs::write(afuera.path().join("x.html"), "<p>Angelica</p>").unwrap();
        let pv_afuera = preview_scope(afuera.path(), "Angelica", &ops(false, true)).unwrap();
        let err = aplicar_t(
            td.path(),
            "Angelica",
            &ops(false, true),
            edits_de(&pv_afuera),
            "tres",
        )
        .unwrap_err();
        assert!(err.contains("fuera del root"), "{err}");

        let snap = td.path().join(".twriter/undo").join(&a.snapshot_id);
        assert!(snap.join("manifest.json").exists(), "el undo anterior no debe desaparecer");
        assert!(fs::read_to_string(snap.join("libro/1.html")).unwrap().contains("uno uno"));
    }

    #[test]
    fn apply_rechaza_un_rel_con_traversal() {
        // Minor 8 de la review r1: `relative_key` es léxico y no normaliza,
        // así que un `..` en el path del edit se saldría de `snap_dir` al
        // escribir el snapshot. `replace_apply` es el borde JS → Rust, y ahí
        // la validación de input no se difiere.
        let td = scope_con(&[("libro/1.html", "<p>Angelica</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let occ = pv.groups[0].occurrences[0].clone();
        // Mismo archivo real (el SO lo resuelve igual al abrirlo), pero el
        // string del path trae un `..` en el medio.
        let con_traversal = td.path().join("libro/../libro/1.html").to_string_lossy().into_owned();
        let edits = vec![FileEdit {
            path: con_traversal,
            ranges: vec![(occ.html_start, occ.html_end)],
        }];
        let err = aplicar_t(td.path(), "Angelica", &ops(false, true), edits, "Angélica").unwrap_err();
        assert!(err.contains(".."), "{err}");
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert!(uno.contains("Angelica"), "no debe tocarse: {uno:?}");
        assert!(!td.path().join(".twriter/undo").exists(), "no debe quedar snapshot");
    }

    #[test]
    fn apply_deja_el_snapshot_con_los_originales() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        assert!(snap.join("manifest.json").exists());
        let original = fs::read_to_string(snap.join("libro/1.html")).unwrap();
        assert!(original.contains("Angelica dijo"), "el snapshot guarda el previo");
    }

    #[test]
    fn apply_borra_el_snapshot_anterior() {
        let td = scope_con(&[("libro/1.html", "<p>uno uno</p>")]);
        let pv1 = preview_scope(td.path(), "uno", &ops(false, true)).unwrap();
        let _a = aplicar_t(td.path(), "uno", &ops(false, true), edits_de(&pv1), "dos").unwrap();
        let pv2 = preview_scope(td.path(), "dos", &ops(false, true)).unwrap();
        let b = aplicar_t(td.path(), "dos", &ops(false, true), edits_de(&pv2), "tres").unwrap();
        // Sin `assert_ne!` sobre los ids ni sleep entre los dos applies: si
        // caen en el mismo milisegundo, el id se sufija en vez de chocar (ver
        // `apply_dos_applies_en_el_mismo_milisegundo_no_chocan`). Lo único
        // que importa acá es que sobreviva exactamente el snapshot del
        // segundo apply.
        let undo_dir = td.path().join(".twriter/undo");
        let quedan: Vec<_> = fs::read_dir(&undo_dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(quedan.len(), 1, "solo se guarda el último");
        assert_eq!(quedan[0].file_name().to_string_lossy(), b.snapshot_id);
    }

    #[test]
    fn apply_dos_applies_en_el_mismo_milisegundo_no_chocan() {
        // Fix round 2: un id repetido (dos applies en el mismo milisegundo,
        // o un reloj que retrocedió) ya no aborta el segundo apply — se
        // sufija (`undo-<ms>`, `undo-<ms>-1`, ...) hasta encontrar uno libre.
        // Sin sleep entre los dos applies a propósito: la propiedad tiene
        // que sostenerse choquen o no, no depender de que no choquen.
        let td = scope_con(&[("libro/1.html", "<p>uno uno</p>")]);
        let pv1 = preview_scope(td.path(), "uno", &ops(false, true)).unwrap();
        let a = aplicar_t(td.path(), "uno", &ops(false, true), edits_de(&pv1), "dos").unwrap();
        assert!(!a.snapshot_id.is_empty());
        let pv2 = preview_scope(td.path(), "dos", &ops(false, true)).unwrap();
        let b = aplicar_t(td.path(), "dos", &ops(false, true), edits_de(&pv2), "tres").unwrap();
        assert!(!b.snapshot_id.is_empty(), "el segundo no debe fallar por la colisión");
        let undo_dir = td.path().join(".twriter/undo");
        let quedan: Vec<_> = fs::read_dir(&undo_dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(quedan.len(), 1, "solo queda un directorio de snapshot");
        assert_eq!(quedan[0].file_name().to_string_lossy(), b.snapshot_id);
    }

    #[test]
    fn apply_actualiza_palabras_en_stats() {
        let td = scope_con(&[("libro/1.html", "<p>dijo no obstante que sí</p>")]);
        let pv = preview_scope(td.path(), "no obstante", &ops(false, true)).unwrap();
        aplicar_t(td.path(), "no obstante", &ops(false, true), edits_de(&pv), "pero").unwrap();
        let stats = crate::stats::read_stats(td.path());
        let stat = stats.get("libro/1.html").expect("stats para el capítulo");
        assert_eq!(stat.palabras, 4, "«dijo pero que sí» son 4 palabras");
        assert_eq!(stat.ultima_edicion.as_deref(), Some(AHORA));
    }

    #[test]
    fn apply_sin_edits_no_hace_nada() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica</p>")]);
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), vec![], "Angélica").unwrap();
        assert_eq!(out.files, 0);
        assert!(out.snapshot_id.is_empty(), "sin escrituras no hay snapshot");
        assert!(!td.path().join(".twriter/undo").exists());
    }
}
