# Git Sync Seamless Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make git sync invisible to non-programmer users — push auto-rebases on non-FF, behind-state auto-pulls, `.twriter/` index never gets versioned, all error messages are human-readable.

**Architecture:** Three coordinated changes. Backend (`src-tauri/src/git.rs`): categorize git CLI stderr into `auth`/`network`/`conflict`/`unknown`, retry push after `pull --rebase --autostash` when rejected, expose new `git_pull_rebase` and `git_ensure_twriter_ignored` Tauri commands. Frontend (`src/app/core/git-service.ts`): auto-pull when `behind > 0`, throttle after 3 consecutive failures, map error categories to Spanish UI strings, invoke `git_ensure_twriter_ignored` once per session per root.

**Tech Stack:** Rust 2021 + `git2` 0.20 (used only for status/commit; push and pull shell out to `git` CLI). Angular 21 with signals via `@angular/core`. Tauri 2 `invoke()` bridge. `tracing` crate for backend logs that bridge to the debug panel.

---

## File Structure

**Backend (Rust):**

- `src-tauri/src/git.rs` — modify `git_push_impl`, add `git_pull_rebase_impl`, add `git_ensure_twriter_ignored_impl`, add `categorize_git_error` helper, add `#[cfg(test)]` module.
- `src-tauri/src/lib.rs` — register two new commands in `invoke_handler`.

**Frontend (Angular):**

- `src/app/core/git-service.ts` — extend `refreshStatus` with auto-pull branch, add `autoPull` private method, add `friendlyError` mapper, add `ensureTwriterIgnored` invoke at root-change effect, throttle on consecutive failures.

**Docs:**

- `README.md` — move "Git / Sync" TODO items to "Hecho" status.
- `CLAUDE.md` — same.

---

## Task 1: Add `categorize_git_error` helper + tests

**Files:**
- Modify: `src-tauri/src/git.rs` (add helper near bottom, add `#[cfg(test)]` mod at end)

- [ ] **Step 1: Write the failing tests**

Append to the end of `src-tauri/src/git.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorize_auth_errors() {
        assert_eq!(categorize_git_error("Permission denied (publickey)."), "auth: Permission denied (publickey).");
        assert_eq!(categorize_git_error("fatal: Authentication failed for 'https://github.com/x.git'"), "auth: fatal: Authentication failed for 'https://github.com/x.git'");
        assert_eq!(categorize_git_error("fatal: could not read Username for 'https://github.com'"), "auth: fatal: could not read Username for 'https://github.com'");
    }

    #[test]
    fn categorize_network_errors() {
        assert_eq!(categorize_git_error("fatal: unable to access 'https://github.com/x.git': Could not resolve host: github.com"), "network: fatal: unable to access 'https://github.com/x.git': Could not resolve host: github.com");
        assert_eq!(categorize_git_error("fatal: unable to access 'https://x.git': Connection refused"), "network: fatal: unable to access 'https://x.git': Connection refused");
        assert_eq!(categorize_git_error("Operation timed out"), "network: Operation timed out");
    }

    #[test]
    fn categorize_rejected_errors() {
        assert_eq!(categorize_git_error(" ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs"), "rejected:  ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs");
        assert_eq!(categorize_git_error("hint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. Integrate the remote changes (e.g.\nhint: 'git pull ...') before pushing again."), "rejected: hint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. Integrate the remote changes (e.g.\nhint: 'git pull ...') before pushing again.");
    }

    #[test]
    fn categorize_conflict_errors() {
        assert_eq!(categorize_git_error("CONFLICT (content): Merge conflict in cap1.html"), "conflict: CONFLICT (content): Merge conflict in cap1.html");
        assert_eq!(categorize_git_error("error: could not apply abc123... message\nhint: Resolve all conflicts manually"), "conflict: error: could not apply abc123... message\nhint: Resolve all conflicts manually");
    }

    #[test]
    fn categorize_unknown_falls_through() {
        assert_eq!(categorize_git_error("fatal: random unknown thing"), "unknown: fatal: random unknown thing");
        assert_eq!(categorize_git_error(""), "unknown: ");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib categorize -- --nocapture`
