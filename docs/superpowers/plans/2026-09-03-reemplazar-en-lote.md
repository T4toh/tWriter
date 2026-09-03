# Reemplazar en lote — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buscar y reemplazar una palabra o frase en todos los capítulos de un scope (repo / saga / libro / archivo actual) desde el panel de búsqueda, con preview por ocurrencia y un Deshacer que restaura desde snapshot.

**Architecture:** El motor vive entero en Rust (`src-tauri/src/replace.rs`) y expone tres comandos: `replace_preview`, `replace_apply`, `replace_undo`. El frontend solo renderiza y maneja la selección. La pieza central es el mapa **plain ↔ HTML por runs**: se busca sobre el texto plano y se reemplaza sobre el HTML, y una ocurrencia solo es reemplazable si cae entera dentro de un run (o sea, si no cruza un tag, una entidad ni un borde de bloque).

**Tech Stack:** Rust (Tauri 2, `serde`, `tempfile` para tests), Angular 21 con signals, `cargo test` para el motor, un smoke runner de node para las funciones puras del frontend.

**Spec:** `docs/superpowers/specs/2026-09-03-reemplazar-en-lote-design.md`

## Global Constraints

- **Idioma de identificadores**: español para sustantivos de dominio (`capitulo`, `saga`, `ocurrencia`, `reemplazo`), inglés para verbos y mecánica de framework. Los nombres mixtos son correctos y no hay que "arreglarlos" (ver CLAUDE.md).
- **Angular**: standalone components, signals (`signal`/`computed`/`input`), templates modernos (`@if`/`@for`/`@switch` — nunca `*ngIf`/`*ngFor`), `inject()` en vez de constructor params, sin `public` explícito, return types explícitos, archivos sin sufijo `.component`.
- **Solo capítulos `.html`.** Las notas `.md` están fuera de alcance: el scope `Notas` deshabilita el botón con el motivo visible.
- **Nunca plegar acentos** en el reemplazo: `Angelica` no matchea `Angélica`.
- **Nunca pisar markup inline.** Una ocurrencia que cruza un tag no se reemplaza; se reporta.
- **El remedio se da adentro de la app**: cada estado deshabilitado o vacío dice **por qué**, en texto visible al lado del control, no en un tooltip ni en prosa genérica.
- **No editar `src-tauri/` con `pnpm tauri dev` corriendo** — el watcher reinicia la app del autor. Avisar antes de tocar Rust.
- **Los commits no llevan trailer de co-autor.**
- El HTML de los capítulos es el subset conocido del editor: `<p>`, `<i>`, `<em>`, `<strong>`, `<hr class="scene-break"/>`, `<h1 class="chapter-title">`, `<span class="dropcap">`, `<blockquote>`.

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `src-tauri/src/replace.rs` (crear) | Motor: `plain_con_runs`, `buscar_ocurrencias`, `ubicar`, `aplicar_ranges`, los tres comandos, snapshot/undo. |
| `src-tauri/src/audit.rs` (modificar) | Extraer `chapter_paths()` para que `replace.rs` reuse el walk y `SKIP_DIRS` sin duplicarlos. |
| `src-tauri/src/lib.rs` (modificar) | `mod replace;` + registrar los tres comandos. |
| `src/app/core/replace-selection.ts` (crear) | Funciones **puras** de selección: contadores, tri-estado, y el armado de los `FileEdit` que se van a escribir. |
| `scripts/run-replace-selection-smoke.mjs` (crear) | Smoke runner de lo anterior. |
| `src/app/core/replace-service.ts` (crear) | Orquesta: debounce, invokes, flush/reload, toasts, estado del preview y del undo. |
| `src/app/core/search-service.ts` (modificar) | `replaceMode` signal + cortar la query a tantivy mientras está prendido. |
| `src/app/core/settings-service.ts` (modificar) | Persistir `replaceCaseSensitive` y `replaceWholeWord`. |
| `src/app/search-panel/search-panel.{ts,html,scss}` (modificar) | Segunda fila, toggles, lista de preview con checkboxes, barra de Deshacer. |
| `TODO.md` (modificar) | Cerrar el item de la línea 1798. |

---

## Task 1: El motor puro — plain, runs y búsqueda

**Files:**
- Create: `src-tauri/src/replace.rs`
- Test: `src-tauri/src/replace.rs` (módulo `#[cfg(test)] mod tests` al final, como hace `stats.rs`)

**Interfaces:**
- Consumes: nada.
- Produces: `Run`, `MotivoSkip`, `PlainMap`, `Opciones`, `Ubicacion`, `plain_con_runs(&str) -> PlainMap`, `buscar_ocurrencias(&str, &str, &Opciones) -> Vec<(usize, usize)>`, `ubicar(&PlainMap, usize, usize) -> Ubicacion`, `aplicar_ranges(&str, Vec<(usize, usize)>, &str) -> String`.

**Contexto para quien lo implemente:** el HTML de un capítulo se lee crudo del disco. El texto que el autor ve es el HTML sin tags y con las entidades decodificadas. Los offsets de los dos no coinciden, así que hay que buscar en uno y escribir en el otro. Un **run** es un tramo de texto plano que se corresponde byte a byte con el HTML; los tags, las entidades y los saltos de bloque cortan runs. Referencias de estilo en el repo: `search.rs::html_to_text` (línea 293) hace el strip y el decode de las mismas seis entidades, `import.rs::count_words` (línea 305) es el walker char-por-char con la bandera `in_tag`.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `src-tauri/src/replace.rs` con **solo** los tipos vacíos suficientes para compilar y este módulo de tests:

```rust
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
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Avisar al autor antes: **si tiene `pnpm tauri dev` corriendo, el watcher va a reiniciar la app.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml replace::`
Expected: FAIL — errores de compilación por las funciones que todavía no existen.

- [ ] **Step 3: Implementar el motor**

Reemplazar el contenido de `src-tauri/src/replace.rs` (dejando el módulo de tests al final intacto):

```rust
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
```

Agregar `mod replace;` a `src-tauri/src/lib.rs`, en orden alfabético (entre `mod reorder;` y `mod saga_config;`).

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml replace::`
Expected: PASS, 18 tests de `replace::`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/replace.rs src-tauri/src/lib.rs
git commit -m "feat(reemplazar): motor de plain↔html por runs"
```

---

## Task 2: `replace_preview` — enumerar el scope

**Files:**
- Modify: `src-tauri/src/audit.rs` (extraer `chapter_paths`)
- Modify: `src-tauri/src/replace.rs` (agregar el comando y sus tipos)
- Modify: `src-tauri/src/lib.rs` (registrar `replace_preview`)
- Test: `src-tauri/src/replace.rs`, módulo `tests`

**Interfaces:**
- Consumes: de Task 1 — `plain_con_runs`, `buscar_ocurrencias`, `ubicar`, `Opciones`, `MotivoSkip`, `Ubicacion`.
- Produces: `audit::chapter_paths(&Path) -> Result<Vec<PathBuf>, String>`; y en `replace.rs` los tipos `ReplaceOccurrence`, `ReplaceSkipped`, `ReplaceGroup`, `ReplacePreview` más el comando `replace_preview(scope_path: String, needle: String, case_sensitive: bool, whole_word: bool) -> Result<ReplacePreview, String>`.

**Contexto:** `audit.rs` ya tiene el walk correcto con la lista `SKIP_DIRS` (saltea `notas/`, `extras/`, `Exportados/`, `.git`, `.twriter`, etc.). Hay que extraerlo para no duplicar esa lista, que es justo la clase de cosa que se desincroniza. El título de cada grupo sale de `<stem>.meta.json` → campo `titulo`, con fallback al nombre del archivo sin extensión; `audit.rs::read_idioma` (línea 91) es el molde exacto para leerlo.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al módulo `tests` de `replace.rs`:

```rust
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
```

