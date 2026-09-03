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
/// `motivo_gap_previo` es qué cortó el run anterior de este (None en el primero).
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
            // Entidad no reconocida: se trata como texto literal.
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
    // Arranca en un hueco (un `\n` de bloque, por ejemplo).
    Ubicacion::Cruza(MotivoSkip::CruzaBloque)
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
    for (start, end) in ranges {
        if start > end || end > out.len() {
            continue;
        }
        out.replace_range(start..end, replacement);
    }
    out
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
}
