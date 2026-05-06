mod create;
mod fs;
mod git;
mod import;
mod reorder;
mod settings;

use create::{create_chapter, create_directory};
use fs::{get_tree, read_chapter, read_meta, write_chapter, write_meta};
use git::{git_commit_all, git_pull, git_push, git_status};
use import::{delete_chapter_file, delete_directory, import_chapter};
use reorder::move_node;
use settings::{get_settings, set_settings};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_tree,
            read_chapter,
            write_chapter,
            read_meta,
            write_meta,
            get_settings,
            set_settings,
            git_status,
            git_commit_all,
            git_push,
            git_pull,
            import_chapter,
            delete_chapter_file,
            delete_directory,
            create_chapter,
            create_directory,
            move_node,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
