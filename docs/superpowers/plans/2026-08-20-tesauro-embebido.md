# Tesauro embebido (español + inglés) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el popover de repeticiones ofrezca sinónimos clickeables que reemplazan la palabra en el editor, en español e inglés, offline, y que el mismo tesauro esté disponible con un atajo sobre cualquier palabra del cursor.

**Architecture:** Dos archivos MyThes vendoreados en `src-tauri/resources/tesauro/` (español crudo, inglés podado por un script del repo). Rust los lee una vez por idioma a un `String` en memoria con un `HashMap` de offsets, cacheado en `OnceLock`, y expone `tesauro_lookup(palabra, idioma) -> Vec<Acepcion>`; por el bridge cruza solo la entrada consultada. El frontend agrega un servicio con caché chica, chips en el popover de repeticiones y un `@HostListener` para el modo bajo demanda.

**Tech Stack:** Rust / Tauri 2 (`serde`, `OnceLock`, `tauri::path::BaseDirectory`), Angular 21 (standalone, signals), Node stdlib para el script de poda. **Cero dependencias nuevas** — ni crates ni paquetes npm.

**Spec:** `docs/superpowers/specs/2026-08-20-tesauro-design.md`

## Global Constraints

- **Cero dependencias nuevas.** Ni crates en `src-tauri/Cargo.toml` ni paquetes en `package.json`. La decodificación ISO-8859-1 se hace a mano (latin-1 mapea 1:1 a los primeros 256 codepoints Unicode), el script de poda usa solo `node:fs`.
- **Tests Rust van inline**, en `#[cfg(test)] mod tests` dentro del módulo. El repo no usa `src-tauri/tests/` — el patrón está en `grammar.rs:1497`, `split_chapter.rs:486`, `create.rs:418`. El spec dice `src-tauri/tests/`; el repo manda.
- **No hay runner de tests para el frontend.** Lo que toca el DOM o `@tiptap/core` se valida con `pnpm build` + verificación manual del autor. Lo puro va con su smoke runner en `scripts/`, patrón de `scripts/run-rae-smoke.mjs`.
- **Convenciones Angular del repo:** standalone components, signals (`signal`/`computed`/`input`/`output`), templates con `@if`/`@for`, sin `public` explícito, return types explícitos, `inject()` para DI, nombres de archivo sin sufijo `.component`.
- **UI, comentarios y nombres de dominio en español.**
- **Commits sin `Co-Authored-By`.** Mensajes en español, prefijo `feat:` / `fix:` / `docs:` / `chore:`.
- **No marcar el item del `TODO.md` como hecho.** Lo cierra el autor después de probarlo con la app levantada.
- **Licencias:** el `.dat` español se shipea **sin modificar** (LGPL 2.1) con su licencia al lado; el inglés se puede podar (WordNet 2.1 lo permite) pero va con su licencia y una nota de qué se modificó.

---

### Task 1: Datos vendoreados y script de poda

**Files:**
- Create: `scripts/podar-tesauro-en.mjs`
- Create: `src-tauri/resources/tesauro/th_es_v2.dat` (copia cruda)
- Create: `src-tauri/resources/tesauro/th_en_us.dat` (generado)
- Create: `src-tauri/resources/tesauro/LICENCIAS.md`
- Create: `src-tauri/resources/tesauro/COPYING-LGPL-2.1.txt` (copiado del sistema o bajado)
- Create: `src-tauri/resources/tesauro/WordNet_license.txt` (copiado del sistema)
- Modify: `src-tauri/tauri.conf.json` (agregar `resources` al objeto `bundle`)

**Interfaces:**
- Consumes: nada.
- Produces: los dos `.dat` en `src-tauri/resources/tesauro/`, con formato MyThes: primera línea el encoding, después `palabra|N` seguido de N líneas de acepción `categoria|sinónimo|sinónimo|…`. El español usa `-` como categoría; el inglés usa `(noun)`, `(verb)`, `(adj)`, `(adv)`.

**Fuente de los datos** (verificado el 2026-08-20 en esta máquina):
`/Applications/LibreOffice.app/Contents/Resources/extensions/dict-es/` y `.../dict-en/`. Si LibreOffice no está instalado, los mismos archivos están en las extensiones de diccionarios de LibreOffice (`dictionaries` del proyecto, paquetes `dict-es` y `dict-en`).

- [ ] **Step 1: Escribir el script de poda**

Crear `scripts/podar-tesauro-en.mjs`:

