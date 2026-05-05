mod fs;

use fs::{get_tree, read_chapter, read_meta, write_chapter, write_meta};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_tree,
            read_chapter,
            write_chapter,
            read_meta,
            write_meta,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
