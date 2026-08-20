//! Tesauro MyThes embebido. Ver
//! `docs/superpowers/specs/2026-08-20-tesauro-design.md`.

/// Una acepción de una palabra. `categoria` es `None` en español, donde el dato
/// no la trae, y `Some("noun")` / `Some("verb")` / … en inglés.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Acepcion {
    pub categoria: Option<String>,
    pub sinonimos: Vec<String>,
}

use std::collections::HashMap;

/// Techo de lo que se le manda al popover. WordNet tiene entradas con decenas de
/// sinónimos y el popover no es un diccionario: los primeros son los más
/// cercanos en el orden del archivo.
const MAX_ACEPCIONES: usize = 4;
const MAX_SINONIMOS: usize = 12;

/// Enclíticos, de más largo a más corto — el orden importa: `selo` tiene que
/// probarse antes que `lo`.
const ENCLITICOS: [&str; 14] = [
    "selos", "selas", "selo", "sela", "los", "las", "les", "nos", "lo", "la", "le", "me", "te",
    "se",
];

pub struct Tesauro {
    texto: String,
    /// clave → (offset de byte donde arranca la primera línea de acepción, N)
    indice: HashMap<String, (usize, usize)>,
}

impl Tesauro {
    /// Una pasada sobre el `.dat` armando el índice de claves. El texto queda
    /// entero en memoria: son 2,8 MB el español y ~6,3 MB el inglés, y así no
    /// hace falta el `.idx` ni hacer `seek` por consulta.
    pub fn parse(dat: &str) -> Tesauro {
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
        // Enclítico: `mirarlo` → `mirar`. Solo si lo que queda existe, así no
        // hay que saber si la palabra era un infinitivo o un gerundio.
        for suf in ENCLITICOS {
            if let Some(base) = clave.strip_suffix(suf) {
                if base.chars().count() >= 3 {
                    if let Some(a) = self.entrada(base) {
                        return a;
                    }
                }
            }
        }
        // Plural simple, re-pluralizando los sinónimos. No se lematiza: ver el
        // spec, un lema sin re-conjugar da sugerencias que no concuerdan.
        for suf in ["es", "s"] {
            if let Some(base) = clave.strip_suffix(suf) {
                if base.chars().count() >= 3 {
                    if let Some(a) = self.entrada(base) {
                        return a
                            .into_iter()
                            .map(|ac| Acepcion {
                                categoria: ac.categoria,
                                sinonimos: ac.sinonimos.iter().map(|s| pluralizar(s)).collect(),
                            })
                            .collect();
                    }
                }
            }
        }
        Vec::new()
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
            let sinonimos: Vec<String> = campos
                .filter(|s| !s.trim().is_empty())
                .take(MAX_SINONIMOS)
                .map(|s| s.trim().to_string())
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

/// ponytail: regla de plural cruda (vocal → `s`, consonante → `es`). Falla en
/// `luz`/`luces` y en las palabras que terminan en `s`. Vale la aproximación:
/// solo se usa cuando el singular ya dio match, y el usuario ve el resultado
/// antes de aceptarlo. Upgrade path si molesta: tabla de excepciones.
fn pluralizar(s: &str) -> String {
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
fn cargar_desde(ruta: &str) -> Option<Tesauro> {
    let bytes = std::fs::read(Path::new(ruta)).ok()?;
    let texto = if bytes.starts_with(b"ISO8859-1") {
        bytes.iter().map(|b| *b as char).collect::<String>()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Some(Tesauro::parse(&texto))
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
            let cargado = cargar_desde(&ruta.to_string_lossy());
            if cargado.is_none() {
                tracing::warn!(ruta = %ruta.display(), "no se pudo leer el tesauro");
            }
            cargado
        })
        .as_ref()
}

#[tauri::command]
pub fn tesauro_lookup(app: AppHandle, palabra: String, idioma: String) -> Vec<Acepcion> {
    match tesauro(&app, &idioma) {
        Some(t) => t.lookup(&palabra),
        None => Vec::new(),
    }
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
-|disculpa|indulto\n";

    const EN: &str = "UTF-8\n\
ship|2\n\
(noun)|vessel|watercraft\n\
(verb)|transport|send\n";

    #[test]
    fn entrada_espanola_sin_categoria() {
        let t = Tesauro::parse(ES);
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
        let t = Tesauro::parse(ES);
        assert_eq!(t.lookup("Nave").len(), 1);
    }

    #[test]
    fn clave_acentuada() {
        let t = Tesauro::parse(ES);
        assert_eq!(t.lookup("perdón")[0].sinonimos, vec!["disculpa", "indulto"]);
    }

    #[test]
    fn plural_pluraliza_los_sinonimos() {
        let t = Tesauro::parse(ES);
        assert_eq!(
            t.lookup("naves")[0].sinonimos,
            vec!["bajeles", "buques", "navíos"]
        );
    }

    #[test]
    fn enclitico_se_recorta() {
        let t = Tesauro::parse(ES);
        assert_eq!(t.lookup("mirarlo")[0].sinonimos, vec!["observar", "contemplar"]);
    }

    #[test]
    fn sin_lematizacion_una_conjugacion_no_da_nada() {
        let t = Tesauro::parse(ES);
        assert!(t.lookup("eres").is_empty());
    }

    #[test]
    fn palabra_ausente_da_vacio_no_error() {
        let t = Tesauro::parse(ES);
        assert!(t.lookup("xyzzy").is_empty());
    }

    #[test]
    fn dat_truncado_no_panickea() {
        // Cabecera sin líneas de acepción ni \n final: `inicio` cae justo
        // fuera del buffer.
        let t = Tesauro::parse("word|5");
        assert!(t.lookup("word").is_empty());
    }

    #[test]
    fn acepciones_inglesas_con_categoria() {
        let t = Tesauro::parse(EN);
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
        let es = cargar_desde(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/tesauro/th_es_v2.dat"
        ))
        .expect("falta th_es_v2.dat");
        assert!(es.lookup("nave").iter().any(|a| a.sinonimos.contains(&"bajel".to_string())));
        assert!(!es.lookup("perdón").is_empty(), "clave acentuada no consultable");

        let en = cargar_desde(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/tesauro/th_en_us.dat"
        ))
        .expect("falta th_en_us.dat");
        let ship = en.lookup("ship");
        assert!(ship.iter().any(|a| a.categoria.as_deref() == Some("noun")));
        assert!(
            !ship.iter().any(|a| a.sinonimos.iter().any(|s| s.contains("generic term"))),
            "el podado dejó hiperónimos adentro"
        );
    }
}
