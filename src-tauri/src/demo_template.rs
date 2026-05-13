use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use crate::book_config::BookConfig;
use crate::import::count_words;
use crate::import_wizard::{ImportSummary, ProgressPayload};
use crate::saga_config::SagaConfig;
use crate::search;

// ─────────── Contenido demo (hardcoded) ───────────

struct DemoPart {
    es: &'static str,
    en: &'static str,
}

struct DemoChapter {
    titulo_es: &'static str,
    titulo_en: &'static str,
    partes: [DemoPart; 3],
}

const SAGA_DEFAULT_ES: &str = "Tu saga de fantasía";
const SAGA_DEFAULT_EN: &str = "Your fantasy saga";
const BOOK_TITULO_ES: &str = "Primera novela de fantasía";
const BOOK_TITULO_EN: &str = "First fantasy novel";

const DEMO_CHAPTERS: [DemoChapter; 5] = [
    DemoChapter {
        titulo_es: "El Llamado",
        titulo_en: "The Call",
        partes: [
            DemoPart {
                es: include_str!("demo_content/cap1_p1_es.html"),
                en: include_str!("demo_content/cap1_p1_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap1_p2_es.html"),
                en: include_str!("demo_content/cap1_p2_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap1_p3_es.html"),
                en: include_str!("demo_content/cap1_p3_en.html"),
            },
        ],
    },
    DemoChapter {
        titulo_es: "El Bosque de las Sombras",
        titulo_en: "The Shadow Forest",
        partes: [
            DemoPart {
                es: include_str!("demo_content/cap2_p1_es.html"),
                en: include_str!("demo_content/cap2_p1_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap2_p2_es.html"),
                en: include_str!("demo_content/cap2_p2_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap2_p3_es.html"),
                en: include_str!("demo_content/cap2_p3_en.html"),
            },
        ],
    },
    DemoChapter {
        titulo_es: "La Espada Rota",
        titulo_en: "The Broken Sword",
        partes: [
            DemoPart {
                es: include_str!("demo_content/cap3_p1_es.html"),
                en: include_str!("demo_content/cap3_p1_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap3_p2_es.html"),
                en: include_str!("demo_content/cap3_p2_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap3_p3_es.html"),
                en: include_str!("demo_content/cap3_p3_en.html"),
            },
        ],
    },
    DemoChapter {
        titulo_es: "El Pacto de Ceniza",
        titulo_en: "The Pact of Ash",
        partes: [
            DemoPart {
                es: include_str!("demo_content/cap4_p1_es.html"),
                en: include_str!("demo_content/cap4_p1_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap4_p2_es.html"),
                en: include_str!("demo_content/cap4_p2_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap4_p3_es.html"),
                en: include_str!("demo_content/cap4_p3_en.html"),
            },
        ],
    },
    DemoChapter {
        titulo_es: "Más Allá del Umbral",
        titulo_en: "Beyond the Threshold",
        partes: [
            DemoPart {
                es: include_str!("demo_content/cap5_p1_es.html"),
                en: include_str!("demo_content/cap5_p1_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap5_p2_es.html"),
                en: include_str!("demo_content/cap5_p2_en.html"),
            },
            DemoPart {
                es: include_str!("demo_content/cap5_p3_es.html"),
                en: include_str!("demo_content/cap5_p3_en.html"),
            },
        ],
    },
];

// ─────────── API ───────────

