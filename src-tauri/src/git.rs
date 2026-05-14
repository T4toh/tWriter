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

/// Classify git CLI stderr into a category prefix so the frontend can map
/// it to a friendly Spanish message. Order matters: `rejected` must beat
/// `conflict` because the rejected-push hint includes the word "conflict"
/// in some locales, and `auth` must beat `network` because some auth errors
/// also mention "unable to access".
fn categorize_git_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    let category = if s.contains("permission denied")
        || s.contains("authentication failed")
        || s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("publickey")
    {
        "auth"
    } else if s.contains("[rejected]")
        || s.contains("non-fast-forward")
        || s.contains("fetch first")
        || s.contains("updates were rejected")
    {
        "rejected"
    } else if s.contains("conflict")
        || s.contains("could not apply")
        || s.contains("resolve all conflicts")
    {
        "conflict"
    } else if s.contains("could not resolve host")
        || s.contains("connection refused")
        || s.contains("operation timed out")
        || s.contains("unable to access")
        || s.contains("network is unreachable")
    {
        "network"
    } else {
        "unknown"
    };
    format!("{}: {}", category, stderr)
}

fn signature(repo: &Repository) -> Result<Signature<'static>, String> {
    repo.signature()
        .or_else(|_| Signature::now("tWriter", "twriter@local"))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorize_auth_errors() {
        assert_eq!(
            categorize_git_error("Permission denied (publickey)."),
            "auth: Permission denied (publickey)."
        );
        assert_eq!(
            categorize_git_error("fatal: Authentication failed for 'https://github.com/x.git'"),
            "auth: fatal: Authentication failed for 'https://github.com/x.git'"
        );
        assert_eq!(
            categorize_git_error("fatal: could not read Username for 'https://github.com'"),
            "auth: fatal: could not read Username for 'https://github.com'"
        );
    }

    #[test]
    fn categorize_network_errors() {
        assert_eq!(
            categorize_git_error(
                "fatal: unable to access 'https://github.com/x.git': Could not resolve host: github.com"
            ),
            "network: fatal: unable to access 'https://github.com/x.git': Could not resolve host: github.com"
        );
        assert_eq!(
            categorize_git_error("fatal: unable to access 'https://x.git': Connection refused"),
            "network: fatal: unable to access 'https://x.git': Connection refused"
        );
        assert_eq!(
            categorize_git_error("Operation timed out"),
            "network: Operation timed out"
        );
    }

    #[test]
    fn categorize_rejected_errors() {
        assert_eq!(
            categorize_git_error(
                " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs"
            ),
            "rejected:  ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs"
        );
        assert_eq!(
            categorize_git_error(
                "hint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. Integrate the remote changes (e.g.\nhint: 'git pull ...') before pushing again."
            ),
            "rejected: hint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. Integrate the remote changes (e.g.\nhint: 'git pull ...') before pushing again."
        );
    }

    #[test]
    fn categorize_conflict_errors() {
        assert_eq!(
            categorize_git_error("CONFLICT (content): Merge conflict in cap1.html"),
            "conflict: CONFLICT (content): Merge conflict in cap1.html"
        );
        assert_eq!(
            categorize_git_error(
                "error: could not apply abc123... message\nhint: Resolve all conflicts manually"
            ),
            "conflict: error: could not apply abc123... message\nhint: Resolve all conflicts manually"
        );
    }

    #[test]
    fn categorize_unknown_falls_through() {
        assert_eq!(
            categorize_git_error("fatal: random unknown thing"),
            "unknown: fatal: random unknown thing"
        );
        assert_eq!(categorize_git_error(""), "unknown: ");
    }
}
