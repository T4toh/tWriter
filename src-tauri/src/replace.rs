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
fn aplicar_ranges(
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

/// Escapa el texto de reemplazo antes de que entre al HTML.
///
/// El autor tipea TEXTO PLANO —el spec deja "regex / markup" fuera de
/// alcance—, así que si escribe `Marks & Spencer` tiene que ver eso en su
/// novela. Sin escapar, ese `&` suelto es un error fatal de parseo meses
/// después, al exportar: `epub.rs::build_part_xhtml` embebe el cuerpo del
/// capítulo verbatim adentro del shell XHTML, donde `&` desnudo no es válido.
/// Y un `<b>` tipeado se colaría fuera del subset del schema de TipTap.
///
/// Solo los tres de contenido: el replacement nunca cae adentro de un
/// atributo, así que las comillas no hacen falta. El `&` va primero o
/// escaparía los `&` que generan los otros dos.
fn escapar_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
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
    /// `<path>#<html_start>`. Estable entre previews del mismo archivo
    /// MIENTRAS no se escriba en el medio, así que destildar una ocurrencia
    /// sobrevive a un re-preview por debounce pero NO a un apply: el primer
    /// reemplazo corre el offset de todo lo que viene después y los ids
    /// cambian. Por eso el frontend arranca sin nada seleccionado tras
    /// aplicar, en vez de intentar reusar la selección vieja.
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

// Los tres comandos son `async` + `spawn_blocking` (mismo patrón que
// `search.rs::search_reindex`): en Tauri 2 un comando sync corre en el main
// thread, y estos tres caminan el scope entero leyendo cada `.html` a String.
// `replace_preview` es el peor: se dispara cada 250 ms mientras se tipea, y
// sobre Dropbox o iCloud un `read_to_string` de un archivo desmaterializado
// bloquea hasta que baja de la red — o sea la ventana congelada y sin spinner,
// porque el hilo que lo pintaría es el que está bloqueado.
#[tauri::command]
pub async fn replace_preview(
    scope_path: String,
    needle: String,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<ReplacePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        preview_scope(
            Path::new(&scope_path),
            needle.as_str(),
            &Opciones { case_sensitive, whole_word },
        )
    })
    .await
    .map_err(|e| format!("task: {e}"))?
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
    ///
    /// OJO al renderizar: no son todos capítulos. Acá también caen
    /// `.twriter/stats.json` (si el conteo de palabras no se pudo guardar) y
    /// el `manifest.json` del snapshot (si no se pudo reescribir con los
    /// mtimes reales). Un toast que los liste como "capítulos que no se
    /// pudieron escribir" miente en esos dos casos.
    pub failed_files: Vec<String>,
    /// Vacío solo si no se INTENTÓ escribir ningún capítulo (sin edits, todo
    /// salteado por la revalidación o por el guard de la fase 3): ahí no hay
    /// que deshacer y el snapshot se borra. Si una escritura se intentó y
    /// falló, esto vuelve poblado aunque `files` sea 0: `write_chapter` es
    /// tmp+rename, así que el capítulo que falló quedó intacto, pero el lote
    /// puede haber reescrito capítulos anteriores y el id es lo único que
    /// deja deshacerlos.
    pub snapshot_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    pub rel: String,
    pub occurrences: usize,
    /// mtime en segundos epoch DESPUÉS de escribir. **Fallback**: desde que
    /// existe `hash_after_apply` el guard del undo va por contenido, y esto
    /// solo decide para los snapshots que quedaron en disco de antes (sin el
    /// campo del hash). Se sigue registrando para que un downgrade de la app
    /// no se quede sin guard.
    ///
    /// `0` es un sentinel, NO un mtime real: significa "no se pudo
    /// registrar" (el capítulo no llegó a escribirse, o la reescritura final
    /// del manifest falló y quedó el manifest inicial en disco). El undo NO
    /// puede usar `0` como gate para bloquear el restore — al revés, con `0`
    /// tiene que restaurar igual. Bloquear ahí sería negarle el Deshacer al
    /// autor justo en el caso en que más lo necesita: un lote que falló a
    /// mitad de camino.
    pub mtime_after_apply: u64,
    /// Hash del contenido que quedó en disco DESPUÉS de escribir. Es el guard
    /// del undo: si el contenido de hoy hashea igual, nadie tocó el capítulo
    /// desde el reemplazo y restaurar es seguro; si no, se editó después (sea
    /// cual sea el mtime) y va a `blocked`.
    ///
    /// Content-addressed en vez de time-addressed porque el mtime no alcanza:
    /// su resolución es la del filesystem, y en HFS+/exFAT/SMB —donde vive el
    /// repo si está en Dropbox o iCloud— es de un segundo, así que una edición
    /// ajena que cae en el mismo segundo que el reemplazo le queda invisible.
    ///
    /// `None` es el mismo sentinel que el `0` del mtime ("no se pudo
    /// registrar", restaurar igual), y además es lo que trae un manifest
    /// viejo, escrito antes de que el campo existiera: ahí el guard cae al
    /// mtime en vez de quedarse sin guard.
    #[serde(default)]
    pub hash_after_apply: Option<String>,
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

/// FNV-1a de 64 bits, en hex. Elegido por lo que NO necesita: no es
/// criptográfico (acá el "adversario" es un autosave o un `git pull`, no
/// alguien fabricando una colisión), no es una dependencia nueva, y a
/// diferencia del `DefaultHasher` de la std es estable de por vida — el valor
/// va a un archivo en disco que una versión posterior de la app tiene que poder
/// comparar.
fn hash_contenido(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Hash del contenido que hay en disco. `None` si no se pudo leer: en el apply
/// eso es el sentinel de "no pude registrar" (el undo restaura igual), y en el
/// undo significa que no hay con qué comparar.
fn hash_de_archivo(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| hash_contenido(&b))
}

