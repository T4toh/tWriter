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
pub async fn git_pull(repo_path: String) -> Result<(), String> {
    run_blocking(move || git_pull_impl(&repo_path)).await
}

#[tauri::command]
pub async fn git_pull_rebase(repo_path: String) -> Result<(), String> {
    run_blocking(move || git_pull_rebase_impl(&repo_path)).await
}

#[tauri::command]
pub async fn git_ensure_twriter_ignored(repo_path: String) -> Result<EnsureResult, String> {
    run_blocking(move || git_ensure_twriter_ignored_impl(&repo_path)).await
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
    let first = run_git(repo_path, &["push"])?;
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
    let retry = run_git(repo_path, &["push"])?;
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
    let out = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| {
            tracing::error!(target: "git", error = %e, "no se pudo lanzar git");
            format!("no se pudo ejecutar git: {}", e)
        })?;
    Ok(GitOutput {
        success: out.status.success(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
    })
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

fn git_pull_impl(repo_path: &str) -> Result<(), String> {
    let branch = current_branch_name(repo_path);
    let needs_upstream = branch.is_some() && !has_upstream(repo_path);

    let mut args: Vec<&str> = vec!["pull", "--ff-only"];
    if needs_upstream {
        args.push("origin");
        args.push(branch.as_deref().unwrap());
    }

    let out = run_git(repo_path, &args)?;
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
    Ok(())
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

pub(crate) fn git_pull_rebase_impl(repo_path: &str) -> Result<(), String> {
    let branch = current_branch_name(repo_path);
    let needs_upstream = branch.is_some() && !has_upstream(repo_path);

    let mut args: Vec<&str> = vec!["pull", "--rebase", "--autostash"];
    if needs_upstream {
        args.push("origin");
        args.push(branch.as_deref().unwrap());
    }

    let out = run_git(repo_path, &args)?;
    if out.success {
        if needs_upstream {
            if let Some(b) = branch.as_deref() {
                set_upstream(repo_path, b);
            }
        }
        tracing::info!(target: "git", "pull --rebase --autostash ok");
        return Ok(());
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
}
