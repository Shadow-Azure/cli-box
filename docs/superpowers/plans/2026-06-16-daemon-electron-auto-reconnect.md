# Daemon-Electron Auto-Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix renderer WebSocket connection failures when daemon restarts on a different port, by removing the getDaemonPort IPC cache and simplifying CLI process lifecycle management.

**Architecture:** Remove the `daemonPort` cache in the Electron IPC handler so every call re-reads `daemon.json`. The existing renderer onclose handler already detects port changes and reconnects. Simplify the CLI `cmd_start_daemon` to use clean `ensure_healthy_daemon` + `ensure_healthy_electron` functions that check PID + health instead of relying on band-aid cleanup functions.

**Tech Stack:** Rust (tokio + reqwest), Electron (TypeScript + Vitest)

**Spec:** `docs/superpowers/specs/2026-06-16-daemon-electron-auto-reconnect-design.md`

---

## File Structure

### Files to Modify

| File | Responsibility |
|------|----------------|
| `electron-app/src/main/index.ts` | Remove `daemonPort` cache from `get-daemon-port` IPC handler |
| `crates/cli-box-cli/src/main.rs` | Rewrite `cmd_start_daemon`, add `ensure_healthy_daemon` + `ensure_healthy_electron`, add helper functions, remove band-aid functions |
| `electron-app/src/__tests__/daemon-bridge.test.ts` | Add test for uncached `findRunningDaemon` behavior |

---

## Task 1: Fix getDaemonPort IPC — Remove Cache

**Files:**
- Modify: `electron-app/src/main/index.ts:48-57`

- [ ] **Step 1: Replace the cached IPC handler with an uncached one**

In `electron-app/src/main/index.ts`, find the `get-daemon-port` handler (around line 48):

```typescript
// IPC: renderer asks for daemon port
// Re-check daemon on each call — daemon may have started after Electron launched
ipcMain.handle("get-daemon-port", () => {
  if (!daemonPort) {
    const existingPort = findRunningDaemon();
    if (existingPort) {
      daemonPort = existingPort;
      writeElectronJson(daemonPort);
    }
  }
  return daemonPort;
});
```

Replace with:

```typescript
// IPC: renderer asks for daemon port
// Always re-read daemon.json — daemon may have restarted on a different port.
// Removing the cache ensures the renderer's onclose handler can discover
// a new daemon port when the old one dies.
ipcMain.handle("get-daemon-port", () => {
  const existingPort = findRunningDaemon();
  if (existingPort !== daemonPort) {
    daemonPort = existingPort;
    if (existingPort) writeElectronJson(existingPort);
  }
  return daemonPort;
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd electron-app && pnpm typecheck`
Expected: PASS (no type errors in index.ts)

- [ ] **Step 3: Commit**

```bash
git add electron-app/src/main/index.ts
git commit -m "fix(electron): remove getDaemonPort IPC cache for auto-reconnect

Always re-read daemon.json on every IPC call. When daemon restarts on a
different port, the renderer's onclose handler discovers the new port
and reconnects automatically."
```

---

## Task 2: Add CLI Helper Functions

**Files:**
- Modify: `crates/cli-box-cli/src/main.rs` (add functions before `find_running_electron` around line 1786)

- [ ] **Step 1: Add helper functions**

Add these functions before the `find_running_electron` function (around line 1786) in `crates/cli-box-cli/src/main.rs`:

```rust
/// Check if a process is alive via `kill(pid, 0)`.
fn is_process_alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Kill a process by PID (SIGTERM, then SIGKILL if needed).
fn kill_process(pid: i32) {
    let _ = std::process::Command::new("kill")
        .arg(pid.to_string())
        .status();
    std::thread::sleep(std::time::Duration::from_millis(500));
    if is_process_alive(pid) {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

/// Read electron.json and return (pid, port).
fn read_electron_json() -> Option<(i32, u16)> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let path = std::path::PathBuf::from(home)
        .join(".cli-box")
        .join("electron.json");
    if !path.exists() {
        return None;
    }
    let json = std::fs::read_to_string(&path).ok()?;
    let info: serde_json::Value = serde_json::from_str(&json).ok()?;
    let pid = info["pid"].as_u64()? as i32;
    let port = info["port"].as_u64()? as u16;
    Some((pid, port))
}

/// Remove electron.json from disk.
fn remove_electron_json() {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let path = std::path::PathBuf::from(home)
        .join(".cli-box")
        .join("electron.json");
    let _ = std::fs::remove_file(&path);
}

/// Check if the daemon on a given port responds to /health.
fn daemon_health_check(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    reqwest::blocking::get(&url)
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build --release -p cli-box-cli`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/cli-box-cli/src/main.rs
git commit -m "feat(cli): add process lifecycle helper functions

