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
    let salida = match Command::new(epubcheck_bin()).arg(epub_path).output() {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!(target: "epubcheck", "epubcheck no instalado — export sin validar");
            return Ok(EpubcheckReport {
                disponible: false,
                instalar: comando_instalar(),
                ..Default::default()
            });
        }
        Err(e) => return Err(format!("epubcheck: {}", e)),
    };
    // epubcheck escribe el detalle por stderr y el resumen por stdout, y de qué
    // lado cae cada cosa cambió entre versiones: juntamos los dos.
    let texto = format!(
        "{}{}",
        String::from_utf8_lossy(&salida.stderr),
        String::from_utf8_lossy(&salida.stdout)
    );
    let reporte = parse_salida(&texto);
    tracing::info!(
        target: "epubcheck",
        fatals = reporte.fatals, errors = reporte.errors, warnings = reporte.warnings,
        "epub validado"
    );
    Ok(reporte)
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
}

#[tauri::command]
pub async fn epubcheck_estado() -> EpubcheckEstado {
    tauri::async_runtime::spawn_blocking(estado_impl)
        .await
        .unwrap_or_default()
}

fn estado_impl() -> EpubcheckEstado {
    match Command::new(epubcheck_bin()).arg("--version").output() {
        Ok(o) => {
            let texto = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            EpubcheckEstado {
                disponible: true,
                version: texto
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .map(str::to_string),
                instalar: None,
            }
        }
        Err(_) => EpubcheckEstado {
            disponible: false,
            version: None,
            instalar: comando_instalar(),
        },
    }
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
    fn el_epub_inexistente_falla_sin_llamar_al_binario() {
        assert!(validar_impl("/no/existe.epub").is_err());
    }
}
