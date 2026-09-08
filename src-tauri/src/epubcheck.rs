//! Validación del EPUB exportado con epubcheck (el validador oficial del W3C,
//! el mismo que corre Kobo/KDP del otro lado). No lo bundleamos: es un jar y
//! necesita una JVM, así que shipearlo significa arrastrar un runtime entero
//! al bundle. Si el autor lo tiene instalado, lo usamos; si no, el export sale
//! igual y la app dice cómo instalarlo.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// Cuántas líneas de epubcheck le pasamos a la UI. Un EPUB roto puede tirar
/// cientos; con las primeras alcanza para saber qué arreglar.
const MAX_MENSAJES: usize = 20;

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct EpubcheckReport {
    /// `false` = no hay binario. El resto de los campos no significan nada.
    pub disponible: bool,
    pub fatals: u32,
    pub errors: u32,
    pub warnings: u32,
    /// Líneas FATAL/ERROR/WARNING tal como las escribe epubcheck.
    pub mensajes: Vec<String>,
    /// Comando de instalación, cuando lo sabemos para esta plataforma.
    pub instalar: Option<String>,
    /// Binario que se intentó correr. Va siempre: si algo no anda, la primera
    /// pregunta es cuál agarró, y adivinarlo desde afuera es imposible (el
    /// PATH de la app no es el del shell del autor).
    pub binario: String,
    /// Exit code del proceso. `None` = lo mató una señal.
    pub exit_code: Option<i32>,
    /// El validador no pudo correr (JVM ausente, jar roto, permisos). Distinto
    /// de "el EPUB tiene errores": ahí epubcheck sale con 1 pero **habla**.
    /// Lleva la salida cruda, que es lo único que explica qué pasó.
    pub falla: Option<String>,
}

/// Resuelve el binario. Igual que `pandoc_bin`: la app lanzada desde
/// Finder/Dock hereda el PATH mínimo de launchd, sin los symlinks de Homebrew.
fn epubcheck_bin() -> String {
    const CANDIDATES: [&str; 3] = [
        "/opt/homebrew/bin/epubcheck", // Homebrew (Apple Silicon)
        "/usr/local/bin/epubcheck",    // Homebrew (Intel)
        "/usr/bin/epubcheck",          // paquetes nativos Linux
    ];
    for c in CANDIDATES {
        if Path::new(c).exists() {
            return c.to_string();
        }
    }
    "epubcheck".to_string()
}

/// Comando de instalación por plataforma. En Linux no adivinamos el gestor de
/// paquetes (ver la convención del remedio accionable en CLAUDE.md): la UI
/// muestra el link a los releases.
fn comando_instalar() -> Option<String> {
    if cfg!(target_os = "macos") {
        Some("brew install epubcheck".to_string())
    } else {
        None
    }
}

#[tauri::command]
pub async fn epubcheck_validar(epub_path: String) -> Result<EpubcheckReport, String> {
    tauri::async_runtime::spawn_blocking(move || validar_impl(&epub_path))
        .await
        .map_err(|e| format!("task: {}", e))?
}

fn validar_impl(epub_path: &str) -> Result<EpubcheckReport, String> {
    if !Path::new(epub_path).is_file() {
        return Err(format!("no existe el epub: {}", epub_path));
    }
    let bin = epubcheck_bin();
    let salida = match Command::new(&bin).arg(epub_path).output() {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!(target: "epubcheck", bin = %bin, "epubcheck no instalado — export sin validar");
            return Ok(EpubcheckReport {
                disponible: false,
                instalar: comando_instalar(),
                binario: bin,
                ..Default::default()
            });
        }
        Err(e) => return Err(format!("epubcheck ({}): {}", bin, e)),
    };
    // epubcheck escribe el detalle por stderr y el resumen por stdout, y de qué
    // lado cae cada cosa cambió entre versiones: juntamos los dos.
    let texto = format!(
        "{}{}",
        String::from_utf8_lossy(&salida.stderr),
        String::from_utf8_lossy(&salida.stdout)
    );
    let reporte = armar_reporte(&texto, &bin, salida.status.code(), salida.status.success());
    if reporte.falla.is_some() {
        tracing::warn!(target: "epubcheck", bin = %bin, code = ?salida.status.code(), "epubcheck no pudo validar");
    } else {
        tracing::info!(
            target: "epubcheck",
            bin = %bin,
            fatals = reporte.fatals, errors = reporte.errors, warnings = reporte.warnings,
            "epub validado"
        );
    }
    Ok(reporte)
}

