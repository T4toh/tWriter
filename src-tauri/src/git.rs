use git2::{BranchType, Delta, IndexAddOption, Oid, Repository, Signature, StatusOptions};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

/// Timeout default para ops git locales (status, rev-parse, etc.).
const RUN_GIT_DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout para ops git que tocan la red (push/pull/fetch).
const RUN_GIT_NET_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GitStatus {
    pub has_changes: bool,
    pub changed: u32,
    pub ahead: u32,
    pub behind: u32,
    pub branch: Option<String>,
    pub remote: Option<String>,
    /// Lista detallada de archivos cambiados. El frontend agrupa pares
    /// `<n>.html` + `<n>.meta.json` para mostrar "1 capítulo" en vez de
    /// "2 archivos". Cap a 500 entradas para no inflar el IPC en repos
    /// monstruosos (raro pero defensivo).
    pub paths: Vec<GitStatusPath>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GitStatusPath {
    pub path: String,
    /// `new` | `modified` | `deleted` | `renamed` | `typechange` | `conflicted`
    pub kind: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct GitCommitResult {
    pub committed: bool,
    pub oid: Option<String>,
    pub files: u32,
}

#[derive(Serialize, Debug, Clone)]
pub struct PullPathChange {
    pub path: String,
    pub kind: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct EnsureResult {
    pub gitignore_updated: bool,
    pub untracked_files: u32,
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
pub async fn git_pull(repo_path: String) -> Result<Vec<PullPathChange>, String> {
    run_blocking(move || git_pull_impl(&repo_path)).await
}

#[tauri::command]
pub async fn git_pull_rebase(repo_path: String) -> Result<Vec<PullPathChange>, String> {
    run_blocking(move || git_pull_rebase_impl(&repo_path)).await
}

#[tauri::command]
pub async fn git_ensure_twriter_ignored(repo_path: String) -> Result<EnsureResult, String> {
    run_blocking(move || git_ensure_twriter_ignored_impl(&repo_path)).await
}

#[tauri::command]
pub async fn git_fetch(repo_path: String) -> Result<(), String> {
    run_blocking(move || git_fetch_impl(&repo_path)).await
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
///
/// Si el push es rechazado por non-fast-forward (otra PC pusheó primero),
/// corre `git pull --rebase --autostash` y reintenta una vez. Si el rebase
/// produce conflictos, lo aborta y retorna `conflict: ...` para que la UI
/// muestre un mensaje claro. Cualquier otro error se categoriza
/// (`auth:`, `network:`, `unknown:`) vía `categorize_git_error`.
pub(crate) fn git_push_impl(repo_path: &str) -> Result<(), String> {
    let first = run_git_net(repo_path, &["push"])?;
    if first.success {
        tracing::info!(target: "git", "push ok");
        return Ok(());
    }
    if !is_rejected(&first.stderr) {
        let msg = categorize_git_error(&first.stderr);
        tracing::error!(target: "git", error = %msg, "push falló");
        return Err(msg);
    }
    tracing::warn!(target: "git", "push rechazado (non-FF), intentando pull --rebase --autostash");
    if let Err(msg) = git_pull_rebase_impl(repo_path) {
        tracing::error!(target: "git", action = "push.rebase_conflict", error = %msg, "pull --rebase falló");
        return Err(msg);
    }
    tracing::info!(target: "git", action = "push.pull_rebase_ok", "rebase ok, reintentando push");
    let retry = run_git_net(repo_path, &["push"])?;
    if !retry.success {
        let msg = categorize_git_error(&retry.stderr);
        tracing::error!(target: "git", action = "push.retry_failed", error = %msg, "retry de push falló");
        return Err(msg);
    }
    tracing::info!(target: "git", action = "push.retry_ok", "push ok tras rebase");
    Ok(())
}

struct GitOutput {
    success: bool,
    stderr: String,
    #[allow(dead_code)]
    stdout: String,
}

fn run_git(cwd: &str, args: &[&str]) -> Result<GitOutput, String> {
    run_git_with_timeout(cwd, args, RUN_GIT_DEFAULT_TIMEOUT)
}

/// Variante para ops que tocan la red — timeout más largo.
fn run_git_net(cwd: &str, args: &[&str]) -> Result<GitOutput, String> {
    run_git_with_timeout(cwd, args, RUN_GIT_NET_TIMEOUT)
}

fn run_git_with_timeout(cwd: &str, args: &[&str], timeout: Duration) -> Result<GitOutput, String> {
    // Hardening contra cuelgues sin TTY:
    // - GIT_TERMINAL_PROMPT=0: nunca pide credenciales por prompt.
    // - GIT_SSH_COMMAND: BatchMode + ConnectTimeout cortos para que SSH falle
    //   rápido si no hay agent / no hay red. accept-new evita el prompt de
    //   host key en la primera conexión.
    let mut child = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new",
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            tracing::error!(target: "git", error = %e, "no se pudo lanzar git");
            format!("no se pudo ejecutar git: {}", e)
        })?;

    match child.wait_timeout(timeout).map_err(|e| {
        tracing::error!(target: "git", error = %e, "wait_timeout falló");
        format!("wait_timeout: {}", e)
    })? {
        Some(_) => {
            // Terminó dentro del timeout; recolectar stdout/stderr.
            let out = child.wait_with_output().map_err(|e| {
                tracing::error!(target: "git", error = %e, "wait_with_output falló");
                format!("wait_with_output: {}", e)
            })?;
            Ok(GitOutput {
                success: out.status.success(),
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
                stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
            })
        }
        None => {
            // Timeout: matar el child para no dejar zombies.
            let _ = child.kill();
            let _ = child.wait();
            let secs = timeout.as_secs();
            tracing::error!(target: "git", args = ?args, secs, "git timeout");
            Err(format!(
                "network: git command timed out after {}s",
                secs
            ))
        }
    }
}

fn is_rejected(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("[rejected]")
        || s.contains("non-fast-forward")
        || s.contains("fetch first")
        || s.contains("updates were rejected")
}

fn current_branch_name(repo_path: &str) -> Option<String> {
    let out = run_git(repo_path, &["symbolic-ref", "--short", "HEAD"]).ok()?;
    if out.success && !out.stdout.is_empty() {
        Some(out.stdout)
    } else {
        None
    }
}

fn has_upstream(repo_path: &str) -> bool {
    run_git(repo_path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .map(|o| o.success)
        .unwrap_or(false)
}

fn set_upstream(repo_path: &str, branch: &str) {
    let upstream = format!("origin/{}", branch);
    let res = run_git(
        repo_path,
        &["branch", "--set-upstream-to", &upstream, branch],
    );
    match res {
        Ok(out) if out.success => {
            tracing::info!(target: "git", branch, upstream = %upstream, "upstream seteado");
        }
        Ok(out) => {
            tracing::warn!(target: "git", error = %out.stderr, "no se pudo setear upstream");
        }
        Err(e) => {
            tracing::warn!(target: "git", error = %e, "no se pudo setear upstream");
        }
    }
}

fn git_pull_impl(repo_path: &str) -> Result<Vec<PullPathChange>, String> {
    let pre_oid = head_oid(repo_path);
    let branch = current_branch_name(repo_path);
    let needs_upstream = branch.is_some() && !has_upstream(repo_path);

    let mut args: Vec<&str> = vec!["pull", "--ff-only"];
    if needs_upstream {
        args.push("origin");
        args.push(branch.as_deref().unwrap());
    }

    let out = run_git_net(repo_path, &args)?;
    if !out.success {
        let msg = if out.stderr.is_empty() {
            "pull falló (sin stderr)".to_string()
        } else {
            categorize_git_error(&out.stderr)
        };
        tracing::error!(target: "git", error = %msg, "pull falló");
        return Err(msg);
    }
    if needs_upstream {
        if let Some(b) = branch.as_deref() {
            set_upstream(repo_path, b);
        }
    }
    tracing::info!(target: "git", "pull --ff-only ok");
    let post_oid = head_oid(repo_path);
    Ok(changed_paths_since(repo_path, pre_oid, post_oid))
}

pub(crate) fn git_ensure_twriter_ignored_impl(repo_path: &str) -> Result<EnsureResult, String> {
    let root = PathBuf::from(repo_path);
    let gi_path = root.join(".gitignore");
    let existing = std::fs::read_to_string(&gi_path).unwrap_or_default();
    let already_ignored = existing.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == ".twriter" || trimmed == ".twriter/"
    });
    let gitignore_updated = if !already_ignored {
        let mut new_content = existing.clone();
        if !new_content.is_empty() && !new_content.ends_with('\n') {
            new_content.push('\n');
        }
        if !new_content.is_empty() {
            new_content.push('\n');
        }
        new_content.push_str("# tWriter: índice de búsqueda local (se regenera al boot)\n");
        new_content.push_str(".twriter/\n");
        std::fs::write(&gi_path, new_content).map_err(|e| e.to_string())?;
        true
    } else {
        false
    };

    let ls = Command::new("git")
        .current_dir(&root)
        .args(["ls-files", ".twriter"])
        .output()
        .map_err(|e| format!("git ls-files: {}", e))?;
    let listed = String::from_utf8_lossy(&ls.stdout);
    let untracked_files: u32 = if ls.status.success() && !listed.trim().is_empty() {
        let count = listed.lines().count() as u32;
        let rm = Command::new("git")
            .current_dir(&root)
            .args(["rm", "-r", "--cached", ".twriter"])
            .output()
            .map_err(|e| format!("git rm --cached: {}", e))?;
        if !rm.status.success() {
            let stderr = String::from_utf8_lossy(&rm.stderr).to_string();
            tracing::warn!(target: "git", error = %stderr, "git rm --cached .twriter falló");
            return Err(format!("no se pudo destrackear .twriter/: {}", stderr));
        }
        count
    } else {
        0
    };

    if gitignore_updated || untracked_files > 0 {
        tracing::info!(
            target: "git",
            action = "twriter_cleanup",
            gitignore_updated,
            untracked_files,
            "limpieza de .twriter/ aplicada"
        );
    }
    Ok(EnsureResult {
        gitignore_updated,
        untracked_files,
    })
}

pub(crate) fn git_pull_rebase_impl(repo_path: &str) -> Result<Vec<PullPathChange>, String> {
    let pre_oid = head_oid(repo_path);
    let branch = current_branch_name(repo_path);
    let needs_upstream = branch.is_some() && !has_upstream(repo_path);

    let mut args: Vec<&str> = vec!["pull", "--rebase", "--autostash"];
    if needs_upstream {
        args.push("origin");
        args.push(branch.as_deref().unwrap());
    }

    let out = run_git_net(repo_path, &args)?;
    if out.success {
        if needs_upstream {
            if let Some(b) = branch.as_deref() {
                set_upstream(repo_path, b);
            }
        }
        tracing::info!(target: "git", "pull --rebase --autostash ok");
        let post_oid = head_oid(repo_path);
        return Ok(changed_paths_since(repo_path, pre_oid, post_oid));
    }
    let _ = run_git(repo_path, &["rebase", "--abort"]);
    let stderr_lc = out.stderr.to_lowercase();
    let msg = if stderr_lc.contains("conflict") || stderr_lc.contains("could not apply") {
        format!("conflict: {}", out.stderr)
    } else {
        categorize_git_error(&out.stderr)
    };
    tracing::error!(target: "git", error = %msg, "pull --rebase falló");
    Err(msg)
}

/// Fetch silencioso `git fetch --prune`. Devuelve error categorizado para
/// que el caller decida si loggear y seguir (best-effort) o mostrar al user.
pub(crate) fn git_fetch_impl(repo_path: &str) -> Result<(), String> {
    let out = run_git_net(repo_path, &["fetch", "--prune"])?;
    if out.success {
        tracing::debug!(target: "git", "fetch --prune ok");
        return Ok(());
    }
    let msg = if out.stderr.is_empty() {
        "fetch falló (sin stderr)".to_string()
    } else {
        categorize_git_error(&out.stderr)
    };
    tracing::warn!(target: "git", error = %msg, "fetch falló (best-effort)");
    Err(msg)
}

fn head_oid(repo_path: &str) -> Option<Oid> {
    let repo = Repository::open(repo_path).ok()?;
    let head = repo.head().ok()?;
    let commit = head.peel_to_commit().ok()?;
    Some(commit.id())
}

/// Devuelve los paths absolutos cambiados entre dos commits del repo. Si
/// alguno de los oids es None (repo recién inicializado, HEAD detached
/// inválido) o si son iguales, devuelve vec vacío. Errores intermedios se
/// logean y devuelven vec vacío — el caller trata el refresh como best-effort.
fn changed_paths_since(
    repo_path: &str,
    from_oid: Option<Oid>,
    to_oid: Option<Oid>,
) -> Vec<PullPathChange> {
    let (from, to) = match (from_oid, to_oid) {
        (Some(f), Some(t)) => (f, t),
        _ => return Vec::new(),
    };
    if from == to {
        return Vec::new();
    }
    let repo = match Repository::open(repo_path) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(target: "git", error = %e, "changed_paths: no se pudo abrir repo");
            return Vec::new();
        }
    };
    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => return Vec::new(),
    };
    let from_tree = match repo.find_commit(from).and_then(|c| c.tree()) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(target: "git", error = %e, "changed_paths: from_commit/tree falló");
            return Vec::new();
        }
    };
    let to_tree = match repo.find_commit(to).and_then(|c| c.tree()) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(target: "git", error = %e, "changed_paths: to_commit/tree falló");
            return Vec::new();
        }
    };
    let diff = match repo.diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(target: "git", error = %e, "changed_paths: diff falló");
            return Vec::new();
        }
    };
    let mut out: Vec<PullPathChange> = Vec::new();
    let _ = diff.foreach(
        &mut |delta, _| {
            let kind = match delta.status() {
                Delta::Added | Delta::Copied => "added",
                Delta::Deleted => "deleted",
                Delta::Modified | Delta::Typechange => "modified",
                Delta::Renamed => "renamed",
                _ => return true,
            };
            let rel = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path());
            if let Some(rel) = rel {
                let abs = workdir.join(rel);
                out.push(PullPathChange {
                    path: abs.to_string_lossy().into_owned(),
                    kind: kind.to_string(),
                });
            }
            true
        },
        None,
        None,
        None,
    );
    out
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
    let mut paths: Vec<GitStatusPath> = Vec::with_capacity(statuses.len().min(500));
    for entry in statuses.iter().take(500) {
        let Some(p) = entry.path() else { continue };
        paths.push(GitStatusPath {
            path: p.to_string(),
            kind: status_kind(entry.status()),
        });
    }

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
        paths,
    })
}

