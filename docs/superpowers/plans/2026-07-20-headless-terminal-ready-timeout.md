# Headless terminal_ready Timeout Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the fixed 60s terminal-readiness timeout that `cli-box start` hits in headless mode by having the daemon answer readiness from PTY state.

**Architecture:** Single change in `readyz_handler`: when `DaemonState.headless` is true, compute `terminal_ready` from the queried sandbox's `pty_pid` existence instead of the renderer-populated `terminal_ready_sandboxes` set (which is never populated in headless mode because there is no Electron renderer). The non-headless path is unchanged.

**Tech Stack:** Rust, axum (`tower::ServiceExt::oneshot` integration tests), tokio.

## Global Constraints

- Code and comments in English; user-facing communication in Chinese (CLAUDE.md §七).
- TDD: write the failing test first, watch it fail, then implement.
- `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings` must be clean before commit.
- Commit format `<type>(<scope>): <description>`, scope `daemon`. Implementation + tests in one commit.
- Do not merge to main; commit on the existing branch `fix/daemon-headless-terminal-ready`.

## File Structure

- **Modify:** `crates/cli-box-core/src/daemon/mod.rs` — `readyz_handler` (currently lines 339-358). Responsibility: serve the daemon `/readyz` polling endpoint.
- **Test:** `crates/cli-box-core/tests/daemon_integration.rs` — add two test functions and one non-`unix`-gated state helper. Responsibility: exercise daemon routes via `oneshot` without binding a TCP port.

No new files. The change is intentionally localized to the readiness endpoint and its tests.

---

## Task 1: Headless terminal readiness from PTY state

**Files:**
- Modify: `crates/cli-box-core/src/daemon/mod.rs` (the `readyz_handler` function, lines ~345-348)
- Test: `crates/cli-box-core/tests/daemon_integration.rs` (add helper + 2 tests, near the existing `readyz_returns_not_ready_without_renderer` test at line 207)

**Interfaces:**
- Consumes: `DaemonState` fields `headless: bool`, `sandboxes: HashMap<String, ManagedSandbox>`, `terminal_ready_sandboxes: HashSet<String>`; `ManagedSandbox.pty_pid: Option<u32>`. All pre-existing, unchanged.
- Produces: no new public API. Only the JSON value of `terminal_ready` in the `/readyz?sandbox_id=<id>` response changes (now `true` in headless mode for sandboxes with a PTY).

- [ ] **Step 1: Add the failing test + helper**

Append this helper after the existing `router_with_sandbox` function (after line 64). It is intentionally **not** `#[cfg(unix)]` — `readyz` only inspects state and never spawns a real PTY, so it runs on all platforms (mac dev + Linux CI):

```rust
/// Headless daemon state with one CLI sandbox carrying `pty_pid`.
/// Not unix-gated: readyz only inspects state, it does not spawn a PTY.
fn headless_ready_state(id: &str, pty_pid: u32) -> Arc<Mutex<DaemonState>> {
    let mut sandboxes = HashMap::new();
    sandboxes.insert(
        id.to_string(),
        ManagedSandbox {
            id: id.to_string(),
            kind: InstanceKind::Cli {
                command: "zsh".to_string(),
                args: vec![],
            },
            status: InstanceStatus::Running,
            port: 0,
            pty_pid: Some(pty_pid),
            window_id: None,
        },
    );
    Arc::new(Mutex::new(DaemonState {
        port: 0,
        sandboxes,
        started_at: std::time::Instant::now(),
        screenshot_ws_tx: None,
        pending_screenshots: HashMap::new(),
        pending_scrollback: HashMap::new(),
        screenshot_request_counter: 0,
        terminal_ready_sandboxes: HashSet::new(),
        headless: true,
    }))
}
```

Then add this test next to `readyz_returns_not_ready_without_renderer` (after line 224):

