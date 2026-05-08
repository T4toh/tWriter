// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // linuxdeploy-plugin-gtk's AppRun hook forces GDK_BACKEND=x11 as a
        // legacy workaround (tauri-apps/tauri#8541). On modern Wayland hosts
        // (Arch / CachyOS / Plasma 6) that crashes EGL with EGL_BAD_PARAMETER
        // before the window can render. If we detect a Wayland session,
        // override back to wayland.
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            std::env::set_var("GDK_BACKEND", "wayland");
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    twriter_lib::run()
}