`tempfile = "3"` ya está en `[dev-dependencies]` de `src-tauri/Cargo.toml`
(lo usa `stats.rs`), así que no hay que agregar nada.

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml replace::`
Expected: FAIL — `preview_scope` no existe.

- [ ] **Step 3: Extraer el walk de `audit.rs`**

En `src-tauri/src/audit.rs`, agregar la función pública y hacer que el `walk` existente la use:

```rust
/// Enumera los `.html` de un scope (saga / libro / sección / un archivo
/// suelto), salteando las carpetas de `SKIP_DIRS`. Ordenado por path para que
/// el resultado sea estable entre corridas.
pub fn chapter_paths(scope: &Path) -> Result<Vec<PathBuf>, String> {
    if !scope.exists() {
        return Err(format!("scope no existe: {}", scope.display()));
    }
    let mut out = Vec::new();
    walk_paths(scope, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk_paths(path: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_file() {
        if path.extension().and_then(|e| e.to_str()) == Some("html") {
            out.push(path.to_path_buf());
        }
        return Ok(());
    }
    let entries = fs::read_dir(path).map_err(|e| format!("read_dir {}: {}", path.display(), e))?;
    let mut sorted: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    sorted.sort();
    for entry in sorted {
        if entry.is_dir() {
            let name = entry.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if SKIP_DIRS.iter().any(|skip| skip.eq_ignore_ascii_case(name)) {
                continue;
            }
            walk_paths(&entry, out)?;
        } else if entry.extension().and_then(|e| e.to_str()) == Some("html") {
            out.push(entry);
        }
    }
    Ok(())
}
```

Y reescribir el `walk` viejo para que no duplique el recorrido:

```rust
fn walk(path: &Path, out: &mut Vec<ChapterPayload>) -> Result<(), String> {
    for p in chapter_paths(path)? {
        push_chapter(&p, out)?;
    }
    Ok(())
}
```

Además, generalizar el lector de `meta.json` para que sirva a los dos casos. Renombrar `read_idioma` a `read_meta_field` y dejar el call site de `push_chapter` usándolo:

```rust
/// Lee un campo string de `<stem>.meta.json`. None si no existe el archivo,
/// no parsea, o el campo no está.
pub fn read_meta_field(chapter_path: &Path, field: &str) -> Option<String> {
    let stem = chapter_path.file_stem()?.to_str()?;
    let parent = chapter_path.parent()?;
    let meta_path = parent.join(format!("{stem}.meta.json"));
    if !meta_path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&meta_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get(field).and_then(|v| v.as_str()).map(String::from)
}
```

En `push_chapter`, cambiar `let idioma = read_idioma(path);` por
`let idioma = read_meta_field(path, "idioma");`.

- [ ] **Step 4: Implementar el preview**

Agregar a `src-tauri/src/replace.rs`:

```rust
use std::path::{Path, PathBuf};

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
```

En `src-tauri/src/lib.rs`: `use replace::replace_preview;` junto a los otros `use`, y `replace_preview,` en el `generate_handler!`, al lado de los `search_*`.

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — los 17 de Task 1, los 7 nuevos, y **todos los de `audit`/`stats` que ya existían** (el refactor del walk no debe romperlos).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/replace.rs src-tauri/src/audit.rs src-tauri/src/lib.rs
git commit -m "feat(reemplazar): comando replace_preview y walk compartido con audit"
```

---

## Task 3: `replace_apply` — snapshot, revalidación y escritura

**Files:**
- Modify: `src-tauri/src/replace.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/replace.rs`, módulo `tests`

**Interfaces:**
- Consumes: de Task 2 — `preview_scope`, `plain_con_runs`, `buscar_ocurrencias`, `ubicar`, `aplicar_ranges`, `Opciones`. De la base — `crate::fs::write_chapter(String, String)`, `crate::stats::{read_stats, write_stats, relative_key, ChapterStat}`, `crate::import::count_words(&str) -> u32`.
- Produces: `FileEdit { path: String, ranges: Vec<(usize, usize)> }`, `ReplaceOutcome { files, occurrences, skipped_files, snapshot_id }`, `SnapshotManifest`, `aplicar(root, needle, op, edits, replacement) -> Result<ReplaceOutcome, String>` y el comando `replace_apply`.

**Contexto crítico:** el preview y el apply son dos invokes separados, y en el medio corre el autosave, un pull o la otra PC del autor. Escribir en `html_start..html_end` a ciegas metería basura en medio de una palabra. Por eso el apply recibe de nuevo el needle y los toggles: re-escanea cada archivo y exige que los ranges pedidos estén entre los que encuentra ahora. Si alguno no está, el archivo se saltea **entero** y se reporta.

Orden obligatorio: **revalidar todo → snapshotear los sobrevivientes → escribir**. Snapshotear antes de revalidar copiaría archivos que no se van a tocar; escribir antes de snapshotear deja al autor sin red.

`palabras` ya no vive en `meta.json`: está en `.twriter/stats.json` (ver el header de `stats.rs`). `upsert_stat` reescribe el mapa entero en cada llamada, así que para N archivos va un solo `read_stats` / `write_stats`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al módulo `tests`:

```rust
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
        let a = aplicar_t(td.path(), "uno", &ops(false, true), edits_de(&pv1), "dos").unwrap();
        let pv2 = preview_scope(td.path(), "dos", &ops(false, true)).unwrap();
        let b = aplicar_t(td.path(), "dos", &ops(false, true), edits_de(&pv2), "tres").unwrap();
        assert_ne!(a.snapshot_id, b.snapshot_id);
        let undo_dir = td.path().join(".twriter/undo");
        let quedan: Vec<_> = fs::read_dir(&undo_dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(quedan.len(), 1, "solo se guarda el último");
    }

    #[test]
    fn apply_actualiza_palabras_en_stats() {
        let td = scope_con(&[("libro/1.html", "<p>dijo no obstante que sí</p>")]);
        let pv = preview_scope(td.path(), "no obstante", &ops(false, true)).unwrap();
        aplicar_t(td.path(), "no obstante", &ops(false, true), edits_de(&pv), "pero").unwrap();
        let stats = crate::stats::read_stats(td.path());
        let stat = stats.get("libro/1.html").expect("stats para el capítulo");
        assert_eq!(stat.palabras, 4, "«dijo pero que sí» son 4 palabras");
        assert!(stat.ultima_edicion.is_some());
    }

    #[test]
    fn apply_sin_edits_no_hace_nada() {
        let td = scope_con(&[("libro/1.html", "<p>Angelica</p>")]);
        let out = aplicar_t(td.path(), "Angelica", &ops(false, true), vec![], "Angélica").unwrap();
        assert_eq!(out.files, 0);
        assert!(out.snapshot_id.is_empty(), "sin escrituras no hay snapshot");
        assert!(!td.path().join(".twriter/undo").exists());
    }
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml replace::`
Expected: FAIL — `aplicar` y `FileEdit` no existen.

- [ ] **Step 3: Implementar el apply**

Agregar a `src-tauri/src/replace.rs`:

```rust
use std::time::{SystemTime, UNIX_EPOCH};

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

fn ahora_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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

    // 1. Revalidar: cada range pedido tiene que seguir existiendo hoy.
    struct Pendiente {
        path: PathBuf,
        html: String,
        nuevo: String,
        ocurrencias: usize,
    }
    let mut pendientes: Vec<Pendiente> = Vec::new();
    for edit in edits {
        if edit.ranges.is_empty() {
            continue;
        }
        let path = PathBuf::from(&edit.path);
        let Ok(html) = std::fs::read_to_string(&path) else {
            out.skipped_files.push(edit.path);
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
        if !edit.ranges.iter().all(|r| vigentes.contains(r)) {
            tracing::warn!(
                target: "replace",
                path = %edit.path,
                "el archivo cambió desde el preview, no lo toco"
            );
            out.skipped_files.push(edit.path);
            continue;
        }
        let ocurrencias = edit.ranges.len();
        let nuevo = aplicar_ranges(&html, edit.ranges, replacement);
        pendientes.push(Pendiente { path, html, nuevo, ocurrencias });
    }
    if pendientes.is_empty() {
        return Ok(out);
    }

    // 2. Snapshot de los sobrevivientes, antes de escribir nada.
    let undo_root = root.join(UNDO_SUBDIR);
    if undo_root.exists() {
        // Solo se guarda el último: el anterior se va.
        std::fs::remove_dir_all(&undo_root)
            .map_err(|e| format!("limpiar {}: {}", undo_root.display(), e))?;
    }
    let id = nuevo_snapshot_id();
    let snap_dir = undo_root.join(&id);
    let mut manifest_files: Vec<SnapshotFile> = Vec::new();
    for p in &pendientes {
        let rel = crate::stats::relative_key(root, &p.path)
            .ok_or_else(|| format!("capítulo fuera del root: {}", p.path.display()))?;
        let destino = snap_dir.join(&rel);
        if let Some(parent) = destino.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
        std::fs::write(&destino, &p.html)
            .map_err(|e| format!("snapshot {}: {}", destino.display(), e))?;
        manifest_files.push(SnapshotFile { rel, occurrences: p.ocurrencias, mtime_after_apply: 0 });
    }

    // 3. Escribir. `fs::write_chapter` reindexa tantivy por su cuenta.
    let mut stats = crate::stats::read_stats(root);
    for (idx, p) in pendientes.iter().enumerate() {
        crate::fs::write_chapter(p.path.to_string_lossy().into_owned(), p.nuevo.clone())?;
        out.files += 1;
        out.occurrences += p.ocurrencias;
        manifest_files[idx].mtime_after_apply = mtime_epoch(&p.path);
        if let Some(key) = crate::stats::relative_key(root, &p.path) {
            stats.insert(
                key,
                crate::stats::ChapterStat {
                    palabras: crate::import::count_words(&p.nuevo),
                    ultima_edicion: Some(ultima_edicion.to_string()),
                },
            );
        }
    }
    crate::stats::write_stats(root, &stats)?;

    let manifest = SnapshotManifest {
        id: id.clone(),
        when: ultima_edicion.to_string(),
        needle: needle.to_string(),
        replacement: replacement.to_string(),
        files: manifest_files,
    };
    std::fs::write(
        snap_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("manifest: {e}"))?;
    out.snapshot_id = id;

    tracing::info!(
        target: "replace",
        needle,
        replacement,
        files = out.files,
        occurrences = out.occurrences,
        skipped = out.skipped_files.len(),
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
```

**Sobre `ultima_edicion`**: `src-tauri/Cargo.toml` no tiene ninguna crate de
fechas (ni `chrono` ni `time`), y no vale agregar una dependencia para
formatear un string. El repo ya resuelve esto al revés: `chapter-service.ts:199`
manda `ultimaEdicion: new Date().toISOString()` en cada save. El reemplazo hace
lo mismo — el frontend pasa el timestamp y Rust lo guarda tal cual. Así el
formato queda idéntico al del resto de los capítulos, sin dependencias nuevas.

En `src-tauri/src/lib.rs`: agregar `replace_apply` al `use replace::{…}` y al `generate_handler!`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, incluidos los 7 nuevos.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/replace.rs src-tauri/src/lib.rs src-tauri/src/util.rs
git commit -m "feat(reemplazar): replace_apply con snapshot y revalidación contra el disco"
```

---

## Task 4: `replace_undo` — restaurar con guard de mtime

**Files:**
- Modify: `src-tauri/src/replace.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/replace.rs`, módulo `tests`

**Interfaces:**
- Consumes: de Task 3 — `aplicar`, `SnapshotManifest`, `SnapshotFile`, `mtime_epoch`.
- Produces: `UndoOutcome { restored: usize, blocked: Vec<String> }` y el comando `replace_undo(root: String, snapshot_id: String, force_paths: Vec<String>) -> Result<UndoOutcome, String>`.

**Contexto:** restaurar a ciegas se come las ediciones que el autor hizo **después** del reemplazo. El manifest guarda el mtime de cada archivo justo después de escribirlo; si el mtime de hoy es mayor, ese archivo se editó después y no se pisa: se devuelve en `blocked` y el panel pide confirmación explícita. Los paths que vengan en `force_paths` se restauran igual.

- [ ] **Step 1: Escribir los tests que fallan**

```rust
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
        let actual = fs::read_to_string(&cap).unwrap();
        assert!(actual.contains("y después siguió"), "no se pisó la edición nueva");
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
    fn undo_de_un_snapshot_que_no_existe_es_error_claro() {
        let td = scope_con(&[("libro/1.html", "<p>x</p>")]);
        let err = deshacer_t(td.path(), "undo-inexistente", &[]).unwrap_err();
        assert!(err.contains("undo-inexistente"), "el error nombra el snapshot: {err}");
    }
```

Y los helpers, al lado de `scope_con`:

```rust
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
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml replace::`
Expected: FAIL — `deshacer` no existe.

- [ ] **Step 3: Implementar el undo**

```rust
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub restored: usize,
    /// Paths que se editaron DESPUÉS del reemplazo. No se pisaron; el panel
    /// los muestra y pide confirmación para forzarlos.
    pub blocked: Vec<String>,
}

/// Restaura el snapshot. Ver el contexto de la Task 4: el guard de mtime es lo
/// que evita comerse las ediciones posteriores al reemplazo.
pub fn deshacer(
    root: &Path,
    snapshot_id: &str,
    force_paths: &[String],
    ultima_edicion: &str,
) -> Result<UndoOutcome, String> {
    let snap_dir = root.join(UNDO_SUBDIR).join(snapshot_id);
    let manifest_path = snap_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!("no encontré el snapshot {snapshot_id}"));
    }
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("leer manifest de {snapshot_id}: {e}"))?;
    let manifest: SnapshotManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("manifest de {snapshot_id} ilegible: {e}"))?;

    let mut out = UndoOutcome::default();
    let mut stats = crate::stats::read_stats(root);
    for f in &manifest.files {
        let destino = root.join(&f.rel);
        let origen = snap_dir.join(&f.rel);
        let destino_str = destino.to_string_lossy().into_owned();
        let forzado = force_paths.iter().any(|p| p == &destino_str);
        if !forzado && destino.exists() && mtime_epoch(&destino) > f.mtime_after_apply {
            out.blocked.push(destino_str);
            continue;
        }
        let contenido = std::fs::read_to_string(&origen)
            .map_err(|e| format!("leer snapshot {}: {}", origen.display(), e))?;
        crate::fs::write_chapter(destino_str, contenido.clone())?;
        out.restored += 1;
        stats.insert(
            f.rel.clone(),
            crate::stats::ChapterStat {
                palabras: crate::import::count_words(&contenido),
                ultima_edicion: Some(ultima_edicion.to_string()),
            },
        );
    }
    crate::stats::write_stats(root, &stats)?;

    // El snapshot se va solo si no quedó nada bloqueado: si quedó, el autor
    // todavía puede querer forzar esos.
    if out.blocked.is_empty() {
        let _ = std::fs::remove_dir_all(&snap_dir);
    }
    tracing::info!(
        target: "replace",
        snapshot = snapshot_id,
        restored = out.restored,
        blocked = out.blocked.len(),
        "replace_undo"
    );
    Ok(out)
}