```js
#!/usr/bin/env node
// Poda el tesauro inglés de WordNet (el que shipea LibreOffice) para bundlearlo
// en tWriter. Tira los sinónimos etiquetados `(generic term)`, `(related term)`,
// `(similar term)` y `(antonym)`: son hiperónimos y relaciones de WordNet, ruido
// para un novelista (`move` como sinónimo de `ship`). Medido: 18,5 MB → ~6,3 MB.
//
// Recalcula el N de cada entrada y descarta las que quedan sin ninguna acepción,
// porque el parser de `tesauro.rs` confía en que el N coincida con las líneas
// que siguen.
//
// Uso: node scripts/podar-tesauro-en.mjs <th_en_US_v2.dat> <salida.dat>
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('uso: node scripts/podar-tesauro-en.mjs <th_en_US_v2.dat> <salida.dat>');
  process.exit(2);
}

const RUIDO = /\((generic|related|similar) term\)|\(antonym\)/;
const lineas = readFileSync(src, 'utf8').split('\n');
const out = ['UTF-8'];
let entradas = 0;
let i = 1; // la primera línea del .dat es el encoding

while (i < lineas.length) {
  const cabecera = lineas[i];
  i += 1;
  const corte = cabecera.lastIndexOf('|');
  if (corte < 0) continue;
  const n = Number(cabecera.slice(corte + 1));
  if (!Number.isInteger(n) || n < 0) continue;
  const palabra = cabecera.slice(0, corte);
  const acepciones = [];
  for (let k = 0; k < n && i < lineas.length; k += 1, i += 1) {
    const campos = lineas[i].split('|');
    const sinonimos = campos
      .slice(1)
      .filter((s) => s.trim() !== '' && !RUIDO.test(s));
    if (sinonimos.length > 0) acepciones.push([campos[0], ...sinonimos].join('|'));
  }
  if (acepciones.length === 0) continue;
  out.push(`${palabra}|${acepciones.length}`, ...acepciones);
  entradas += 1;
}

const texto = out.join('\n') + '\n';
writeFileSync(dst, texto);
console.log(`${entradas} entradas · ${(Buffer.byteLength(texto) / 1e6).toFixed(1)} MB`);
```

- [ ] **Step 2: Copiar el español crudo y generar el inglés podado**

```bash
mkdir -p src-tauri/resources/tesauro
LO=/Applications/LibreOffice.app/Contents/Resources/extensions
cp "$LO/dict-es/th_es_v2.dat" src-tauri/resources/tesauro/th_es_v2.dat
cp "$LO/dict-en/WordNet_license.txt" src-tauri/resources/tesauro/WordNet_license.txt
node scripts/podar-tesauro-en.mjs "$LO/dict-en/th_en_US_v2.dat" src-tauri/resources/tesauro/th_en_us.dat
ls -la src-tauri/resources/tesauro/
```

Esperado: el script imprime ~140.000 entradas y **~6,3 MB**; `th_es_v2.dat` pesa 2,8 MB. Si el inglés sale arriba de 8 MB, el filtro `RUIDO` no está matcheando — revisar antes de seguir.

El `COPYING` de la LGPL 2.1 no viene en la extensión de LibreOffice (el `LICENSE.md` de `dict-es` solo linkea). Bajarlo:

```bash
curl -sL https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt \
  -o src-tauri/resources/tesauro/COPYING-LGPL-2.1.txt
wc -l src-tauri/resources/tesauro/COPYING-LGPL-2.1.txt
```

- [ ] **Step 3: Verificar a mano las dos entradas que usan los tests**

```bash
iconv -f latin1 -t utf8 src-tauri/resources/tesauro/th_es_v2.dat | grep -A1 -m1 '^nave|'
grep -A3 -m1 '^ship|' src-tauri/resources/tesauro/th_en_us.dat
```

Esperado en español: `nave|8` seguido de `-|bajel|buque|barco|navío|…`.
Esperado en inglés: `ship|N` con acepciones `(noun)|vessel|watercraft` y `(verb)|transport|send|…`, **sin** ningún `(generic term)`.

- [ ] **Step 4: Escribir `LICENCIAS.md`**

Crear `src-tauri/resources/tesauro/LICENCIAS.md`:

```markdown
# Tesauros de terceros bundleados en tWriter

tWriter es MIT. Estos datos NO lo son — cada uno mantiene su licencia.

## `th_es_v2.dat` — español

OpenThesaurus-es, versión para LibreOffice / Apache OpenOffice.
Autor: Marcelo Garrone. Snapshot generado el 2012-01-11.
Distribuido bajo **GNU LGPL 2.1** (`COPYING-LGPL-2.1.txt`).

**Se shipea sin ninguna modificación**, byte por byte como viene en la
extensión `dict-es` de LibreOffice. Encoding ISO-8859-1.

## `th_en_us.dat` — inglés

Derivado del tesauro `th_en_US_v2.dat` de la extensión `dict-en` de
LibreOffice, generado a partir de **WordNet 2.1**, Copyright 2005 by
Princeton University. Licencia completa en `WordNet_license.txt`.

**Modificado**: `scripts/podar-tesauro-en.mjs` eliminó los sinónimos
etiquetados `(generic term)`, `(related term)`, `(similar term)` y
`(antonym)`, recalculó la cantidad de acepciones de cada entrada y descartó
las entradas que quedaron sin ninguna. El resto del contenido y el formato
MyThes están intactos. Encoding UTF-8.
```

- [ ] **Step 5: Declarar los recursos en `tauri.conf.json`**

En el objeto `bundle`, después de `"active": true`, agregar:

```json
    "resources": [
      "resources/tesauro/*"
    ],
```