Expected: FAIL with "cannot find function `categorize_git_error`".

- [ ] **Step 3: Add the helper**

Insert before `fn signature(...)` near the end of `src-tauri/src/git.rs`:

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib categorize -- --nocapture`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/git.rs
git commit -m "feat(git): add categorize_git_error helper for stderr classification"
```

---

## Task 2: Push auto-rebase + retry

**Files:**
- Modify: `src-tauri/src/git.rs` (replace `git_push_impl`, add small helpers `run_git`, `is_rejected`)
- Test: same file's `#[cfg(test)]` block

- [ ] **Step 1: Write the failing tests**

Add helpers and tests to the existing `mod tests` block in `src-tauri/src/git.rs`. The helpers create three repos: a bare `origin`, and two clones `pcA` / `pcB`. Append inside the `mod tests { ... }`:

```rust
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
        let out = Command::new("git").current_dir(cwd).args(args).output().unwrap();
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
        run(&root, &[
            "clone",
            origin.to_str().unwrap(),
            pc_a.to_str().unwrap(),
        ]);
        // baseline commit on pcA
        fs::write(pc_a.join("README.md"), "base\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["-c", "user.email=a@x", "-c", "user.name=a", "commit", "-m", "base"]);
        run(&pc_a, &["push", "origin", "main"]);
        let pc_b = root.join("pcB");
        run(&root, &[
            "clone",
            origin.to_str().unwrap(),
            pc_b.to_str().unwrap(),
        ]);
        (origin, pc_a, pc_b)
    }

    #[test]
    fn push_auto_rebases_on_non_ff() {
        let (_origin, pc_a, pc_b) = setup_triple();
        // A commits + pushes a new file
        fs::write(pc_a.join("a.txt"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["-c", "user.email=a@x", "-c", "user.name=a", "commit", "-m", "from A"]);
        run(&pc_a, &["push"]);
        // B commits a different file but did not pull
        fs::write(pc_b.join("b.txt"), "from B\n").unwrap();
        run(&pc_b, &["add", "."]);
        run(&pc_b, &["-c", "user.email=b@x", "-c", "user.name=b", "commit", "-m", "from B"]);
        // call our implementation
        git_push_impl(pc_b.to_str().unwrap()).expect("push should auto-rebase and succeed");
        // verify both files exist on B (rebase pulled A's commit)
        assert!(pc_b.join("a.txt").exists(), "a.txt should be present after rebase");
        assert!(pc_b.join("b.txt").exists());
    }

    #[test]
    fn push_returns_conflict_on_rebase_conflict() {
        let (_origin, pc_a, pc_b) = setup_triple();
        // both touch the same line of the same file
        fs::write(pc_a.join("README.md"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["-c", "user.email=a@x", "-c", "user.name=a", "commit", "-m", "A"]);
        run(&pc_a, &["push"]);
        fs::write(pc_b.join("README.md"), "from B\n").unwrap();
        run(&pc_b, &["add", "."]);
        run(&pc_b, &["-c", "user.email=b@x", "-c", "user.name=b", "commit", "-m", "B"]);
        let err = git_push_impl(pc_b.to_str().unwrap()).expect_err("should fail with conflict");
        assert!(err.starts_with("conflict:"), "expected conflict prefix, got: {}", err);
        // rebase must have been aborted: working tree clean, no .git/rebase-merge
        assert!(!pc_b.join(".git/rebase-merge").exists());
        assert!(!pc_b.join(".git/rebase-apply").exists());
    }
```