#[tauri::command]
pub fn replace_undo(
    root: String,
    snapshot_id: String,
    force_paths: Vec<String>,
    ultima_edicion: String,
) -> Result<UndoOutcome, String> {
    deshacer(
        Path::new(&root),
        snapshot_id.as_str(),
        &force_paths,
        ultima_edicion.as_str(),
    )
}
```

En `src-tauri/src/lib.rs`: agregar `replace_undo` al `use` y al `generate_handler!`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

`File::set_modified` es estable desde Rust 1.75 y el toolchain de esta máquina
es 1.97, así que no hace falta ninguna dependencia extra para el test de mtime.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/replace.rs src-tauri/src/lib.rs
git commit -m "feat(reemplazar): replace_undo con guard de mtime"
```

---

## Task 5: La selección, en funciones puras

**Files:**
- Create: `src/app/core/replace-selection.ts`
- Create: `scripts/run-replace-selection-smoke.mjs`

**Interfaces:**
- Consumes: nada (módulo puro, sin imports del framework).
- Produces: `ReplaceOccurrence`, `ReplaceSkipped`, `ReplaceGroup`, `ReplacePreview`, `FileEdit`, `MotivoSkip`, `TriState`, `contar()`, `estadoGrupo()`, `toggleOcurrencia()`, `toggleGrupo()`, `editsDesdeSeleccion()`.

**Contexto:** los contadores ("21 de 23 en 6 capítulos") y el armado de los `FileEdit` es lo que se rompe callado — un off-by-one acá escribe en archivos que el autor destildó. Por eso va separado del servicio, puro, con smoke runner. El frontend no tiene runner de tests (ver CLAUDE.md); el patrón es `scripts/run-search-locate-smoke.mjs`.

`deselected` guarda los ids **apagados**, no los prendidos, para que un preview nuevo arranque con todo seleccionado sin código extra.

- [ ] **Step 1: Escribir el smoke runner que falla**

Crear `scripts/run-replace-selection-smoke.mjs`:

```js
#!/usr/bin/env node
// Smoke runner de la selección del reemplazo. No es parte del build de Angular.
// Compila el TS a un dir temporal y corre las aserciones.
//
// Prueba la mitad pura: contadores, tri-estado, y el armado de los FileEdit que
// se van a escribir. Un off-by-one acá escribe en archivos que el autor
// destildó, y no hay forma de verlo mirando la UI.
//
// Uso: node scripts/run-replace-selection-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'replace-selection-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--outDir', outDir,
    'src/app/core/replace-selection.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'replace-selection.js')).href);
const { contar, estadoGrupo, toggleOcurrencia, toggleGrupo, editsDesdeSeleccion } = mod;

let passed = 0;
let failed = 0;
function check(nombre, cond) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  ✗ ${nombre}`);
  }
}

/** Grupo de prueba: `n` ocurrencias en `path`, offsets 10, 20, 30… */
function grupo(path, n, skipped = 0) {
  return {
    path,
    title: path,
    occurrences: Array.from({ length: n }, (_, i) => ({
      id: `${path}#${(i + 1) * 10}`,
      snippet: `…ocurrencia ${i}…`,
      htmlStart: (i + 1) * 10,
      htmlEnd: (i + 1) * 10 + 8,
    })),
    skipped: Array.from({ length: skipped }, () => ({
      snippet: '…cruza…',
      reason: 'crossesTag',
    })),
  };
}