is_process_alive, kill_process, read_electron_json, remove_electron_json,
daemon_health_check — used by ensure_healthy_daemon/electron."
```

---

## Task 3: Add ensure_healthy_daemon Function

**Files:**
- Modify: `crates/cli-box-cli/src/main.rs` (add after helper functions from Task 2)

- [ ] **Step 1: Add ensure_healthy_daemon function**

Add after the helper functions (after `daemon_health_check`):

```rust
/// Ensure we have a healthy daemon process.
///
/// Reads daemon.json → checks PID alive → checks /health.
/// If healthy, reuses the existing daemon. Otherwise kills the stale
/// process and spawns a new daemon, waiting for readiness.
async fn ensure_healthy_daemon() -> anyhow::Result<u16> {
    if let Some(info) = cli_box_core::daemon::read_daemon_info() {
        let pid = info.pid as i32;
        let port = info.port;

        if is_process_alive(pid) && daemon_health_check(port) {
            println!("Sandbox daemon already running on port {port} (pid={pid})");
            return Ok(port);
        }

        // Process is dead or unhealthy — kill if alive, clean up json
        if is_process_alive(pid) {
            tracing::warn!("[start] Daemon pid={pid} alive but unhealthy, killing");
            kill_process(pid);
        }
        let _ = cli_box_core::daemon::cleanup_daemon_info();
    }

    // Spawn new daemon
    let daemon_bin = find_daemon_binary()?;
    tracing::info!("[start] spawning daemon: {}", daemon_bin.display());

    let _child = Command::new(&daemon_bin)
        .spawn()
        .context("Failed to launch cli-box-daemon")?;

    // Wait for daemon.json to appear + /health to respond (up to 10s)
    let timeout = std::time::Duration::from_secs(10);
    let start = std::time::Instant::now();
    let port = loop {
        if start.elapsed() > timeout {
            anyhow::bail!(
                "Timeout: sandbox daemon did not start within {}s.",
                timeout.as_secs()
            );
        }
        if let Some(info) = cli_box_core::daemon::read_daemon_info() {
            if daemon_health_check(info.port) {
                break info.port;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    };
    println!("Sandbox daemon started on port {port}");
    Ok(port)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build --release -p cli-box-cli`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/cli-box-cli/src/main.rs
git commit -m "feat(cli): add ensure_healthy_daemon function

Checks daemon.json PID + /health. Reuses healthy daemon or kills stale
process and spawns new one."
```

---

## Task 4: Add ensure_healthy_electron Function

**Files:**
- Modify: `crates/cli-box-cli/src/main.rs` (add after ensure_healthy_daemon from Task 3)

- [ ] **Step 1: Add ensure_healthy_electron function**

Add after `ensure_healthy_daemon`:

```rust
/// Ensure we have a healthy Electron with renderer connected to the daemon.
///
/// If old Electron is alive and renderer_connected → reuse (it auto-reconnects).
/// If old Electron is alive but renderer not connected → wait (auto-reconnect
///   is in progress via the IPC fix).
/// If old Electron is dead → spawn new and wait for renderer_connected.
async fn ensure_healthy_electron() {
    use std::io::Write;

    // If existing Electron is alive, just wait for renderer_connected.
    // The IPC fix (removed cache) means old Electron auto-discovers new daemon.
    let electron_alive = read_electron_json()
        .map(|(pid, _)| is_process_alive(pid))
        .unwrap_or(false);

    if !electron_alive {
        // Clean up stale electron.json and spawn new Electron
        remove_electron_json();

        if let Some(electron_bin) = find_electron_binary() {
            tracing::info!("[start] spawning Electron: {}", electron_bin.display());
            if let Err(e) = Command::new(&electron_bin).spawn() {
                eprintln!("Warning: Failed to launch Electron app: {e}");
                return;
            }
            tracing::info!("[start] Electron launched");
        } else {
            tracing::warn!("[start] Electron app not found, running in headless daemon mode");
            return;
        }
    } else {
        tracing::info!("[start] Electron already running, waiting for renderer to connect/reconnect");
    }

    // Wait for renderer WebSocket to connect
    print!("Waiting for renderer");
    let _ = std::io::stdout().flush();

    let timeout = std::time::Duration::from_secs(60);
    let start = std::time::Instant::now();
    let poll_interval = std::time::Duration::from_secs(1);
    let mut dot_count: u8 = 0;

    loop {
        if start.elapsed() > timeout {
            println!();
            tracing::warn!(
                "[start] Renderer WebSocket did not connect within {}s",
                timeout.as_secs()
            );
            eprintln!("Error: Electron renderer did not connect within {}s.", timeout.as_secs());
            eprintln!("Hint: Screenshot functionality will not work. Try: cli-box close <id> and restart.");
            break;
        }

        match client::daemon_readiness().await {
            Ok(resp) if resp.renderer_connected => {
                println!(" done");
                break;
            }
            Err(e) => {
                tracing::trace!("[start] readyz check failed (will retry): {e}");
            }
            _ => {}
        }

        dot_count = (dot_count % 3) + 1;
        print!(
            "\rWaiting for renderer{:<3}",
            ".".repeat(dot_count as usize)
        );
        let _ = std::io::stdout().flush();

        tokio::time::sleep(poll_interval).await;
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build --release -p cli-box-cli`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/cli-box-cli/src/main.rs
git commit -m "feat(cli): add ensure_healthy_electron function

If old Electron alive, waits for auto-reconnect (no kill/respawn).
Only spawns new Electron when old one is dead."
```

---

## Task 5: Rewrite cmd_start_daemon

**Files:**
- Modify: `crates/cli-box-cli/src/main.rs:412-629` (replace entire function)

- [ ] **Step 1: Replace cmd_start_daemon with clean version**

Replace the entire `cmd_start_daemon` function (lines 412-629) with:

```rust
/// Start a sandbox via the daemon: ensures daemon is running, then creates a sandbox.
async fn cmd_start_daemon(command: &str, args: &[String]) -> anyhow::Result<()> {
    use std::io::Write;

    // Step 1: Ensure healthy daemon
    let port = ensure_healthy_daemon().await?;

    // Step 2: Create sandbox
    let mode = if command.to_lowercase().ends_with(".app") {
        "app"
    } else {
        "cli"
    };

    let full_cmd = if args.is_empty() {
        command.to_string()
    } else {
        format!("{} {}", command, args.join(" "))
    };

    println!("Creating sandbox: mode={mode}, command={full_cmd}");

    let result = client::daemon_create_sandbox(mode, Some(command), args, None, None)
        .await
        .map_err(|e| {
            eprintln!("Error: Failed to connect to daemon: {e}");
            eprintln!("Hint: Run 'cli-box start' in another terminal to start the daemon.");
            e
        })?;

    println!(
        "Sandbox created: id={}, pty_pid={:?}, window_id={:?}",
        result.sandbox_id, result.pty_pid, result.window_id
    );
    println!("Daemon port: {port}");

    // Step 3: Ensure healthy Electron (renderer connected)
    ensure_healthy_electron().await;

    // Step 4: Wait for terminal readiness (CLI sandboxes only)
    if result.pty_pid.is_some() {
        print!("Waiting for terminal");
        let _ = std::io::stdout().flush();

        let timeout = std::time::Duration::from_secs(60);
        let start = std::time::Instant::now();
        let poll_interval = std::time::Duration::from_millis(500);
        let mut dot_count: u8 = 0;

        loop {
            if start.elapsed() > timeout {
                println!();
                tracing::warn!(
                    "[start] Terminal not ready within {}s for sandbox {}",
                    timeout.as_secs(),
                    result.sandbox_id
                );
                eprintln!("Error: Terminal not ready within {}s for sandbox {}.", timeout.as_secs(), result.sandbox_id);
                eprintln!("Hint: The sandbox may not have started correctly. Try closing and restarting.");
                break;
            }

            match client::daemon_readiness_for_sandbox(&result.sandbox_id).await {
                Ok(resp) if resp.terminal_ready => {
                    println!(" done");
                    break;
                }
                Err(e) => {
                    tracing::trace!("[start] terminal readyz check failed (will retry): {e}");
                }
                _ => {}
            }

            dot_count = (dot_count % 3) + 1;
            print!(
                "\rWaiting for terminal{:<3}",
                ".".repeat(dot_count as usize)
            );
            let _ = std::io::stdout().flush();

            tokio::time::sleep(poll_interval).await;
        }
    }

    println!("Sandbox ready: id={}", result.sandbox_id);
    Ok(())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build --release -p cli-box-cli`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/cli-box-cli/src/main.rs
git commit -m "refactor(cli): rewrite cmd_start_daemon with clean lifecycle

Replaces band-aid cleanup/probe/retry logic with ensure_healthy_daemon +
ensure_healthy_electron. No more kill-and-respawn of old Electron —
the IPC fix makes auto-reconnect work."
```

---

## Task 6: Remove Old Band-Aid Functions

**Files:**
- Modify: `crates/cli-box-cli/src/main.rs` (remove `cleanup_stale_electron_processes`, `probe_running_daemon`, `kill_stale_electron`, old `find_running_electron`)

- [ ] **Step 1: Remove dead code**

In `crates/cli-box-cli/src/main.rs`, remove these functions entirely (they are no longer called after Task 5):

1. `cleanup_stale_electron_processes` (around line 1840)
2. `probe_running_daemon` (around line 1822)
3. `kill_stale_electron` (around line 1898)
4. `find_running_electron` (around line 1786) — replaced by `read_electron_json` + `is_process_alive`

Also remove their associated unit tests in `#[cfg(test)] mod tests` that reference these functions.

- [ ] **Step 2: Verify it compiles with no warnings about removed functions**

Run: `cargo build --release -p cli-box-cli`
Expected: PASS, no "unused function" warnings for removed functions

- [ ] **Step 3: Run Rust tests**

Run: `cargo test -p cli-box-cli`
Expected: PASS (all remaining tests)

- [ ] **Step 4: Commit**

```bash
git add crates/cli-box-cli/src/main.rs
git commit -m "refactor(cli): remove band-aid functions

Removes cleanup_stale_electron_processes, probe_running_daemon,
kill_stale_electron, find_running_electron and their tests.
These are replaced by ensure_healthy_daemon + ensure_healthy_electron."
```

---

## Task 7: Build Release and Manual Test

**Files:**
- Manual testing only

- [ ] **Step 1: Build release**

Run: `cd /Users/zn-ice/2026/cli-box && ./release.sh`
Expected: Release built successfully

- [ ] **Step 2: Test scenario A — Normal start (clean state)**

```bash
# Kill all existing processes
kill $(ps aux | grep -E "cli-box|CLI Box" | grep -v grep | awk '{print $2}') 2>/dev/null
sleep 3
rm -f ~/.cli-box/daemon.json ~/.cli-box/electron.json

# Start fresh
./release/cli-box start zsh
```

Expected: "Waiting for renderer done" within 10s, "Waiting for terminal done", sandbox ready.

- [ ] **Step 3: Test scenario B — Daemon restart on same port**

```bash
# With sandbox from step 2 running, kill daemon
kill $(ps aux | grep "cli-box-daemon" | grep -v grep | awk '{print $2}')
sleep 2

# Start new sandbox — CLI spawns new daemon on same port
./release/cli-box start opencode
```

Expected: New daemon starts, old Electron auto-reconnects (no 60s timeout).

- [ ] **Step 4: Test scenario C — Daemon restart on different port**

```bash
# Kill daemon + delete daemon.json (force new port)
kill $(ps aux | grep "cli-box-daemon" | grep -v grep | awk '{print $2}')
sleep 2
rm -f ~/.cli-box/daemon.json

# Start new sandbox
./release/cli-box start opencode
```

Expected: New daemon picks a port, old Electron's onclose handler discovers new port via re-read daemon.json, reconnects.

- [ ] **Step 5: Verify screenshot works after reconnection**

```bash
./release/cli-box list
./release/cli-box screenshot --id <id> -o /tmp/test_reconnect.png
```

Expected: Screenshot saved successfully.

---

## Self-Review

### Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| Remove getDaemonPort IPC cache | Task 1 |
| ensure_healthy_daemon (PID + health check) | Task 3 |
| ensure_healthy_electron (reuse if alive, spawn if dead) | Task 4 |
| Rewrite cmd_start_daemon | Task 5 |
| Remove band-aid functions | Task 6 |
| No renderer changes needed (existing onclose handler) | N/A (no code change) |

### Placeholder Scan
- All code blocks contain actual implementation
- No TBD/TODO markers
- All file paths are exact

### Type Consistency
- `is_process_alive(pid: i32)` — used consistently in Tasks 2, 3, 4
- `kill_process(pid: i32)` — used in Task 3
- `read_electron_json() -> Option<(i32, u16)>` — used in Task 4
- `daemon_health_check(port: u16) -> bool` — used in Task 3
- `ensure_healthy_daemon() -> anyhow::Result<u16>` — used in Task 5
- `ensure_healthy_electron()` — used in Task 5