/// Mapea bits de `git2::Status` a una etiqueta corta para la UI. Si hay
/// múltiples bits (e.g. INDEX_MODIFIED + WT_MODIFIED), gana el más severo:
/// conflicted > deleted > renamed > new > typechange > modified.
fn status_kind(s: git2::Status) -> String {
    use git2::Status as S;
    let kind = if s.contains(S::CONFLICTED) {
        "conflicted"
    } else if s.contains(S::INDEX_DELETED) || s.contains(S::WT_DELETED) {
        "deleted"
    } else if s.contains(S::INDEX_RENAMED) || s.contains(S::WT_RENAMED) {
        "renamed"
    } else if s.contains(S::INDEX_NEW) || s.contains(S::WT_NEW) {
        "new"
    } else if s.contains(S::INDEX_TYPECHANGE) || s.contains(S::WT_TYPECHANGE) {
        "typechange"
    } else {
        "modified"
    };
    kind.to_string()
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
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    fn tempdir(label: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let suffix: u128 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("twriter-git-test-{}-{}", label, suffix));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn run(cwd: &PathBuf, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        if !out.status.success() {
            panic!(
                "git {:?} failed in {:?}: {}",
                args,
                cwd,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn setup_triple() -> (PathBuf, PathBuf, PathBuf) {
        let root = tempdir("triple");
        let origin = root.join("origin.git");
        fs::create_dir_all(&origin).unwrap();
        run(&origin, &["init", "--bare", "--initial-branch=main"]);
        let pc_a = root.join("pcA");
        run(
            &root,
            &["clone", origin.to_str().unwrap(), pc_a.to_str().unwrap()],
        );
        run(&pc_a, &["config", "user.email", "a@x"]);
        run(&pc_a, &["config", "user.name", "a"]);
        fs::write(pc_a.join("README.md"), "base\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["commit", "-m", "base"]);
        run(&pc_a, &["push", "-u", "origin", "main"]);
        let pc_b = root.join("pcB");
        run(
            &root,
            &["clone", origin.to_str().unwrap(), pc_b.to_str().unwrap()],
        );
        run(&pc_b, &["config", "user.email", "b@x"]);
        run(&pc_b, &["config", "user.name", "b"]);
        (origin, pc_a, pc_b)
    }

    #[test]
    fn push_auto_rebases_on_non_ff() {
        let (_origin, pc_a, pc_b) = setup_triple();
        fs::write(pc_a.join("a.txt"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["commit", "-m", "from A"]);
        run(&pc_a, &["push"]);
        fs::write(pc_b.join("b.txt"), "from B\n").unwrap();
        run(&pc_b, &["add", "."]);
        run(&pc_b, &["commit", "-m", "from B"]);
        git_push_impl(pc_b.to_str().unwrap()).expect("push should auto-rebase and succeed");
        assert!(
            pc_b.join("a.txt").exists(),
            "a.txt should be present after rebase"
        );
        assert!(pc_b.join("b.txt").exists());
    }

    #[test]
    fn pull_rebase_succeeds_when_divergent_no_conflict() {
        let (_origin, pc_a, pc_b) = setup_triple();
        fs::write(pc_a.join("a.txt"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["commit", "-m", "A"]);
        run(&pc_a, &["push"]);
        fs::write(pc_b.join("b.txt"), "from B\n").unwrap();
        run(&pc_b, &["add", "."]);
        run(&pc_b, &["commit", "-m", "B"]);
        git_pull_rebase_impl(pc_b.to_str().unwrap())
            .expect("pull --rebase should succeed when no overlap");
        assert!(pc_b.join("a.txt").exists());
        assert!(pc_b.join("b.txt").exists());
    }

    #[test]
    fn pull_rebase_returns_conflict_and_aborts() {
        let (_origin, pc_a, pc_b) = setup_triple();
        fs::write(pc_a.join("README.md"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["commit", "-m", "A"]);
        run(&pc_a, &["push"]);
        fs::write(pc_b.join("README.md"), "from B\n").unwrap();
        run(&pc_b, &["add", "."]);
        run(&pc_b, &["commit", "-m", "B"]);
        let err = git_pull_rebase_impl(pc_b.to_str().unwrap()).expect_err("should fail with conflict");
        assert!(err.starts_with("conflict:"), "got: {}", err);
        assert!(!pc_b.join(".git/rebase-merge").exists());
        assert!(!pc_b.join(".git/rebase-apply").exists());
    }

    #[test]
    fn push_returns_conflict_on_rebase_conflict() {
        let (_origin, pc_a, pc_b) = setup_triple();
        fs::write(pc_a.join("README.md"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["commit", "-m", "A"]);
        run(&pc_a, &["push"]);
        fs::write(pc_b.join("README.md"), "from B\n").unwrap();
        run(&pc_b, &["add", "."]);
        run(&pc_b, &["commit", "-m", "B"]);
        let err = git_push_impl(pc_b.to_str().unwrap()).expect_err("should fail with conflict");
        assert!(
            err.starts_with("conflict:"),
            "expected conflict prefix, got: {}",
            err
        );
        assert!(!pc_b.join(".git/rebase-merge").exists());
        assert!(!pc_b.join(".git/rebase-apply").exists());
    }

    #[test]
    fn pull_sets_upstream_when_missing() {
        let (_origin, pc_a, pc_b) = setup_triple();
        fs::write(pc_a.join("a.txt"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["commit", "-m", "A"]);
        run(&pc_a, &["push"]);

        run(&pc_b, &["branch", "--unset-upstream"]);
        assert!(!has_upstream(pc_b.to_str().unwrap()));

        git_pull_impl(pc_b.to_str().unwrap()).expect("pull should set upstream and succeed");

        assert!(has_upstream(pc_b.to_str().unwrap()), "upstream should be set after pull");
        assert!(pc_b.join("a.txt").exists());
    }

    #[test]
    fn pull_rebase_sets_upstream_when_missing() {
        let (_origin, pc_a, pc_b) = setup_triple();
        fs::write(pc_a.join("a.txt"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["commit", "-m", "A"]);
        run(&pc_a, &["push"]);

        run(&pc_b, &["branch", "--unset-upstream"]);
        fs::write(pc_b.join("b.txt"), "from B\n").unwrap();
        run(&pc_b, &["add", "."]);
        run(&pc_b, &["commit", "-m", "B"]);
        assert!(!has_upstream(pc_b.to_str().unwrap()));

        git_pull_rebase_impl(pc_b.to_str().unwrap())
            .expect("pull --rebase should set upstream and succeed");

        assert!(has_upstream(pc_b.to_str().unwrap()));
        assert!(pc_b.join("a.txt").exists());
        assert!(pc_b.join("b.txt").exists());
    }

    fn init_repo() -> PathBuf {
        let dir = tempdir("ensure");
        run(&dir, &["init", "--initial-branch=main"]);
        run(&dir, &["config", "user.email", "t@x"]);
        run(&dir, &["config", "user.name", "t"]);
        fs::write(dir.join("a.txt"), "x\n").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-m", "init"]);
        dir
    }

    #[test]
    fn ensure_appends_gitignore_when_missing() {
        let dir = init_repo();
        let res = git_ensure_twriter_ignored_impl(dir.to_str().unwrap()).unwrap();
        assert!(res.gitignore_updated);
        assert_eq!(res.untracked_files, 0);
        let gi = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(gi.contains(".twriter/"));
    }

    #[test]
    fn ensure_idempotent_when_already_ignored() {
        let dir = init_repo();
        fs::write(dir.join(".gitignore"), "node_modules/\n.twriter/\n").unwrap();
        let res = git_ensure_twriter_ignored_impl(dir.to_str().unwrap()).unwrap();
        assert!(!res.gitignore_updated);
        assert_eq!(res.untracked_files, 0);
        let gi = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(gi.matches(".twriter/").count(), 1);
    }

    #[test]
    fn ensure_matches_twriter_without_slash() {
        let dir = init_repo();
        fs::write(dir.join(".gitignore"), ".twriter\n").unwrap();
        let res = git_ensure_twriter_ignored_impl(dir.to_str().unwrap()).unwrap();
        assert!(!res.gitignore_updated, "bare `.twriter` should count as match");
    }

    #[test]
    fn ensure_untracks_when_already_tracked() {
        let dir = init_repo();
        fs::create_dir_all(dir.join(".twriter/search-index")).unwrap();
        fs::write(dir.join(".twriter/search-index/meta.json"), "{}\n").unwrap();
        run(&dir, &["add", ".twriter"]);
        run(&dir, &["commit", "-m", "oops"]);
        let res = git_ensure_twriter_ignored_impl(dir.to_str().unwrap()).unwrap();
        assert!(res.untracked_files > 0);
        assert!(dir.join(".twriter/search-index/meta.json").exists());
        let ls = Command::new("git")
            .current_dir(&dir)
            .args(["ls-files", ".twriter"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&ls.stdout).is_empty(),
            "ls-files should be empty after rm --cached"
        );
    }

    #[test]
    fn ensure_creates_gitignore_if_missing() {
        let dir = init_repo();
        let _ = fs::remove_file(dir.join(".gitignore"));
        let res = git_ensure_twriter_ignored_impl(dir.to_str().unwrap()).unwrap();
        assert!(res.gitignore_updated);
        assert!(dir.join(".gitignore").exists());
        let gi = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(gi.contains(".twriter/"));
    }

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

    #[test]
    fn status_kind_picks_most_severe() {
        use git2::Status as S;
        assert_eq!(status_kind(S::WT_NEW), "new");
        assert_eq!(status_kind(S::INDEX_NEW), "new");
        assert_eq!(status_kind(S::WT_MODIFIED), "modified");
        assert_eq!(status_kind(S::INDEX_DELETED), "deleted");
        assert_eq!(status_kind(S::WT_DELETED), "deleted");
        assert_eq!(status_kind(S::CONFLICTED), "conflicted");
        // CONFLICTED gana sobre MODIFIED.
        assert_eq!(
            status_kind(S::CONFLICTED | S::WT_MODIFIED),
            "conflicted"
        );
        // DELETED gana sobre MODIFIED.
        assert_eq!(
            status_kind(S::WT_DELETED | S::WT_MODIFIED),
            "deleted"
        );
    }

    #[test]
    fn status_for_populates_paths_for_modified_and_new() {
        let dir = init_repo();
        // Setup: tracked file modificado + archivo nuevo untracked.
        fs::write(dir.join("tracked.html"), "v1\n").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-m", "base"]);
        fs::write(dir.join("tracked.html"), "v2\n").unwrap();
        fs::write(dir.join("untracked.html"), "new\n").unwrap();

        let st = git_status_impl(dir.to_str().unwrap()).unwrap();
        assert_eq!(st.changed, 2);
        let kinds: std::collections::HashMap<_, _> = st
            .paths
            .iter()
            .map(|p| (p.path.as_str(), p.kind.as_str()))
            .collect();
        assert_eq!(kinds.get("tracked.html"), Some(&"modified"));
        assert_eq!(kinds.get("untracked.html"), Some(&"new"));
    }

    #[test]
    fn fetch_succeeds_against_clean_remote() {
        let (_origin, pc_a, _pc_b) = setup_triple();
        git_fetch_impl(pc_a.to_str().unwrap()).expect("fetch should succeed against clean remote");
    }

    #[test]
    fn fetch_picks_up_remote_commits() {
        let (_origin, pc_a, pc_b) = setup_triple();
        // pcA commitea + pushea algo nuevo; pcB hace fetch y debería ver el ref nuevo.
        fs::write(pc_a.join("from-a.txt"), "x\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["commit", "-m", "A"]);
        run(&pc_a, &["push"]);

        let before = run(&pc_b, &["rev-parse", "origin/main"]).trim().to_string();
        git_fetch_impl(pc_b.to_str().unwrap()).expect("fetch must succeed");
        let after = run(&pc_b, &["rev-parse", "origin/main"]).trim().to_string();
        assert_ne!(before, after, "fetch debería avanzar origin/main");
    }

    #[test]
    fn run_git_times_out_quickly() {
        // Forzar un timeout corto contra un sub-comando que no termina rápido.
        // Usamos `git -c core.askpass=/bin/sleep clone` contra una URL inválida
        // — `git` queda esperando credenciales y nuestro timeout lo mata.
        // Si el ambiente no tiene /bin/sleep, el test se skipea.
        if !std::path::Path::new("/bin/sleep").exists() {
            return;
        }
        let dir = tempdir("timeout");
        // `git help` termina rápido — usamos eso para verificar el path happy
        // primero (no timeout).
        let ok = run_git_with_timeout(dir.to_str().unwrap(), &["help"], Duration::from_secs(5))
            .expect("git help should not time out");
        assert!(ok.success);

        // Path triste: clone contra host inválido con SSH command que sleep 10s.
        // Con timeout 1s el child debe morir y retornar Err("network: ... timed out").
        let res = run_git_with_timeout(
            dir.to_str().unwrap(),
            &["clone", "user@invalid.invalid:repo.git", "_clone"],
            Duration::from_millis(500),
        );
        // Toleramos dos resultados: timeout categorizado, o falla rápida
        // (DNS resolve falla antes que SSH connect). Ambos no son "success=true".
        match res {
            Ok(out) => assert!(!out.success, "no debería tener éxito clonando una URL inválida"),
            Err(msg) => assert!(
                msg.contains("timed out") || msg.contains("network") || msg.contains("ejecutar"),
                "unexpected error: {}",
                msg
            ),
        }
    }
}
