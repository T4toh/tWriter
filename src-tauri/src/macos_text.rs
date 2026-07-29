//! Apagado de las sustituciones de texto nativas de macOS.
//!
//! Los atributos HTML (`spellcheck`/`autocorrect`/`autocapitalize`) no alcanzan:
//! WKWebView aplica autocorrección y sustituciones del sistema POR ENCIMA del
//! contenteditable, lo que reescribe voseo (`tenés` → `tenes`) y pisa las
//! comillas de Typography. Se atacan dos capas independientes por si una no
//! muerde en alguna versión de WebKit:
//!
//! 1. `registerDefaults` sobre el domain de la app (registro en memoria: NO
//!    escribe el plist del usuario ni afecta otras apps).
//! 2. Setters de `NSTextCheckingClient` sobre la instancia de WKWebView, cada
//!    uno gateado por `respondsToSelector:` para no panickear si WebKit los
//!    renombra o los saca.
//!
//! Las dos capas se llaman por separado y en momentos distintos: se midió que
//! `WKWebView` no responde ninguno de los tres setters que gobiernan
//! autocorrección/spell-check (ver comentario en `apply_to_webviews`), así que
//! esas dos features dependen EXCLUSIVAMENTE de los `NSUserDefaults`
//! registrados acá. Si WebKit inicializa su text checker durante la
//! construcción de la `WKWebView` (que Tauri crea antes de que corra
//! `.setup()`), un registro tardío llega después de que WebKit ya leyó el
//! valor por default. Por eso `register_defaults_early` se llama como primera
//! sentencia de `run()`, antes de `tauri::Builder::default()` — `apply_to_webviews`
//! sigue viviendo en `.setup()` porque necesita la ventana ya creada.

#[cfg(not(target_os = "macos"))]
pub fn register_defaults_early() {}

#[cfg(not(target_os = "macos"))]
pub fn apply_to_webviews(_app: &tauri::AppHandle) {}

/// Primera sentencia de `run()`, antes de `tauri::Builder::default()`: no
/// necesita `AppHandle` ni `NSApplication`, así que puede correr antes de que
/// Tauri arme nada. No-op real en plataformas que no son macOS.
#[cfg(target_os = "macos")]
pub fn register_defaults_early() {
    register_defaults();
}

/// Claves de `NSUserDefaults` que gobiernan las sustituciones automáticas.
/// Las `NS*` son las de AppKit; las `Web*` las lee WebKit para el corrector
/// dentro de la webview.
#[cfg(target_os = "macos")]
const DEFAULT_KEYS: &[&str] = &[
    "NSAutomaticQuoteSubstitutionEnabled",
    "NSAutomaticDashSubstitutionEnabled",
    "NSAutomaticTextReplacementEnabled",
    "NSAutomaticSpellingCorrectionEnabled",
    "NSAutomaticPeriodSubstitutionEnabled",
    "NSAutomaticCapitalizationEnabled",
    "WebContinuousSpellCheckingEnabled",
    "WebAutomaticSpellingCorrectionEnabled",
];

#[cfg(target_os = "macos")]
fn register_defaults() {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

    let keys: Vec<objc2::rc::Retained<NSString>> =
        DEFAULT_KEYS.iter().map(|k| NSString::from_str(k)).collect();
    let values: Vec<objc2::rc::Retained<NSNumber>> =
        DEFAULT_KEYS.iter().map(|_| NSNumber::new_bool(false)).collect();

    let key_refs: Vec<&NSString> = keys.iter().map(|k| k.as_ref()).collect();
    // `registerDefaults:` pide `NSDictionary<NSString, AnyObject>` (el tipo
    // default de `NSDictionary`), así que subimos cada `NSNumber` a
    // `AnyObject` antes de armar el diccionario en vez de dejar que
    // `from_slices` infiera `ObjectType = NSNumber`.
    let value_refs: Vec<&AnyObject> = values.iter().map(|v| v.as_ref()).collect();

    // `from_slices` y `standardUserDefaults` son funciones safe (crean
    // temporales autoreleased, de ahí el pool); el único punto inseguro real
    // es la llamada a `registerDefaults:` de abajo.
    autoreleasepool(|_| {
        let dict = NSDictionary::from_slices(&key_refs, &value_refs);
        let defaults = NSUserDefaults::standardUserDefaults();
        // SAFETY: `dict` es un `NSDictionary<NSString, AnyObject>` con
        // valores `NSNumber` — el tipo exacto que `registerDefaults:` espera
        // recibir. Vive hasta el final de esta llamada (se dropea al salir
        // del autoreleasepool) y `registerDefaults:` copia su contenido en
        // vez de retener la referencia, así que no hay aliasing ni
        // use-after-free posible.
        unsafe { defaults.registerDefaults(dict.as_ref()) };
    });
    tracing::info!(target: "boot", keys = DEFAULT_KEYS.len(), "sustituciones nativas macOS: defaults registrados");
}

