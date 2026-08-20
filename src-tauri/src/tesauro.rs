//! Tesauro MyThes embebido. Ver
//! `docs/superpowers/specs/2026-08-20-tesauro-design.md`.

/// Una acepción de una palabra. `categoria` es `Some("noun")` / `Some("verb")` /
/// … en inglés, y en español es `None` en la enorme mayoría de las entradas —
/// pero **no siempre**: ~810 acepciones de `th_es_v2.dat` traen la abreviatura
/// de la RAE (`(m.)`, `(adj.)`, `(f.)`, `(tr.)`, `(prnl.)`, `(intr.)`,
/// `(m. fig.)`, `(f. fig.)`, `(fig.)`, `(intr.-prnl.)`, `(interj.)`, `(adv.)`),
/// así que el frontend tiene que saber traducir las dos tablas.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Acepcion {
    pub categoria: Option<String>,
    pub sinonimos: Vec<String>,
}

/// Lo que ve el frontend. `disponible: false` significa que el tesauro del
/// idioma **no se pudo cargar** (recurso ausente del bundle): distinto de una
/// palabra sin entrada, que es `disponible: true` con `acepciones` vacío. Sin la
/// distinción, un empaquetado roto se ve igual que "sin sinónimos" y el usuario
/// busca el problema en la palabra.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RespuestaTesauro {
    pub disponible: bool,
    pub acepciones: Vec<Acepcion>,
}

use std::collections::{HashMap, HashSet};

/// Techo de lo que se le manda al popover. WordNet tiene entradas con decenas de
/// sinónimos y el popover no es un diccionario: los primeros son los más
/// cercanos en el orden del archivo.
const MAX_ACEPCIONES: usize = 4;
const MAX_SINONIMOS: usize = 12;

/// Enclíticos **del español**, de más largo a más corto — el orden importa:
/// `selo` tiene que probarse antes que `lo`.
const ENCLITICOS: [&str; 14] = [
    "selos", "selas", "selo", "sela", "los", "las", "les", "nos", "lo", "la", "le", "me", "te",
    "se",
];

pub struct Tesauro {
    texto: String,
    /// clave → (offset de byte donde arranca la primera línea de acepción, N)
    indice: HashMap<String, (usize, usize)>,
    /// Las normalizaciones morfológicas son por idioma: los enclíticos y la
    /// regla de plural vocal/consonante son del español y sobre datos ingleses
    /// producen no-palabras (`rifles` → `firearmes`).
    ingles: bool,
}

impl Tesauro {
    /// Una pasada sobre el `.dat` armando el índice de claves. El texto queda
    /// entero en memoria: son 2,8 MB el español y ~6,3 MB el inglés, y así no
    /// hace falta el `.idx` ni hacer `seek` por consulta.
    pub fn parse(dat: &str, ingles: bool) -> Tesauro {
        let mut indice: HashMap<String, (usize, usize)> = HashMap::new();
        let mut offset = 0usize;
        let mut saltar = 0usize; // líneas de acepción pendientes de la entrada actual
        for linea in dat.split('\n') {
            let largo = linea.len() + 1; // +1 por el \n que `split` se comió
            if saltar > 0 {
                saltar -= 1;
                offset += largo;
                continue;
            }
            if let Some(corte) = linea.rfind('|') {
                if let Ok(n) = linea[corte + 1..].trim().parse::<usize>() {
                    let clave = linea[..corte].to_lowercase();
                    indice.insert(clave, (offset + largo, n));
                    saltar = n;
                }
            }
            offset += largo;
        }
        Tesauro {
            texto: dat.to_string(),
            indice,
            ingles,
        }
    }

