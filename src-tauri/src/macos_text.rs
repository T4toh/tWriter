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

#[cfg(not(target_os = "macos"))]
pub fn disable_native_text_substitutions(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
pub fn disable_native_text_substitutions(app: &tauri::AppHandle) {
    register_defaults();
    apply_to_webviews(app);
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

    unsafe {
        let dict = NSDictionary::from_slices(&key_refs, &value_refs);
        let defaults = NSUserDefaults::standardUserDefaults();
        defaults.registerDefaults(dict.as_ref());
    }
    tracing::info!(target: "boot", keys = DEFAULT_KEYS.len(), "sustituciones nativas macOS: defaults registrados");
}

/// Setters de sustitución/corrección sobre la instancia de WKWebView.
/// `respondsToSelector:` gatea cada uno para no panickear si WebKit los
/// renombra o los saca en alguna versión.
#[cfg(target_os = "macos")]
fn apply_to_webviews(app: &tauri::AppHandle) {
    use objc2::rc::autoreleasepool;
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

        autoreleasepool(|_| {
            // Un `msg_send!` tipado por selector, cada uno gateado por
            // `respondsToSelector:` (con `sel!`, que exige literales — de ahí
            // la macro local en vez de iterar sobre `&[&str]`). Preferido por
            // sobre `performSelector:withObject:`, que es frágil para pasar
            // el `BOOL` del setter.
            macro_rules! apply_setter {
                ($sel:ident : $value:expr) => {{
                    unsafe {
                        let responds: bool = msg_send![wv, respondsToSelector: sel!($sel:)];
                        if responds {
                            let _: () = msg_send![wv, $sel: $value];
                        } else {
                            tracing::debug!(
                                target: "boot",
                                selector = concat!(stringify!($sel), ":"),
                                "WKWebView no responde, salteado"
                            );
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
        });
    });
    if let Err(e) = r {
        tracing::warn!(target: "boot", error = %e, "with_webview falló");
    }
}