/// Genera una saga demo completa en `target_root`. 1 saga + 1 libro + 5 capítulos × 3 partes.
///
/// - `saga_name` trim. Si vacío, usa el default del idioma.
/// - `lang` ∈ {"es","en"}. Otros → error.
/// - Si la carpeta destino ya existe, prueba sufijos "(2)"..."(99)".
/// - `progress(done, total, current)` se llama después de escribir cada parte (total=15).
pub fn generate_demo(
    target_root: &Path,
    saga_name: &str,
    lang: &str,
    mut progress: impl FnMut(u32, u32, &str),
) -> Result<ImportSummary, String> {
    if !target_root.is_dir() {
        return Err(format!("target no existe: {}", target_root.display()));
    }
    if lang != "es" && lang != "en" {
        return Err(format!("lang inválido: {} (esperado 'es' o 'en')", lang));
    }
    let trimmed = saga_name.trim();
    let requested = if trimmed.is_empty() {
        if lang == "en" {
            SAGA_DEFAULT_EN
        } else {
            SAGA_DEFAULT_ES
        }
    } else {
        trimmed
    };

    let saga_name_final = pick_free_name(target_root, requested)?;
    let saga_dir = target_root.join(&saga_name_final);
    let mut summary = ImportSummary::default();

    fs::create_dir(&saga_dir).map_err(|e| format!("mkdir {}: {}", saga_dir.display(), e))?;
    summary.created_dirs += 1;
    if saga_name_final != requested {
        tracing::info!(
            target: "demo",
            requested = requested,
            chosen = %saga_name_final,
            "saga renombrada por colisión"
        );
    }

    write_saga_json(&saga_dir, &build_saga_cfg(&saga_name_final, lang))?;

    let book_title = if lang == "en" { BOOK_TITULO_EN } else { BOOK_TITULO_ES };
    let book_dir_name = format!("1 - {}", book_title);
    let book_dir = saga_dir.join(&book_dir_name);
    fs::create_dir(&book_dir).map_err(|e| format!("mkdir {}: {}", book_dir.display(), e))?;
    summary.created_dirs += 1;
    write_book_json(&book_dir, &build_book_cfg(book_title, lang, &saga_name_final))?;

    let total: u32 = 15;
    let mut done: u32 = 0;
    for (i, chap) in DEMO_CHAPTERS.iter().enumerate() {
        let titulo = if lang == "en" { chap.titulo_en } else { chap.titulo_es };
        let chap_dir_name = format!("{} - {}", i + 1, titulo);
        let chap_dir = book_dir.join(&chap_dir_name);
        fs::create_dir(&chap_dir)
            .map_err(|e| format!("mkdir {}: {}", chap_dir.display(), e))?;
        summary.created_dirs += 1;

        for (j, parte) in chap.partes.iter().enumerate() {
            let n = (j + 1) as u32;
            let html = if lang == "en" { parte.en } else { parte.es };
            let html_path = chap_dir.join(format!("{}.html", n));
            let meta_path = chap_dir.join(format!("{}.meta.json", n));
            let mut html_owned = html.to_string();
            if !html_owned.ends_with('\n') {
                html_owned.push('\n');
            }
            fs::write(&html_path, &html_owned)
                .map_err(|e| format!("write {}: {}", html_path.display(), e))?;
            let palabras = count_words(html);
            let meta = serde_json::json!({
                "orden": n,
                "titulo": "",
                "palabras": palabras,
                "ultima_edicion": null,
                "status": "draft",
                "idioma": lang,
            });
            fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap_or_default())
                .map_err(|e| format!("write {}: {}", meta_path.display(), e))?;
            summary.copied_chapters += 1;
            search::index_path_best_effort(&html_path.to_string_lossy(), "chapter");

            done += 1;
            let label = format!("cap {} parte {}", i + 1, n);
            progress(done, total, &label);
        }
    }
    tracing::info!(
        target: "demo",
        saga = %saga_name_final,
        creados = summary.copied_chapters,
        dirs = summary.created_dirs,
        lang = lang,
        "demo generado"
    );
    Ok(summary)
}

fn pick_free_name(root: &Path, requested: &str) -> Result<String, String> {
    if !root.join(requested).exists() {
        return Ok(requested.to_string());
    }
    for n in 2..=99u32 {
        let candidate = format!("{} ({})", requested, n);
        if !root.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "demasiadas colisiones para \"{}\": 99 sufijos ocupados",
        requested
    ))
}

fn build_saga_cfg(nombre: &str, lang: &str) -> SagaConfig {
    SagaConfig {
        nombre: nombre.to_string(),
        autor: Some("Demo Author".to_string()),
        idioma: Some(lang.to_string()),
        imprenta: Some("Independiente".to_string()),
        template: Some("6x9".to_string()),
        prefijo_capitulo: Some("decimal".to_string()),
        mostrar_titulo_capitulo: Some(true),
        dropcap: Some(false),
        mostrar_numero_parte: Some(true),
        formato_parte: Some("raw".to_string()),
        ..Default::default()
    }
}

fn build_book_cfg(titulo: &str, lang: &str, serie: &str) -> BookConfig {
    BookConfig {
        titulo: titulo.to_string(),
        autor: Some("Demo Author".to_string()),
        idioma: Some(lang.to_string()),
        serie: Some(serie.to_string()),
        numero_en_serie: Some(1),
        imprenta: Some("Independiente".to_string()),
        template: Some("6x9".to_string()),
        prefijo_capitulo: Some("decimal".to_string()),
        mostrar_titulo_capitulo: Some(true),
        dropcap: Some(false),
        mostrar_numero_parte: Some(true),
        formato_parte: Some("raw".to_string()),
        derechos_reservados: Some(true),
        ..Default::default()
    }
}

fn write_saga_json(dir: &Path, cfg: &SagaConfig) -> Result<(), String> {
    let path = dir.join("saga.json");
    let mut json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn write_book_json(dir: &Path, cfg: &BookConfig) -> Result<(), String> {
    let path = dir.join("book.json");
    let mut json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    json.push('\n');
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ─────────── Comando Tauri ───────────

#[tauri::command]
pub async fn generate_demo_template(
    app: AppHandle,
    target_root: String,
    saga_name: String,
    lang: String,
) -> Result<ImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&target_root);
        let app_for_cb = app.clone();
        let mut cb = move |done: u32, total: u32, current: &str| {
            let _ = app_for_cb.emit(
                "import-progress",
                ProgressPayload {
                    done,
                    total,
                    current: current.to_string(),
                },
            );
        };
        generate_demo(&root, &saga_name, &lang, &mut cb)
    })
    .await
    .map_err(|e| format!("task: {}", e))?
}