    pub fn lookup(&self, palabra: &str) -> Vec<Acepcion> {
        let clave = palabra.trim().to_lowercase();
        if clave.is_empty() {
            return Vec::new();
        }
        if let Some(a) = self.entrada(&clave) {
            return a;
        }
        // Plural simple, re-pluralizando los sinónimos. No se lematiza: ver el
        // spec, un lema sin re-conjugar da sugerencias que no concuerdan.
        //
        // Va ANTES que los enclíticos a propósito: en el `.dat` español hay 116
        // plurales reales que también se leen como enclítico, y dos son palabras
        // de novela — `calles` daba sinónimos de `cal` y `caballos` de `cabal`.
        for suf in ["es", "s"] {
            if let Some(base) = clave.strip_suffix(suf) {
                if base.chars().count() >= 3 {
                    if let Some(a) = self.entrada(base) {
                        return a
                            .into_iter()
                            .map(|ac| Acepcion {
                                categoria: ac.categoria,
                                sinonimos: ac
                                    .sinonimos
                                    .iter()
                                    .map(|s| self.pluralizar(s))
                                    .collect(),
                            })
                            .collect();
                    }
                }
            }
        }
        // Enclítico: `mirarlo` → `mirar`. Solo si lo que queda existe, así no
        // hay que saber si la palabra era un infinitivo o un gerundio. Solo en
        // español: en inglés no existen y el recorte inventaba resultados
        // (`tables` → `les` → `tab` → "check", "chit", "bill").
        if !self.ingles {
            for suf in ENCLITICOS {
                if let Some(base) = clave.strip_suffix(suf) {
                    if base.chars().count() >= 3 {
                        if let Some(a) = self.entrada(base) {
                            return a;
                        }
                    }
                }
            }
        }
        Vec::new()
    }

    /// El plural del sinónimo tiene que concordar con el de la palabra
    /// consultada, y cada idioma lo forma distinto.
    fn pluralizar(&self, s: &str) -> String {
        if self.ingles {
            pluralizar_en(s)
        } else {
            pluralizar_es(s)
        }
    }

    fn entrada(&self, clave: &str) -> Option<Vec<Acepcion>> {
        let &(inicio, n) = self.indice.get(clave)?;
        let mut out = Vec::new();
        // `.get` en vez de indexar directo: un .dat truncado (cabecera sin
        // líneas de datos ni \n final) deja `inicio` justo en el borde del
        // buffer y el índice directo panickearía.
        for linea in self.texto.get(inicio..)?.split('\n').take(n.min(MAX_ACEPCIONES)) {
            let mut campos = linea.split('|');
            let cat = campos.next().unwrap_or("-");
            // El 28,9% de las entradas inglesas se lista a sí misma como
            // sinónimo (`light`, `word`, `night`, `run`) y 493 acepciones
            // repiten un sinónimo adentro de los primeros campos: un chip que
            // reemplaza la palabra por sí misma, y chips duplicados que además
            // rompen el `track s` del `@for` (NG0955). El tope va DESPUÉS del
            // filtro, así un descarte no se come un sinónimo bueno.
            let mut vistos: HashSet<String> = HashSet::new();
            let sinonimos: Vec<String> = campos
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .filter(|s| {
                    let norm = s.to_lowercase();
                    norm != clave && vistos.insert(norm)
                })
                .take(MAX_SINONIMOS)
                .map(|s| s.to_string())
                .collect();
            if sinonimos.is_empty() {
                continue;
            }
            out.push(Acepcion {
                categoria: match cat.trim().trim_start_matches('(').trim_end_matches(')') {
                    "-" | "" => None,
                    c => Some(c.to_string()),
                },
                sinonimos,
            });
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }
}

/// Plural inglés por la **terminación del sinónimo**, no por el sufijo con el
/// que entró la consulta: WordNet trae sinónimos que ya terminan en `s`
/// (`Canis familiaris`, y las entradas latinas en general) y reponer otra daba
/// `Canis familiariss`. Con esto, `dog` → `canid` → `canids`, `stone` → `rock`
/// → `rocks`, `box` → `boxes`.
///
/// ponytail: las frases multipalabra se pluralizan por la última palabra
/// (`movable barrier` → `movable barriers`), que es lo correcto en inglés más a
/// menudo de lo que falla; hacerlo bien pide morfología que no vale la pena
/// acá. El usuario ve el resultado antes de aceptarlo.
fn pluralizar_en(s: &str) -> String {
    let anteultima = s.chars().rev().nth(1);
    if s.ends_with('s') {
        s.to_string()
    } else if s.ends_with('x') || s.ends_with('z') || s.ends_with("ch") || s.ends_with("sh") {
        format!("{s}es")
    // Consonante + `y` → `ies` (`extremity` → `extremities`). Con vocal antes
    // de la `y` cae al `+s` de siempre, que es el caso fácil (`boy` → `boys`):
    // esa distinción es toda la regla.
    } else if s.ends_with('y') && matches!(anteultima, Some(c) if !"aeiou".contains(c)) {
        format!("{}ies", s.trim_end_matches('y'))
    } else {
        format!("{s}s")
    }
}

/// ponytail: regla de plural cruda del **español** (vocal → `s`, consonante →
/// `es`). Falla en `luz`/`luces` y en las palabras que terminan en `s`. Vale la
/// aproximación: solo se usa cuando el singular ya dio match, y el usuario ve el
/// resultado antes de aceptarlo. Upgrade path si molesta: tabla de excepciones.
fn pluralizar_es(s: &str) -> String {
    match s.chars().last() {
        Some(c) if "aeiouáéíóú".contains(c) => format!("{s}s"),
        Some(_) => format!("{s}es"),
        None => s.to_string(),
    }
}

use std::path::Path;
use std::sync::OnceLock;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

static ES: OnceLock<Option<Tesauro>> = OnceLock::new();
static EN: OnceLock<Option<Tesauro>> = OnceLock::new();

/// Lee un `.dat` de disco y lo parsea. El español viene en **ISO-8859-1** y el
/// inglés en UTF-8; latin-1 mapea 1:1 a los primeros 256 codepoints de Unicode,
/// así que la conversión es un `as char` por byte y no hace falta ninguna crate.
fn cargar_desde(ruta: &str, ingles: bool) -> Option<Tesauro> {
    let bytes = std::fs::read(Path::new(ruta)).ok()?;
    let texto = if bytes.starts_with(b"ISO8859-1") {
        bytes.iter().map(|b| *b as char).collect::<String>()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Some(Tesauro::parse(&texto, ingles))
}

/// El tesauro del idioma, cargado una sola vez. Si el recurso no está donde
/// debería, se loggea la ruta que se intentó — sin eso, un bundle mal armado se
/// ve igual que una palabra sin sinónimos.
fn tesauro(app: &AppHandle, idioma: &str) -> Option<&'static Tesauro> {
    let ingles = idioma.starts_with("en");
    let archivo = if ingles {
        "resources/tesauro/th_en_us.dat"
    } else {
        "resources/tesauro/th_es_v2.dat"
    };
    let celda = if ingles { &EN } else { &ES };
    celda
        .get_or_init(|| {
            let ruta = match app.path().resolve(archivo, BaseDirectory::Resource) {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(archivo, error = %e, "no pude resolver la ruta del tesauro");
                    return None;
                }
            };
            let cargado = cargar_desde(&ruta.to_string_lossy(), ingles);
            if cargado.is_none() {
                tracing::warn!(ruta = %ruta.display(), "no se pudo leer el tesauro");
            }
            cargado
        })
        .as_ref()
}