const groups = [grupo('/a/1.html', 5), grupo('/a/2.html', 3)];

{
  const c = contar(groups, new Set());
  check('sin nada destildado, todo seleccionado', c.total === 8 && c.selected === 8);
  check('cuenta capítulos', c.chapters === 2 && c.chaptersSelected === 2);
}

{
  const des = new Set(['/a/1.html#20']);
  const c = contar(groups, des);
  check('una destildada baja el selected', c.selected === 7 && c.total === 8);
  check('el capítulo sigue contando', c.chaptersSelected === 2);
}

{
  const des = new Set(groups[1].occurrences.map((o) => o.id));
  const c = contar(groups, des);
  check('capítulo entero destildado no cuenta', c.chaptersSelected === 1);
  check('selected baja al del otro capítulo', c.selected === 5);
}

{
  check('grupo intacto = all', estadoGrupo(groups[0], new Set()) === 'all');
  check(
    'grupo con una destildada = some',
    estadoGrupo(groups[0], new Set(['/a/1.html#20'])) === 'some',
  );
  check(
    'grupo entero destildado = none',
    estadoGrupo(groups[0], new Set(groups[0].occurrences.map((o) => o.id))) === 'none',
  );
}

{
  const a = toggleOcurrencia('/a/1.html#10', new Set());
  check('toggle apaga', a.has('/a/1.html#10'));
  const b = toggleOcurrencia('/a/1.html#10', a);
  check('toggle de nuevo prende', !b.has('/a/1.html#10'));
  check('toggle no muta el Set original', a.has('/a/1.html#10'));
}

{
  const apagado = toggleGrupo(groups[0], new Set());
  check('toggleGrupo desde all apaga todas', estadoGrupo(groups[0], apagado) === 'none');
  check('toggleGrupo no toca el otro grupo', estadoGrupo(groups[1], apagado) === 'all');
  const prendido = toggleGrupo(groups[0], apagado);
  check('toggleGrupo desde none prende todas', estadoGrupo(groups[0], prendido) === 'all');
  const parcial = new Set(['/a/1.html#20']);
  check(
    'toggleGrupo desde some prende todas',
    estadoGrupo(groups[0], toggleGrupo(groups[0], parcial)) === 'all',
  );
}

{
  const edits = editsDesdeSeleccion(groups, new Set(['/a/1.html#20']));
  check('un edit por archivo con selección', edits.length === 2);
  const a = edits.find((e) => e.path === '/a/1.html');
  check('el archivo con 5 menos 1 lleva 4 ranges', a.ranges.length === 4);
  check(
    'la ocurrencia destildada no está en los ranges',
    !a.ranges.some(([start]) => start === 20),
  );
  check('los ranges son [htmlStart, htmlEnd]', a.ranges[0][0] === 10 && a.ranges[0][1] === 18);
}

{
  const todasFuera = new Set(groups[0].occurrences.map((o) => o.id));
  const edits = editsDesdeSeleccion(groups, todasFuera);
  check('el archivo sin selección no genera edit', edits.length === 1);
  check('y el que queda es el otro', edits[0].path === '/a/2.html');
}

{
  // Un grupo que SOLO tiene skipped no aporta nada que escribir.
  const soloSkipped = [grupo('/a/3.html', 0, 2)];
  const c = contar(soloSkipped, new Set());
  check('grupo solo con skipped tiene total 0', c.total === 0);
  check('y no genera edits', editsDesdeSeleccion(soloSkipped, new Set()).length === 0);
  check('y su tri-estado es none', estadoGrupo(soloSkipped[0], new Set()) === 'none');
}

rmSync(outDir, { recursive: true, force: true });

console.log(`replace-selection: ${passed} aserciones OK, ${failed} fallaron`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Correr el smoke y verificar que falla**

Run: `node scripts/run-replace-selection-smoke.mjs`
Expected: FAIL — `tsc` no encuentra `src/app/core/replace-selection.ts`.

- [ ] **Step 3: Implementar el módulo**

Crear `src/app/core/replace-selection.ts`:

```ts
/**
 * Selección del reemplazo en lote: contadores, tri-estado y el armado de los
 * `FileEdit` que se mandan a escribir.
 *
 * Puro a propósito, sin nada de Angular: es la parte que se rompe callado —un
 * off-by-one acá escribe en un archivo que el autor destildó— y el frontend no
 * tiene runner de tests. Se valida con `scripts/run-replace-selection-smoke.mjs`.
 *
 * `deselected` guarda los ids APAGADOS, no los prendidos, así un preview nuevo
 * arranca con todo seleccionado sin código extra.
 */

/** Espejo de `MotivoSkip` en `src-tauri/src/replace.rs`. */
export type MotivoSkip = 'crossesTag' | 'crossesEntity' | 'crossesBlock';

export interface ReplaceOccurrence {
  /** `<path>#<htmlStart>`, generado en Rust. */
  id: string;
  snippet: string;
  htmlStart: number;
  htmlEnd: number;
}

export interface ReplaceSkipped {
  snippet: string;
  reason: MotivoSkip;
}

export interface ReplaceGroup {
  path: string;
  title: string;
  occurrences: ReplaceOccurrence[];
  skipped: ReplaceSkipped[];
}

export interface ReplacePreview {
  groups: ReplaceGroup[];
  total: number;
  totalSkipped: number;
  truncated: boolean;
}

/** Lo que consume `replace_apply`. */
export interface FileEdit {
  path: string;
  ranges: Array<[number, number]>;
}

export interface SelectionCounts {
  total: number;
  selected: number;
  chapters: number;
  /** Capítulos con al menos una ocurrencia seleccionada. */
  chaptersSelected: number;
}

export type TriState = 'all' | 'none' | 'some';

export function contar(groups: ReplaceGroup[], deselected: Set<string>): SelectionCounts {
  let total = 0;
  let selected = 0;
  let chaptersSelected = 0;
  for (const g of groups) {
    total += g.occurrences.length;
    const enGrupo = g.occurrences.filter((o) => !deselected.has(o.id)).length;
    selected += enGrupo;
    if (enGrupo > 0) chaptersSelected += 1;
  }
  return { total, selected, chapters: groups.length, chaptersSelected };
}

export function estadoGrupo(group: ReplaceGroup, deselected: Set<string>): TriState {
  const n = group.occurrences.length;
  if (n === 0) return 'none';
  const apagadas = group.occurrences.filter((o) => deselected.has(o.id)).length;
  if (apagadas === 0) return 'all';
  if (apagadas === n) return 'none';
  return 'some';
}

/** Devuelve un Set NUEVO: los signals comparan por referencia. */
export function toggleOcurrencia(id: string, deselected: Set<string>): Set<string> {
  const out = new Set(deselected);
  if (out.has(id)) out.delete(id);
  else out.add(id);
  return out;
}

/** `all` → apaga todas. `none` y `some` → prende todas. */
export function toggleGrupo(group: ReplaceGroup, deselected: Set<string>): Set<string> {
  const out = new Set(deselected);
  if (estadoGrupo(group, deselected) === 'all') {
    for (const o of group.occurrences) out.add(o.id);
  } else {
    for (const o of group.occurrences) out.delete(o.id);
  }
  return out;
}

