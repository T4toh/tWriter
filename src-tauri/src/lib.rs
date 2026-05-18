mod audit;
mod book_config;
mod create;
mod debug_bridge;
mod demo_template;
mod dialogs;
mod epub;
mod extras;
mod fonts;
mod fs;
mod git;
mod grammar;
mod image;
mod import;
mod import_notes;
mod import_wizard;
mod notes;
mod reorder;
mod saga_config;
mod search;
mod secrets;
mod settings;
mod split_chapter;
mod stats;
mod storage;
mod system_fonts;
mod theme;
mod themes;
mod util;

use audit::list_chapters_for_audit;
use book_config::{get_book_config, mark_as_epilogo, set_book_config};
use saga_config::{find_saga_dir, get_saga_config, set_saga_config};
use create::{create_book, create_chapter, create_directory};
use demo_template::generate_demo_template;
use dialogs::{pick_file, pick_folder};
use epub::{export_book, list_exports};
use extras::{add_extra, has_extras, list_extras, remove_extra, rename_extra};
use fonts::{add_font, consolidate_fonts, has_fonts, list_fonts, remove_font, rename_font};
use fs::{
    get_tree, is_directory_excluded, read_chapter, read_meta, rename_node, set_directory_excluded,
    write_chapter, write_meta,
};
use git::{
    git_commit_all, git_ensure_twriter_ignored, git_pull, git_pull_rebase, git_push, git_status,
};
use grammar::{
    check_grammar, check_grammar_available, languagetool_docker_start, languagetool_docker_status,
    languagetool_docker_stop,
};
use image::read_image;
use import::{delete_chapter_file, delete_directory, import_chapter};
use import_notes::{joplin_import_apply, joplin_scan};
use import_wizard::{import_wizard_apply, scan_import_source};
use notes::{create_folder, create_note, delete_note, read_note, write_note};
use reorder::{move_node, relocate_node};
use search::{search_query, search_reindex};
use secrets::{lt_api_key_save, lt_api_key_status};
use settings::{get_settings, set_settings};
use split_chapter::{split_chapter_apply, split_chapter_preview};
use stats::write_chapter_stats;
use storage::detect_storage_backend;
use system_fonts::{list_system_fonts, refresh_system_fonts};
use themes::{
    add_theme_font, create_theme, delete_theme, duplicate_theme, get_chapter_theme_fonts,
    get_theme, list_font_usage, list_theme_fonts, list_themes, remove_theme_font, rename_theme,
    rename_theme_font, set_theme,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    debug_bridge::init_tracing();
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            debug_bridge::set_app_handle(handle.clone());
            tracing::info!(target: "boot", "tWriter listo");
            // Auto-init search index si hay root configurado. Best-effort.
            tauri::async_runtime::spawn(async move {
                let cfg = match settings::get_settings(handle.clone()) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(target: "search", error = %e, "no pude leer settings al boot");
                        return;
                    }
                };
                let Some(root) = cfg.root else { return; };
                let handle_for_blocking = handle.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    let mut emit_cb = move |p: search::ReindexProgress| {
                        let _ = tauri::Emitter::emit(&handle_for_blocking, "search-reindex-progress", p);
                    };
                    let r = std::path::PathBuf::from(&root);
                    if let Err(e) = search::full_reindex(&r, Some(&mut emit_cb)) {
                        tracing::warn!(target: "search", error = %e, "reindex boot falló");
                    }
                })
                .await;
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_tree,
            read_chapter,
            write_chapter,
            read_meta,
            write_meta,
            write_chapter_stats,
            rename_node,
            get_settings,
            set_settings,
            git_status,
            git_commit_all,
            git_push,
            git_pull,
            git_pull_rebase,
            git_ensure_twriter_ignored,
            detect_storage_backend,
            import_chapter,
            delete_chapter_file,
            delete_directory,
            create_chapter,
            create_directory,
            create_book,
            read_note,
            write_note,
            create_note,
            create_folder,
            delete_note,
            move_node,
            relocate_node,
            export_book,
            list_exports,
            get_book_config,
            set_book_config,
            mark_as_epilogo,
            get_saga_config,
            set_saga_config,
            find_saga_dir,
            read_image,
            check_grammar,
            check_grammar_available,
            list_chapters_for_audit,
            languagetool_docker_status,
            languagetool_docker_start,
            languagetool_docker_stop,
            is_directory_excluded,
            set_directory_excluded,
            scan_import_source,
            import_wizard_apply,
            split_chapter_preview,
            split_chapter_apply,
            generate_demo_template,
            list_extras,
            has_extras,
            add_extra,
            remove_extra,
            rename_extra,
            list_fonts,
            has_fonts,
            add_font,
            remove_font,
            rename_font,
            consolidate_fonts,
            list_system_fonts,
            refresh_system_fonts,
            list_themes,
            get_theme,
            get_chapter_theme_fonts,
            set_theme,
            create_theme,
            rename_theme,
            duplicate_theme,
            delete_theme,
            list_theme_fonts,
            add_theme_font,
            remove_theme_font,
            rename_theme_font,
            list_font_usage,
            pick_folder,
            pick_file,
            search_query,
            search_reindex,
            joplin_scan,
            joplin_import_apply,
            lt_api_key_status,
            lt_api_key_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
