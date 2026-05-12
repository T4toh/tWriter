use rfd::AsyncFileDialog;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

fn apply_common<'a>(
    mut d: AsyncFileDialog,
    title: Option<&'a str>,
    default_path: Option<&'a str>,
) -> AsyncFileDialog {
    if let Some(t) = title {
        d = d.set_title(t);
    }
    if let Some(p) = default_path {
        if !p.is_empty() {
            d = d.set_directory(p);
        }
    }
    d
}

#[tauri::command]
pub async fn pick_folder(
    title: Option<String>,
    default_path: Option<String>,
) -> Option<String> {
    let dialog = apply_common(AsyncFileDialog::new(), title.as_deref(), default_path.as_deref());
    let picked = dialog
        .pick_folder()
        .await
        .map(|h| h.path().to_string_lossy().into_owned());
    match &picked {
        Some(p) => tracing::info!(target: "dialog", path = %p, "pick_folder elegido"),
        None => tracing::info!(target: "dialog", "pick_folder cancelado"),
    }
    picked
}

#[tauri::command]
pub async fn pick_file(
    title: Option<String>,
    default_path: Option<String>,
    filters: Option<Vec<FileFilter>>,
    multiple: Option<bool>,
) -> Vec<String> {
    let mut dialog = apply_common(AsyncFileDialog::new(), title.as_deref(), default_path.as_deref());
    if let Some(fs) = filters.as_ref() {
        for f in fs {
            let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter(&f.name, &exts);
        }
    }
    let picked: Vec<String> = if multiple.unwrap_or(false) {
        dialog
            .pick_files()
            .await
            .map(|v| v.into_iter().map(|h| h.path().to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    } else {
        dialog
            .pick_file()
            .await
            .map(|h| vec![h.path().to_string_lossy().into_owned()])
            .unwrap_or_default()
    };
    if picked.is_empty() {
        tracing::info!(target: "dialog", "pick_file cancelado");
    } else {
        tracing::info!(target: "dialog", count = picked.len(), "pick_file elegido");
    }
    picked
}
