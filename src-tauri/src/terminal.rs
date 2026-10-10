//! «Abrir en terminal» del modal de storage-help: abre una terminal del
//! sistema parada en la carpeta de la novela, para que el autor corra los
//! `git init` / `git push` de la guía sin tener que copiar el `cd`.

use std::path::Path;
use std::process::Command;

/// Terminales a probar en orden. `$TERMINAL` primero si está seteado (es la
/// convención en Linux para "la terminal del usuario"), después las de los
/// escritorios grandes y los emuladores sueltos. Todos arrancan en el cwd
/// del proceso, así que alcanza con `current_dir` y no hace falta el flag
/// de cada uno.
#[cfg(target_os = "linux")]
fn candidates() -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.trim().is_empty() {
            out.push((t, vec![]));
        }
    }
    for t in [
        "x-terminal-emulator",
        "konsole",
        "gnome-terminal",
        "kitty",
        "alacritty",
        "foot",
        "xfce4-terminal",
        "xterm",
    ] {
        out.push((t.to_string(), vec![]));
    }
    out
}

#[cfg(target_os = "macos")]
fn candidates() -> Vec<(String, Vec<String>)> {
    vec![("open".into(), vec!["-a".into(), "Terminal".into(), ".".into()])]
}

#[cfg(target_os = "windows")]
fn candidates() -> Vec<(String, Vec<String>)> {
    vec![
        ("wt".into(), vec!["-d".into(), ".".into()]),
        ("cmd".into(), vec!["/C".into(), "start".into(), "cmd".into()]),
    ]
}

fn open_in(dir: &Path) -> Result<String, String> {
    if !dir.is_dir() {
        return Err(format!("no es una carpeta: {}", dir.display()));
    }
    let mut last = String::new();
    for (bin, args) in candidates() {
        match Command::new(&bin).args(&args).current_dir(dir).spawn() {
            Ok(_) => return Ok(bin),
            Err(e) => last = format!("{bin}: {e}"),
        }
    }
    Err(format!("no encontré ninguna terminal ({last})"))
}

#[tauri::command]
pub fn open_terminal(dir: String) -> Result<String, String> {
    open_in(Path::new(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Los tests que tocan `$TERMINAL` corren en serie.
    static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn rechaza_un_path_que_no_es_carpeta() {
        let tmp = std::env::temp_dir().join("twriter-terminal-no-existe");
        let err = open_in(&tmp).unwrap_err();
        assert!(err.contains("no es una carpeta"), "{err}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn abre_la_primera_terminal_que_arranca() {
        let _g = ENV.lock().unwrap();
        // `/bin/true` hace de terminal: arranca y sale. Prueba el spawn real
        // con `current_dir`, que es lo único que no cubre la lista.
        std::env::set_var("TERMINAL", "/bin/true");
        let ok = open_in(&std::env::temp_dir()).unwrap();
        std::env::remove_var("TERMINAL");
        assert_eq!(ok, "/bin/true");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn terminal_del_usuario_va_primero_y_si_no_hay_cae_a_la_lista() {
        let _g = ENV.lock().unwrap();
        // Sin $TERMINAL la lista arranca con x-terminal-emulator.
        std::env::remove_var("TERMINAL");
        assert_eq!(candidates()[0].0, "x-terminal-emulator");
        // Con $TERMINAL esa va primero y el resto queda atrás.
        std::env::set_var("TERMINAL", "mi-term");
        let c = candidates();
        assert_eq!(c[0].0, "mi-term");
        assert_eq!(c[1].0, "x-terminal-emulator");
        std::env::remove_var("TERMINAL");
    }
}
