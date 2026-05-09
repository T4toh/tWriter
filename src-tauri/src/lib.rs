mod book_config;
mod create;
mod epub;
mod extras;
mod fs;
mod git;
mod grammar;
mod image;
mod import;
mod import_wizard;
mod reorder;
mod saga_config;
mod settings;

use book_config::{get_book_config, set_book_config};
use saga_config::{find_saga_dir, get_saga_config, set_saga_config};
use create::{create_chapter, create_directory};
use epub::export_book;
use extras::{add_extra, has_extras, list_extras, remove_extra, rename_extra};
use fs::{
    get_tree, is_directory_excluded, read_chapter, read_meta, set_directory_excluded,
    write_chapter, write_meta,
};
use git::{git_commit_all, git_pull, git_push, git_status};
use grammar::{
    check_grammar, check_grammar_available, languagetool_docker_start, languagetool_docker_status,
    languagetool_docker_stop,
};
use image::read_image;
use import::{delete_chapter_file, delete_directory, import_chapter};
use import_wizard::{import_wizard_apply, scan_import_source};
use reorder::move_node;
use settings::{get_settings, set_settings};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            export_book,
            get_book_config,
            set_book_config,
            get_saga_config,
            set_saga_config,
            find_saga_dir,
            read_image,
            check_grammar,
            check_grammar_available,
            languagetool_docker_status,
            languagetool_docker_start,
            languagetool_docker_stop,
            is_directory_excluded,
            set_directory_excluded,
            scan_import_source,
            import_wizard_apply,
            list_extras,
            has_extras,
            add_extra,
            remove_extra,
            rename_extra,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