/// Un `rel` del manifest con segmento vacío, `.` o `..` se sale del root al
/// hacer `join`. Lo valida `aplicar` antes de crear el snapshot y `deshacer`
/// antes de escribir: el manifest vive en `.twriter/` (local, gitignored), pero
/// es la ÚNICA autoridad que el undo consulta para decidir qué archivo pisar, y
/// `write_chapter` no valida ni root ni extensión.
///
/// También rechaza el separador de Windows: `relative_key` normaliza `\\` a
/// `/`, así que ningún `rel` legítimo lo trae, y en Windows `..\\x` traversa
/// igual que `../x`.
fn rel_valido(rel: &str) -> bool {
    if rel.split(['/', '\\']).any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return false;
    }
    // Y tiene que ser un capítulo. Sin esto el manifest podía nombrar
    // `libro/book.json`, `.twriter/stats.json` o `.git/config` —todos ADENTRO
    // del root, así que el chequeo de traversal no los ve— y `deshacer` los
    // sobrescribía con el contenido del snapshot; `write_chapter` no valida
    // extensión. Case-insensitive, aunque `audit::chapter_paths` solo devuelva
    // `.html` en minúscula: acá el input es el manifest, no el walk.
    Path::new(rel).extension().is_some_and(|e| e.eq_ignore_ascii_case("html"))
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
    //
    // La key es el path NORMALIZADO por `Components`, no el string crudo:
    // `Components` colapsa los `.`, los separadores repetidos y la barra
    // final, así que dos grafías del mismo archivo (`<root>/./libro/1.html`
    // y `<root>//libro/1.html`) caen en la misma entrada en vez de plegarse
    // por separado. El chequeo de segmentos de la fase 2 no alcanzaba para
    // atraparlas: corre sobre el `rel` que devuelve `strip_prefix`, que ya
    // viene normalizado por `Components` y por lo tanto limpio. `..` sí
    // sobrevive a la normalización (a propósito: es el chequeo de traversal
    // el que tiene que rechazarlo, no un colapso silencioso), y nada de esto
    // toca el filesystem — `canonicalize` está descartado porque falla si el
    // archivo no existe y resuelve symlinks que en Dropbox o iCloud apuntan a
    // otro lado.
    let mut por_path: std::collections::BTreeMap<PathBuf, Vec<(usize, usize)>> =
        std::collections::BTreeMap::new();
    for edit in edits {
        por_path
            .entry(PathBuf::from(&edit.path).components().collect::<PathBuf>())
            .or_default()
            .extend(edit.ranges);
    }

    // 1. Revalidar: cada range pedido tiene que seguir existiendo hoy.
    struct Pendiente {
        path: PathBuf,
        html: String,
        nuevo: String,
        ocurrencias: usize,
    }
    let mut pendientes: Vec<Pendiente> = Vec::new();
    // Se escapa una sola vez acá y no adentro del loop: lo que se guarda en el
    // manifest del snapshot sigue siendo el literal que tipeó el autor, que es
    // lo que el panel le muestra.
    let replacement_html = escapar_html(replacement);
    for (path, mut ranges) in por_path {
        if ranges.is_empty() {
            continue;
        }
        let path_str = path.to_string_lossy().into_owned();
        let Ok(html) = std::fs::read_to_string(&path) else {
            out.skipped_files.push(path_str);
            continue;
        };
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
        let nuevo = aplicar_ranges(&html, ranges, &replacement_html);
        pendientes.push(Pendiente { path, html, nuevo, ocurrencias });
    }
    if pendientes.is_empty() {
        return Ok(out);
    }

    // 2. Snapshot de los sobrevivientes. Nada de esto toca un capítulo real
    // todavía, así que puede abortar con `?`/`return Err` sin dejar al autor
    // sin red: el undo anterior (si hay) sigue intacto hasta el final de
    // este bloque.
    let undo_root = root.join(UNDO_SUBDIR);

    // Resolver todos los `rel` primero: si alguno falla (capítulo fuera del
    // root, o un `rel` que se saldría de `snap_dir` al escribir el snapshot),
    // abortar ACÁ, antes de reclamar ningún directorio — así el snapshot
    // anterior no se pierde por un request malformado. El caso vivo es `..`:
    // los `.` y los separadores repetidos ya los colapsó la normalización de
    // la fase 0, y un `rel` vacío es el path del root mismo.
    let mut manifest_files: Vec<SnapshotFile> = Vec::new();
    for p in &pendientes {
        let rel = crate::stats::relative_key(root, &p.path)
            .ok_or_else(|| format!("capítulo fuera del root: {}", p.path.display()))?;
        if !rel_valido(&rel) {
            return Err(format!("path de capítulo inválido: {}", p.path.display()));
        }
        manifest_files.push(SnapshotFile {
            rel,
            occurrences: p.ocurrencias,
            mtime_after_apply: 0,
            hash_after_apply: None,
        });
    }

    // Reclamar el id ATÓMICAMENTE con `create_dir` (falla si ya existe, a
    // diferencia de `create_dir_all`): un `exists()` y crear después dejaba
    // una ventana donde dos `replace_apply` concurrentes (los comandos Tauri
    // corren en threads propios; el guard `applying` vive en el frontend, que
    // es justo el lado que no cubre esto) podían elegir el mismo id y
    // terminar escribiendo los dos adentro del mismo snapshot.
    std::fs::create_dir_all(&undo_root)
        .map_err(|e| format!("mkdir {}: {}", undo_root.display(), e))?;
    let base_id = nuevo_snapshot_id();
    let (mut id, mut sufijo) = (base_id.clone(), 1u32);
    let snap_dir = loop {
        let d = undo_root.join(&id);
        match std::fs::create_dir(&d) {
            Ok(()) => break d,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                id = format!("{base_id}-{sufijo}");
                sufijo += 1;
            }
            Err(e) => return Err(format!("mkdir {}: {}", d.display(), e)),
        }
    };

    // Escribir los originales + el manifest inicial (mtimes en 0, se
    // completan en la fase 3). Que el manifest exista ANTES del primer
    // `write_chapter` es lo que evita que un snapshot quede sin él si algo
    // falla a mitad del lote real.
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
    let mut salteados: Vec<usize> = Vec::new();
    // Hasta dónde llegó el lote real. El `break` de abajo deja capítulos sin
    // intentar y NO se pueden listar en el manifest: su copia es idéntica al
    // disco hoy, pero el autor puede deshacer días después y con ediciones en
    // el medio, y como su `mtime_after_apply` queda en el sentinel `0` —que
    // saltea el guard del undo por diseño— restaurarlos borraría trabajo que
    // este reemplazo nunca tocó.
    let mut ultimo_intentado: Option<usize> = None;
    for (idx, p) in pendientes.iter().enumerate() {
        // `nuevo` se calculó en la fase 1 sobre el `html` leído ahí. Entre
        // ese read y este punto puede pasar un autosave, un `git pull` o un
        // write de la otra PC — la misma ventana que justifica la
        // revalidación de la fase 1, pero más chica. Sin este chequeo,
        // `write_chapter` de abajo pisaría esa edición ajena con `nuevo`
        // calculado sobre el html VIEJO, perdiéndola en silencio.
        //
        // Compara CONTENIDO, no mtime: el mtime tiene la resolución del
        // filesystem (1 segundo en HFS+/exFAT/SMB, que es donde vive el repo
        // si está en Dropbox o iCloud), así que un write ajeno que caiga en el
        // mismo segundo que el read de la fase 1 le queda invisible — y en un
        // lote chico la ventana entera cabe adentro de un segundo. El
        // contenido no depende del reloj ni del volumen. Cuesta releer el
        // archivo que estamos por escribir, que acaba de pasar por el page
        // cache.
        //
        // De arrastre se va un falso positivo que el mtime tenía hasta en
        // APFS: un autosave que reescribe contenido IDÉNTICO movía el mtime y
        // el capítulo se salteaba sin motivo, cuando `nuevo` seguía siendo
        // válido.
        //
        // Un archivo ilegible cuenta como cambiado (`None != Some`), igual que
        // antes: no se pisa lo que no se pudo leer.
        let en_disco = std::fs::read_to_string(&p.path).ok();
        if en_disco.as_deref() != Some(p.html.as_str()) {
            // Cambió entre el read de la fase 1 y este punto. Mismo canal y
            // semántica que la revalidación: "cambió desde que lo leí", no
            // se pisa.
            tracing::warn!(
                target: "replace",
                path = %p.path.display(),
                "el archivo cambió justo antes de escribir, no lo piso"
            );
            out.skipped_files.push(p.path.to_string_lossy().into_owned());
            // Y fuera del manifest final: su entrada quedaría con el
            // sentinel `0`, que le dice al undo "restaurá igual" — o sea que
            // el Deshacer pisaría justo la edición ajena que este guard
            // acaba de proteger. La copia de la fase 2 se queda adentro del
            // snapshot sin listar (inofensiva: nadie la mira).
            salteados.push(idx);
            continue;
        }
        ultimo_intentado = Some(idx);
        match crate::fs::write_chapter(p.path.to_string_lossy().into_owned(), p.nuevo.clone()) {
            Ok(()) => {
                out.files += 1;
                out.occurrences += p.ocurrencias;
                manifest_files[idx].mtime_after_apply = mtime_epoch(&p.path);
                // Del disco, no de `p.nuevo`: `write_chapter` le agrega el
                // `\n` final si falta, así que hashear lo que teníamos en
                // memoria daría un valor que el undo nunca va a poder igualar
                // leyendo el archivo.
                manifest_files[idx].hash_after_apply = hash_de_archivo(&p.path);
                stats.insert(
                    manifest_files[idx].rel.clone(),
                    crate::stats::ChapterStat {
                        palabras: crate::import::count_words(&p.nuevo),
                        ultima_edicion: Some(ultima_edicion.to_string()),
                    },
                );
            }
            Err(e) => {
                // Registrar el mtime IGUAL que en el camino feliz. Dejarlo en
                // el sentinel `0` —que saltea el guard del undo por diseño—
                // era el agujero del Critical 1 en la otra rama: el capítulo
                // quedaba restaurable sin red para siempre, y el Deshacer de
                // días después le pisaba las ediciones nuevas. Con el mtime
                // real las tres formas del fallo se resuelven solas: truncado
                // ⇒ el hash es el del disco de ahora ⇒ restaura; intacto ⇒
                // idem ⇒ restaura; editado después ⇒ el hash cambió ⇒ va a
                // `blocked` y el autor decide. Los sentinels (`0` / `None`)
                // quedan para lo único que los motivó: "escribí pero no pude
                // leer el archivo".
                manifest_files[idx].mtime_after_apply = mtime_epoch(&p.path);
                manifest_files[idx].hash_after_apply = hash_de_archivo(&p.path);
                out.failed_files.push(format!("{}: {}", p.path.display(), e));
                break;
            }
        }
    }

    if out.files == 0 && out.failed_files.is_empty() {
        // Nada que deshacer: ninguna escritura se intentó siquiera, todas se
        // saltearon por el guard de la fase 3. `stats` no cambió (nadie llegó
        // insert), y dejar un snapshot sin ningún capítulo real ensuciaría
        // `.twriter/undo` con un Deshacer que además sería DAÑINO: restaurar
        // pisaría justo la edición ajena que el guard acaba de proteger.
        //
        // `failed_files` es lo que separa este caso de "se intentó escribir y
        // falló", que también da `files == 0` y por el que hay que pasar por
        // el camino normal. Desde que `write_chapter` escribe con tmp+rename,
        // un fallo (ENOSPC, EIO, quota) deja el capítulo viejo entero en vez
        // de truncado, así que el snapshot ya no es la única copia — pero se
        // conserva igual: es la red del lote entero, no de ese archivo, y
        // borrarlo le saca el id al autor cuando el fallo llegó a mitad de
        // camino.
        //
        // Y de acá depende algo del undo: `deshacer` borra el snapshot cuando
        // no queda nada bloqueado ni fallado, así que un manifest con
        // `files: []` lo borraría sin restaurar nada. `aplicar` no puede
        // producirlo justamente por este `return`: si no se intentó ninguna
        // escritura sale por acá (y el snapshot se va ahora), y si se intentó
        // alguna, el filtro del manifest final deja listada al menos esa.
        //
        // OJO, esto es load-bearing: en ESTE punto `failed_files` contiene
        // solo capítulos. Los pushes de `stats.json` y del `manifest.json`
        // están deliberadamente DEBAJO de este `if`. Mover el `write_stats`
        // acá arriba, o agregar cualquier push de un no-capítulo antes de
        // este chequeo, hace que un fallo ajeno a los capítulos conserve un
        // snapshot que hay que borrar — el bug al revés.
        let _ = std::fs::remove_dir_all(&snap_dir);
        tracing::info!(
            target: "replace",
            needle,
            replacement,
            skipped = out.skipped_files.len(),
            failed = out.failed_files.len(),
            "replace_apply sin escrituras"
        );
        return Ok(out);
    }

    // El snapshot es el que hay que poder deshacer: o cubre un capítulo que
    // se escribió, o cubre uno que la escritura pudo dejar dañado. Recién
    // ahora se barren los hermanos de `id` en `undo_root` — si no se hubiera
    // intentado ninguna escritura (arriba), el undo anterior seguía intacto.
    // Que un lote fallido consuma el slot de undo es el precio de tener un
    // solo slot: preferimos perder el Deshacer del apply anterior antes que
    // el original del capítulo que este apply acaba de dañar.
    // Filtrado por el prefijo `undo-` (así el barrido no se come algo que
    // una Task futura quiera guardar en la misma carpeta) y logueado si
    // falla, en vez de tragarse el error: si el barrido no puede limpiar,
    // `.twriter/undo` acumula copias de capítulos sin que nada lo diga.
    if let Ok(entries) = std::fs::read_dir(&undo_root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == std::ffi::OsStr::new(id.as_str()) {
                continue;
            }
            if !name.to_string_lossy().starts_with("undo-") {
                continue;
            }
            if let Err(e) = std::fs::remove_dir_all(entry.path()) {
                tracing::warn!(
                    target: "replace",
                    dir = %entry.path().display(),
                    error = %e,
                    "no se pudo barrer un snapshot anterior"
                );
            }
        }
    }

    // Read-modify-write del mapa entero: si un autosave llama a
    // `write_chapter_stats` justo en esta ventana, ese `insert` se pisa acá.
    // Es cosmético (se autocura en el próximo save de ese capítulo, que
    // vuelve a leer y reescribir el mapa) y un lock para esto no se
    // justifica — el brief ya pide un solo read/write para todo el lote.
    if let Err(e) = crate::stats::write_stats(root, &stats) {
        // El autor no ve `tracing::error!`: si se queda solo en el log, el
        // toast dice éxito mientras `stats.json` quedó viejo. Mismo canal
        // que los capítulos que no se pudieron escribir.
        tracing::error!(target: "replace", error = %e, "no se pudo guardar stats tras el reemplazo");
        out.failed_files.push(format!("{}: {}", root.join(".twriter/stats.json").display(), e));
    }

    // El manifest final lista solo los capítulos que este apply tocó o
    // intentó tocar. Sin ese recorte, el sentinel `0` conflaría cuatro estados
    // que quieren cosas distintas del undo: "escrito pero no pude registrar el
    // mtime" y "intentado y quizás truncado" (los dos: restaurar), contra
    // "salteado porque hay una edición ajena más nueva" y "nunca intentado,
    // quedó después del `break`" (los dos: NO restaurar). Las copias de los
    // dos últimos se quedan adentro del snapshot sin listar, inofensivas.
    let files: Vec<SnapshotFile> = manifest_files
        .into_iter()
        .enumerate()
        .filter(|(idx, _)| ultimo_intentado.is_some_and(|u| *idx <= u) && !salteados.contains(idx))
        .map(|(_, mf)| mf)
        .collect();
    let manifest_final = SnapshotManifest {
        id: id.clone(),
        when: ultima_edicion.to_string(),
        needle: needle.to_string(),
        replacement: replacement.to_string(),
        files,
    };
    let manifest_path = snap_dir.join("manifest.json");
    match serde_json::to_string_pretty(&manifest_final) {
        Ok(json) => {
            // tmp + rename, igual que `stats::write_stats`: un `fs::write`
            // pelado acá abre `manifest.json` con `O_TRUNC` y, si falla a
            // mitad, se lleva puesto el manifest INICIAL —que estaba
            // completo y era válido— dejando el snapshot ilegible justo
            // cuando los capítulos ya cambiaron en disco. Un snapshot sin
            // manifest es un snapshot que no se puede deshacer.
            let tmp = snap_dir.join("manifest.json.tmp");
            if let Err(e) = std::fs::write(&tmp, json)
                .and_then(|()| std::fs::rename(&tmp, &manifest_path))
            {
                // Mismo motivo que arriba: si esto solo loguea, el registro
                // de Deshacer queda con los mtimes en el sentinel `0` de
                // todas formas (ver el doc comment del campo) y el autor no
                // se entera de que el manifest no reflejó la escritura real.
                tracing::error!(target: "replace", error = %e, "no se pudo reescribir el manifest final");
                out.failed_files.push(format!("{}: {}", manifest_path.display(), e));
            }
        }
        Err(e) => {
            tracing::error!(target: "replace", error = %e, "no se pudo serializar el manifest final");
            out.failed_files.push(format!("{}: {}", manifest_path.display(), e));
        }
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
pub async fn replace_apply(
    root: String,
    needle: String,
    case_sensitive: bool,
    whole_word: bool,
    edits: Vec<FileEdit>,
    replacement: String,
    ultima_edicion: String,
) -> Result<ReplaceOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        aplicar(
            Path::new(&root),
            needle.as_str(),
            &Opciones { case_sensitive, whole_word },
            edits,
            replacement.as_str(),
            ultima_edicion.as_str(),
        )
    })
    .await
    .map_err(|e| format!("task: {e}"))?
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub restored: usize,
    /// Paths que se editaron DESPUÉS del reemplazo. No se pisaron; el panel
    /// los muestra y pide confirmación para forzarlos.
    pub blocked: Vec<String>,
    /// Lo que no se pudo restaurar, en formato `"<path>: <error>"` (mismo que
    /// `ReplaceOutcome::failed_files`). Va por acá y no por un `Err` porque
    /// perder el `UndoOutcome` entero es lo que deja al autor sin saber qué
    /// volvió al original y qué no.
    ///
    /// OJO al renderizar: no son todos capítulos. Acá también cae
    /// `.twriter/stats.json` (si el conteo de palabras no se pudo guardar).
    /// Un toast que los liste como "capítulos que no se pudieron restaurar"
    /// miente en ese caso.
    pub failed: Vec<String>,
    /// `true` cuando lo que hay en `blocked` se bloqueó porque el REGISTRO
    /// quedó incompleto (residuo del rename del manifest), no porque el
    /// capítulo se haya editado después del reemplazo. Son dos cosas
    /// distintas y la UI tiene que decirlas distinto: con esto en `false`,
    /// "Pisarlos igual" pisa ediciones propias y recientes del autor; con
    /// esto en `true`, la app no sabe si restaurar es seguro.
    pub suspect: bool,
}