/// Salida + exit code → veredicto.
///
/// epubcheck sale con 1 cuando el EPUB tiene errores, así que un exit code
/// sucio por sí solo no es una falla de la herramienta. Lo que la delata es
/// salir mal SIN haber dicho una sola línea de diagnóstico: ahí no llegó a
/// validar nada (la JVM que el wrapper de Homebrew espera no está, el jar no
/// se puede leer) y reportar "0 errores" sería mentir.
fn armar_reporte(texto: &str, bin: &str, code: Option<i32>, exito: bool) -> EpubcheckReport {
    let mut r = parse_salida(texto);
    r.binario = bin.to_string();
    r.exit_code = code;
    if !exito && r.mensajes.is_empty() {
        let detalle = texto.trim();
        r.falla = Some(if detalle.is_empty() {
            format!("{} terminó con {:?} y sin salida", bin, code)
        } else {
            detalle.to_string()
        });
    }
    r
}

/// Cuenta y junta las líneas de diagnóstico. epubcheck las escribe como
/// `NIVEL(CÓDIGO): archivo(línea,columna): mensaje`, una por línea.
fn parse_salida(texto: &str) -> EpubcheckReport {
    let mut r = EpubcheckReport {
        disponible: true,
        ..Default::default()
    };
    for linea in texto.lines() {
        let linea = linea.trim();
        let contador = if linea.starts_with("FATAL(") {
            &mut r.fatals
        } else if linea.starts_with("ERROR(") {
            &mut r.errors
        } else if linea.starts_with("WARNING(") {
            &mut r.warnings
        } else {
            continue;
        };
        *contador += 1;
        if r.mensajes.len() < MAX_MENSAJES {
            r.mensajes.push(linea.to_string());
        }
    }
    r
}

/// Estado del validador, para que Configuración pueda decir si está y cómo
/// instalarlo sin tener que exportar un EPUB antes.
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct EpubcheckEstado {
    pub disponible: bool,
    /// Primera línea de `epubcheck --version`, cuando está.
    pub version: Option<String>,
    pub instalar: Option<String>,
    /// Binario que se probó. Va siempre: "no está instalado" y "está pero no
    /// arranca" se ven igual desde la UI si no se dice qué se intentó correr.
    pub binario: String,
    /// Salida cruda cuando el binario existe pero termina mal (el wrapper de
    /// Homebrew sin JVM, por ejemplo). `None` si ni siquiera se pudo lanzar.
    pub salida: Option<String>,
}

#[tauri::command]
pub async fn epubcheck_estado() -> EpubcheckEstado {
    tauri::async_runtime::spawn_blocking(estado_impl)
        .await
        .unwrap_or_default()
}

fn estado_impl() -> EpubcheckEstado {
    let bin = epubcheck_bin();
    match Command::new(&bin).arg("--version").output() {
        // Existir no alcanza: el `epubcheck` de Homebrew es un script que
        // hace `exec` de una JVM, y sin esa JVM el script está pero no corre.
        Ok(o) if o.status.success() => {
            let texto = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            EpubcheckEstado {
                disponible: true,
                version: primera_linea(&texto),
                instalar: None,
                binario: bin.clone(),
                salida: None,
            }
        }
        Ok(o) => {
            let texto = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stderr),
                String::from_utf8_lossy(&o.stdout)
            );
            tracing::warn!(target: "epubcheck", bin = %bin, code = ?o.status.code(), "epubcheck presente pero no corre");
            EpubcheckEstado {
                disponible: false,
                version: None,
                instalar: comando_instalar(),
                binario: bin.clone(),
                salida: Some(match texto.trim() {
                    "" => format!("terminó con {:?} y sin salida", o.status.code()),
                    t => t.to_string(),
                }),
            }
        }
        Err(e) => EpubcheckEstado {
            disponible: false,
            version: None,
            instalar: comando_instalar(),
            binario: bin.clone(),
            salida: if e.kind() == std::io::ErrorKind::NotFound {
                None
            } else {
                Some(e.to_string())
            },
        },
    }
}