```rust
#[tokio::test]
async fn readyz_terminal_ready_in_headless_mode() {
    // Headless mode has no renderer, so terminal_ready must be derived from
    // the sandbox's PTY existence rather than the renderer-reported set.
    let resp = build_daemon_router(headless_ready_state("sb-1", 4242))
        .oneshot(
            Request::builder()
                .uri("/readyz?sandbox_id=sb-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["terminal_ready"], true);

    // Unknown sandbox id -> not ready.
    let resp = build_daemon_router(headless_ready_state("sb-1", 4242))
        .oneshot(
            Request::builder()
                .uri("/readyz?sandbox_id=unknown")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["terminal_ready"], false);
}
```

- [ ] **Step 2: Run the new test and verify it FAILS (red)**

Run: `cargo test -p cli-box-core --test daemon_integration readyz_terminal_ready_in_headless_mode`
Expected: FAIL — `assert_eq!(json["terminal_ready"], true)` fails because the current handler returns `false` (the `terminal_ready_sandboxes` set is empty and nothing populates it in headless mode).

- [ ] **Step 3: Implement the fix in `readyz_handler`**

In `crates/cli-box-core/src/daemon/mod.rs`, replace this block inside `readyz_handler` (currently lines 345-348):

```rust
        let terminal_ready = match params.get("sandbox_id") {
            Some(sandbox_id) => s.terminal_ready_sandboxes.contains(sandbox_id.as_str()),
            None => true,
        };
```

with:

```rust
        let terminal_ready = match params.get("sandbox_id") {
            None => true,
            Some(sandbox_id) => {
                if s.headless {
                    // No renderer in headless mode; the terminal is ready as
                    // soon as the sandbox's PTY exists (spawned synchronously at
                    // creation). The CLI only polls for CLI sandboxes, which
                    // always carry a pty_pid, so this mirrors its own gate.
                    s.sandboxes
                        .get(sandbox_id.as_str())
                        .map(|sb| sb.pty_pid.is_some())
                        .unwrap_or(false)
                } else {
                    s.terminal_ready_sandboxes.contains(sandbox_id.as_str())
                }
            }
        };
```

- [ ] **Step 4: Run the new test and verify it PASSES (green)**

Run: `cargo test -p cli-box-core --test daemon_integration readyz_terminal_ready_in_headless_mode`
Expected: PASS.

- [ ] **Step 5: Add the non-headless regression-guard test**

Add this test next to the one above. It locks in that the headless branch did not alter the renderer-driven path (`state_with_sandbox` has `headless: false`, `pty_pid: None`, empty ready set):

```rust
#[tokio::test]
async fn readyz_terminal_ready_uses_renderer_set_when_not_headless() {
    // Non-headless: readiness must still come from terminal_ready_sandboxes,
    // unaffected by the headless branch.
    let state = state_with_sandbox();
    let resp = build_daemon_router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/readyz?sandbox_id=test-sb")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["terminal_ready"], false);

    // Once the renderer reports ready, it flips to true.
    {
        let mut s = state.lock().await;
        s.terminal_ready_sandboxes.insert("test-sb".to_string());
    }
    let resp = build_daemon_router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/readyz?sandbox_id=test-sb")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["terminal_ready"], true);
}
```

- [ ] **Step 6: Run the full quality gate**

Run each; all must pass:

```bash
cargo test -p cli-box-core --test daemon_integration
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

Expected: all daemon_integration tests pass (including the two new ones); clippy clean; fmt clean. If `fmt --check` reports a diff, run `cargo fmt --all` and re-check.

- [ ] **Step 7: Commit**

```bash
git add crates/cli-box-core/src/daemon/mod.rs crates/cli-box-core/tests/daemon_integration.rs
git commit -m "fix(daemon): resolve headless terminal_ready timeout

In headless mode no renderer connects the screenshot WebSocket, so
terminal_ready_sandboxes was never populated and 'cli-box start' always
hit the 60s readiness timeout. Derive terminal_ready from the sandbox's
PTY existence in headless mode; non-headless path unchanged.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Manual Verification (post-implementation, on the Aliyun headless host)

After Task 1 lands, confirm end-to-end on `47.98.144.243` (per memory: cli-box source present, no Electron → headless):

```bash
time cli-box start   # default zsh sandbox
```

Expected: completes ("Sandbox ready") within ~1s, **not** 60s, and no "Terminal not ready within 60s" error/hint is printed. This is a release-test step (per CLAUDE.md §6.3), not a unit assertion.