/// Restaura el snapshot. Ver el contexto de la Task 4: el guard por hash del
/// contenido es lo que evita comerse las ediciones posteriores al reemplazo.
pub fn deshacer(
    root: &Path,
    snapshot_id: &str,
    force_paths: &[String],
    ultima_edicion: &str,
) -> Result<UndoOutcome, String> {
    // `snapshot_id` es un string crudo del frontend y abajo termina en un
    // `remove_dir_all`. Exigir el prefijo que usa `nuevo_snapshot_id` (y que
    // ya filtra el barrido de hermanos en `aplicar`) descarta de una los
    // segmentos de traversal; el chequeo de separadores tapa lo que el prefijo
    // deja pasar, tipo `undo-1/../..`.
    if !snapshot_id.starts_with("undo-")
        || snapshot_id.contains('/')
        || snapshot_id.contains('\\')
    {
        return Err(format!("id de snapshot inválido: {snapshot_id}"));
    }
    let snap_dir = root.join(UNDO_SUBDIR).join(snapshot_id);
    let manifest_path = snap_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!("no encontré el snapshot {snapshot_id}"));
    }
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("leer manifest de {snapshot_id}: {e}"))?;
    let manifest: SnapshotManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("manifest de {snapshot_id} ilegible: {e}"))?;

    // Si quedó el `.tmp` del rename, el manifest que acabamos de leer puede ser
    // el INICIAL: el que trae todos los campos en el sentinel, o sea el que
    // le dice al undo "restaurá todo igual" incluso lo que el guard de la
    // fase 3 salteó. Un `exists()` y ninguna escritura nueva: con el manifest bajo
    // sospecha nada se restaura solo, todo sale por `blocked` y el panel pide
    // confirmación explícita. No es airtight (si el fallo fue antes de crear el
    // tmp no queda rastro) pero cubre el ENOSPC, que es el caso probable.
    let manifest_sospechoso = snap_dir.join("manifest.json.tmp").exists();

    let mut out = UndoOutcome::default();
    let mut stats = crate::stats::read_stats(root);
    for f in &manifest.files {
        if !rel_valido(&f.rel) {
            // Formato `"<path>: <error>"`, igual que el resto de `failed` y
            // que `ReplaceOutcome::failed_files`: al revés, una UI que parta
            // por el primer `": "` muestra basura.
            out.failed.push(format!("{}: no es un path de capítulo válido", f.rel));
            continue;
        }
        let destino = root.join(&f.rel);
        let origen = snap_dir.join(&f.rel);
        let destino_str = destino.to_string_lossy().into_owned();
        // Normalizado de los dos lados, igual que hace `aplicar` con los edits:
        // el frontend puede rearmar el path del botón "Pisarlos igual" con otra
        // grafía (`<root>/./libro/1.html`) y una comparación de strings crudos
        // dejaría el botón sin efecto.
        let destino_norm = destino.components().collect::<PathBuf>();
        let forzado = force_paths
            .iter()
            .any(|p| PathBuf::from(p).components().collect::<PathBuf>() == destino_norm);
        // El guard va por contenido: si el capítulo hashea igual que lo que el
        // apply dejó escrito, nadie lo tocó. Nada de relojes — el mtime en
        // segundos no distingue una edición ajena que cayó adentro del mismo
        // segundo que el reemplazo, y en HFS+/exFAT/SMB no hay más resolución
        // que esa (ver el doc de `hash_after_apply`).
        //
        // Los sentinels de "no se pudo registrar" (`None` acá, `0` en el
        // mtime) NO bloquean: ahí el capítulo puede estar escrito o truncado
        // por un fallo de escritura, y es justo cuando el autor más necesita
        // deshacer.
        //
        // Un archivo ilegible tampoco bloquea (`is_some_and`): sin contenido
        // con qué comparar, el caso vivo es el capítulo borrado, y restaurarlo
        // es exactamente lo que se le pide al undo. Mismo criterio que tenía el
        // guard de mtime, donde un `metadata` fallido daba `0`.
        let editado_despues = match &f.hash_after_apply {
            Some(h) => hash_de_archivo(&destino).is_some_and(|actual| &actual != h),
            // Manifest viejo (pre-hash): el guard de mtime es lo único que hay.
            None => f.mtime_after_apply != 0 && mtime_epoch(&destino) > f.mtime_after_apply,
        };
        if !forzado && (manifest_sospechoso || editado_despues) {
            out.suspect |= manifest_sospechoso;
            out.blocked.push(destino_str);
            continue;
        }
        let contenido = match std::fs::read_to_string(&origen) {
            Ok(c) => c,
            Err(e) => {
                // El errno pelado no le dice nada al autor, y acá el remedio
                // existe y la app lo tiene a mano: los originales que sí se
                // copiaron siguen en el snapshot, así que nombrar la carpeta de
                // la que puede copiarlos a mano.
                out.failed.push(format!(
                    "{}: el registro de Deshacer está incompleto, falta la copia del original ({e}). Los originales que quedaron están en {}",
                    destino.display(),
                    snap_dir.display()
                ));
                continue;
            }
        };
        let palabras = crate::import::count_words(&contenido);
        // Ni un `?` de acá para abajo: los capítulos anteriores del lote ya
        // volvieron al original en disco, y abortar con `Err` tira el conteo
        // real y el `blocked` — el autor lee "no se pudo deshacer" cuando la
        // mitad se deshizo, y el reintento queda trabado porque los ya
        // restaurados ahora tienen mtime nuevo y salen bloqueados.
        if let Err(e) = crate::fs::write_chapter(destino_str, contenido) {
            out.failed.push(format!("{}: {}", destino.display(), e));
            continue;
        }
        out.restored += 1;
        stats.insert(
            f.rel.clone(),
            crate::stats::ChapterStat {
                palabras,
                ultima_edicion: Some(ultima_edicion.to_string()),
            },
        );
    }
    // Sin restauraciones el mapa quedó igual que en disco: escribirlo sería
    // ruido, y un fallo suyo ensuciaría `failed` con algo que no le pasó a
    // ningún capítulo.
    if out.restored > 0 {
        if let Err(e) = crate::stats::write_stats(root, &stats) {
            tracing::error!(target: "replace", error = %e, "no se pudo guardar stats tras el deshacer");
            out.failed.push(format!("{}: {}", root.join(".twriter/stats.json").display(), e));
        }
    }

    // El snapshot se va solo si no quedó NADA pendiente. `blocked` porque el
    // autor todavía puede querer forzar esos; `failed` porque si no, el primer
    // fallo de escritura borraría la única copia de los originales con la
    // restauración a medias — el snapshot tiene que sobrevivir al reintento.
    if out.blocked.is_empty() && out.failed.is_empty() {
        let _ = std::fs::remove_dir_all(&snap_dir);
    }
    tracing::info!(
        target: "replace",
        snapshot = snapshot_id,
        restored = out.restored,
        blocked = out.blocked.len(),
        failed = out.failed.len(),
        "replace_undo"
    );
    Ok(out)
}

