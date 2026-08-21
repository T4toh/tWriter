use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Estado de la última sesión del editor. `chapter_path` es relativo al root
/// y `pm_pos` es la posición absoluta del cursor en el documento ProseMirror
/// (state.selection.from). Se aplica al boot si el archivo sigue existiendo.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LastSession {
    #[serde(rename = "chapterPath")]
    pub chapter_path: String,
    #[serde(rename = "pmPos")]
    pub pm_pos: usize,
}

/// Las tres excepciones de repetición deliberada del detector. Espeja
/// `ExcepcionesDeliberadas` de `src/app/repeticiones/detector.ts`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepeticionesExcepciones {
    /// `cuerpo a cuerpo`, `side by side`.
    #[serde(default = "bool_true")]
    pub construccion: bool,
    /// `¡Guía nocturno! ¡Guía nocturno!`, `a veces… a veces`.
    #[serde(default = "bool_true", rename = "fraseRepetida")]
    pub frase_repetida: bool,
    /// `loved traveling…, loved hearing…`.
    #[serde(default = "bool_true")]
    pub anafora: bool,
}

fn bool_true() -> bool {
    true
}

impl Default for RepeticionesExcepciones {
    fn default() -> Self {
        Self {
            construccion: true,
            frase_repetida: true,
            anafora: true,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct Settings {
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default, rename = "editorWidth", skip_serializing_if = "Option::is_none")]
    pub editor_width: Option<String>,
    #[serde(
        default,
        rename = "editorFontSize",
        skip_serializing_if = "Option::is_none"
    )]
    pub editor_font_size: Option<u32>,
    #[serde(
        default,
        rename = "editorFontFamily",
        skip_serializing_if = "Option::is_none"
    )]
    pub editor_font_family: Option<String>,
    /// Familias usadas recientemente en el dropdown del editor (más recientes
    /// arriba, max 5). Persiste cross-session. Cada selección hace
    /// unshift + dedupe + truncate en el frontend antes de guardar.
    #[serde(
        default,
        rename = "editorFontRecents",
        skip_serializing_if = "Option::is_none"
    )]
    pub editor_font_recents: Option<Vec<String>>,
    #[serde(
        default,
        rename = "editorParagraphSpacing",
        skip_serializing_if = "Option::is_none"
    )]
    pub editor_paragraph_spacing: Option<String>,
    #[serde(
        default,
        rename = "grammarMode",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_mode: Option<String>,
    #[serde(
        default,
        rename = "grammarCustomUrl",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_custom_url: Option<String>,
    /// Username de LT Premium / self-hosted con auth. No es sensible (es un email),
    /// se persiste en settings.json. El apiKey va al keyring del sistema vía el
    /// módulo `secrets` (libsecret / Keychain / Credential Manager), nunca a este JSON.
    #[serde(
        default,
        rename = "grammarLtUsername",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_lt_username: Option<String>,
    #[serde(
        default,
        rename = "grammarVariantEs",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_variant_es: Option<String>,
    #[serde(
        default,
        rename = "grammarVariantEn",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_variant_en: Option<String>,
    /// Si true, se manda `level=picky` a LanguageTool en vez de `default`,
    /// activando reglas extra de texto formal (ej. `TOO_LONG_SENTENCE`).
    /// Default false: en prosa de novela las oraciones largas suelen ser
    /// deliberadas. Verificado que solo agrega matches en inglés — el ruleset
    /// picky de español de LT 6.8 está prácticamente vacío.
    #[serde(
        default,
        rename = "grammarPicky",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_picky: Option<bool>,
    /// Si true, el auto-check de gramática queda apagado aunque LT esté
    /// disponible. Default false (auto se activa solo cuando LT responde).
    #[serde(
        default,
        rename = "grammarAutoDisabled",
        skip_serializing_if = "Option::is_none"
    )]
    pub grammar_auto_disabled: Option<bool>,
    /// Si true, el auto-check del validador RAE queda apagado. Default false
    /// (auto-check activo cuando idioma == 'es').
    #[serde(
        default,
        rename = "raeAutoDisabled",
        skip_serializing_if = "Option::is_none"
    )]
    pub rae_auto_disabled: Option<bool>,
    /// Si true, el detector de repeticiones cercanas queda apagado.
    /// Default false (marca mientras se escribe, como el validador RAE).
    #[serde(
        default,
        rename = "repeticionesAutoDisabled",
        skip_serializing_if = "Option::is_none"
    )]
    pub repeticiones_auto_disabled: Option<bool>,
    /// Qué formas de repetición deliberada filtra el detector. Las tres
    /// prendidas por default: son legítimas (frase hecha, anáfora, énfasis de
    /// diálogo) y marcarlas hace ruido. Primera clave no escalar de `Settings`,
    /// de ahí el `default` en cada campo de la struct anidada: un
    /// settings.json viejo, o uno escrito por una versión con menos flags, no
    /// tiene que romper el parseo.
    #[serde(
        default,
        rename = "repeticionesExcepciones",
        skip_serializing_if = "Option::is_none"
    )]
    pub repeticiones_excepciones: Option<RepeticionesExcepciones>,
    /// Ancho del panel derecho ("compact" | "normal" | "wide" | "full").
    #[serde(
        default,
        rename = "rightPanelWidth",
        skip_serializing_if = "Option::is_none"
    )]
    pub right_panel_width: Option<String>,
    /// Scope persistido del panel de búsqueda Ctrl+F.
    /// "all" | "saga" | "book" | "notes" | "chapters".
    #[serde(
        default,
        rename = "searchScope",
        skip_serializing_if = "Option::is_none"
    )]
    pub search_scope: Option<String>,
    /// Si true, el panel de búsqueda muestra el score BM25 por hit.
    #[serde(
        default,
        rename = "searchDebug",
        skip_serializing_if = "Option::is_none"
    )]
    pub search_debug: Option<bool>,
    /// Última sesión del pane 0: cap activo + posición del cursor. Se restaura
    /// al boot si el archivo sigue existiendo.
    #[serde(
        default,
        rename = "lastSession",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_session: Option<LastSession>,
    /// Paths de nodos del tree (saga/libro/sección/folder libre) que estaban
    /// expandidos al cerrar. Apply al cargar el tree.
    #[serde(
        default,
        rename = "treeExpanded",
        skip_serializing_if = "Option::is_none"
    )]
    pub tree_expanded: Option<Vec<String>>,
    /// Scope paths con la sección Extras abierta.
    #[serde(
        default,
        rename = "treeExtrasExpanded",
        skip_serializing_if = "Option::is_none"
    )]
    pub tree_extras_expanded: Option<Vec<String>>,
    /// Keys `<scopePath>::<relPath>` de subdirs dentro de Extras expandidos.
    #[serde(
        default,
        rename = "treeExtrasDirsExpanded",
        skip_serializing_if = "Option::is_none"
    )]
    pub tree_extras_dirs_expanded: Option<Vec<String>>,
    /// Book paths con la sección Exportados abierta.
    #[serde(
        default,
        rename = "treeExportsExpanded",
        skip_serializing_if = "Option::is_none"
    )]
    pub tree_exports_expanded: Option<Vec<String>>,
    /// Paths expandidos del árbol secundario de notas (variante 'notes'). Se
    /// persiste aparte de `tree_expanded` para que los dos árboles del panel
    /// izquierdo no se pisen al guardar.
    #[serde(
        default,
        rename = "treeNotesExpanded",
        skip_serializing_if = "Option::is_none"
    )]
    pub tree_notes_expanded: Option<Vec<String>>,
    /// Panel de notas (segundo árbol) colapsado. Default false (abierto).
    #[serde(
        default,
        rename = "notesPaneCollapsed",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes_pane_collapsed: Option<bool>,
    /// Alto en px del panel de notas cuando está abierto (resizable).
    #[serde(
        default,
        rename = "notesPaneHeight",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes_pane_height: Option<u32>,
    /// Tab activa del panel de notas: "libro" (notas del libro que se está
    /// escribiendo) o "todas" (el árbol completo). Sin esto serde lo dropea en
    /// el round-trip y el panel vuelve al default en cada boot.
    #[serde(default, rename = "notasTab", skip_serializing_if = "Option::is_none")]
    pub notas_tab: Option<String>,
    /// Runtime de containers donde la app vio el container de LanguageTool
    /// ("docker" | "podman" | "apple"). Lo descubre y lo escribe el backend
    /// (`grammar.rs`); el frontend NO lo conoce ni lo manda. Ver
    /// `merge_backend_owned`.
    #[serde(
        default,
        rename = "languagetoolRuntime",
        skip_serializing_if = "Option::is_none"
    )]
    pub languagetool_runtime: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    Ok(dir.join("settings.json"))
}