fn primera_linea(texto: &str) -> Option<String> {
    texto
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cuenta_por_nivel_y_junta_las_lineas() {
        let salida = "Validating using EPUB version 3.3 rules.\n\
ERROR(RSC-005): Deployment.epub/OEBPS/6_blank.xhtml(6,15): Error while parsing file: element \"title\" must not be empty.\n\
WARNING(OPF-055): Deployment.epub/OEBPS/content.opf(20,80): deprecated media-type.\n\
FATAL(PKG-008): Deployment.epub: no se pudo leer el zip.\n\
Messages: 1 fatal / 1 error / 1 warning / 0 infos\n";
        let r = parse_salida(salida);
        assert!(r.disponible);
        assert_eq!((r.fatals, r.errors, r.warnings), (1, 1, 1));
        assert_eq!(r.mensajes.len(), 3);
        assert!(r.mensajes[0].contains("RSC-005"));
    }

    #[test]
    fn parse_epub_limpio_no_reporta_nada() {
        let r = parse_salida("Validating using EPUB version 3.3 rules.\nNo errors or warnings detected.\nMessages: 0 fatals / 0 errors / 0 warnings / 0 infos\n");
        assert_eq!((r.fatals, r.errors, r.warnings), (0, 0, 0));
        assert!(r.mensajes.is_empty());
    }

    #[test]
    fn parse_capa_los_mensajes() {
        let muchos = (0..50)
            .map(|i| format!("ERROR(RSC-005): x.xhtml({},1): roto", i))
            .collect::<Vec<_>>()
            .join("\n");
        let r = parse_salida(&muchos);
        assert_eq!(r.errors, 50);
        assert_eq!(r.mensajes.len(), MAX_MENSAJES);
    }

    #[test]
    fn un_exit_sucio_sin_diagnostico_es_falla_de_la_herramienta() {
        // El wrapper de Homebrew hace `exec` de una JVM: sin JVM el script
        // existe, corre, y muere sin haber validado nada.
        let r = armar_reporte(
            "/opt/homebrew/bin/epubcheck: line 3: /opt/homebrew/opt/openjdk/bin/java: No such file or directory\n",
            "/opt/homebrew/bin/epubcheck",
            Some(127),
            false,
        );
        assert!(r.disponible);
        assert_eq!(r.exit_code, Some(127));
        assert!(r.falla.as_deref().unwrap().contains("No such file"));
        assert_eq!((r.fatals, r.errors, r.warnings), (0, 0, 0));
    }

    #[test]
    fn un_epub_con_errores_no_cuenta_como_falla_de_la_herramienta() {
        // Acá el exit code también es sucio, pero epubcheck habló: el problema
        // es el EPUB, no el validador.
        let r = armar_reporte(
            "ERROR(RSC-005): x.epub/OEBPS/6_blank.xhtml(6,15): element \"title\" must not be empty.\n",
            "epubcheck",
            Some(1),
            false,
        );
        assert!(r.falla.is_none());
        assert_eq!(r.errors, 1);
    }

    #[test]
    fn un_epub_limpio_sale_sin_falla_y_con_el_binario_puesto() {
        let r = armar_reporte("No errors or warnings detected.\n", "epubcheck", Some(0), true);
        assert!(r.falla.is_none());
        assert_eq!(r.binario, "epubcheck");
        assert_eq!(r.exit_code, Some(0));
    }

    #[test]
    fn el_epub_inexistente_falla_sin_llamar_al_binario() {
        assert!(validar_impl("/no/existe.epub").is_err());
    }
}