/** Un `FileEdit` por archivo con al menos una ocurrencia seleccionada. */
export function editsDesdeSeleccion(
  groups: ReplaceGroup[],
  deselected: Set<string>,
): FileEdit[] {
  const out: FileEdit[] = [];
  for (const g of groups) {
    const ranges = g.occurrences
      .filter((o) => !deselected.has(o.id))
      .map((o): [number, number] => [o.htmlStart, o.htmlEnd]);
    if (ranges.length > 0) out.push({ path: g.path, ranges });
  }
  return out;
}
```

- [ ] **Step 4: Correr el smoke y verificar que pasa**

Run: `node scripts/run-replace-selection-smoke.mjs`
Expected: PASS — `replace-selection: 25 aserciones OK, 0 fallaron`

- [ ] **Step 5: Commit**

```bash
git add src/app/core/replace-selection.ts scripts/run-replace-selection-smoke.mjs
git commit -m "feat(reemplazar): selección pura con smoke runner"
```

---

## Task 6: `ReplaceService` y el modo reemplazo

**Files:**
- Create: `src/app/core/replace-service.ts`
- Modify: `src/app/core/search-service.ts`
- Modify: `src/app/core/settings-service.ts`

**Interfaces:**
- Consumes: de Task 2/3/4 — los comandos `replace_preview`, `replace_apply`, `replace_undo`. De Task 5 — todo `replace-selection.ts`. De la base — `SearchService.{query, applyPathChanges}`, `ChapterService.{flushAllDirty, reloadIfChanged}`, `ProjectService.{findAncestorByKind, loadTree, tree}`, `GitService.refreshStatus`, `SettingsService.{root, searchScope}`, `ToastService`, `DebugService`.
- Produces: `SearchService.replaceMode` (signal), `SettingsService.{replaceCaseSensitive, replaceWholeWord, setReplaceCaseSensitive, setReplaceWholeWord}`, y `ReplaceService` con `{replacement, groups, deselected, counts, applying, previewing, error, truncated, lastUndo, scopeBloqueado, puedeAplicar, motivoBloqueo, toggleOcurrencia, toggleGrupo, apply, undo, reset}`.

**Contexto:** `ReplaceService` inyecta `SearchService`, así que `replaceMode` tiene que vivir en `SearchService` — al revés sería DI circular. El preview depende del needle, los toggles y el scope, **no** del replacement: cambiar el texto de reemplazo no re-escanea nada, solo cambia la etiqueta del botón.

`flushAllDirty()` antes de enumerar es lo que hace que todo el motor pueda ser disk-based, incluido el scope `Archivo actual`: después del flush el disco es igual al buffer del editor.

- [ ] **Step 1: Agregar los toggles a settings**

En `src/app/core/settings-service.ts`, siguiendo exactamente el patrón de `searchFuzzy` (líneas 112, 159, 212, 425, 456):

```ts
// En la interface de settings persistidos, al lado de searchFuzzy:
  /** Toggle `Aa` del reemplazo: distinguir mayúsculas de minúsculas. */
  replaceCaseSensitive?: boolean;
  /** Toggle `ab` del reemplazo: exigir palabra completa. Default ON — sin
   *  esto, reemplazar `golpear` convierte `golpearon` en `golpeóon`. */
  replaceWholeWord?: boolean;

// Signals:
  readonly replaceCaseSensitive = signal<boolean>(false);
  readonly replaceWholeWord = signal<boolean>(true);

// En la carga (al lado de this.searchFuzzy.set(...)):
      this.replaceCaseSensitive.set(s.replaceCaseSensitive ?? false);
      this.replaceWholeWord.set(s.replaceWholeWord ?? true);

// Setters:
  async setReplaceCaseSensitive(enabled: boolean): Promise<void> {
    this.replaceCaseSensitive.set(enabled);
    await this.persist();
  }

  async setReplaceWholeWord(enabled: boolean): Promise<void> {
    this.replaceWholeWord.set(enabled);
    await this.persist();
  }

// En persist(), al lado de searchFuzzy. OJO: wholeWord es true por default,
// así que el `|| undefined` de searchFuzzy NO sirve — borraría el false.
      replaceCaseSensitive: this.replaceCaseSensitive() || undefined,
      replaceWholeWord: this.replaceWholeWord(),
```

- [ ] **Step 2: Agregar `replaceMode` a `SearchService`**

En `src/app/core/search-service.ts`, junto a `open` y `query`:

```ts
  /** Modo reemplazo del panel (toggle `⇄`). Vive acá y no en `ReplaceService`
   *  para que ese pueda inyectar a este sin DI circular. Mientras está
   *  prendido la query a tantivy NO corre: el panel muestra el preview del
   *  reemplazo, que se calcula aparte y sobre el disco. */
  readonly replaceMode = signal<boolean>(false);
```

En el `effect` del constructor, agregar `this.replaceMode();` a las
dependencias leídas, y al principio de `runSearch()`:

```ts
    if (this.replaceMode()) {
      this.loading.set(false);
      return;
    }
```

- [ ] **Step 3: Crear `ReplaceService`**

Crear `src/app/core/replace-service.ts`:

```ts
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ChapterService } from './chapter-service';
import { DebugService } from './debug-service';
import { GitService } from './git-service';
import { ProjectService } from './project-service';
import {
  FileEdit,
  ReplaceGroup,
  ReplacePreview,
  contar,
  editsDesdeSeleccion,
  estadoGrupo,
  toggleGrupo as toggleGrupoPuro,
  toggleOcurrencia as toggleOcurrenciaPuro,
} from './replace-selection';
import { SearchService } from './search-service';
import { SettingsService } from './settings-service';
import { ToastService } from './toast-service';

const DEBOUNCE_MS = 250;

interface ReplaceOutcome {
  files: number;
  occurrences: number;
  /** Cambiaron entre el preview y el apply: no se tocaron. */
  skippedFiles: string[];
  /** Se intentaron escribir y falló (disco lleno, permisos, archivo tomado por
   *  el servicio de sync). Cada entrada es `"<path>: <error>"`. Los que sí se
   *  escribieron antes del fallo están en el snapshot, así que Deshacer los
   *  cubre — hay que decírselo al autor, no tragarse el error. */
  failedFiles: string[];
  snapshotId: string;
}

interface UndoOutcome {
  restored: number;
  blocked: string[];
}

export interface UndoInfo {
  snapshotId: string;
  needle: string;
  replacement: string;
  files: number;
  occurrences: number;
  /** Paths que el undo se negó a pisar por estar editados después. */
  blocked: string[];
}

/** Por qué el reemplazo no se puede correr con la configuración actual. */
export type MotivoBloqueo =
  | 'sinQuery'
  | 'sinCambio'
  | 'scopeNotas'
  | 'sinContexto'
  | 'sinSeleccion'
  | null;

@Injectable({ providedIn: 'root' })
export class ReplaceService {
  private search = inject(SearchService);
  private settings = inject(SettingsService);
  private chapter = inject(ChapterService);
  private project = inject(ProjectService);
  private git = inject(GitService);
  private toast = inject(ToastService);
  private debug = inject(DebugService);

  readonly replacement = signal<string>('');
  readonly groups = signal<ReplaceGroup[]>([]);
  readonly deselected = signal<Set<string>>(new Set());
  readonly previewing = signal<boolean>(false);
  readonly applying = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly truncated = signal<boolean>(false);
  readonly totalSkipped = signal<number>(0);
  readonly lastUndo = signal<UndoInfo | null>(null);

  readonly counts = computed(() => contar(this.groups(), this.deselected()));

  /** True si el scope elegido no puede alimentar un reemplazo. */
  readonly scopeBloqueado = computed<boolean>(() => {
    const s = this.settings.searchScope();
    if (s === 'notes') return true;
    if (s === 'current') {
      const activo = this.chapter.panes[0].active();
      return activo == null || !activo.path.toLowerCase().endsWith('.html');
    }
    return false;
  });

  readonly motivoBloqueo = computed<MotivoBloqueo>(() => {
    if (!this.search.query().trim()) return 'sinQuery';
    if (this.search.query().trim() === this.replacement()) return 'sinCambio';
    if (this.scopeBloqueado()) return 'scopeNotas';
    if (this.search.scopeNeedsContext()) return 'sinContexto';
    if (this.counts().selected === 0) return 'sinSeleccion';
    return null;
  });

  readonly puedeAplicar = computed<boolean>(
    () => this.motivoBloqueo() === null && !this.applying() && !this.previewing(),
  );

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 0;

  constructor() {
    // El preview depende del needle, los toggles y el scope. NO del
    // replacement: cambiar el texto de reemplazo solo cambia la etiqueta del
    // botón, no lo que se encontró.
    effect(() => {
      const activo = this.search.replaceMode();
      this.search.query();
      this.settings.searchScope();
      this.settings.replaceCaseSensitive();
      this.settings.replaceWholeWord();
      this.chapter.panes[0].active();
      if (!activo) {
        this.reset();
        return;
      }
      this.schedulePreview();
    });
  }

  reset(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.groups.set([]);
    this.deselected.set(new Set());
    this.error.set(null);
    this.truncated.set(false);
    this.totalSkipped.set(0);
    this.previewing.set(false);
  }

  setReplacement(value: string): void {
    this.replacement.set(value);
  }

  toggleOcurrencia(id: string): void {
    this.deselected.set(toggleOcurrenciaPuro(id, this.deselected()));
  }

  toggleGrupo(group: ReplaceGroup): void {
    this.deselected.set(toggleGrupoPuro(group, this.deselected()));
  }

  estadoGrupo(group: ReplaceGroup): 'all' | 'none' | 'some' {
    return estadoGrupo(group, this.deselected());
  }