- [ ] **Step 2: Run tests to verify they fail (push_impl not yet rebasing)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib push_ -- --nocapture --test-threads=1`
Expected: FAIL — `push_auto_rebases_on_non_ff` fails because current implementation only does `git push` (which gets rejected).

- [ ] **Step 3: Replace `git_push_impl` with rebase + retry**

Replace the current `git_push_impl` function in `src-tauri/src/git.rs` with:

```rust
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
    let pull = run_git(repo_path, &["pull", "--rebase", "--autostash"])?;
    if !pull.success {
        // try to leave repo clean
        let _ = run_git(repo_path, &["rebase", "--abort"]);
        let msg = categorize_git_error(&pull.stderr);
        tracing::error!(target: "git", action = "push.rebase_conflict", error = %msg, "pull --rebase falló");
        // force "conflict:" prefix if categorize matched something else
        let msg = if msg.starts_with("conflict:") || msg.starts_with("rejected:") {
            msg
        } else if pull.stderr.to_lowercase().contains("conflict")
            || pull.stderr.to_lowercase().contains("could not apply")
        {
            format!("conflict: {}", pull.stderr)
        } else {
            msg
        };
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
```

The `pub(crate)` is so the tests in the same file can call `git_push_impl` directly without going through the Tauri command async wrapper.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib push_ -- --nocapture --test-threads=1`
Expected: PASS (2 tests). May take ~5 s because of subprocess git calls.

- [ ] **Step 5: Run the full git test suite to verify no regression**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib git -- --nocapture --test-threads=1`
Expected: all categorize + push tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/git.rs
git commit -m "feat(git): auto pull --rebase + retry on non-FF push"
```

---

## Task 3: `git_pull_rebase` command + tests

**Files:**
- Modify: `src-tauri/src/git.rs` (add `git_pull_rebase` command and `git_pull_rebase_impl`)

- [ ] **Step 1: Write the failing test**

Append to the `mod tests` block in `src-tauri/src/git.rs`:

```rust
    #[test]
    fn pull_rebase_succeeds_when_divergent_no_conflict() {
        let (_origin, pc_a, pc_b) = setup_triple();
        fs::write(pc_a.join("a.txt"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["-c", "user.email=a@x", "-c", "user.name=a", "commit", "-m", "A"]);
        run(&pc_a, &["push"]);
        fs::write(pc_b.join("b.txt"), "from B\n").unwrap();
        run(&pc_b, &["add", "."]);
        run(&pc_b, &["-c", "user.email=b@x", "-c", "user.name=b", "commit", "-m", "B"]);
        git_pull_rebase_impl(pc_b.to_str().unwrap()).expect("pull --rebase should succeed when no overlap");
        assert!(pc_b.join("a.txt").exists());
        assert!(pc_b.join("b.txt").exists());
    }

    #[test]
    fn pull_rebase_returns_conflict_and_aborts() {
        let (_origin, pc_a, pc_b) = setup_triple();
        fs::write(pc_a.join("README.md"), "from A\n").unwrap();
        run(&pc_a, &["add", "."]);
        run(&pc_a, &["-c", "user.email=a@x", "-c", "user.name=a", "commit", "-m", "A"]);
        run(&pc_a, &["push"]);
        fs::write(pc_b.join("README.md"), "from B\n").unwrap();
        run(&pc_b, &["add", "."]);
        run(&pc_b, &["-c", "user.email=b@x", "-c", "user.name=b", "commit", "-m", "B"]);
        let err = git_pull_rebase_impl(pc_b.to_str().unwrap()).expect_err("should fail with conflict");
        assert!(err.starts_with("conflict:"), "got: {}", err);
        assert!(!pc_b.join(".git/rebase-merge").exists());
        assert!(!pc_b.join(".git/rebase-apply").exists());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib pull_rebase -- --nocapture --test-threads=1`
Expected: FAIL — `git_pull_rebase_impl` not defined yet.

- [ ] **Step 3: Add command + impl**

Add the Tauri command near the other commands at the top of `src-tauri/src/git.rs` (under `pub async fn git_pull(...)`):

```rust
#[tauri::command]
pub async fn git_pull_rebase(repo_path: String) -> Result<(), String> {
    run_blocking(move || git_pull_rebase_impl(&repo_path)).await
}
```

Add the impl in the "Implementaciones bloqueantes" section, after `git_pull_impl`:

```rust
pub(crate) fn git_pull_rebase_impl(repo_path: &str) -> Result<(), String> {
    let out = run_git(repo_path, &["pull", "--rebase", "--autostash"])?;
    if out.success {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib pull_rebase -- --nocapture --test-threads=1`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/git.rs
git commit -m "feat(git): add git_pull_rebase command with conflict abort"
```

---

## Task 4: `git_ensure_twriter_ignored` command + tests

**Files:**
- Modify: `src-tauri/src/git.rs` (add struct, command, impl, tests)

- [ ] **Step 1: Write failing tests**

Append to the `mod tests` block in `src-tauri/src/git.rs`:

```rust
    fn init_repo() -> PathBuf {
        let dir = tempdir("ensure");
        run(&dir, &["init", "--initial-branch=main"]);
        run(&dir, &["config", "user.email", "t@x"]);
        run(&dir, &["config", "user.name", "t"]);
        // baseline commit so HEAD exists
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
        // not duplicated
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
        // commit a file inside .twriter/
        fs::create_dir_all(dir.join(".twriter/search-index")).unwrap();
        fs::write(dir.join(".twriter/search-index/meta.json"), "{}\n").unwrap();
        run(&dir, &["add", ".twriter"]);
        run(&dir, &["commit", "-m", "oops"]);
        let res = git_ensure_twriter_ignored_impl(dir.to_str().unwrap()).unwrap();
        assert!(res.untracked_files > 0);
        // file still on disk
        assert!(dir.join(".twriter/search-index/meta.json").exists());
        // but not in index anymore
        let ls = Command::new("git").current_dir(&dir).args(["ls-files", ".twriter"]).output().unwrap();
        assert!(String::from_utf8_lossy(&ls.stdout).is_empty(), "ls-files should be empty after rm --cached");
    }

    #[test]
    fn ensure_creates_gitignore_if_missing() {
        let dir = init_repo();
        // ensure no .gitignore exists
        let _ = fs::remove_file(dir.join(".gitignore"));
        let res = git_ensure_twriter_ignored_impl(dir.to_str().unwrap()).unwrap();
        assert!(res.gitignore_updated);
        assert!(dir.join(".gitignore").exists());
        let gi = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(gi.contains(".twriter/"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib ensure_ -- --nocapture --test-threads=1`
Expected: FAIL — `git_ensure_twriter_ignored_impl` and `EnsureResult` not defined.

- [ ] **Step 3: Add struct, command, and impl**

Add the result struct near the other structs at the top of `src-tauri/src/git.rs` (after `GitCommitResult`):

```rust
#[derive(Serialize, Debug, Clone)]
pub struct EnsureResult {
    pub gitignore_updated: bool,
    pub untracked_files: u32,
}
```

Add the Tauri command near the other commands:

```rust
#[tauri::command]
pub async fn git_ensure_twriter_ignored(repo_path: String) -> Result<EnsureResult, String> {
    run_blocking(move || git_ensure_twriter_ignored_impl(&repo_path)).await
}
```

Add the impl in the "Implementaciones bloqueantes" section, after `git_pull_rebase_impl`:

```rust
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

    // Untrack .twriter/ if previously committed.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib ensure_ -- --nocapture --test-threads=1`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/git.rs
git commit -m "feat(git): add git_ensure_twriter_ignored — auto-fix .twriter/ versioning"
```

---

## Task 5: Wire new commands in `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Read current state**

Inspect the file. Around line 41 there's `use git::{git_commit_all, git_pull, git_push, git_status};` and around line 107-108 the handlers list contains `git_push, git_pull`.

- [ ] **Step 2: Update the `use` statement**

Change the existing line:

```rust
use git::{git_commit_all, git_pull, git_push, git_status};
```

to:

```rust
use git::{git_commit_all, git_ensure_twriter_ignored, git_pull, git_pull_rebase, git_push, git_status};
```

- [ ] **Step 3: Register the new handlers**

In the `invoke_handler` `generate_handler![...]` list (right after `git_pull,` near line 108), insert:

```rust
            git_pull_rebase,
            git_ensure_twriter_ignored,
```

- [ ] **Step 4: Verify the crate compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: clean (no errors). Warnings about unused functions are acceptable since the frontend wires them next.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(git): register git_pull_rebase + git_ensure_twriter_ignored commands"
```

---

## Task 6: Frontend `friendlyError` mapper + tests

**Files:**
- Modify: `src/app/core/git-service.ts` (add free function `friendlyError` at module scope)
- Create: `src/app/core/git-service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/core/git-service.spec.ts`:

```ts
import { friendlyError } from './git-service';

describe('friendlyError', () => {
  it('maps auth: prefix', () => {
    expect(friendlyError('auth: Permission denied (publickey).'))
      .toBe('No se pudo autenticar contra el remoto. Revisá la clave SSH o el token.');
  });

  it('maps network: prefix', () => {
    expect(friendlyError('network: Could not resolve host'))
      .toBe('Sin conexión al remoto. Reintentamos en 30 s.');
  });

  it('maps conflict: prefix with detail', () => {
    expect(friendlyError('conflict: CONFLICT (content): Merge conflict in cap1.html'))
      .toMatch(/Conflicto entre esta PC y el remoto/);
  });

  it('maps rejected: prefix', () => {
    expect(friendlyError('rejected: ! [rejected] main -> main (non-fast-forward)'))
      .toMatch(/El remoto avanz/);
  });

  it('falls back to generic for unknown', () => {
    expect(friendlyError('unknown: weird thing'))
      .toBe('Falló el sync. Mirá el panel 🐛 para más info.');
  });

  it('passes through non-categorized strings as-is generic', () => {
    expect(friendlyError('totally raw error'))
      .toBe('Falló el sync. Mirá el panel 🐛 para más info.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm ng test --watch=false --browsers=ChromeHeadless --include='src/app/core/git-service.spec.ts'`
Expected: FAIL — `friendlyError` is not exported.

- [ ] **Step 3: Add the mapper to `git-service.ts`**

At the top of `src/app/core/git-service.ts`, after the imports and before the interfaces, add:

```ts
export function friendlyError(raw: string): string {
  if (raw.startsWith('auth:')) {
    return 'No se pudo autenticar contra el remoto. Revisá la clave SSH o el token.';
  }
  if (raw.startsWith('network:')) {
    return 'Sin conexión al remoto. Reintentamos en 30 s.';
  }
  if (raw.startsWith('conflict:')) {
    return 'Conflicto entre esta PC y el remoto. Abrí el panel 🐛 para detalle.';
  }
  if (raw.startsWith('rejected:')) {
    return 'El remoto avanzó y reintentamos rebasear automáticamente. Si volvés a ver este mensaje, abrí el panel 🐛.';
  }
  return 'Falló el sync. Mirá el panel 🐛 para más info.';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm ng test --watch=false --browsers=ChromeHeadless --include='src/app/core/git-service.spec.ts'`
Expected: PASS (6 specs).

- [ ] **Step 5: Commit**

```bash
git add src/app/core/git-service.ts src/app/core/git-service.spec.ts
git commit -m "feat(git-service): friendlyError maps backend categories to Spanish UI"
```

---

## Task 7: Frontend auto-pull + throttle + ensure-on-root

**Files:**
- Modify: `src/app/core/git-service.ts`

This is the largest frontend task. The current `refreshStatus` only fetches state. The current root-change effect resets state and starts timers. We extend both.

- [ ] **Step 1: Add throttle + auto-pull state**

In the `GitService` class, just after the existing `private commitTimer: ...` declaration (around line 63), add:

```ts
  private autoFailCount = 0;
  private autoPaused = false;
  private autoPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private autoPullInflight = false;
  private ensuredForRoot: string | null = null;
```

- [ ] **Step 2: Replace `refreshStatus` to dispatch `autoPull` when behind**

Replace the current `refreshStatus` body (`async refreshStatus(): Promise<void> { ... }` around lines 79-90) with:

```ts
  async refreshStatus(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    try {
      const s = await invoke<GitStatus>('git_status', { repoPath: root });
      this.status.set(s);
      this.error.set(null);
      if (
        !this.autoPaused &&
        !this.autoPullInflight &&
        !this.syncing() &&
        s.behind > 0
      ) {
        void this.autoPull(s);
      }
    } catch (err) {
      this.status.set(null);
      this.error.set(friendlyError(String(err)));
    }
  }
```

- [ ] **Step 3: Add `autoPull` private method**

Add inside the `GitService` class, after the `pull(): Promise<void>` method:

```ts
  private async autoPull(s: GitStatus): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    this.autoPullInflight = true;
    try {
      if (s.ahead === 0) {
        await invoke('git_pull', { repoPath: root });
      } else {
        await invoke('git_pull_rebase', { repoPath: root });
      }
      this.autoFailCount = 0;
      this.error.set(null);
      await this.refreshStatus();
    } catch (err) {
      const raw = String(err);
      if (raw.startsWith('conflict:')) {
        this.error.set(friendlyError(raw));
        this.pauseAutoLoop();
      } else {
        this.autoFailCount += 1;
        if (this.autoFailCount >= 3) {
          this.error.set(friendlyError(raw));
          this.pauseAutoLoop();
        }
      }
    } finally {
      this.autoPullInflight = false;
    }
  }

  private pauseAutoLoop(): void {
    this.autoPaused = true;
    if (this.autoPauseTimer) clearTimeout(this.autoPauseTimer);
    this.autoPauseTimer = setTimeout(() => {
      this.autoPaused = false;
      this.autoFailCount = 0;
    }, 5 * 60_000);
  }
```

- [ ] **Step 4: Wrap `syncNow` errors with `friendlyError`**

In the existing `syncNow` method, find the `catch (err)` block and replace `this.error.set(String(err));` with `this.error.set(friendlyError(String(err)));`. Same change inside `pull()`.

Also: at the **end** of `syncNow` (after `this.lastSyncAt.set(Date.now());`, before the `finally`), reset throttle on success:

```ts
      this.autoFailCount = 0;
      if (this.autoPauseTimer) clearTimeout(this.autoPauseTimer);
      this.autoPaused = false;
```

- [ ] **Step 5: Invoke `git_ensure_twriter_ignored` once per root**

In the `constructor` `effect(...)` block (around lines 66-76), replace:

```ts
      if (root && isGit) {
        void this.refreshStatus();
        this.startTimers();
      }
```

with:

```ts
      if (root && isGit) {
        if (this.ensuredForRoot !== root) {
          this.ensuredForRoot = root;
          void invoke('git_ensure_twriter_ignored', { repoPath: root }).catch((err) => {
            // non-fatal — log and continue
            console.warn('git_ensure_twriter_ignored failed', err);
          });
        }
        void this.refreshStatus();
        this.startTimers();
      } else {
        this.ensuredForRoot = null;
      }
```

- [ ] **Step 6: Reset throttle in `stopTimers`**

In `stopTimers`, after clearing the existing timers, add:

```ts
    if (this.autoPauseTimer) clearTimeout(this.autoPauseTimer);
    this.autoPauseTimer = null;
    this.autoPaused = false;
    this.autoFailCount = 0;
    this.autoPullInflight = false;
```

- [ ] **Step 7: Run frontend tests**

Run: `pnpm ng test --watch=false --browsers=ChromeHeadless`
Expected: existing suite + `friendlyError` specs all PASS.

- [ ] **Step 8: Manual smoke test (foreground)**

This requires the dev environment. Run:

```bash
pnpm tauri dev
```

In a separate terminal, watch the panel 🐛 output. Open a known git repo as the root. Verify in the panel 🐛 that one of:
- `[git] limpieza de .twriter/ aplicada` (if the repo had it tracked or missing .gitignore), or
- no message (if already clean).

Kill the dev server after the smoke check.

- [ ] **Step 9: Commit**

```bash
git add src/app/core/git-service.ts
git commit -m "feat(git-service): auto-pull on behind, throttle on repeated failure, friendlier errors"
```

---

## Task 8: README + CLAUDE.md updates

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `README.md` Git / Sync TODO**

In `README.md`, find the `### Git / Sync` section under `## TODO` (around line 548). Replace the two bullets ("Push sin pull falla silencioso…" and "`.twriter/` se está versionando…") with a single bullet referencing what's now done:

```markdown
- ~~Push sin pull falla silencioso si el remoto avanzó desde otra PC~~ ✅ Backend ahora hace `git pull --rebase --autostash` y reintenta el push una vez al detectar non-fast-forward. Si el rebase produce conflictos, aborta y muestra un mensaje friendly. Auto-pull en background cada 30 s cuando `behind > 0` (seamless entre PCs). Throttle a 5 min después de 3 fallas consecutivas. Errores categorizados (`auth`/`network`/`conflict`/`rejected`/`unknown`) mapeados a español en la UI.
- ~~`.twriter/` se está versionando y genera conflictos cada sync entre PCs~~ ✅ Al detectar backend git, la app corre `git_ensure_twriter_ignored` (idempotente): agrega `.twriter/` al `.gitignore` si falta y corre `git rm -r --cached .twriter` si está trackeado. El cambio queda uncommitted — el próximo auto-commit lo pickea.
```

- [ ] **Step 2: Update the "Git auto-sync (cuando backend = git)" section**

In `README.md`, under `### Git auto-sync (cuando backend = git)` (around line 320), update the bullet list to reflect the new behavior. Replace the existing bullets with:

```markdown
- `git2` crate (libgit2) para status + commit. Push/pull delegan al binario `git` del sistema (más estable para SSH/agent que libssh2).
- SSH agent + fallback a `~/.ssh/id_ed25519/id_rsa/id_ecdsa`.
- Auto-commit cada 5 min cuando hay cambios.
- Status polling 30 s; cuando detecta `behind > 0` corre auto-pull en background (`git pull --ff-only` o `git pull --rebase --autostash` si la rama está divergente).
- Push auto-rebase: si el remoto avanzó desde otra PC, `git push` falla con non-FF; el backend corre `git pull --rebase --autostash` y reintenta el push una vez. Si el rebase choca, se aborta y la UI muestra "Conflicto entre esta PC y el remoto. Abrí el panel 🐛 para detalle." (sin terminal jargon).
- `.twriter/` auto-ignorado al boot: el índice tantivy nunca llega al index del repo, evitando conflictos add/add entre PCs.
- Throttle: tras 3 fallas consecutivas de auto-pull, se pausa el loop 5 min para no spamear el panel 🐛. Sync manual (⇅) sigue siempre disponible.
- Botón "sync ahora" (⇅) en header.
```

- [ ] **Step 3: Update `CLAUDE.md`**

In `CLAUDE.md`, find the existing line that says:

```markdown
El repo `Novelas/` se sincroniza desde dentro de la app vía `git2` crate (libgit2 bindings) — sin shellear `git`. Auth con SSH key del sistema o token GitHub en keyring (`keyring` crate). Default: auto-commit cada 5 min y al cerrar capítulo, push en background.
```

Replace it with:

```markdown
El repo `Novelas/` se sincroniza desde dentro de la app: `git2` (libgit2) para status + commit, binario `git` del sistema para push/pull (más robusto contra SSH/agent quirks). Default: auto-commit cada 5 min, status polling cada 30 s, auto-pull cuando `behind > 0`, auto-rebase + retry cuando `git push` es rechazado por non-FF. `.twriter/` (índice tantivy local) se destrackea automáticamente vía `git_ensure_twriter_ignored` para que no genere conflictos entre PCs. Errores del CLI git se categorizan en `auth`/`network`/`conflict`/`rejected`/`unknown` y `git-service.ts::friendlyError` los mapea a strings en español para la UI.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: cubrir git seamless sync (auto-rebase + auto-pull + .twriter/ ignore)"
```

---

## Task 9: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p twriter_lib -- --test-threads=1`
Expected: all tests PASS (existing + new git tests).

- [ ] **Step 2: Full Angular test suite**

Run: `pnpm ng test --watch=false --browsers=ChromeHeadless`
Expected: all specs PASS.

- [ ] **Step 3: Clippy check (no new warnings)**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: clean. If clippy complains about the new code, fix the warnings inline and re-run.

- [ ] **Step 4: Tauri dev smoke**

Run: `pnpm tauri dev`. With a real git repo as root:
- Confirm the panel 🐛 either logs `twriter_cleanup` once or stays silent (idempotent path).
- Verify badge state transitions correctly when you `git push` an unrelated change from another shell — the app should auto-pull within 30 s.

Stop the dev server after the check.

- [ ] **Step 5: No commit (verification only)**

Nothing to commit. If any step failed, fix the underlying issue and re-run the failing step before declaring done.