// ─────────── Tests ───────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn tmp_dir(label: &str) -> PathBuf {
        let pid = std::process::id();
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("twriter-demo-test-{}-{}-{}", label, pid, seq));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn noop_progress(_done: u32, _total: u32, _label: &str) {}

    #[test]
    fn genera_estructura_completa_es() {
        let root = tmp_dir("estructura-es");
        let summary = generate_demo(&root, "Mi Saga", "es", noop_progress).unwrap();

        // 1 saga dir + 1 book dir + 5 chapter dirs = 7
        assert_eq!(summary.created_dirs, 7);
        assert_eq!(summary.copied_chapters, 15);
        assert!(summary.failed.is_empty());

        let saga = root.join("Mi Saga");
        assert!(saga.join("saga.json").is_file());
        let book = saga.join("1 - Primera novela de fantasía");
        assert!(book.join("book.json").is_file());

        for (i, chap) in DEMO_CHAPTERS.iter().enumerate() {
            let chap_dir = book.join(format!("{} - {}", i + 1, chap.titulo_es));
            assert!(chap_dir.is_dir(), "falta {}", chap_dir.display());
            for j in 1..=3u32 {
                assert!(chap_dir.join(format!("{}.html", j)).is_file());
                assert!(chap_dir.join(format!("{}.meta.json", j)).is_file());
            }
        }
    }

    #[test]
    fn idioma_en_setea_metadata_y_titulos_ingleses() {
        let root = tmp_dir("idioma-en");
        generate_demo(&root, "", "en", noop_progress).unwrap();
        let saga = root.join(SAGA_DEFAULT_EN);
        assert!(saga.is_dir());
        let book = saga.join("1 - First fantasy novel");
        assert!(book.is_dir());
        // Caps en EN
        for chap in DEMO_CHAPTERS.iter() {
            let dir = book.join(format!("{} - {}", 1, chap.titulo_en));
            if dir.is_dir() {
                // bien
            }
        }
        // Verificar meta.idioma == "en" en cap1 parte1
        let meta = fs::read_to_string(
            book.join("1 - The Call").join("1.meta.json"),
        )
        .unwrap();
        assert!(meta.contains("\"idioma\": \"en\""));

        // Verificar saga.json idioma
        let saga_json = fs::read_to_string(saga.join("saga.json")).unwrap();
        assert!(saga_json.contains("\"idioma\": \"en\""));
    }

    #[test]
    fn lang_invalido_devuelve_err() {
        let root = tmp_dir("lang-err");
        let r = generate_demo(&root, "X", "fr", noop_progress);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("lang inválido"));
    }

    #[test]
    fn colision_auto_sufijo() {
        let root = tmp_dir("colision");
        // primera corrida
        generate_demo(&root, "Demo", "es", noop_progress).unwrap();
        assert!(root.join("Demo").is_dir());
        // segunda corrida con el mismo nombre
        generate_demo(&root, "Demo", "es", noop_progress).unwrap();
        assert!(root.join("Demo (2)").is_dir(), "esperaba sufijo (2)");
        // tercera corrida
        generate_demo(&root, "Demo", "es", noop_progress).unwrap();
        assert!(root.join("Demo (3)").is_dir(), "esperaba sufijo (3)");
        // original intacta
        assert!(root.join("Demo").join("saga.json").is_file());
    }

    #[test]
    fn callback_recibe_15_y_15_al_final() {
        let root = tmp_dir("progress");
        let mut events: Vec<(u32, u32)> = Vec::new();
        let cb = |done: u32, total: u32, _: &str| {
            events.push((done, total));
        };
        generate_demo(&root, "Prog", "es", cb).unwrap();
        assert_eq!(events.len(), 15);
        for (_, t) in &events {
            assert_eq!(*t, 15);
        }
        assert_eq!(events.last().copied(), Some((15, 15)));
    }

    #[test]
    fn prosa_cubre_subset_html_canonico() {
        let mut total = String::new();
        for chap in DEMO_CHAPTERS.iter() {
            for parte in chap.partes.iter() {
                total.push_str(parte.es);
                total.push('\n');
            }
        }
        assert!(total.contains("—"), "esperaba diálogo RAE (em-dash)");
        assert!(total.contains("<em>"), "esperaba al menos un <em>");
        assert!(total.contains("<strong>"), "esperaba al menos un <strong>");
        assert!(
            total.contains("<hr class=\"scene-break\"/>"),
            "esperaba al menos un scene-break"
        );
        assert!(
            total.contains("<blockquote>"),
            "esperaba al menos un <blockquote>"
        );
    }

    #[test]
    fn defaults_segun_idioma_cuando_nombre_vacio() {
        let root = tmp_dir("default-name");
        generate_demo(&root, "   ", "es", noop_progress).unwrap();
        assert!(root.join(SAGA_DEFAULT_ES).is_dir());
        let root2 = tmp_dir("default-name-en");
        generate_demo(&root2, "", "en", noop_progress).unwrap();
        assert!(root2.join(SAGA_DEFAULT_EN).is_dir());
    }
}