  private schedulePreview(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runPreview();
    }, DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    const needle = this.search.query().trim();
    if (!needle || this.scopeBloqueado()) {
      this.groups.set([]);
      this.totalSkipped.set(0);
      this.truncated.set(false);
      return;
    }
    const scopePath = this.resolveScopePath();
    if (!scopePath) {
      this.groups.set([]);
      return;
    }
    const id = ++this.requestId;
    this.previewing.set(true);
    this.error.set(null);
    try {
      // El disco tiene que estar al día antes de escanearlo: el capítulo
      // abierto puede tener ediciones sin guardar.
      await this.chapter.flushAllDirty();
      const pv = await invoke<ReplacePreview>('replace_preview', {
        scopePath,
        needle,
        caseSensitive: this.settings.replaceCaseSensitive(),
        wholeWord: this.settings.replaceWholeWord(),
      });
      if (id !== this.requestId) return;
      this.groups.set(pv.groups);
      this.totalSkipped.set(pv.totalSkipped);
      this.truncated.set(pv.truncated);
      // Las ocurrencias que ya no existen se van del set de apagadas, así el
      // contador no queda mintiendo tras editar la query.
      const vivos = new Set(pv.groups.flatMap((g) => g.occurrences.map((o) => o.id)));
      this.deselected.update((prev) => new Set([...prev].filter((id) => vivos.has(id))));
    } catch (err) {
      if (id !== this.requestId) return;
      this.error.set(String(err));
      this.groups.set([]);
      this.debug.error('replace', `preview falló: ${err}`);
    } finally {
      if (id === this.requestId) this.previewing.set(false);
    }
  }

  /**
   * Mapea el scope del panel a un PATH de disco. `replace_preview` camina un
   * directorio (o un archivo suelto), no filtra por nombre de saga como hace
   * tantivy, así que hay que resolver el ancestro a su path.
   */
  private resolveScopePath(): string | null {
    const s = this.settings.searchScope();
    const root = this.settings.root();
    if (s === 'all' || s === 'chapters') return root ?? null;
    const activo = this.chapter.panes[0].active();
    if (s === 'current') return activo?.path ?? null;
    if (!activo) return null;
    if (s === 'saga') return this.project.findAncestorByKind(activo.path, 'saga')?.path ?? null;
    if (s === 'book') return this.project.findAncestorByKind(activo.path, 'book')?.path ?? null;
    return null;
  }

  async apply(): Promise<void> {
    if (!this.puedeAplicar()) return;
    const root = this.settings.root();
    if (!root) return;
    const needle = this.search.query().trim();
    const replacement = this.replacement();
    const edits: FileEdit[] = editsDesdeSeleccion(this.groups(), this.deselected());
    if (edits.length === 0) return;
    this.applying.set(true);
    try {
      await this.chapter.flushAllDirty();
      const out = await invoke<ReplaceOutcome>('replace_apply', {
        root,
        needle,
        caseSensitive: this.settings.replaceCaseSensitive(),
        wholeWord: this.settings.replaceWholeWord(),
        edits,
        replacement,
        // Rust no tiene crate de fechas; el formato lo fija el frontend, igual
        // que en cada save de capítulo (`chapter-service.ts:199`).
        ultimaEdicion: new Date().toISOString(),
      });
      await this.afterWrite(edits.map((e) => e.path));
      if (out.snapshotId) {
        this.lastUndo.set({
          snapshotId: out.snapshotId,
          needle,
          replacement,
          files: out.files,
          occurrences: out.occurrences,
          blocked: [],
        });
      }
      const verbo = replacement ? 'Reemplacé' : 'Borré';
      this.toast.success(
        `${verbo} ${out.occurrences} en ${out.files} capítulo${out.files === 1 ? '' : 's'}.`,
      );
      if (out.skippedFiles.length > 0) {
        this.toast.warn(
          `${out.skippedFiles.length} capítulo${out.skippedFiles.length === 1 ? '' : 's'} cambiaron desde el preview: no los toqué.`,
        );
      }
      if (out.failedFiles.length > 0) {
        // Se escribieron algunos y otros no. El autor tiene que saberlo Y saber
        // que Deshacer cubre los que sí se escribieron.
        this.toast.error(
          `No pude escribir ${out.failedFiles.length} capítulo${out.failedFiles.length === 1 ? '' : 's'}. ` +
            `Los que sí cambiaron se pueden deshacer.`,
        );
        this.debug.error('replace', 'fallos de escritura', out.failedFiles.join('\n'));
      }
      this.debug.info('replace', 'apply', JSON.stringify(out));
      await this.runPreview();
    } catch (err) {
      this.error.set(String(err));
      this.toast.error(`Reemplazo: ${err}`);
      this.debug.error('replace', `apply falló: ${err}`);
    } finally {
      this.applying.set(false);
    }
  }

  async undo(forcePaths: string[] = []): Promise<void> {
    const info = this.lastUndo();
    const root = this.settings.root();
    if (!info || !root) return;
    this.applying.set(true);
    try {
      await this.chapter.flushAllDirty();
      const out = await invoke<UndoOutcome>('replace_undo', {
        root,
        snapshotId: info.snapshotId,
        forcePaths,
        ultimaEdicion: new Date().toISOString(),
      });
      await this.afterWrite(this.groups().map((g) => g.path));
      if (out.blocked.length > 0) {
        this.lastUndo.set({ ...info, blocked: out.blocked });
        this.toast.warn(
          `Deshice ${out.restored}. ${out.blocked.length} capítulo${out.blocked.length === 1 ? '' : 's'} se editaron después del reemplazo y no los pisé.`,
        );
      } else {
        this.lastUndo.set(null);
        this.toast.success(`Deshecho: ${out.restored} capítulo${out.restored === 1 ? '' : 's'}.`);
      }
      this.debug.info('replace', 'undo', JSON.stringify(out));
      await this.runPreview();
    } catch (err) {
      this.toast.error(`Deshacer: ${err}`);
      this.debug.error('replace', `undo falló: ${err}`);
    } finally {
      this.applying.set(false);
    }
  }

  /** Refresca todo lo que quedó viejo tras escribir en disco. Mismo orden que
   *  usa `QuotesFixService` después de un fix en lote. */
  private async afterWrite(paths: string[]): Promise<void> {
    await this.chapter.reloadIfChanged(paths.map((path) => ({ path, kind: 'modified' as const })));
    await this.project.loadTree();
    void this.git.refreshStatus();
    await this.search.applyPathChanges(paths.map((path) => ({ path, kind: 'modified' as const })));
  }
}
```

Firmas ya verificadas contra el repo, no hace falta chequearlas de nuevo:
`ProjectService.findAncestorByKind(path, kind)` (`project-service.ts:59`) y
`loadTree()` (`:18`), `GitService.refreshStatus()` (`git-service.ts:305`), y
`PullChangeKind = 'added' | 'modified' | 'deleted' | 'renamed'`
(`types.ts:87`), así que `'modified'` es válido.

- [ ] **Step 4: Verificar que compila**

Run: `pnpm build`
Expected: build de Angular OK, sin errores de tipos.

- [ ] **Step 5: Commit**

```bash
git add src/app/core/replace-service.ts src/app/core/search-service.ts src/app/core/settings-service.ts
git commit -m "feat(reemplazar): ReplaceService y modo reemplazo del panel"
```

---

## Task 7: La UI del panel

**Files:**
- Modify: `src/app/search-panel/search-panel.ts`
- Modify: `src/app/search-panel/search-panel.html`
- Modify: `src/app/search-panel/search-panel.scss`

**Interfaces:**
- Consumes: de Task 6 — todo `ReplaceService` y `SearchService.replaceMode`, `SettingsService.{replaceCaseSensitive, replaceWholeWord, setReplaceCaseSensitive, setReplaceWholeWord}`. De Task 5 — `ReplaceGroup`, `MotivoSkip`.
- Produces: nada que consuman otras tasks.

**Contexto:** el panel ya tiene header con toggles (`≈`, 🐛), fila de scope y `sp-body` con la lista agrupada. El modo reemplazo agrega una fila y **reemplaza** el contenido de `sp-body` por el preview. Los estilos existentes a reusar: `.sp-btn`, `.is-active`, `.sp-status`, `.sp-group`, `.sp-hit-snippet`, `.sp-count`.

El tri-estado del checkbox del capítulo se hace con la property `indeterminate` del input, no con una clase.

- [ ] **Step 1: Agregar el estado y los handlers al componente**

En `src/app/search-panel/search-panel.ts`:

```ts
// imports nuevos
import { LucideReplace } from '@lucide/angular';
import { ReplaceService } from '../core/replace-service';
import type { MotivoSkip, ReplaceGroup } from '../core/replace-selection';

// en el decorador @Component, agregar LucideReplace al array `imports`

