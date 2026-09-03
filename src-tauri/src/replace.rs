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
}