#[tauri::command]
pub async fn replace_undo(
    root: String,
    snapshot_id: String,
    force_paths: Vec<String>,
    ultima_edicion: String,
) -> Result<UndoOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        deshacer(
            Path::new(&root),
            snapshot_id.as_str(),
            &force_paths,
            ultima_edicion.as_str(),
        )
    })
    .await
    .map_err(|e| format!("task: {e}"))?
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

    fn deshacer_t(
        root: &Path,
        snapshot_id: &str,
        force_paths: &[String],
    ) -> Result<UndoOutcome, String> {
        deshacer(root, snapshot_id, force_paths, AHORA)
    }

    /// Empuja el mtime de un archivo 10 s al futuro. Escribir dos veces dentro
    /// del mismo segundo deja el mtime igual y el guard no se ejercitaría.
    fn forzar_mtime_futuro(path: &Path) {
        let t = SystemTime::now() + std::time::Duration::from_secs(10);
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(t).unwrap();
    }

    /// Pisa el mtime con un epoch en segundos exacto. Con el segundo que el
    /// manifest registró, reproduce la edición ajena que cayó DENTRO del mismo
    /// segundo que el reemplazo — lo que en HFS+/exFAT/SMB pasa siempre.
    fn forzar_mtime(path: &Path, secs: u64) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(secs)).unwrap();
    }

    /// Lee el manifest del snapshot.
    fn manifest_de(root: &Path, snapshot_id: &str) -> SnapshotManifest {
        let p = root.join(".twriter/undo").join(snapshot_id).join("manifest.json");
        serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
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

    /// La premisa de la que depende el sembrado de `deselected` en el
    /// frontend: el id lleva el `html_start`, así que el primer reemplazo
    /// corre el id de TODA ocurrencia posterior. Si esto deja de ser cierto,
    /// aquel sembrado se puede simplificar; mientras sea cierto, sacarlo
    /// resucita prendida la ocurrencia que el autor destildó.
    #[test]
    fn tras_aplicar_una_los_ids_de_las_siguientes_se_corren() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica fue. La novela Angelica de otro.</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let segunda_antes = pv.groups[0].occurrences[1].id.clone();
        // Solo la primera: "Angélica" es un byte más larga que "Angelica".
        let primera = pv.groups[0].occurrences[0].clone();
        let edits = vec![FileEdit {
            path: pv.groups[0].path.clone(),
            ranges: vec![(primera.html_start, primera.html_end)],
        }];
        aplicar_t(td.path(), "Angelica", &ops(false, true), edits, "Angélica").unwrap();
        let pv2 = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        assert_eq!(pv2.total, 1, "la sobreviviente sigue ahí");
        assert_ne!(
            pv2.groups[0].occurrences[0].id, segunda_antes,
            "el id de la sobreviviente tiene que haber cambiado de offset"
        );
    }

    #[test]
    fn apply_escapa_el_ampersand_del_replacement() {
        let td = scope_con(&[("libro/1.html", "<p>La casa de Ana.</p>")]);
        let pv = preview_scope(td.path(), "Ana", &ops(false, true)).unwrap();
        aplicar_t(td.path(), "Ana", &ops(false, true), edits_de(&pv), "Ana & Co").unwrap();
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert_eq!(
            uno.trim_end(), "<p>La casa de Ana &amp; Co.</p>",
            "un `&` crudo en el disco rompe el parseo XHTML del EPUB"
        );
    }

    #[test]
    fn apply_escapa_los_angulos_del_replacement() {
        let td = scope_con(&[("libro/1.html", "<p>Dijo casa y se fue.</p>")]);
        let pv = preview_scope(td.path(), "casa", &ops(false, true)).unwrap();
        aplicar_t(td.path(), "casa", &ops(false, true), edits_de(&pv), "<b>casa</b>").unwrap();
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert_eq!(
            uno.trim_end(), "<p>Dijo &lt;b&gt;casa&lt;/b&gt; y se fue.</p>",
            "el reemplazo es literal: si el autor tipea `<b>`, ve `<b>`"
        );
        // Y el `<` escapado no puede haberse comido el `&` de su propia entidad.
        assert!(!uno.contains("&amp;lt;"), "doble escape, quedó {uno:?}");
    }

    #[test]
    fn lo_reemplazado_con_ampersand_se_puede_volver_a_reemplazar() {
        let td = scope_con(&[("libro/1.html", "<p>La casa de Ana.</p>")]);
        let pv = preview_scope(td.path(), "Ana", &ops(false, true)).unwrap();
        aplicar_t(td.path(), "Ana", &ops(false, true), edits_de(&pv), "Ana & Co").unwrap();
        // Round-trip: la entidad corta el run, pero el texto de los dos lados
        // sigue siendo reemplazable. Con el `&` crudo de antes, el run se
        // cortaba igual pero el archivo ya estaba roto para el EPUB.
        let pv2 = preview_scope(td.path(), "Ana", &ops(false, true)).unwrap();
        assert_eq!(pv2.total, 1, "la ocurrencia vecina a la entidad sigue viva");
        aplicar_t(td.path(), "Ana", &ops(false, true), edits_de(&pv2), "Beatriz").unwrap();
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert_eq!(uno.trim_end(), "<p>La casa de Beatriz &amp; Co.</p>");
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
    fn apply_pliega_las_grafias_alternativas_del_mismo_path() {
        // Critical 2, tercer intento: el fold por el string crudo dejaba que
        // dos grafías del mismo archivo generaran dos `Pendiente` sobre el
        // mismo html original, y el segundo pisaba al primero (un reemplazo
        // perdido, dos entradas de manifest, `files` y `skipped` contando el
        // mismo archivo). El chequeo de segmentos sobre `rel` no las
        // atrapaba: `strip_prefix` devuelve el path ya normalizado por
        // `Components`, así que `<root>/./libro/1.html` y `<root>//libro/1.html`
        // llegaban con un `rel` perfectamente limpio. Ahora la key del fold
        // es el path normalizado, y las tres grafías son una sola entrada.
        let td = scope_con(&[("libro/1.html", "<p>Angelica y Angelica y Angelica</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let occs = pv.groups[0].occurrences.clone();
        assert_eq!(occs.len(), 3);
        let normal = pv.groups[0].path.clone();
        // El `.` va PEGADO AL ROOT, no en el medio: `strip_prefix` trimea
        // solo en la frontera del prefijo, así que `<root>/./libro/1.html`
        // llegaba con un `rel` limpio y pasaba el chequeo de segmentos,
        // mientras que un `.` en el medio (`<root>/libro/./1.html`) ya lo
        // rechazaba. Este es el agujero que el fold normalizado cierra.
        let con_punto = format!("{}/./libro/1.html", td.path().to_string_lossy());
        let con_doble_barra = format!("{}//libro/1.html", td.path().to_string_lossy());
        let edits = vec![
            FileEdit { path: normal, ranges: vec![(occs[0].html_start, occs[0].html_end)] },
            FileEdit { path: con_punto, ranges: vec![(occs[1].html_start, occs[1].html_end)] },
            FileEdit {
                path: con_doble_barra,
                ranges: vec![(occs[2].html_start, occs[2].html_end)],
            },
        ];
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits, "Angélica").unwrap();
        assert_eq!(out.files, 1, "un solo archivo, no tres");
        assert_eq!(out.occurrences, 3, "los tres reemplazos, ninguno pisado");
        assert!(out.skipped_files.is_empty(), "nada salteado: {:?}", out.skipped_files);
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert_eq!(uno.trim_end(), "<p>Angélica y Angélica y Angélica</p>", "quedó {uno:?}");
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(snap.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(
            manifest["files"].as_array().unwrap().len(),
            1,
            "una sola entrada de manifest por archivo, no una por grafía"
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
    #[cfg(unix)]
    fn apply_conserva_el_snapshot_cuando_la_escritura_falla() {
        // Critical 1 de la round 4: la rama de `files == 0` (agregada en la
        // ronda anterior para no ofrecer Deshacer cuando el guard de la fase 3
        // saltea todo) también se comía el snapshot cuando la escritura se
        // INTENTÓ y falló. Con `write_chapter` en tmp+rename el capítulo que
        // falla ya no queda truncado, pero el snapshot tiene que sobrevivir
        // igual: cubre el lote, y el fallo pudo llegar después de reescribir
        // otros capítulos.
        //
        // Acá el fallo se fuerza con permisos, que rompen en el open y NO
        // dañan el archivo — el estado observable que importa es el mismo
        // (`files == 0` con `failed_files` poblado, la misma rama de código),
        // y forzar un ENOSPC real necesitaría montar un RAM disk desde el
        // test. Lo que se exige es que el snapshot sobreviva y que el
        // llamador se vuelva con el id en la mano.
        use std::os::unix::fs::PermissionsExt;
        let td = scope_con(&[("libro/1.html", "<p>Angelica</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let uno = td.path().join("libro/1.html");
        fs::set_permissions(&uno, fs::Permissions::from_mode(0o444)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica");
        let _ = fs::set_permissions(&uno, fs::Permissions::from_mode(0o644));
        let out = out.expect("un fallo de escritura reporta, no aborta con Err");

        assert_eq!(out.files, 0);
        assert_eq!(out.failed_files.len(), 1);
        assert!(
            !out.snapshot_id.is_empty(),
            "una escritura intentada deja el capítulo en riesgo: el id tiene que volver"
        );
        // El snapshot sigue en disco, con manifest legible y el original
        // adentro: eso es todo lo que necesita el Deshacer.
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(snap.join("manifest.json")).unwrap())
                .expect("manifest legible");
        assert_eq!(manifest["files"].as_array().unwrap().len(), 1);
        let original = fs::read_to_string(snap.join("libro/1.html")).unwrap();
        assert_eq!(original, "<p>Angelica</p>", "el original recuperable: {original:?}");
    }

    #[test]
    #[cfg(unix)]
    fn apply_no_lista_en_el_manifest_al_que_saltea_el_guard_de_la_fase_3() {
        // Important de la round 5, el daño inverso del Critical 1: el
        // `continue` del guard de la fase 3 no tocaba `manifest_files[idx]`, así
        // que el capítulo salteado quedaba listado con el sentinel `0` — que
        // para el undo significa "restaurá igual". Deshacer entonces pisaba
        // justo la edición ajena que el guard acababa de proteger.
        //
        // El guard se dispara con ESTADO del filesystem, sin threads ni
        // timing: `2.html` es un symlink a `1.html`, así que escribir
        // `1.html` en la fase 3 le cambia el contenido a `2.html` (el read
        // sigue el link) y su guard lo saltea. Antes esto se hacía con un
        // hard link, que dejó de servir cuando `write_chapter` pasó a
        // tmp+rename: el rename estrena inode y el otro lado del hard link se
        // queda con el contenido viejo.
        use std::os::unix::fs::PermissionsExt;
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica uno</p>"),
            ("libro/3.html", "<p>Angelica tres</p>"),
        ]);
        std::os::unix::fs::symlink(
            td.path().join("libro/1.html"),
            td.path().join("libro/2.html"),
        )
        .unwrap();
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        assert_eq!(pv.groups.len(), 3, "los tres capítulos entran al lote");
        // Y el tercero falla al escribir, para que el lote tenga a la vez un
        // escrito, un salteado y un fallado.
        let tres = td.path().join("libro/3.html");
        fs::set_permissions(&tres, fs::Permissions::from_mode(0o444)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica");
        let _ = fs::set_permissions(&tres, fs::Permissions::from_mode(0o644));
        let out = out.expect("un fallo de escritura reporta, no aborta con Err");

        assert_eq!(out.files, 1, "solo 1.html se escribió");
        assert!(
            out.skipped_files.iter().any(|s| s.ends_with("2.html")),
            "2.html lo saltea el guard: {:?}",
            out.skipped_files
        );
        assert!(
            out.failed_files.iter().any(|s| s.contains("3.html")),
            "3.html falla al escribir: {:?}",
            out.failed_files
        );

        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        let manifest: SnapshotManifest =
            serde_json::from_str(&fs::read_to_string(snap.join("manifest.json")).unwrap()).unwrap();
        let rels: Vec<&str> = manifest.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(
            rels,
            ["libro/1.html", "libro/3.html"],
            "el salteado no se lista; el escrito y el fallado sí"
        );
        // La copia del salteado se queda en el snapshot, sin listar: nadie la
        // mira, y borrarla sería otra escritura en el camino crítico.
        assert!(snap.join("libro/2.html").exists());
    }

    #[test]
    #[cfg(unix)]
    fn apply_que_falla_entero_pasa_el_slot_de_undo_al_snapshot_nuevo() {
        // Contracara del Critical 1: un lote que falló entero SÍ consume el
        // slot único de undo. Es a propósito y es el lado seguro — el
        // snapshot nuevo puede ser la única copia del capítulo que este
        // apply acaba de truncar, mientras que el anterior solo cubre un
        // apply que ya salió bien. Distinguir "falló en el open, archivo
        // intacto" de "falló escribiendo, archivo dañado" pide preguntarle al
        // error de `write_chapter` algo que no dice: apostar ahí es volver a
        // la pérdida de datos.
        use std::os::unix::fs::PermissionsExt;
        let td = scope_con(&[("libro/1.html", "<p>uno</p>")]);
        let pv1 = preview_scope(td.path(), "uno", &ops(false, true)).unwrap();
        let a = aplicar_t(td.path(), "uno", &ops(false, true), edits_de(&pv1), "dos").unwrap();
        assert!(!a.snapshot_id.is_empty());

        let dos_path = td.path().join("libro/2.html");
        fs::write(&dos_path, "<p>Angelica</p>").unwrap();
        let pv2 = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        fs::set_permissions(&dos_path, fs::Permissions::from_mode(0o444)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv2), "Angélica");
        let _ = fs::set_permissions(&dos_path, fs::Permissions::from_mode(0o644));
        let out = out.unwrap();
        assert_eq!(out.files, 0);
        assert!(!out.snapshot_id.is_empty(), "el capítulo se intentó escribir: hay qué deshacer");

        let undo_dir = td.path().join(".twriter/undo");
        let quedan: Vec<_> = fs::read_dir(&undo_dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(quedan.len(), 1, "sigue habiendo un solo slot de undo");
        assert_eq!(quedan[0].file_name().to_string_lossy(), out.snapshot_id);
        // Y el snapshot que quedó trae el original del capítulo en riesgo.
        let snap = undo_dir.join(&out.snapshot_id);
        assert_eq!(fs::read_to_string(snap.join("libro/2.html")).unwrap(), "<p>Angelica</p>");
    }

    #[test]
    fn apply_no_borra_lo_que_no_es_un_snapshot() {
        // Minor N5 de la re-review: el barrido de hermanos borraba
        // cualquier entry de `.twriter/undo` que no fuera `<id>`, sin mirar
        // el patrón. Se filtra por el prefijo `undo-`, así que algo ajeno
        // plantado ahí (o que una Task futura quiera guardar en la misma
        // carpeta) sobrevive.
        let td = scope_con(&[("libro/1.html", "<p>Angelica</p>")]);
        let undo_dir = td.path().join(".twriter/undo");
        fs::create_dir_all(undo_dir.join("no-soy-un-snapshot/sub")).unwrap();
        fs::write(undo_dir.join("no-soy-un-snapshot/sub/importante.txt"), "no tocar").unwrap();
        fs::write(undo_dir.join("archivo-suelto.txt"), "tampoco").unwrap();

        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();

        assert!(
            undo_dir.join("no-soy-un-snapshot/sub/importante.txt").exists(),
            "un directorio que no empieza con undo- no debe tocarse"
        );
        assert!(undo_dir.join("archivo-suelto.txt").exists(), "un archivo suelto no debe tocarse");
        assert!(undo_dir.join(&out.snapshot_id).exists(), "el snapshot nuevo sí queda");
    }

    #[test]
    fn apply_deja_el_snapshot_con_los_originales() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        let original = fs::read_to_string(snap.join("libro/1.html")).unwrap();
        assert!(original.contains("Angelica dijo"), "el snapshot guarda el previo");
        // El manifest final (el que trae los mtimes reales) llegó a disco por
        // el rename, y no quedó el tmp del Important 3 tirado en el snapshot.
        let manifest: SnapshotManifest =
            serde_json::from_str(&fs::read_to_string(snap.join("manifest.json")).unwrap()).unwrap();
        assert_ne!(
            manifest.files[0].mtime_after_apply, 0,
            "el manifest en disco tiene que ser el final, no el inicial"
        );
        assert!(!snap.join("manifest.json.tmp").exists(), "el tmp del rename no queda");
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

    #[test]
    fn undo_restaura_los_originales() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        let u = deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        assert_eq!(u.restored, 1);
        assert!(u.blocked.is_empty());
        let uno = fs::read_to_string(td.path().join("libro/1.html")).unwrap();
        assert!(uno.contains("Angelica dijo"), "volvió al original: {uno:?}");
    }

    #[test]
    fn undo_borra_el_snapshot_al_terminar() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        assert!(!td.path().join(".twriter/undo").join(&out.snapshot_id).exists());
    }

    #[test]
    fn undo_no_pisa_un_archivo_editado_despues() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        // El autor sigue escribiendo sobre el capítulo ya reemplazado.
        let cap = td.path().join("libro/1.html");
        fs::write(&cap, "<p>Angélica dijo, y después siguió</p>").unwrap();
        forzar_mtime_futuro(&cap);
        let u = deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        assert_eq!(u.restored, 0);
        assert_eq!(u.blocked.len(), 1);
        assert!(!u.suspect, "bloqueado por la edición del autor, no por el registro");
        let actual = fs::read_to_string(&cap).unwrap();
        assert!(actual.contains("y después siguió"), "no se pisó la edición nueva");
    }

    #[test]
    fn undo_no_pisa_una_edicion_hecha_en_el_mismo_segundo() {
        // El guard por mtime no podía ver esto: `mtime_after_apply` está en
        // segundos, así que una edición ajena que cae adentro del mismo segundo
        // que el reemplazo deja el mtime IDÉNTICO al registrado. En APFS el
        // caso es raro; en HFS+/exFAT/SMB (Dropbox, iCloud) el mtime no tiene
        // más resolución que el segundo, así que el lote entero puede caer
        // adentro de uno. El guard por hash no le pregunta al reloj.
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        let registrado = manifest_de(td.path(), &out.snapshot_id).files[0].mtime_after_apply;
        assert_ne!(registrado, 0, "el apply registró un mtime real");

        let cap = td.path().join("libro/1.html");
        fs::write(&cap, "<p>Angélica dijo, y después siguió</p>\n").unwrap();
        forzar_mtime(&cap, registrado);

        let u = deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        assert_eq!(u.restored, 0);
        assert_eq!(u.blocked.len(), 1, "{:?}", u.blocked);
        assert!(!u.suspect, "bloqueado por la edición del autor, no por el registro");
        assert!(
            fs::read_to_string(&cap).unwrap().contains("y después siguió"),
            "no se pisó la edición nueva"
        );
    }

    #[test]
    fn undo_de_un_manifest_viejo_sin_hash_cae_al_guard_de_mtime() {
        // Los snapshots que quedaron en disco de antes del hash no tienen el
        // campo. Sin fallback, `hash_after_apply: None` los mandaría a
        // restaurar sin ningún guard.
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        // El manifest tal como lo escribía la versión anterior: sin la clave.
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        let mut crudo: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(snap.join("manifest.json")).unwrap()).unwrap();
        crudo["files"][0]
            .as_object_mut()
            .unwrap()
            .remove("hashAfterApply")
            .expect("el apply lo escribió");
        fs::write(snap.join("manifest.json"), crudo.to_string()).unwrap();

        let cap = td.path().join("libro/1.html");
        fs::write(&cap, "<p>Angélica dijo, y después siguió</p>\n").unwrap();
        forzar_mtime_futuro(&cap);

        let u = deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        assert_eq!(u.restored, 0);
        assert_eq!(u.blocked.len(), 1, "{:?}", u.blocked);
    }

    #[test]
    fn undo_pisa_si_el_usuario_lo_fuerza() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        let cap = td.path().join("libro/1.html");
        fs::write(&cap, "<p>Angélica dijo, y después siguió</p>").unwrap();
        forzar_mtime_futuro(&cap);
        let forzar = vec![cap.to_string_lossy().into_owned()];
        let u = deshacer_t(td.path(), &out.snapshot_id, &forzar).unwrap();
        assert_eq!(u.restored, 1);
        assert!(u.blocked.is_empty());
        let actual = fs::read_to_string(&cap).unwrap();
        assert!(actual.contains("Angelica dijo"));
    }

    #[test]
    #[cfg(unix)]
    fn apply_no_lista_en_el_manifest_lo_que_no_intento_escribir() {
        // Critical 1 de la review r1, pérdida de datos: el `break` de la fase
        // 3 dejaba listados con el sentinel `0` los capítulos que nunca se
        // intentaron. El sentinel saltea el guard del undo por diseño, así
        // que quedaban restaurables SIN guard para siempre — y el autor puede
        // deshacer días después, con ediciones nuevas en el medio.
        use std::os::unix::fs::PermissionsExt;
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica uno</p>"),
            ("libro/2.html", "<p>Angelica dos</p>"),
            ("libro/3.html", "<p>Angelica tres</p>"),
        ]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        assert_eq!(pv.groups.len(), 3, "los tres capítulos entran al lote");
        // El 2 falla al escribir, así que el 3 queda después del `break`.
        let dos = td.path().join("libro/2.html");
        fs::set_permissions(&dos, fs::Permissions::from_mode(0o444)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica");
        let _ = fs::set_permissions(&dos, fs::Permissions::from_mode(0o644));
        let out = out.expect("un fallo de escritura reporta, no aborta con Err");
        assert_eq!(out.files, 1, "solo el 1 se escribió");
        assert_eq!(out.failed_files.len(), 1, "el 2 falló: {:?}", out.failed_files);

        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        let manifest: SnapshotManifest =
            serde_json::from_str(&fs::read_to_string(snap.join("manifest.json")).unwrap()).unwrap();
        let rels: Vec<&str> = manifest.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(
            rels,
            ["libro/1.html", "libro/2.html"],
            "el escrito y el fallado se listan; el que no se intentó, no"
        );
        // La copia del no intentado se queda adentro del snapshot sin listar.
        assert!(snap.join("libro/3.html").exists());

        // El repro entero: el fallo era transitorio (un lock del sync, un
        // ENOSPC que se resolvió), el autor edita el 3 —que el reemplazo nunca
        // tocó— y toca Deshacer.
        let tres = td.path().join("libro/3.html");
        fs::write(&tres, "<p>parrafo nuevo del autor</p>\n").unwrap();
        forzar_mtime_futuro(&tres);
        let u = deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        assert_eq!(u.restored, 2, "solo los dos listados");
        assert!(u.blocked.is_empty() && u.failed.is_empty(), "{u:?}");
        assert_eq!(
            fs::read_to_string(&tres).unwrap(),
            "<p>parrafo nuevo del autor</p>\n",
            "el Deshacer no puede tocar un capítulo que el reemplazo nunca escribió"
        );
    }

    #[test]
    fn undo_con_el_sentinel_cero_restaura_igual() {
        // Important 4: la rama del sentinel es la decisión central de la task
        // (el borrador del plan bloqueaba siempre) y ningún test la pinneaba —
        // borrando el `f.mtime_after_apply != 0 &&` del guard, los 5 tests de
        // undo seguían pasando. Este falla.
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        // Manifest con el sentinel, tal como lo deja un apply que escribió
        // pero no pudo volver a leer el archivo para registrarlo.
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        let mut manifest: SnapshotManifest =
            serde_json::from_str(&fs::read_to_string(snap.join("manifest.json")).unwrap()).unwrap();
        manifest.files[0].mtime_after_apply = 0;
        manifest.files[0].hash_after_apply = None;
        fs::write(snap.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap())
            .unwrap();
        // Y el capítulo con mtime al futuro: es exactamente el estado en que
        // el guard, sin la rama del sentinel, bloquearía el restore. (Con el
        // hash en `None` el guard cae al mtime, que es lo que este test pinnea.)
        let cap = td.path().join("libro/1.html");
        forzar_mtime_futuro(&cap);

        let u = deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        assert_eq!(u.restored, 1, "con el sentinel se restaura igual, no se bloquea");
        assert!(u.blocked.is_empty(), "{:?}", u.blocked);
        assert!(fs::read_to_string(&cap).unwrap().contains("Angelica dijo"));
    }

    #[test]
    #[cfg(unix)]
    fn undo_con_fallo_parcial_reporta_y_conserva_el_snapshot() {
        // Important 2: los `?` del camino de escritura volvían `Err` y tiraban
        // el conteo real y el `blocked`. Y la invariante que no hay que
        // romper: nada puede borrar el snapshot con la restauración a medias.
        use std::os::unix::fs::PermissionsExt;
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica uno</p>"),
            ("libro/2.html", "<p>Angelica dos</p>"),
        ]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        assert_eq!(out.files, 2);
        let dos = td.path().join("libro/2.html");
        fs::set_permissions(&dos, fs::Permissions::from_mode(0o444)).unwrap();
        let u = deshacer_t(td.path(), &out.snapshot_id, &[]);
        let _ = fs::set_permissions(&dos, fs::Permissions::from_mode(0o644));
        let u = u.expect("un fallo parcial reporta, no aborta con Err");

        assert_eq!(u.restored, 1, "el 1 sí volvió: el conteo real tiene que llegar");
        assert_eq!(u.failed.len(), 1, "{:?}", u.failed);
        assert!(u.failed[0].contains("2.html"), "el fallo nombra el capítulo: {:?}", u.failed);
        assert!(fs::read_to_string(td.path().join("libro/1.html")).unwrap().contains("Angelica uno"));
        // El snapshot sigue en disco: es la única copia del original del 2 y
        // el reintento lo necesita.
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        assert!(
            snap.join("libro/2.html").exists(),
            "el snapshot no se borra con la restauración a medias"
        );
    }

    #[test]
    #[cfg(unix)]
    fn undo_que_solo_falla_al_guardar_stats_no_se_come_el_outcome() {
        // El peor de los tres `?` del Important 2: todo restaurado bien y el
        // `write_stats` se llevaba puesto el `UndoOutcome` entero.
        use std::os::unix::fs::PermissionsExt;
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        let twriter = td.path().join(".twriter");
        fs::set_permissions(&twriter, fs::Permissions::from_mode(0o555)).unwrap();
        let u = deshacer_t(td.path(), &out.snapshot_id, &[]);
        let _ = fs::set_permissions(&twriter, fs::Permissions::from_mode(0o755));
        let u = u.expect("el fallo de stats no puede tirar el outcome");

        assert_eq!(u.restored, 1);
        assert_eq!(u.failed.len(), 1, "{:?}", u.failed);
        assert!(u.failed[0].contains("stats.json"), "{:?}", u.failed);
        assert!(fs::read_to_string(td.path().join("libro/1.html")).unwrap().contains("Angelica dijo"));
    }

    #[test]
    fn undo_devuelve_palabras_y_ultima_edicion_a_stats() {
        let td = scope_con(&[("libro/1.html", "<p>dijo no obstante que sí</p>")]);
        let pv = preview_scope(td.path(), "no obstante", &ops(false, true)).unwrap();
        let out =
            aplicar_t(td.path(), "no obstante", &ops(false, true), edits_de(&pv), "pero").unwrap();
        assert_eq!(
            crate::stats::read_stats(td.path()).get("libro/1.html").unwrap().palabras,
            4,
            "«dijo pero que sí» son 4"
        );
        deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        let stats = crate::stats::read_stats(td.path());
        let stat = stats.get("libro/1.html").expect("stats para el capítulo");
        assert_eq!(stat.palabras, 5, "«dijo no obstante que sí» son 5 palabras");
        assert_eq!(stat.ultima_edicion.as_deref(), Some(AHORA));
    }

    #[test]
    fn undo_con_manifest_tmp_no_restaura_nada_sin_confirmar() {
        // El `.tmp` del rename es la señal gratis de que el manifest en disco
        // puede ser el INICIAL, con todos los mtimes en el sentinel `0`: ahí
        // restaurar solo pisaría lo que el guard del apply salteó a propósito.
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica uno</p>"),
            ("libro/2.html", "<p>Angelica dos</p>"),
        ]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        fs::write(snap.join("manifest.json.tmp"), "residuo").unwrap();

        let u = deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        assert_eq!(u.restored, 0, "manifest sospechoso: nada se restaura solo");
        assert_eq!(u.blocked.len(), 2, "{:?}", u.blocked);
        assert!(u.suspect, "la UI tiene que poder decir que el registro quedó incompleto");
        assert!(u.failed.is_empty(), "{:?}", u.failed);
        assert!(fs::read_to_string(td.path().join("libro/1.html")).unwrap().contains("Angélica"));
        assert!(snap.join("manifest.json").exists(), "el snapshot queda para poder forzar");

        // Y el escape hatch: con la confirmación explícita del autor sí se
        // restaura. Sin esto el bloqueo sería permanente.
        let u = deshacer_t(td.path(), &out.snapshot_id, &u.blocked).unwrap();
        assert_eq!(u.restored, 2);
        assert!(u.blocked.is_empty());
    }

    #[test]
    fn undo_no_escribe_fuera_del_root() {
        // Important 3: `aplicar` valida los segmentos del `rel` antes de
        // snapshotear pero `deshacer` hacía `root.join(&f.rel)` a pelo, y el
        // manifest —que vive en `.twriter/`, local— es la única autoridad que
        // el undo consulta para decidir qué pisar. `write_chapter` no valida
        // ni root ni extensión.
        let td = TempDir::new().unwrap();
        let root = td.path().join("novelas");
        fs::create_dir_all(&root).unwrap();
        let victima = td.path().join("victima.html");
        fs::write(&victima, "<p>archivo ajeno</p>\n").unwrap();
        let snap = root.join(".twriter/undo/undo-1");
        fs::create_dir_all(&snap).unwrap();
        let manifest = SnapshotManifest {
            id: "undo-1".to_string(),
            when: AHORA.to_string(),
            needle: "Angelica".to_string(),
            replacement: "Angélica".to_string(),
            files: vec![SnapshotFile {
                rel: "../victima.html".to_string(),
                occurrences: 1,
                mtime_after_apply: 0,
                hash_after_apply: None,
            }],
        };
        fs::write(snap.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap())
            .unwrap();

        let u = deshacer_t(&root, "undo-1", &[]).unwrap();
        assert_eq!(u.restored, 0);
        assert_eq!(u.failed.len(), 1, "{:?}", u.failed);
        assert!(u.failed[0].starts_with("../victima.html: "), "{:?}", u.failed);
        assert_eq!(
            fs::read_to_string(&victima).unwrap(),
            "<p>archivo ajeno</p>\n",
            "no se toca nada afuera del root"
        );
    }

    #[test]
    fn undo_fuerza_aunque_el_path_venga_con_otra_grafia() {
        // Minor 5: el match de `force_paths` era por string exacto, así que si
        // el frontend rearma el path en vez de reenviar el de `blocked`, el
        // botón "Pisarlos igual" no hacía nada.
        let td = scope_con(&[("libro/1.html", "<p>Angelica dijo</p>")]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica").unwrap();
        let cap = td.path().join("libro/1.html");
        fs::write(&cap, "<p>Angélica dijo, y después siguió</p>").unwrap();
        forzar_mtime_futuro(&cap);
        let forzar = vec![td.path().join("./libro/1.html").to_string_lossy().into_owned()];
        let u = deshacer_t(td.path(), &out.snapshot_id, &forzar).unwrap();
        assert_eq!(u.restored, 1, "la otra grafía del mismo path también fuerza");
        assert!(u.blocked.is_empty(), "{:?}", u.blocked);
    }

    #[test]
    fn undo_con_snapshot_id_que_no_es_un_snapshot_es_error() {
        // Minor 8: `snapshot_id` es un string crudo del frontend y termina en
        // un `remove_dir_all`. Mismo criterio que el barrido de hermanos de
        // `aplicar`, que filtra por el prefijo `undo-`.
        let td = scope_con(&[("libro/1.html", "<p>x</p>")]);
        for id in ["..", "../..", "undo-1/../../..", "otra-cosa", ""] {
            let err = deshacer_t(td.path(), id, &[]).unwrap_err();
            assert!(err.contains("inválido"), "«{id}» debe rechazarse, dijo: {err}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn undo_no_pisa_el_capitulo_que_fallo_y_el_autor_edito() {
        // Important de la round 2, el Critical 1 en la otra rama: el capítulo
        // que la escritura no pudo tocar quedaba en el manifest con el
        // sentinel `0`, que saltea el guard del undo — o sea restaurable sin
        // red para siempre, aunque el autor lo hubiera editado después.
        use std::os::unix::fs::PermissionsExt;
        let td = scope_con(&[
            ("libro/1.html", "<p>Angelica uno</p>"),
            ("libro/2.html", "<p>Angelica dos</p>"),
        ]);
        let pv = preview_scope(td.path(), "Angelica", &ops(false, true)).unwrap();
        let dos = td.path().join("libro/2.html");
        fs::set_permissions(&dos, fs::Permissions::from_mode(0o444)).unwrap();
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), edits_de(&pv), "Angélica");
        let _ = fs::set_permissions(&dos, fs::Permissions::from_mode(0o644));
        let out = out.expect("un fallo de escritura reporta, no aborta con Err");
        assert_eq!(out.files, 1);
        assert_eq!(out.failed_files.len(), 1, "{:?}", out.failed_files);

        let snap = td.path().join(".twriter/undo").join(&out.snapshot_id);
        let manifest: SnapshotManifest =
            serde_json::from_str(&fs::read_to_string(snap.join("manifest.json")).unwrap()).unwrap();
        let mf = manifest.files.iter().find(|f| f.rel == "libro/2.html").expect("listado");
        assert_ne!(mf.mtime_after_apply, 0, "el que falló no puede quedar con el sentinel");

        // Días después: el fallo era transitorio, el capítulo quedó intacto y
        // el autor lo siguió escribiendo.
        fs::write(&dos, "<p>parrafo nuevo del autor</p>\n").unwrap();
        forzar_mtime_futuro(&dos);
        let u = deshacer_t(td.path(), &out.snapshot_id, &[]).unwrap();
        assert_eq!(u.restored, 1, "solo el que se escribió");
        assert_eq!(u.blocked, vec![dos.to_string_lossy().into_owned()]);
        assert!(!u.suspect, "bloqueado por la edición del autor");
        assert_eq!(
            fs::read_to_string(&dos).unwrap(),
            "<p>parrafo nuevo del autor</p>\n",
            "el Deshacer no puede pisar lo que el autor escribió después"
        );
        assert!(snap.join("manifest.json").exists(), "el snapshot queda para poder forzar");
    }

    #[test]
    fn undo_no_pisa_lo_que_no_es_un_capitulo() {
        // Important de la round 2: el chequeo de traversal cierra el "afuera
        // del root", pero un `rel` corrupto adentro del root sigue siendo
        // cualquier archivo — `book.json`, `stats.json`, `.git/config`— y
        // `write_chapter` no valida extensión.
        let td = scope_con(&[("libro/1.html", "<p>Angelica</p>")]);
        let book = td.path().join("libro/book.json");
        fs::write(&book, "{\"titulo\":\"el real\"}\n").unwrap();
        let snap = td.path().join(".twriter/undo/undo-1");
        fs::create_dir_all(snap.join("libro")).unwrap();
        fs::write(snap.join("libro/book.json"), "{\"titulo\":\"pisado\"}\n").unwrap();
        let manifest = SnapshotManifest {
            id: "undo-1".to_string(),
            when: AHORA.to_string(),
            needle: "Angelica".to_string(),
            replacement: "Angélica".to_string(),
            files: vec![SnapshotFile {
                rel: "libro/book.json".to_string(),
                occurrences: 1,
                mtime_after_apply: 0,
                hash_after_apply: None,
            }],
        };
        fs::write(snap.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap())
            .unwrap();

        let u = deshacer_t(td.path(), "undo-1", &[]).unwrap();
        assert_eq!(u.restored, 0);
        assert_eq!(u.failed.len(), 1, "{:?}", u.failed);
        assert!(
            u.failed[0].starts_with("libro/book.json: "),
            "formato «<path>: <error>»: {:?}",
            u.failed
        );
        assert_eq!(
            fs::read_to_string(&book).unwrap(),
            "{\"titulo\":\"el real\"}\n",
            "el book.json del autor no se toca"
        );
    }

    #[test]
    fn undo_de_un_snapshot_que_no_existe_es_error_claro() {
        let td = scope_con(&[("libro/1.html", "<p>x</p>")]);
        let err = deshacer_t(td.path(), "undo-inexistente", &[]).unwrap_err();
        assert!(err.contains("undo-inexistente"), "el error nombra el snapshot: {err}");
    }
}
