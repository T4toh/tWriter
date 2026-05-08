// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // linuxdeploy-plugin-gtk's AppRun hook forces GDK_BACKEND=x11 as a
        // legacy workaround (tauri-apps/tauri#8541). On modern Wayland hosts
        // (Arch / CachyOS / Plasma 6) X11 backend crashes EGL with
        // EGL_BAD_PARAMETER. If a Wayland session is detected, override.
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            std::env::set_var("GDK_BACKEND", "wayland");
        }
    }
    twriter_lib::run()
}