/// Lectura cruda del archivo. La comparten el comando y los helpers del backend.
pub fn read_settings(app: &AppHandle) -> Result<Settings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Campos que descubre el backend por su cuenta y el frontend no conoce: si el
/// entrante no los trae (que es siempre), se conservan los de disco. Sin esto
/// hay una carrera real — el front guarda una copia de settings anterior a la
/// escritura del backend y le pisa el campo.
fn merge_backend_owned(incoming: &mut Settings, disk: &Settings) {
    if incoming.languagetool_runtime.is_none() {
        incoming.languagetool_runtime = disk.languagetool_runtime.clone();
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    read_settings(&app)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let mut settings = settings;
    match read_settings(&app) {
        Ok(disk) => merge_backend_owned(&mut settings, &disk),
        Err(e) => {
            // Justo el camino donde se pierde el runtime recordado si el
            // disco falla: igual seguimos y escribimos lo que llegó del
            // front (no cambia el comportamiento, solo deja rastro).
            tracing::warn!(target: "grammar", error = %e, "no se pudo leer settings de disco para el merge");
        }
    }
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Runtime recordado, o `None` si no hay nada o el archivo no se pudo leer.
pub fn remembered_lt_runtime(app: &AppHandle) -> Option<String> {
    read_settings(app).ok()?.languagetool_runtime
}

/// Persiste el runtime si cambió. Best-effort: si falla, se loggea y sigue —
/// que la próxima vez vuelva a preguntar es peor que no arrancar el container
/// ahora.
pub fn remember_lt_runtime(app: &AppHandle, key: &str) {
    let mut s = match read_settings(app) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(target: "grammar", error = %e, "no se pudo leer settings para recordar el runtime");
            return;
        }
    };
    if s.languagetool_runtime.as_deref() == Some(key) {
        return;
    }
    s.languagetool_runtime = Some(key.to_string());
    let Ok(path) = settings_path(app) else { return };
    match serde_json::to_string_pretty(&s) {
        Ok(raw) => {
            if let Err(e) = fs::write(&path, raw) {
                tracing::warn!(target: "grammar", error = %e, "no se pudo recordar el runtime de LanguageTool");
            }
        }
        Err(e) => {
            tracing::warn!(target: "grammar", error = %e, "no se pudo serializar settings");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeticiones_excepciones_roundtrip_and_absent_default() {
        // Primera clave no escalar de Settings. Un settings.json previo a la
        // feature no la trae y tiene que leerse como None sin romper.
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(old.repeticiones_excepciones, None);
        assert_eq!(old.repeticiones_auto_disabled, None);

        // Y uno escrito por una versión con menos flags: los que falten
        // arrancan en true, que es el default de cada excepción.
        let parcial: Settings =
            serde_json::from_str(r#"{"repeticionesExcepciones":{"anafora":false}}"#).unwrap();
        let exc = parcial.repeticiones_excepciones.unwrap();
        assert!(!exc.anafora);
        assert!(exc.construccion, "los ausentes arrancan prendidos");
        assert!(exc.frase_repetida);

        let mut s = Settings::default();
        s.repeticiones_excepciones = Some(RepeticionesExcepciones {
            construccion: true,
            frase_repetida: false,
            anafora: true,
        });
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"fraseRepetida\":false"), "json: {}", json);
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.repeticiones_excepciones, s.repeticiones_excepciones);
    }

    #[test]
    fn grammar_picky_roundtrip_and_absent_default() {
        // La clave persistida es `grammarPicky` (camelCase). Un settings.json
        // previo a la feature no la trae y tiene que leerse como None.
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(old.grammar_picky, None);

        let mut s = Settings::default();
        s.grammar_picky = Some(true);
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"grammarPicky\":true"), "json: {}", json);
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.grammar_picky, Some(true));
    }

    #[test]
    fn last_session_roundtrip() {
        let mut s = Settings::default();
        s.last_session = Some(LastSession {
            chapter_path: "Saga/Libro/1.html".to_string(),
            pm_pos: 1234,
        });
        s.tree_expanded = Some(vec!["Saga".to_string(), "Saga/Libro".to_string()]);
        s.tree_extras_expanded = Some(vec!["Saga".to_string()]);
        s.tree_extras_dirs_expanded = Some(vec!["Saga::convertidos".to_string()]);
        s.tree_exports_expanded = Some(vec!["Saga/Libro".to_string()]);

        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        let ls = back.last_session.expect("last_session");
        assert_eq!(ls.chapter_path, "Saga/Libro/1.html");
        assert_eq!(ls.pm_pos, 1234);
        assert_eq!(back.tree_expanded.as_deref(), Some(&[
            "Saga".to_string(),
            "Saga/Libro".to_string(),
        ][..]));
        assert_eq!(back.tree_extras_expanded.as_deref().map(|v| v.len()), Some(1));
        assert_eq!(back.tree_extras_dirs_expanded.as_deref().map(|v| v.len()), Some(1));
        assert_eq!(back.tree_exports_expanded.as_deref().map(|v| v.len()), Some(1));
    }

    #[test]
    fn back_compat_legacy_json_without_new_fields() {
        // Settings.json escrito antes de esta feature: solo tiene root y un par de
        // campos viejos. Debe deserializar sin error y con los campos nuevos en None.
        let legacy = r#"{"root":"/home/u/Novelas","editorFontSize":18}"#;
        let s: Settings = serde_json::from_str(legacy).unwrap();
        assert_eq!(s.root.as_deref(), Some("/home/u/Novelas"));
        assert_eq!(s.editor_font_size, Some(18));
        assert!(s.last_session.is_none());
        assert!(s.tree_expanded.is_none());
        assert!(s.tree_extras_expanded.is_none());
        assert!(s.tree_extras_dirs_expanded.is_none());
        assert!(s.tree_exports_expanded.is_none());
    }

    #[test]
    fn serialization_skips_none_new_fields() {
        // Confirma que JSON con todos los campos None NO incluye las keys nuevas
        // (mantiene los settings.json viejos minimalistas).
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("lastSession"));
        assert!(!json.contains("treeExpanded"));
        assert!(!json.contains("treeExtrasExpanded"));
        assert!(!json.contains("treeExtrasDirsExpanded"));
        assert!(!json.contains("treeExportsExpanded"));
    }

    #[test]
    fn merge_conserva_el_runtime_de_disco_cuando_el_front_no_lo_manda() {
        // El frontend no conoce el campo, así que SIEMPRE llega None. Sin el
        // merge, cada set_settings (cambiar el tamaño de fuente, por ejemplo)
        // borraría lo que el backend descubrió.
        let mut incoming = Settings::default();
        let disk = Settings {
            languagetool_runtime: Some("apple".to_string()),
            ..Settings::default()
        };
        merge_backend_owned(&mut incoming, &disk);
        assert_eq!(incoming.languagetool_runtime, Some("apple".to_string()));
    }

    #[test]
    fn merge_no_pisa_un_valor_entrante_explicito() {
        let mut incoming = Settings {
            languagetool_runtime: Some("podman".to_string()),
            ..Settings::default()
        };
        let disk = Settings {
            languagetool_runtime: Some("apple".to_string()),
            ..Settings::default()
        };
        merge_backend_owned(&mut incoming, &disk);
        assert_eq!(incoming.languagetool_runtime, Some("podman".to_string()));
    }

    #[test]
    fn runtime_roundtripea_por_json() {
        let s = Settings {
            languagetool_runtime: Some("apple".to_string()),
            ..Settings::default()
        };
        let raw = serde_json::to_string(&s).unwrap();
        assert!(raw.contains("\"languagetoolRuntime\":\"apple\""), "raw: {raw}");
        let back: Settings = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.languagetool_runtime, Some("apple".to_string()));
    }
}