// inyección y proyecciones, al lado de las que ya están
  private replace = inject(ReplaceService);

  protected readonly replaceMode = this.svc.replaceMode;
  protected readonly replacement = this.replace.replacement;
  protected readonly replaceGroups = this.replace.groups;
  protected readonly replaceCounts = this.replace.counts;
  protected readonly replacePreviewing = this.replace.previewing;
  protected readonly replaceApplying = this.replace.applying;
  protected readonly replaceError = this.replace.error;
  protected readonly replaceTruncated = this.replace.truncated;
  protected readonly replaceSkipped = this.replace.totalSkipped;
  protected readonly puedeAplicar = this.replace.puedeAplicar;
  protected readonly motivoBloqueo = this.replace.motivoBloqueo;
  protected readonly lastUndo = this.replace.lastUndo;
  protected readonly caseSensitive = this.settings.replaceCaseSensitive;
  protected readonly wholeWord = this.settings.replaceWholeWord;

  protected toggleReplaceMode(): void {
    this.svc.replaceMode.update((v) => !v);
    queueMicrotask(() => this.inputRef?.nativeElement.focus());
  }

  protected onReplacementInput(event: Event): void {
    this.replace.setReplacement((event.target as HTMLInputElement).value);
  }

  protected toggleCaseSensitive(): void {
    void this.settings.setReplaceCaseSensitive(!this.caseSensitive());
  }

  protected toggleWholeWord(): void {
    void this.settings.setReplaceWholeWord(!this.wholeWord());
  }

  protected estadoGrupo(group: ReplaceGroup): 'all' | 'none' | 'some' {
    return this.replace.estadoGrupo(group);
  }

  protected estaSeleccionada(id: string): boolean {
    return !this.replace.deselected().has(id);
  }

  protected onToggleOcurrencia(id: string): void {
    this.replace.toggleOcurrencia(id);
  }

  protected onToggleGrupo(group: ReplaceGroup): void {
    this.replace.toggleGrupo(group);
  }

  protected aplicarReemplazo(): void {
    void this.replace.apply();
  }

  protected deshacerReemplazo(): void {
    void this.replace.undo();
  }

  protected forzarDeshacer(): void {
    const info = this.lastUndo();
    if (!info) return;
    void this.replace.undo(info.blocked);
  }

  /** Etiqueta del botón. Replacement vacío es borrar, y hay que decirlo. */
  protected labelAplicar(): string {
    const n = this.replaceCounts().selected;
    const verbo = this.replacement() ? 'Reemplazar' : 'Borrar';
    if (n === 1) return `${verbo} 1 ocurrencia`;
    return `${verbo} las ${n} seleccionadas`;
  }

  /** El motivo va en texto VISIBLE al lado del botón, no en un tooltip: si la
   *  app sabe por qué no se puede, lo dice. */
  protected textoBloqueo(): string {
    switch (this.motivoBloqueo()) {
      case 'sinQuery':
        return 'Escribí qué buscar.';
      case 'sinCambio':
        return 'El texto de reemplazo es igual al buscado.';
      case 'scopeNotas':
        return 'El reemplazo solo toca capítulos, no notas.';
      case 'sinContexto':
        return 'Abrí un capítulo para usar este alcance.';
      case 'sinSeleccion':
        return 'No hay ocurrencias seleccionadas.';
      default:
        return '';
    }
  }

  protected motivoSkipLabel(reason: MotivoSkip): string {
    switch (reason) {
      case 'crossesTag':
        return 'cruza una cursiva o negrita';
      case 'crossesEntity':
        return 'contiene un carácter escapado';
      case 'crossesBlock':
        return 'cruza dos párrafos';
    }
  }
```

- [ ] **Step 2: Agregar el markup**

En `src/app/search-panel/search-panel.html`, insertar el botón `⇄` en el header **después** del botón de `≈` (para que el orden sea `? ≈ ⇄ 🐛`):

```html
  <button
    type="button"
    class="sp-btn"
    [class.is-active]="replaceMode()"
    (click)="toggleReplaceMode()"
    [title]="replaceMode() ? 'Cerrar el reemplazo' : 'Reemplazar en lote'"
    aria-label="Toggle modo reemplazo"
  >
    <svg class="ico" lucideReplace [size]="14"></svg>
  </button>
```

Y en el botón del `≈` que ya existe, agregar `[disabled]="replaceMode()"` más el motivo en el title cuando está deshabilitado:

```html
    [disabled]="replaceMode()"
    [title]="
      replaceMode()
        ? 'La búsqueda flexible (≈) no se puede usar para reemplazar: un match aproximado cambiaría palabras que no pediste.'
        : searchFuzzy()
          ? 'Búsqueda flexible (≈) ON — tolera typos y acentos. Apagá para buscar el texto exacto (corregir errores).'
          : 'Búsqueda exacta — encuentra el texto literal. Activá (≈) para tolerar typos/acentos (nombres inventados).'
    "
```

Después del header y **antes** de `.sp-scope-row`, la fila de reemplazo:

```html
@if (replaceMode()) {
  <div class="sp-replace-row">
    <svg class="sp-icon" lucideReplace [size]="16"></svg>
    <input
      type="text"
      class="sp-input"
      placeholder="Reemplazar por… (vacío borra)"
      [value]="replacement()"
      (input)="onReplacementInput($event)"
      spellcheck="false"
      autocomplete="off"
    />
    <button
      type="button"
      class="sp-btn"
      [class.is-active]="caseSensitive()"
      (click)="toggleCaseSensitive()"
      title="Distinguir mayúsculas de minúsculas"
      aria-label="Toggle distinguir mayúsculas"
    >
      <span class="ico">Aa</span>
    </button>
    <button
      type="button"
      class="sp-btn"
      [class.is-active]="wholeWord()"
      (click)="toggleWholeWord()"
      title="Palabra completa — con esto apagado, reemplazar «golpear» también toca «golpearon»"
      aria-label="Toggle palabra completa"
    >
      <span class="ico">ab</span>
    </button>
  </div>
}
```

Y envolver el contenido de `.sp-body`: el bloque de búsqueda que ya existe va dentro de un `@if (!replaceMode()) { … }`, y al lado se agrega el del reemplazo:

```html
@if (replaceMode()) {
  @if (replaceError(); as err) {
    <p class="sp-status sp-error">{{ err }}</p>
  }
  @if (replacePreviewing()) {
    <p class="sp-status">Buscando ocurrencias…</p>
  }
  @if (replaceTruncated()) {
    <p class="sp-status sp-partial">
      Demasiadas ocurrencias para revisar de una. Acotá el alcance o el término.
    </p>
  }
  @if (!replacePreviewing() && replaceCounts().total === 0 && replaceSkipped() === 0) {
    @if (motivoBloqueo() === 'sinQuery') {
      <p class="sp-status sp-hint">
        Escribí arriba qué buscar y acá con qué reemplazarlo. Solo toca capítulos.
      </p>
    } @else if (motivoBloqueo() === 'scopeNotas') {
      <p class="sp-status sp-partial">
        El reemplazo solo toca capítulos. Elegí otro alcance.
      </p>
    } @else {
      <p class="sp-status">
        Sin ocurrencias exactas de "{{ query() }}". El reemplazo no usa ≈ ni pliega
        acentos.
      </p>
    }
  }

  @if (replaceCounts().total > 0) {
    <p class="sp-count">
      {{ replaceCounts().total }} en {{ replaceCounts().chapters }} capítulo{{ replaceCounts().chapters === 1 ? '' : 's' }}
      · {{ replaceCounts().selected }} seleccionada{{ replaceCounts().selected === 1 ? '' : 's' }}
    </p>
    <ul class="sp-list">
      @for (group of replaceGroups(); track group.path) {
        <li class="sp-group">
          <details class="sp-group-details" open>
            <summary class="sp-group-head" [title]="group.path">
              <input
                type="checkbox"
                class="sp-check"
                [checked]="estadoGrupo(group) === 'all'"
                [indeterminate]="estadoGrupo(group) === 'some'"
                (click)="$event.stopPropagation()"
                (change)="onToggleGrupo(group)"
                [attr.aria-label]="'Seleccionar todas en ' + group.title"
              />
              <span class="sp-hit-title">{{ group.title }}</span>
              <span class="sp-group-count">
                {{ group.occurrences.length }}
              </span>
            </summary>
            <ul class="sp-group-body">
              @for (occ of group.occurrences; track occ.id) {
                <li class="sp-item sp-item--check">
                  <label class="sp-occ">
                    <input
                      type="checkbox"
                      class="sp-check"
                      [checked]="estaSeleccionada(occ.id)"
                      (change)="onToggleOcurrencia(occ.id)"
                    />
                    <span class="sp-hit-snippet">{{ occ.snippet }}</span>
                  </label>
                </li>
              }
              @for (sk of group.skipped; track $index) {
                <li class="sp-item sp-item--skipped">
                  <span class="sp-hit-snippet">{{ sk.snippet }}</span>
                  <span class="sp-skip-why">no se reemplaza: {{ motivoSkipLabel(sk.reason) }}</span>
                </li>
              }
            </ul>
            <p class="sp-hit-path">{{ group.path }}</p>
          </details>
        </li>
      }
    </ul>
  }

  @if (lastUndo(); as u) {
    <div class="sp-undo-bar">
      <span class="sp-undo-text">
        Último: {{ u.needle }} → {{ u.replacement || '(borrado)' }} ·
        {{ u.occurrences }} en {{ u.files }} capítulo{{ u.files === 1 ? '' : 's' }}
      </span>
      @if (u.blocked.length > 0) {
        <span class="sp-undo-blocked">
          {{ u.blocked.length }} se editaron después y no los pisé.
        </span>
        <button type="button" class="sp-btn" (click)="forzarDeshacer()" [disabled]="replaceApplying()">
          Pisarlos igual
        </button>
      } @else {
        <button type="button" class="sp-btn" (click)="deshacerReemplazo()" [disabled]="replaceApplying()">
          Deshacer
        </button>
      }
    </div>
  }

  <div class="sp-apply-row">
    @if (textoBloqueo(); as why) {
      <span class="sp-apply-why">{{ why }}</span>
    }
    <button
      type="button"
      class="sp-apply"
      [disabled]="!puedeAplicar()"
      (click)="aplicarReemplazo()"
    >
      {{ replaceApplying() ? 'Aplicando…' : labelAplicar() }}
    </button>
  </div>
}
```

- [ ] **Step 3: Agregar los estilos**

En `src/app/search-panel/search-panel.scss`, siguiendo las variables y el
espaciado que ya usa el archivo (leerlo primero y copiar los tokens de color
que estén en uso — no introducir colores nuevos a mano):

```scss
.sp-replace-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0 0.5rem 0.5rem;
}