/// Setters de sustitución/corrección sobre la instancia de WKWebView.
/// `respondsToSelector:` gatea cada uno para no panickear si WebKit los
/// renombra o los saca en alguna versión.
#[cfg(target_os = "macos")]
pub fn apply_to_webviews(app: &tauri::AppHandle) {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!(target: "boot", "no encontré la ventana 'main' para apagar sustituciones");
        return;
    };
    let r = window.with_webview(|webview| {
        let wv = webview.inner() as *mut AnyObject;
        if wv.is_null() {
            tracing::warn!(target: "boot", "WKWebView nula, no pude aplicar setters de sustitución");
            return;
        }

        // Un `msg_send!` tipado por selector, cada uno gateado por
        // `respondsToSelector:` (con `sel!`, que exige literales — de ahí
        // la macro local en vez de iterar sobre `&[&str]`). Preferido por
        // sobre `performSelector:withObject:`, que es frágil para pasar
        // el `BOOL` del setter. Sin `autoreleasepool` acá: los 6 `msg_send!`
        // de abajo devuelven `()` (setters `void`), no generan objetos
        // autoreleased — el pool que importa es el de `register_defaults`.
        //
        // `applied`/`skipped` acumulan los nombres para el resumen final:
        // en macOS 15+ solo 3 de los 6 selectores existen en `WKWebView`
        // (`setAutomaticSpellingCorrectionEnabled:`,
        // `setContinuousSpellCheckingEnabled:` y
        // `setSmartInsertDeleteEnabled:` son API de `NSTextView`, no de
        // `WKWebView`), así que el salteo de la mitad es el caso normal,
        // no una falla — pero tiene que quedar visible en el log de boot
        // sin depender de `RUST_LOG` custom.
        let mut applied: Vec<&'static str> = Vec::new();
        let mut skipped: Vec<&'static str> = Vec::new();

        macro_rules! apply_setter {
            ($sel:ident : $value:expr) => {{
                let name: &'static str = concat!(stringify!($sel), ":");
                unsafe {
                    let responds: bool = msg_send![wv, respondsToSelector: sel!($sel:)];
                    if responds {
                        let _: () = msg_send![wv, $sel: $value];
                        applied.push(name);
                    } else {
                        tracing::debug!(
                            target: "boot",
                            selector = name,
                            "WKWebView no responde, salteado"
                        );
                        skipped.push(name);
                    }
                }
            }};
        }

        apply_setter!(setAutomaticQuoteSubstitutionEnabled: false);
        apply_setter!(setAutomaticDashSubstitutionEnabled: false);
        apply_setter!(setAutomaticTextReplacementEnabled: false);
        apply_setter!(setAutomaticSpellingCorrectionEnabled: false);
        apply_setter!(setContinuousSpellCheckingEnabled: false);
        apply_setter!(setSmartInsertDeleteEnabled: false);

        // Resumen a nivel `info`/`warn` (no `debug`) para que salga con
        // el filtro por default del repo (`debug_bridge.rs`, que suma
        // `boot=info` justo para esto). El log por-selector de arriba
        // queda en `debug` para quien corra con `RUST_LOG` custom.
        if skipped.is_empty() {
            tracing::info!(
                target: "boot",
                "setters de WKWebView: {}/6 aplicados ({})",
                applied.len(),
                applied.join(", ")
            );
        } else {
            tracing::warn!(
                target: "boot",
                "setters de WKWebView: {}/6 aplicados ({}) — {} no existen en esta versión de WebKit y se saltearon ({})",
                applied.len(),
                applied.join(", "),
                skipped.len(),
                skipped.join(", ")
            );
        }
    });
    if let Err(e) = r {
        tracing::warn!(target: "boot", error = %e, "with_webview falló");
    }
}
