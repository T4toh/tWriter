use git2::{BranchType, IndexAddOption, Repository, Signature, StatusOptions};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GitStatus {
    pub has_changes: bool,
    pub changed: u32,
    pub ahead: u32,
    pub behind: u32,
    pub branch: Option<String>,
    pub remote: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct GitCommitResult {
    pub committed: bool,
    pub oid: Option<String>,
    pub files: u32,
}

// ─────────────── Tauri commands (async, offload a thread pool) ───────────────

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatus, String> {
    run_blocking(move || git_status_impl(&repo_path)).await
}

#[tauri::command]
pub async fn git_commit_all(
    repo_path: String,
    message: String,
) -> Result<GitCommitResult, String> {
    run_blocking(move || git_commit_all_impl(&repo_path, &message)).await
}

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<(), String> {
    run_blocking(move || git_push_impl(&repo_path)).await
}

#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<(), String> {
    run_blocking(move || git_pull_impl(&repo_path)).await
}

async fn run_blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("task: {}", e))?
}

// ─────────────── Implementaciones bloqueantes ───────────────

fn git_status_impl(repo_path: &str) -> Result<GitStatus, String> {
    let repo = open_repo(repo_path)?;
    status_for(&repo)
}

fn git_commit_all_impl(repo_path: &str, message: &str) -> Result<GitCommitResult, String> {
    let repo = open_repo(repo_path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;

    let st = status_for(&repo)?;
    if !st.has_changes {
        return Ok(GitCommitResult {
            committed: false,
            oid: None,
            files: 0,
        });
    }

    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let sig = signature(&repo)?;

    let parent_commit = match repo.head() {
        Ok(head) => Some(head.peel_to_commit().map_err(|e| e.to_string())?),
        Err(_) => None,
    };
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| {
            tracing::error!(target: "git", error = %e, "commit falló");
            e.to_string()
        })?;

    let oid_str = oid.to_string();
    let short: String = oid_str.chars().take(7).collect();
    tracing::info!(target: "git", files = st.changed, oid = %short, "commit creado");
    Ok(GitCommitResult {
        committed: true,
        oid: Some(oid_str),
        files: st.changed,
    })
}

/// Push usando el binario `git` del sistema. Hereda SSH config + agent + askpass.
/// libgit2/libssh2 falla seguido con "Failed getting response; class=Ssh"; el CLI siempre anda.
fn git_push_impl(repo_path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["push"])
        .output()
        .map_err(|e| {
            tracing::error!(target: "git", error = %e, "no se pudo lanzar git push");
            format!("no se pudo ejecutar git: {}", e)
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("push falló (exit {})", output.status)
        } else {
            stderr
        };
        tracing::error!(target: "git", error = %msg, "push falló");
        return Err(msg);
    }
    tracing::info!(target: "git", "push ok");
    Ok(())
}

fn git_pull_impl(repo_path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["pull", "--ff-only"])
        .output()
        .map_err(|e| {
            tracing::error!(target: "git", error = %e, "no se pudo lanzar git pull");
            format!("no se pudo ejecutar git: {}", e)
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("pull falló (exit {})", output.status)
        } else {
            stderr
        };
        tracing::error!(target: "git", error = %msg, "pull falló");
        return Err(msg);
    }
    tracing::info!(target: "git", "pull --ff-only ok");
    Ok(())
}

// ─────────────── Helpers ───────────────

fn open_repo(path: &str) -> Result<Repository, String> {
    let p = PathBuf::from(path);
    Repository::discover(&p).map_err(|e| format!("no es un repo git ({}): {}", path, e))
}

fn status_for(repo: &Repository) -> Result<GitStatus, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let changed = statuses.len() as u32;

    let head = repo.head().ok();
    let branch = head.as_ref().and_then(|h| h.shorthand()).map(String::from);

    let (ahead, behind, remote) = match branch.as_deref() {
        Some(name) => {
            let local_branch = repo.find_branch(name, BranchType::Local).ok();
            match local_branch.as_ref().and_then(|b| b.upstream().ok()) {
                Some(upstream) => {
                    let local_oid = local_branch
                        .as_ref()
                        .and_then(|b| b.get().target())
                        .unwrap_or_else(git2::Oid::zero);
                    let upstream_oid = upstream.get().target().unwrap_or_else(git2::Oid::zero);
                    let (a, b) = repo
                        .graph_ahead_behind(local_oid, upstream_oid)
                        .unwrap_or((0, 0));
                    let r = remote_for_branch(repo, name).ok();
                    (a as u32, b as u32, r)
                }
                None => (0, 0, None),
            }
        }
        None => (0, 0, None),
    };

    Ok(GitStatus {
        has_changes: changed > 0,
        changed,
        ahead,
        behind,
        branch,
        remote,
    })
}

fn remote_for_branch(repo: &Repository, branch_name: &str) -> Result<String, String> {
    let upstream_name = format!("branch.{}.remote", branch_name);
    let cfg = repo.config().map_err(|e| e.to_string())?;
    cfg.get_string(&upstream_name)
        .or_else(|_| Ok::<String, String>("origin".to_string()))
}

fn signature(repo: &Repository) -> Result<Signature<'static>, String> {
    repo.signature()
        .or_else(|_| Signature::now("tWriter", "twriter@local"))
        .map_err(|e| e.to_string())
}