.sp-check {
  flex: 0 0 auto;
  margin: 0 0.4rem 0 0;
  cursor: pointer;
}

.sp-occ {
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
  cursor: pointer;
  width: 100%;
  text-align: left;
}

.sp-item--skipped {
  opacity: 0.6;
}

.sp-skip-why {
  display: block;
  font-size: 0.75rem;
  font-style: italic;
}

.sp-undo-bar,
.sp-apply-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.5rem;
}

.sp-undo-text,
.sp-apply-why,
.sp-undo-blocked {
  font-size: 0.8rem;
}

.sp-apply {
  margin-left: auto;
  padding: 0.4rem 0.8rem;
  cursor: pointer;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}
```

- [ ] **Step 4: Verificar que compila**

Run: `pnpm build`
Expected: build OK. `LucideReplace` ya está verificado como export válido de
la versión de `@lucide/angular` que tiene el repo.

- [ ] **Step 5: Correr todos los chequeos**

```bash
pnpm build
node scripts/run-replace-selection-smoke.mjs
node scripts/run-search-locate-smoke.mjs
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: los cuatro en verde.

- [ ] **Step 6: Commit**

```bash
git add src/app/search-panel
git commit -m "feat(reemplazar): UI de reemplazo en el panel de búsqueda"
```

---

## Task 8: Cerrar el item del TODO y handoff al autor

**Files:**
- Modify: `TODO.md` (el item que arranca en la línea 1798)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada.

**Contexto:** el item del TODO no se marca como hecho hasta que el autor lo verifique con la app levantada — la verificación manual la hace él. Lo que corresponde acá es dejar el item describiendo lo que se construyó y qué falta probar a mano.

- [ ] **Step 1: Reescribir el item del TODO**

Reemplazar el cuerpo del item "**No hay reemplazar…**" (línea 1798) por el estado real, conservando el `- [ ]` sin marcar y siguiendo el estilo del archivo (prosa que explica el por qué, no un changelog):

```markdown
- [ ] **Reemplazar en lote: implementado, pendiente de verificación del autor**
  (reportado el 2026-09-03: "estuve buscando Angelica para cambiar por Angélica
  a mano como mono")
  Diseño en `docs/superpowers/specs/2026-09-03-reemplazar-en-lote-design.md`,
  plan en `docs/superpowers/plans/2026-09-03-reemplazar-en-lote.md`.
  Vive en el panel de búsqueda detrás del toggle `⇄`: reusa el selector de
  scope, enumera con `replace_preview` (Rust) sobre el disco —no sobre el
  índice tantivy, así que es inmune al bug del índice mudo—, deja destildar
  ocurrencia por ocurrencia, y escribe con `replace_apply` previo snapshot en
  `.twriter/undo/`.
  La pieza no obvia es el mapa **plain ↔ HTML por runs**: se busca en el texto
  plano y se escribe en el HTML, y una ocurrencia solo es reemplazable si cae
  entera dentro de un run. Esa única regla es la que evita pisar una cursiva,
  romper una entidad o matchear de punta a punta de dos párrafos, sin código
  especial para cada caso. Lo salteado se muestra con su snippet y el motivo.
  **Qué falta probar a mano** (la app tiene que estar levantada):
  1. `Angelica` → `Angélica` con scope "Todo el repo" sobre el repo de prueba:
     que el conteo del preview coincida con lo que se ve, y que el árbol y el
     status de git se refresquen sin recargar.
  2. Destildar una ocurrencia suelta y confirmar que ese párrafo queda intacto.
  3. Deshacer, y después reemplazar de nuevo: que el snapshot viejo se borre.
  4. Editar un capítulo *después* de un reemplazo y recién entonces Deshacer:
     tiene que negarse a pisarlo y ofrecer "Pisarlos igual".
  5. Un reemplazo con el capítulo abierto y con cambios sin guardar: el flush
     tiene que entrar antes del escaneo, o el preview cuenta de menos.
```

- [ ] **Step 2: Commit**

```bash
git add TODO.md
git commit -m "docs(todo): reemplazar en lote implementado, pendiente de verificación"
```

- [ ] **Step 3: Avisar al autor qué probar**

Pasarle la lista de los 5 puntos del TODO, aclarando que el repo de prueba
(no-git, descartable) es el lugar para probarlo y no el `Novelas/` real.
Recordarle que **`pnpm tauri dev` hay que reiniciarlo**, porque los cambios de
Rust no entran por HMR.

---

## Self-Review

**Cobertura del spec** — recorrido sección por sección:

| Sección del spec | Task |
|---|---|
| Motor de runs, regla de "entero dentro de un run" | 1 |
| Toggles `Aa` / `ab`, sin plegado de acentos | 1 (motor), 6 (persistencia), 7 (UI) |
| `≈` deshabilitado con el motivo | 7 |
| `replace_preview`, walk compartido, título del meta, topes 2000/500 | 2 |
| Payload `ReplaceOccurrence`/`Skipped`/`Group`/`Preview`, id `<path>#<htmlStart>` | 2 (Rust), 5 (TS) |
| `replace_apply`, revalidación contra el disco, escritura parcial | 3 |
| Snapshot en `.twriter/undo/`, manifest, solo el último | 3 |
| `palabras` en `.twriter/stats.json` con un solo read/write | 3 |
| `replace_undo` + guard de mtime + `force_paths` | 4 |
| Selección, tri-estado, contadores, `FileEdit` | 5 |
| `replaceMode` en `SearchService`, query a tantivy cortada | 6 |
| `flushAllDirty` / `reloadIfChanged` / `loadTree` / `refreshStatus` / índice | 6 |
| Scope resuelto a path; `Notas` y `Archivo actual`-nota bloqueados con motivo | 6 (lógica), 7 (texto) |
| Botón deshabilitado con motivo visible; replacement vacío = borrar | 7 |
| Barra de Deshacer en el panel (no en el toast) | 7 |
| Mensaje de 0 ocurrencias que explica el por qué | 7 |
| Fuera de alcance (notas, regex, undo de PM, historial, títulos) | no se implementa, por diseño |

Sin huecos.

**Placeholders**: no quedan "TBD" ni "manejar los errores apropiadamente". Los
tres puntos donde el plan manda **verificar antes de escribir** (el helper de
timestamp ISO en Task 3, las firmas de `project-service`/`git-service`/
`PullPathChange` en Task 6, el nombre del ícono de lucide en Task 7) son
comandos concretos con qué hacer según el resultado, no vaguedades: son cosas
que el plan no puede afirmar sin leer esos archivos, y adivinarlas sería peor.

**Consistencia de tipos**: `Opciones{case_sensitive, whole_word}` se usa igual
en las cuatro tasks de Rust. `MotivoSkip` serializa `camelCase` (`crossesTag`)
y el TS de Task 5 declara exactamente esos tres strings. `FileEdit.ranges` es
`Vec<(usize, usize)>` en Rust y `Array<[number, number]>` en TS, y
`editsDesdeSeleccion` los emite en ese orden `[htmlStart, htmlEnd]`, que es lo
que la revalidación de Task 3 compara contra `vigentes`. `ReplaceOutcome`
serializa `skippedFiles`/`snapshotId` en camelCase y la interface de Task 6 los
lee con esos nombres. `snapshot_id` vacío ⇒ Task 6 no setea `lastUndo`, que es
el caso "no se escribió nada" del test de Task 3.

---

**Plan completo y guardado en `docs/superpowers/plans/2026-09-03-reemplazar-en-lote.md`.**