- [ ] **Step 6: Verificar que el build ve los recursos**

```bash
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
ls src-tauri/target/debug/resources/tesauro/
```

Esperado: el build compila y los cuatro archivos aparecen copiados bajo `target/debug/resources/tesauro/`. Ese copiado es lo que hace que el modo dev resuelva los recursos; si la carpeta no aparece, **paren acá** y anoten el hallazgo: la Task 3 depende de esto y el fallback tiene que decidirse con el dato a la vista, no adivinado.

- [ ] **Step 7: Commit**

```bash
git add scripts/podar-tesauro-en.mjs src-tauri/resources/tesauro src-tauri/tauri.conf.json
git commit -m "feat: vendorear tesauros MyThes es+en con su script de poda y licencias"
```

---

### Task 2: Parser MyThes y normalización en Rust

Unidad pura, sin Tauri ni filesystem: parsea un `&str` en formato MyThes y responde consultas. Es la mitad que `cargo test` cubre entera.

**Files:**
- Create: `src-tauri/src/tesauro.rs`
- Test: `src-tauri/src/tesauro.rs` (`#[cfg(test)] mod tests` al final del mismo archivo)

**Interfaces:**
- Consumes: el formato MyThes que produce la Task 1.
- Produces:
  - `pub struct Acepcion { pub categoria: Option<String>, pub sinonimos: Vec<String> }`, con `#[derive(Serialize)]`. Los nombres de campo son de una sola palabra, así que no hace falta ningún `rename_all`: llegan al frontend como `categoria` y `sinonimos`.
  - `pub struct Tesauro` con `pub fn parse(dat: &str) -> Tesauro` y `pub fn lookup(&self, palabra: &str) -> Vec<Acepcion>`.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `src-tauri/src/tesauro.rs` con **solo** los tests y las firmas vacías:

```rust
//! Tesauro MyThes embebido. Ver
//! `docs/superpowers/specs/2026-08-20-tesauro-design.md`.

/// Una acepción de una palabra. `categoria` es `None` en español, donde el dato
/// no la trae, y `Some("noun")` / `Some("verb")` / … en inglés.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Acepcion {
    pub categoria: Option<String>,
    pub sinonimos: Vec<String>,
}

pub struct Tesauro {
    _texto: String,
}

impl Tesauro {
    pub fn parse(_dat: &str) -> Tesauro {
        todo!()
    }

    pub fn lookup(&self, _palabra: &str) -> Vec<Acepcion> {
        todo!()
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
    fn acepciones_inglesas_con_categoria() {
        let t = Tesauro::parse(EN);
        let a = t.lookup("ship");
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].categoria.as_deref(), Some("noun"));
        assert_eq!(a[0].sinonimos, vec!["vessel", "watercraft"]);
        assert_eq!(a[1].categoria.as_deref(), Some("verb"));
    }
}
```