/// Separado del comando para poder testear el caso "tesauro no disponible" sin
/// un `AppHandle`.
fn respuesta(t: Option<&Tesauro>, palabra: &str) -> RespuestaTesauro {
    match t {
        Some(t) => RespuestaTesauro {
            disponible: true,
            acepciones: t.lookup(palabra),
        },
        None => RespuestaTesauro {
            disponible: false,
            acepciones: Vec::new(),
        },
    }
}

#[tauri::command]
pub fn tesauro_lookup(app: AppHandle, palabra: String, idioma: String) -> RespuestaTesauro {
    respuesta(tesauro(&app, &idioma), &palabra)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ES: &str = "ISO8859-1\n\
nave|1\n\
-|bajel|buque|navío\n\
mirar|1\n\
-|observar|contemplar\n\
perdón|1\n\
-|disculpa|indulto\n\
cal|1\n\
-|caliza|óxido de calcio\n\
calle|1\n\
-|vía|avenida\n";

    const EN: &str = "UTF-8\n\
ship|2\n\
(noun)|vessel|watercraft\n\
(verb)|transport|send\n\
tab|1\n\
(noun)|check|chit|bill\n\
table|1\n\
(noun)|tabular array|array\n\
rifle|1\n\
(noun)|firearm|piece|small-arm\n\
dog|1\n\
(noun)|domestic dog|Canis familiaris|canine|canid\n\
stone|1\n\
(noun)|rock|natural object\n\
hand|1\n\
(noun)|manus|mitt|paw|extremity\n\
word|1\n\
(noun)|Son|Word|Logos|Logos|hypostasis\n\
crowded|1\n\
(adj)|crowded|a|b|c|d|e|f|g|h|i|j|k|l\n";

    #[test]
    fn entrada_espanola_sin_categoria() {
        let t = Tesauro::parse(ES, false);
        assert_eq!(
            t.lookup("nave"),
            vec![Acepcion {
                categoria: None,
                sinonimos: vec!["bajel".into(), "buque".into(), "navío".into()],
            }]
        );
    }

    #[test]
    fn la_consulta_no_distingue_mayusculas() {
        let t = Tesauro::parse(ES, false);
        assert_eq!(t.lookup("Nave").len(), 1);
    }

    #[test]
    fn clave_acentuada() {
        let t = Tesauro::parse(ES, false);
        assert_eq!(t.lookup("perdón")[0].sinonimos, vec!["disculpa", "indulto"]);
    }

    #[test]
    fn plural_pluraliza_los_sinonimos() {
        let t = Tesauro::parse(ES, false);
        assert_eq!(
            t.lookup("naves")[0].sinonimos,
            vec!["bajeles", "buques", "navíos"]
        );
    }

    #[test]
    fn enclitico_se_recorta() {
        let t = Tesauro::parse(ES, false);
        assert_eq!(t.lookup("mirarlo")[0].sinonimos, vec!["observar", "contemplar"]);
    }

    #[test]
    fn sin_lematizacion_una_conjugacion_no_da_nada() {
        let t = Tesauro::parse(ES, false);
        assert!(t.lookup("eres").is_empty());
    }

    #[test]
    fn palabra_ausente_da_vacio_no_error() {
        let t = Tesauro::parse(ES, false);
        assert!(t.lookup("xyzzy").is_empty());
    }

    #[test]
    fn dat_truncado_no_panickea() {
        // Cabecera sin líneas de acepción ni \n final: `inicio` cae justo
        // fuera del buffer.
        let t = Tesauro::parse("word|5", false);
        assert!(t.lookup("word").is_empty());
    }

    #[test]
    fn acepciones_inglesas_con_categoria() {
        let t = Tesauro::parse(EN, true);
        let a = t.lookup("ship");
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].categoria.as_deref(), Some("noun"));
        assert_eq!(a[0].sinonimos, vec!["vessel", "watercraft"]);
        assert_eq!(a[1].categoria.as_deref(), Some("verb"));
    }

    /// Los fixtures de arriba prueban el parser; este prueba **los datos que se
    /// shipean**: que el `.dat` español esté donde va, que la decodificación
    /// ISO-8859-1 deje las claves acentuadas consultables, y que el inglés
    /// podado no haya quedado con la cuenta de acepciones desfasada.
    #[test]
    fn datos_reales_vendoreados() {
        let es = cargar_desde(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/resources/tesauro/th_es_v2.dat"
            ),
            false,
        )
        .expect("falta th_es_v2.dat");
        assert!(es.lookup("nave").iter().any(|a| a.sinonimos.contains(&"bajel".to_string())));
        assert!(!es.lookup("perdón").is_empty(), "clave acentuada no consultable");
        // Las dos colisiones plural/enclítico que son palabras de novela.
        assert_eq!(es.lookup("calles"), es.lookup("calle").iter().map(pluralizada).collect::<Vec<_>>());
        assert_eq!(
            es.lookup("caballos"),
            es.lookup("caballo").iter().map(pluralizada).collect::<Vec<_>>()
        );

        let en = cargar_desde(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/resources/tesauro/th_en_us.dat"
            ),
            true,
        )
        .expect("falta th_en_us.dat");
        let ship = en.lookup("ship");
        assert!(ship.iter().any(|a| a.categoria.as_deref() == Some("noun")));
        assert!(
            !ship.iter().any(|a| a.sinonimos.iter().any(|s| s.contains("generic term"))),
            "el podado dejó hiperónimos adentro"
        );
        // Los casos medidos del inglés: nada de `firearmes`, nada de resolver
        // `tables` por el enclítico `les`, y `word` no se ofrece a sí misma.
        assert_eq!(
            en.lookup("rifles")[0].sinonimos,
            vec!["firearms", "pieces", "small-arms"]
        );
        assert!(
            !en.lookup("tables").iter().any(|a| a.sinonimos.contains(&"check".to_string())),
            "`tables` resolvió por enclítico a `tab`"
        );
        assert!(
            !en.lookup("word").iter().any(|a| a.sinonimos.iter().any(|s| s.eq_ignore_ascii_case("word"))),
            "la palabra consultada se ofrece como sinónimo de sí misma"
        );
        assert_eq!(
            en.lookup("bide")[0].sinonimos,
            vec!["abide", "stay", "stay on", "continue", "remain"],
            "sinónimo duplicado adentro de la acepción"
        );
    }

    /// Re-pluraliza los sinónimos de una acepción con la regla del español, para
    /// comparar contra lo que devuelve el lookup de un plural.
    fn pluralizada(a: &Acepcion) -> Acepcion {
        Acepcion {
            categoria: a.categoria.clone(),
            sinonimos: a.sinonimos.iter().map(|s| pluralizar_es(s)).collect(),
        }
    }

    #[test]
    fn el_plural_se_prueba_antes_que_el_enclitico() {
        let t = Tesauro::parse(ES, false);
        assert_eq!(t.lookup("calles")[0].sinonimos, vec!["vías", "avenidas"]);
    }

    #[test]
    fn el_ingles_no_recorta_encliticos() {
        let t = Tesauro::parse(EN, true);
        assert_eq!(
            t.lookup("tables")[0].sinonimos,
            vec!["tabular arrays", "arrays"]
        );
    }

    #[test]
    fn el_plural_ingles_no_devuelve_no_palabras() {
        let t = Tesauro::parse(EN, true);
        assert_eq!(
            t.lookup("rifles")[0].sinonimos,
            vec!["firearms", "pieces", "small-arms"]
        );
    }

    #[test]
    fn el_plural_ingles_no_duplica_la_s_del_sinonimo() {
        let t = Tesauro::parse(EN, true);
        let s = &t.lookup("dogs")[0].sinonimos;
        assert_eq!(
            s,
            &vec!["domestic dogs", "Canis familiaris", "canines", "canids"]
        );
        assert!(!s.iter().any(|x| x.ends_with("ss")), "una `s` de más: {s:?}");
        assert_eq!(
            t.lookup("stones")[0].sinonimos,
            vec!["rocks", "natural objects"]
        );
        let h = &t.lookup("hands")[0].sinonimos;
        assert_eq!(h, &vec!["manus", "mitts", "paws", "extremities"]);
        assert!(!h.iter().any(|x| x.ends_with("ys")), "`y` sin convertir: {h:?}");
    }

    #[test]
    fn el_plural_ingles_usa_es_solo_donde_corresponde() {
        assert_eq!(pluralizar_en("Canis familiaris"), "Canis familiaris");
        assert_eq!(pluralizar_en("box"), "boxes");
        assert_eq!(pluralizar_en("waltz"), "waltzes");
        assert_eq!(pluralizar_en("church"), "churches");
        assert_eq!(pluralizar_en("bush"), "bushes");
        assert_eq!(pluralizar_en("rock"), "rocks");
        // Las dos ramas de la `y`.
        assert_eq!(pluralizar_en("extremity"), "extremities");
        assert_eq!(pluralizar_en("boy"), "boys");
    }

    #[test]
    fn no_se_ofrece_la_palabra_consultada_ni_repetidos() {
        let t = Tesauro::parse(EN, true);
        assert_eq!(t.lookup("word")[0].sinonimos, vec!["Son", "Logos", "hypostasis"]);
    }

    #[test]
    fn el_tope_se_aplica_despues_de_filtrar() {
        // 13 campos, el primero descartado por ser la palabra consultada: si el
        // `take` fuera antes del filtro se perdería el último bueno.
        let t = Tesauro::parse(EN, true);
        let s = &t.lookup("crowded")[0].sinonimos;
        assert_eq!(s.len(), MAX_SINONIMOS);
        assert_eq!(s.last().unwrap(), "l");
    }

    #[test]
    fn tesauro_ausente_no_es_una_palabra_sin_sinonimos() {
        assert_eq!(
            respuesta(None, "nave"),
            RespuestaTesauro {
                disponible: false,
                acepciones: vec![],
            }
        );
        let t = Tesauro::parse(ES, false);
        let r = respuesta(Some(&t), "xyzzy");
        assert!(r.disponible && r.acepciones.is_empty());
    }
}