Registrar el módulo para que compile: agregar `mod tesauro;` a la lista de `mod` de `src-tauri/src/lib.rs` (está ordenada alfabéticamente — va entre `mod system_fonts;` y `mod theme;`).

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tesauro`
Expected: los 8 tests fallan con `panicked at 'not yet implemented'`.

- [ ] **Step 3: Implementar el parser y el lookup**

Reemplazar el `struct Tesauro` y su `impl` por:

```rust
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
        for linea in self.texto[inicio..].split('\n').take(n.min(MAX_ACEPCIONES)) {
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
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tesauro`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tesauro.rs src-tauri/src/lib.rs
git commit -m "feat: parser MyThes y normalización del tesauro en Rust"
```

---

### Task 3: Comando `tesauro_lookup` con carga desde los recursos

**Files:**
- Modify: `src-tauri/src/tesauro.rs` (loader + comando + un test contra los datos reales)
- Modify: `src-tauri/src/lib.rs` (`use` y `generate_handler!`)

**Interfaces:**
- Consumes: `Tesauro::parse` / `Tesauro::lookup` y `Acepcion` de la Task 2; los `.dat` de la Task 1.
- Produces: el comando `tesauro_lookup(palabra: String, idioma: String) -> Vec<Acepcion>`, invocable desde el frontend como `invoke('tesauro_lookup', { palabra, idioma })`. `idioma` acepta lo mismo que ya usa el detector (`'es'` / `'en'`, y cualquier variante que empiece con `en` cuenta como inglés). Nunca devuelve error: sin datos o sin entrada devuelve `[]`.

- [ ] **Step 1: Escribir el test que falla — datos reales, no fixture**

Agregar al `mod tests` de `src-tauri/src/tesauro.rs`:

```rust
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
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tesauro::tests::datos_reales`
Expected: FAIL — `cannot find function 'cargar_desde' in this scope`.

- [ ] **Step 3: Implementar el loader y el comando**

Agregar al final de `src-tauri/src/tesauro.rs` (antes del `mod tests`):

```rust
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
fn tesauro<'a>(app: &AppHandle, idioma: &str) -> Option<&'a Tesauro> {
    let ingles = idioma.starts_with("en");
    let archivo = if ingles {
        "resources/tesauro/th_en_us.dat"
    } else {
        "resources/tesauro/th_es_v2.dat"
    };
    let celda = if ingles { &EN } else { &ES };
    celda
        .get_or_init(|| {
            let ruta = app.path().resolve(archivo, BaseDirectory::Resource).ok()?;
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
```

Si `tracing` no está en el scope del módulo, mirar cómo lo usa `src-tauri/src/search.rs` y copiar ese `use`.

En `src-tauri/src/lib.rs`: agregar `use tesauro::tesauro_lookup;` junto a los otros `use` de módulos (después de `use system_fonts::{…};`), y `tesauro_lookup,` a la lista de `tauri::generate_handler![…]`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tesauro`
Expected: 9 passed. Si el test de datos reales tarda unos segundos es normal: parsea los 9 MB de verdad.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tesauro.rs src-tauri/src/lib.rs
git commit -m "feat: comando tesauro_lookup con carga cacheada desde los recursos"
```

---

### Task 4: Servicio del frontend

**Files:**
- Modify: `src/app/core/types.ts` (agregar `Acepcion`)
- Create: `src/app/core/tesauro-service.ts`

**Interfaces:**
- Consumes: el comando `tesauro_lookup` de la Task 3.
- Produces:
  - `export interface Acepcion { categoria: string | null; sinonimos: string[] }` en `src/app/core/types.ts`.
  - `TesauroService` con `lookup(palabra: string, idioma: string): Promise<Acepcion[]>`, `providedIn: 'root'`.

- [ ] **Step 1: Agregar el tipo**

Al final de `src/app/core/types.ts`:

```ts
/** Una acepción del tesauro. `categoria` es `null` en español (el dato MyThes no
 *  la trae) y `'noun'` / `'verb'` / `'adj'` / `'adv'` en inglés. */
export interface Acepcion {
  categoria: string | null;
  sinonimos: string[];
}
```

- [ ] **Step 2: Escribir el servicio**

Crear `src/app/core/tesauro-service.ts`:

```ts
import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { Acepcion } from './types';

/** Cuántas consultas se recuerdan. El popover de repeticiones pregunta por la
 *  misma palabra cada vez que se abre una marca del mismo grupo. */
const MAX_CACHE = 50;

/**
 * Consulta el tesauro embebido. Sin signals a propósito: es request/response,
 * no estado observable — el que lo llama guarda el resultado donde le sirve.
 */
@Injectable({ providedIn: 'root' })
export class TesauroService {
  private readonly cache = new Map<string, Acepcion[]>();

  async lookup(palabra: string, idioma: string): Promise<Acepcion[]> {
    const clave = `${idioma}:${palabra.toLowerCase()}`;
    const guardado = this.cache.get(clave);
    if (guardado) return guardado;
    let res: Acepcion[] = [];
    try {
      res = await invoke<Acepcion[]>('tesauro_lookup', { palabra, idioma });
    } catch {
      // Sin sinónimos no es una falla que valga interrumpir la escritura: el
      // popover ya sabe mostrar "sin sinónimos".
      res = [];
    }
    if (this.cache.size >= MAX_CACHE) {
      const primera = this.cache.keys().next().value;
      if (primera !== undefined) this.cache.delete(primera);
    }
    this.cache.set(clave, res);
    return res;
  }
}
```

- [ ] **Step 3: Verificar que compila**

Run: `pnpm build`
Expected: build exitoso, sin errores de TypeScript. (No hay runner de tests para esto — ver Global Constraints.)

- [ ] **Step 4: Commit**

```bash
git add src/app/core/types.ts src/app/core/tesauro-service.ts
git commit -m "feat: servicio del tesauro con caché de las últimas consultas"
```

---

### Task 5: Sinónimos en el popover de repeticiones

**Files:**
- Modify: `src/app/editor/repeticiones-popover.ts`
- Modify: `src/app/editor/repeticiones-popover.scss`
- Modify: `src/app/editor/editor.ts`
- Modify: `src/app/editor/editor.html:419-425`

**Interfaces:**
- Consumes: `TesauroService.lookup` (Task 4), `Acepcion` (Task 4), `RepeticionPos` de `repeticiones-extension.ts`, y el **patrón de herencia de marcas de `applyRaeFix`** (`editor.ts:1300-1338`) — `marksAcross` sobre un `tr.replaceWith`. Los helpers `serializeRange`/`parseFragmentHtml` de `rae-apply.ts` NO se usan: son para reemplazar un párrafo entero por HTML, y acá se reemplaza una palabra por texto plano con marcas.
- Produces: el popover acepta `acepciones = input<Acepcion[] | null>(null)` (`null` = cargando) y emite `reemplazar = output<string>()`. `Editor` expone `reemplazarRepeticion(sinonimo: string): void`.

- [ ] **Step 1: Sumar los chips al popover**

En `src/app/editor/repeticiones-popover.ts`, actualizar el comentario de cabecera de la clase (hoy dice que los sinónimos son "otro item del TODO" — ya no lo son) y, en el template, insertar el bloque de sinónimos **entre** `.rep-pop-msg` y `<footer>`:

```html
        @if (acepciones() === null) {
          <div class="rep-pop-sin">Buscando sinónimos…</div>
        } @else if (acepciones()!.length === 0) {
          <div class="rep-pop-sin">Sin sinónimos para «{{ palabra() }}»</div>
        } @else {
          @for (a of acepciones()!; track $index) {
            <div class="rep-pop-acepcion">
              @if (a.categoria) {
                <span class="rep-pop-cat">{{ categoriaEs(a.categoria) }}</span>
              }
              <div class="rep-pop-chips">
                @for (s of a.sinonimos; track s) {
                  <button
                    type="button"
                    class="rep-pop-chip"
                    (click)="reemplazar.emit(s)"
                  >
                    {{ s }}
                  </button>
                }
              </div>
            </div>
          }
        }
```

Y en la clase, junto a los otros `input`/`output`:

```ts
  /** `null` mientras la consulta está en vuelo; `[]` cuando no hay sinónimos. */
  acepciones = input<Acepcion[] | null>(null);
  reemplazar = output<string>();

  /** Las categorías vienen del dato en inglés (`noun`, `verb`, …) y la UI es en
   *  español. Lo que no está en la tabla se muestra tal cual en vez de tragarse
   *  la etiqueta. */
  protected categoriaEs(cat: string): string {
    const tabla: Record<string, string> = {
      noun: 'sustantivo',
      verb: 'verbo',
      adj: 'adjetivo',
      adv: 'adverbio',
    };
    return tabla[cat] ?? cat;
  }
```

Importar `Acepcion` desde `'../core/types'` (el archivo ya importa `Repeticion` de ahí).

- [ ] **Step 2: Estilos de los chips**

Agregar a `src/app/editor/repeticiones-popover.scss`, siguiendo las variables de tema que ya usa el archivo (mirar las reglas existentes de `.rep-pop-goto` para el color y el radio de los botones):

```scss
.rep-pop-sin {
  font-size: 0.82rem;
  opacity: 0.7;
  margin-top: 0.4rem;
}

.rep-pop-acepcion {
  margin-top: 0.45rem;
}

.rep-pop-cat {
  display: block;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
  margin-bottom: 0.2rem;
}

.rep-pop-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.rep-pop-chip {
  cursor: pointer;
  border: 1px solid currentColor;
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
  font: inherit;
  font-size: 0.82rem;
  background: transparent;
  color: inherit;
  opacity: 0.85;

  &:hover {
    opacity: 1;
  }
}
```

- [ ] **Step 3: Cargar los sinónimos al abrir el popover**

En `src/app/editor/editor.ts`:

1. Importar el servicio y el tipo, e inyectarlo junto a los otros servicios de la clase:

```ts
import { TesauroService } from '../core/tesauro-service';
import { Acepcion } from '../core/types';
// …
  private readonly tesauro = inject(TesauroService);
  protected readonly repAcepciones = signal<Acepcion[] | null>(null);
```

2. Al final de `openRepPopover` (después de `this.resaltarGrupo(r)`), disparar la consulta:

```ts
    this.repAcepciones.set(null);
    void this.cargarSinonimos(this.repPopover()!.palabra);
```

3. Agregar el método, al lado de `resaltarGrupo`:

```ts
  /** La consulta es asincrónica y el popover se puede haber cerrado o movido a
   *  otra palabra mientras estaba en vuelo: se descarta el resultado viejo
   *  comparando contra la palabra que está abierta ahora. */
  private async cargarSinonimos(palabra: string): Promise<void> {
    const idioma = this.meta().idioma === 'en' ? 'en' : 'es';
    const res = await this.tesauro.lookup(palabra, idioma);
    if (this.repPopover()?.palabra !== palabra) return;
    this.repAcepciones.set(res);
  }
```

El idioma es la misma expresión que ya usa `checkRepeticiones` (`editor.ts:1241`): `this.meta().idioma === 'en' ? 'en' : 'es'`.

4. En `dismissRepeticion` y en `goToPreviousRepeticion`, agregar `this.repAcepciones.set(null);` junto al `this.repPopover.set(null)` que ya tienen, para que la próxima apertura no muestre por un frame los sinónimos de la palabra anterior.

- [ ] **Step 4: Aplicar el reemplazo**

Agregar a `editor.ts`, al lado de `dismissRepeticion`:

```ts
  /** Reemplaza la aparición que está mirando el popover por el sinónimo
   *  elegido. La herencia de marcas es la misma de `applyRaeFix` — ver el
   *  comentario largo de ahí: `marksAcross` y no `marks()`, porque en el borde
   *  de un `<em>` `marks()` devuelve las del texto de afuera y se pierde la
   *  cursiva. */
  protected reemplazarRepeticion(sinonimo: string): void {
    const popover = this.repPopover();
    if (!popover || !this.tiptap) return;
    const r = popover.repeticion;
    if (!r) return;
    const original = popover.palabra;
    // Si la palabra abría oración va con mayúscula, y el sinónimo del tesauro
    // viene siempre en minúscula.
    const reemplazo =
      original.charAt(0) === original.charAt(0).toUpperCase() &&
      original.charAt(0) !== original.charAt(0).toLowerCase()
        ? sinonimo.charAt(0).toUpperCase() + sinonimo.slice(1)
        : sinonimo;
    const from = r.from;
    const to = r.to;
    this.tiptap
      .chain()
      .focus()
      .command(({ tr, state, dispatch }) => {
        if (!dispatch) return true;
        const $f = tr.doc.resolve(from);
        const marks = to > from ? ($f.marksAcross(tr.doc.resolve(to)) ?? $f.marks()) : $f.marks();
        tr.replaceWith(from, to, state.schema.text(reemplazo, marks));
        return true;
      })
      .run();
    this.limpiarGrupo();
    this.repAcepciones.set(null);
    this.repPopover.set(null);
    this.repeticiones.update((list) => list.filter((x) => x.id !== r.id));
    this.applyRepeticionesDecorations(this.repeticiones());
    if (this.repAuto()) this.scheduleRepRecheck();
  }
```

El `repPopover` guarda hoy `repeticion: RepeticionPos`. La guarda `if (!r) return;` está de más ahora y **es a propósito**: la Task 6 hace ese campo nullable y este método no tiene que cambiar de nuevo.

- [ ] **Step 5: Conectar el template**

En `src/app/editor/editor.html:419-425`, agregar las dos líneas nuevas al `<app-repeticiones-popover>`:

```html
    [acepciones]="repAcepciones()"
    (reemplazar)="reemplazarRepeticion($event)"
```

- [ ] **Step 6: Verificar que compila**

Run: `pnpm build`
Expected: build exitoso.

- [ ] **Step 7: Commit**

```bash
git add src/app/editor/repeticiones-popover.ts src/app/editor/repeticiones-popover.scss src/app/editor/editor.ts src/app/editor/editor.html
git commit -m "feat: sinónimos clickeables en el popover de repeticiones"
```

- [ ] **Step 8: Verificación manual del autor**

Esta mitad toca el DOM y ProseMirror: no hay runner. Pedirle al autor que levante `pnpm tauri dev` y confirme, sobre un capítulo real en español:

1. Click en una marca de repetición de una palabra común (`lugar`, `ciudad`) → aparecen chips de sinónimos.
2. Click en un chip → la palabra se reemplaza en el documento y la marca desaparece.
3. Reemplazar una palabra que esté **adentro de una cursiva** y otra **pegada al borde** de una cursiva → la cursiva se mantiene en los dos casos.
4. Una palabra rara (un nombre propio, `bondi`) → dice "Sin sinónimos para «…»" y el resto del popover sigue andando.
5. Un capítulo en inglés → los chips aparecen agrupados con la etiqueta `sustantivo` / `verbo`.

Si el paso 1 dice "sin sinónimos" para **todas** las palabras, el problema es la resolución de recursos en modo dev: mirar el log por el `tracing::warn!` de `tesauro.rs` con la ruta que intentó.

---

### Task 6: Tesauro bajo demanda con atajo de teclado

**Files:**
- Create: `src/app/editor/palabra-en.ts`
- Create: `scripts/run-tesauro-smoke.mjs`
- Modify: `src/app/editor/repeticiones-popover.ts`
- Modify: `src/app/editor/editor.ts`

**Interfaces:**
- Consumes: `TesauroService` (Task 4), el popover con chips (Task 5).
- Produces: `palabraEn(texto: string, offset: number): { inicio: number; fin: number } | null` en `src/app/editor/palabra-en.ts`. El campo `repeticion` de `repPopover` pasa a ser `RepeticionPos | null`, y el objeto suma `from: number` y `to: number`.

- [ ] **Step 1: Escribir el smoke runner que falla**

Crear `scripts/run-tesauro-smoke.mjs`, calcado de `scripts/run-rae-smoke.mjs` (leer ese archivo primero y copiar su mecánica de compilar con `tsc` a un tmpdir e importar el JS resultante). Los casos:

```js
// dentro del runner, después de importar { palabraEn } del JS compilado
const casos = [
  ['la nave oscura', 5, [3, 7], 'cursor adentro de la palabra'],
  ['la nave oscura', 3, [3, 7], 'cursor pegado al inicio'],
  ['la nave oscura', 7, [3, 7], 'cursor pegado al final'],
  ['la nave oscura', 2, null, 'cursor en el espacio'],
  ['el navío ancló', 4, [3, 8], 'palabra acentuada'],
  ['la niña rió', 4, [3, 7], 'eñe'],
  ['—Perdón —dijo', 3, [1, 7], 'raya de diálogo no es parte de la palabra'],
  ['fin', 3, [0, 3], 'final del texto'],
  ['', 0, null, 'texto vacío'],
];
let fallos = 0;
for (const [texto, offset, esperado, desc] of casos) {
  const r = palabraEn(texto, offset);
  const got = r ? [r.inicio, r.fin] : null;
  const ok = JSON.stringify(got) === JSON.stringify(esperado);
  if (!ok) { fallos += 1; console.error(`FALLA ${desc}: ${JSON.stringify(got)} != ${JSON.stringify(esperado)}`); }
}
console.log(fallos === 0 ? `${casos.length} casos OK` : `${fallos} fallas`);
process.exit(fallos === 0 ? 0 : 1);
```

- [ ] **Step 2: Correr el runner y verificar que falla**

Run: `node scripts/run-tesauro-smoke.mjs`
Expected: FAIL — no existe `src/app/editor/palabra-en.ts`, el `tsc` no compila nada.

- [ ] **Step 3: Implementar la función pura**

Crear `src/app/editor/palabra-en.ts`:

```ts
/**
 * Límites de la palabra que toca el offset dado. Función pura, sin DOM: la
 * cubre `scripts/run-tesauro-smoke.mjs`.
 *
 * `fin` es exclusivo. Un cursor pegado al final de una palabra cuenta como
 * adentro — es el caso normal al terminar de escribirla.
 */
const LETRA = /[a-záéíóúüñA-ZÁÉÍÓÚÜÑ']/;

export function palabraEn(
  texto: string,
  offset: number,
): { inicio: number; fin: number } | null {
  if (texto.length === 0) return null;
  let i = Math.max(0, Math.min(offset, texto.length));
  // Cursor pegado al final de una palabra: mirar el carácter de atrás.
  if (i === texto.length || !LETRA.test(texto[i])) {
    if (i === 0 || !LETRA.test(texto[i - 1])) return null;
    i -= 1;
  }
  let inicio = i;
  while (inicio > 0 && LETRA.test(texto[inicio - 1])) inicio -= 1;
  let fin = i + 1;
  while (fin < texto.length && LETRA.test(texto[fin])) fin += 1;
  return { inicio, fin };
}
```

- [ ] **Step 4: Correr el runner y verificar que pasa**

Run: `node scripts/run-tesauro-smoke.mjs`
Expected: `9 casos OK`.

- [ ] **Step 5: Hacer el popover usable sin repetición**

En `src/app/editor/repeticiones-popover.ts`:

1. El template está envuelto en `@if (repeticion(); as r) {`. Cambiar el gate a `@if (anchor()) {` y envolver **solo** las partes que dependen de la repetición:
   - el `<span class="rep-pop-count">` y el bloque `.rep-pop-msg` van dentro de un `@if (repeticion(); as r) { … }`;
   - en modo tesauro, el head muestra la etiqueta `Sinónimos` en lugar de `Repetición`, y `.rep-pop-msg` se reemplaza por `<div class="rep-pop-msg"><span class="rep-pop-word">{{ palabra() }}</span></div>`;
   - los botones del footer: "Ir a la anterior" solo cuando `repeticion()` no es `null`; "Ignorar" pasa a decir `Cerrar` cuando es `null`.

2. La etiqueta del head:

```html
        <span class="rep-pop-tag">{{ repeticion() ? 'Repetición' : 'Sinónimos' }}</span>
```

- [ ] **Step 6: Abrir el popover con el atajo**

En `src/app/editor/editor.ts`:

1. Cambiar el tipo del signal `repPopover` para que `repeticion` sea `RepeticionPos | null` y sume las posiciones del rango a reemplazar:

```ts
  protected readonly repPopover = signal<{
    repeticion: RepeticionPos | null;
    palabra: string;
    anchor: AnchorBox;
    from: number;
    to: number;
  } | null>(null);
```

`openRepPopover` pasa a setear también `from: r.from, to: r.to`. En `reemplazarRepeticion` (Task 5), cambiar `const from = r.from; const to = r.to;` por `const { from, to } = popover;` y **borrar** la guarda `if (!r) return;` — ahora tiene que funcionar sin repetición. La baja de la marca queda condicional:

```ts
    if (r) {
      this.repeticiones.update((list) => list.filter((x) => x.id !== r.id));
      this.applyRepeticionesDecorations(this.repeticiones());
    }
```

Y en `dismissRepeticion` y `goToPreviousRepeticion`, envolver en `if (popover.repeticion)` lo que use la repetición (el filtrado de la lista y el salto a `fromPrevio`/`toPrevio`).

2. Agregar el atajo, junto a los otros `@HostListener` del componente (el patrón está en `src/app/app.ts:496-512`):

```ts
  /**
   * Sinónimos de la palabra del cursor, sin que tenga que haber una repetición
   * marcada. `Ctrl+Shift+S` sigue el estilo de los atajos que ya hay
   * (`Ctrl+F` de búsqueda en `app.ts`).
   */
  @HostListener('window:keydown.control.shift.s', ['$event'])
  protected onAtajoTesauro(event: KeyboardEvent): void {
    if (!this.tiptap) return;
    event.preventDefault();
    const state = this.tiptap.state;
    const $pos = state.selection.$from;
    // `textBetween(0, content.size, undefined, ' ')` y no `textContent`: el
    // schema permite `<br>`, que aporta 0 caracteres a `textContent` pero 1 a
    // las posiciones del nodo. Con `leafText` de un espacio, offsets y
    // posiciones quedan alineados.
    const texto = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, ' ');
    const limites = palabraEn(texto, $pos.parentOffset);
    if (!limites) return;
    const inicio = $pos.start();
    const from = inicio + limites.inicio;
    const to = inicio + limites.fin;
    const palabra = state.doc.textBetween(from, to, ' ').trim();
    if (palabra.length === 0) return;
    if (this.grammarPopover()) this.closeGrammarPopover();
    if (this.raePopover()) this.raePopover.set(null);
    this.limpiarGrupo();
    const view = (this.tiptap as unknown as {
      view: { coordsAtPos: (pos: number) => { left: number; top: number; bottom: number } };
    }).view;
    const coords = view.coordsAtPos(from);
    this.repPopover.set({
      repeticion: null,
      palabra,
      anchor: { left: coords.left, top: coords.top, bottom: coords.bottom },
      from,
      to,
    });
    this.repAcepciones.set(null);
    void this.cargarSinonimos(palabra);
  }
```

Importar `palabraEn` de `'./palabra-en'` y `HostListener` de `@angular/core` — hoy `editor.ts` **no** lo importa, los `@HostListener` que existen están en `app.ts` y `tree.ts`.

- [ ] **Step 7: Verificar que compila y que el smoke sigue verde**

Run: `pnpm build && node scripts/run-tesauro-smoke.mjs`
Expected: build exitoso y `9 casos OK`.

- [ ] **Step 8: Commit**

```bash
git add src/app/editor/palabra-en.ts scripts/run-tesauro-smoke.mjs src/app/editor/repeticiones-popover.ts src/app/editor/editor.ts
git commit -m "feat: atajo de tesauro sobre la palabra del cursor"
```

- [ ] **Step 9: Verificación manual del autor**

1. Cursor sobre una palabra cualquiera + `Ctrl+Shift+S` → popover con etiqueta "Sinónimos" y los chips.
2. Click en un chip → reemplaza esa palabra, no otra.
3. `Ctrl+Shift+S` con el cursor en un espacio o en una línea vacía → no pasa nada, sin error en consola.
4. `Ctrl+Shift+S` sobre una palabra en un párrafo que tenga un salto de línea duro (`<br>`) antes → reemplaza la palabra correcta y no una corrida unos caracteres.
5. Que el atajo no pise nada del OS ni del editor (probar con texto seleccionado y sin).

---

### Task 7: Documentación

**Files:**
- Modify: `TODO.md` (la sección "Gramática, ortografía y tesauro")
- Modify: `CLAUDE.md` (mapa de arquitectura y sección de sidecars/datos)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada de código.

- [ ] **Step 1: Corregir el relevamiento del `TODO.md`**

En el item **"Tesauro de sinónimos embebido"** (`TODO.md:262`):

- Reemplazar la línea "**Sin equivalente en inglés en este repo**: rla-es es solo español. Para la mitad inglesa habría que buscar otro MyThes aparte." por el dato medido: existe `th_en_US_v2.dat` en la extensión `dict-en` de LibreOffice — WordNet 2.1 vía Princeton, 145.866 entradas, 18,5 MB crudo y 6,3 MB podando los `(generic term)` / `(related term)`, licencia permisiva.
- Agregar la cobertura medida: ~70% de las formas que el detector marca tienen entrada (14 de 20 sobre `Buenos Aires 2077`), ~75-80% con las normalizaciones de enclítico y plural. Los misses son conjugaciones y no se lematiza a propósito.
- Anotar el item como **implementado sin cerrar** (sin marcar el `[x]`), apuntando al spec `docs/superpowers/specs/2026-08-20-tesauro-design.md` y al plan, igual que quedó anotado el detector de repeticiones antes de que el autor lo verificara.

En el sub-item **"Sinónimos en el popover de repetición"** (`TODO.md:238`): anotar que quedó implementado en esta tanda, que el reemplazo hereda marcas con `marksAcross` como pedía la nota, y que la mitad inglesa **sí** tiene sugerencias — la advertencia de "degradar a sin sugerencias" quedó igual pero por huecos léxicos y conjugaciones, no por falta de datos en inglés.

- [ ] **Step 2: Actualizar el `CLAUDE.md`**

- En el mapa de arquitectura, agregar `tesauro.rs  sinónimos MyThes es+en` a la columna de Rust.
- En la sección **"Sidecars y servicios externos"**, agregar que `src-tauri/resources/tesauro/` shipea dos `.dat` MyThes con licencias de terceros (LGPL 2.1 el español, WordNet el inglés), que el español va **sin modificar** por licencia, y que el inglés se regenera con `scripts/podar-tesauro-en.mjs`.
- En la lista de comandos, agregar `node scripts/run-tesauro-smoke.mjs` junto a los otros smoke runners.

- [ ] **Step 3: Commit**

```bash
git add TODO.md CLAUDE.md
git commit -m "docs: anotar el tesauro embebido y corregir el relevamiento del inglés"
```
