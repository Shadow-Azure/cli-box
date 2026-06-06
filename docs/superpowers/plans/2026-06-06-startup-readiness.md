# Startup Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cli-box start` wait for xterm.js terminal readiness before returning, with per-stage progress output.

**Architecture:** Renderer sends `terminal_ready` over existing screenshot WebSocket when xterm.js mounts. Daemon tracks ready sandboxes. CLI polls `/readyz?sandbox_id=<id>` with progress output.

**Tech Stack:** Rust (axum, tokio) · TypeScript (React, xterm.js)

---

### Task 1: Daemon — Track terminal readiness

**Files:**
- Modify: `crates/cli-box-core/src/daemon/mod.rs:48-58` (DaemonState)
- Modify: `crates/cli-box-core/src/daemon/mod.rs:126-132` (DaemonReadinessResponse)
- Modify: `crates/cli-box-core/src/daemon/mod.rs:293-309` (readyz_handler)
- Modify: `crates/cli-box-core/src/daemon/mod.rs:738-776` (screenshot_ws message handling)

- [ ] **Step 1: Add `terminal_ready_sandboxes` to `DaemonState`**

In `crates/cli-box-core/src/daemon/mod.rs`, add `use std::collections::HashSet;` at the top imports if not already present.

Then add field to `DaemonState` (after line 57):

```rust
    pub terminal_ready_sandboxes: HashSet<String>,
```

And in the `DaemonState::new()` or initialization (find where DaemonState is constructed), add:
```rust
terminal_ready_sandboxes: HashSet::new(),
```

- [ ] **Step 2: Update `DaemonReadinessResponse`**

Replace the struct (lines 126-132):

```rust
#[derive(Debug, Serialize)]
pub struct DaemonReadinessResponse {
    /// "ready" if renderer WebSocket is connected, "not_ready" otherwise.
    pub status: String,
    /// Whether the Electron renderer's screenshot WebSocket is connected.
    pub renderer_connected: bool,
    /// Whether the requested sandbox's terminal is ready (true if no sandbox_id requested).
    pub terminal_ready: bool,
}
```

- [ ] **Step 3: Update `readyz_handler` to accept `sandbox_id` query param**

Replace the readyz_handler (lines 293-309):

```rust
async fn readyz_handler(
    State(state): State<Arc<Mutex<DaemonState>>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Json<DaemonReadinessResponse> {
    let s = state.lock().await;
    let renderer_connected = s.screenshot_ws_tx.is_some();
    let terminal_ready = match params.get("sandbox_id") {
        Some(sandbox_id) => s.terminal_ready_sandboxes.contains(sandbox_id.as_str()),
        None => true,
    };
    Json(DaemonReadinessResponse {
        status: if renderer_connected && terminal_ready {
            "ready".to_string()
        } else {
            "not_ready".to_string()
        },
        renderer_connected,
        terminal_ready,
    })
}
```

- [ ] **Step 4: Handle `terminal_ready` message in screenshot WebSocket**

In `handle_screenshot_ws`, add a new match arm in the `msg_type` match (before the `_ =>` catch-all, around line 771):

```rust
                                    Some("terminal_ready") => {
                                        if let Some(sandbox_id) = msg.get("sandbox_id").and_then(|v| v.as_str()) {
                                            let mut s = state.lock().await;
                                            s.terminal_ready_sandboxes.insert(sandbox_id.to_string());
                                            tracing::info!(
                                                "[screenshot_ws] terminal ready: {}",
                                                sandbox_id
                                            );
                                        }
                                    }
```

- [ ] **Step 5: Verify compilation**

Run: `cargo check -p cli-box-core`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add crates/cli-box-core/src/daemon/mod.rs
git commit -m "feat(daemon): track per-sandbox terminal readiness via WebSocket"
```

---

### Task 2: Renderer — Send terminal_ready on mount

**Files:**
- Modify: `electron-app/src/renderer/main.tsx:114-210` (screenshot WebSocket)

- [ ] **Step 1: Add terminal_ready notification after WebSocket connects**

In `electron-app/src/renderer/main.tsx`, inside the `ws.onopen` handler (around line 131), after `console.log("[screenshot-ws] connected")`, add a notification for existing terminals:

```typescript
ws.onopen = () => {
    console.log("[screenshot-ws] connected");
    reconnectDelay = 1000;
    // Notify daemon that existing terminals are ready
    for (const tab of tabsRef.current) {
        const ref = terminalRefs.current.get(tab.id);
        if (ref?.current) {
            ws?.send(JSON.stringify({
                type: "terminal_ready",
                sandbox_id: tab.id,
            }));
        }
    }
};
```

- [ ] **Step 2: Send terminal_ready when new terminals mount**

Find where new tabs are created in the terminal area rendering (around line 336-343). After `SandboxTerminal` is rendered, we need a way to detect when it's ready.

Add a callback mechanism. In the `SandboxTerminal` component, the `onReady` callback is already called after `fitAddon.fit()` completes. We need to use this.

In the terminal rendering section, find the `SandboxTerminal` component usage. Add an `onReady` callback:

Replace the SandboxTerminal rendering (around line 341-343):
```typescript
<SandboxTerminal ref={tabRef} sandboxId={tab.id} ptyPid={tab.sandbox.pty_pid!} />
```

With:
```typescript
<SandboxTerminal
    ref={tabRef}
    sandboxId={tab.id}
    ptyPid={tab.sandbox.pty_pid!}
    onReady={() => {
        if (screenshotWsRef.current?.readyState === WebSocket.OPEN) {
            screenshotWsRef.current.send(JSON.stringify({
                type: "terminal_ready",
                sandbox_id: tab.id,
            }));
        }
    }}
/>
```

- [ ] **Step 3: Store WebSocket ref for access from onReady callback**

We need a ref to the screenshot WebSocket. Add a ref near the other refs (around line 22-25):

```typescript
const screenshotWsRef = useRef<WebSocket | null>(null);
```

In the WebSocket connection code, after `ws = new WebSocket(...)` (around line 129), add:
```typescript
screenshotWsRef.current = ws;
```

In the cleanup code, add:
```typescript
screenshotWsRef.current = null;
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd electron-app && pnpm typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/renderer/main.tsx
git commit -m "feat(renderer): notify daemon when terminal is ready"
```

---

### Task 3: CLI — Wait for terminal readiness with progress

**Files:**
- Modify: `crates/cli-box-cli/src/client.rs:51-70` (daemon_readiness)
- Modify: `crates/cli-box-cli/src/main.rs:412-528` (cmd_start_daemon)

- [ ] **Step 1: Add `daemon_readiness_for_sandbox` client function**

In `crates/cli-box-cli/src/client.rs`, add after `daemon_readiness`:

```rust
/// Check daemon readiness for a specific sandbox (terminal mounted).
pub async fn daemon_readiness_for_sandbox(sandbox_id: &str) -> Result<DaemonReadinessResponse> {
    let base = daemon_base_url()?;
    let client = reqwest_client();
    let resp = client
        .get(format!("{base}/readyz?sandbox_id={sandbox_id}"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .with_context(|| "Failed to connect to daemon readyz endpoint")?;
    let readiness: DaemonReadinessResponse = resp.json().await?;
    Ok(readiness)
}
```

- [ ] **Step 2: Refactor `cmd_start_daemon` wait logic**

Replace the wait section in `cmd_start_daemon` (lines 470-525). The new logic:

```rust
    // Spawn Electron only if not already running.
    let electron_newly_spawned = if find_running_electron() {
        tracing::info!("[start] Electron already running, skipping spawn");
        false
    } else if let Some(electron_bin) = find_electron_binary() {
        tracing::info!("[start] spawning Electron: {}", electron_bin.display());
        let _child = Command::new(&electron_bin)
            .spawn()
            .context("Failed to launch Electron app")?;
        tracing::info!("[start] Electron launched");
        true
    } else {
        tracing::warn!("[start] Electron app not found, running in headless daemon mode");
        false
    };

    use std::io::Write;

    // Phase 1: Wait for renderer WebSocket (only if Electron was newly spawned)
    if electron_newly_spawned {
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
                    "[start] Renderer WebSocket did not connect within {}s, continuing anyway",
                    timeout.as_secs()
                );
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
            print!("\rWaiting for renderer{:<3}", ".".repeat(dot_count as usize));
            let _ = std::io::stdout().flush();

            tokio::time::sleep(poll_interval).await;
        }
    }

    // Phase 2: Wait for terminal readiness
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
                "[start] Terminal not ready within {}s for sandbox {}, continuing anyway",
                timeout.as_secs(),
                result.sandbox_id
            );
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
        print!("\rWaiting for terminal{:<3}", ".".repeat(dot_count as usize));
        let _ = std::io::stdout().flush();

        tokio::time::sleep(poll_interval).await;
    }

    Ok(())
```

- [ ] **Step 3: Verify compilation**

Run: `cargo check -p cli-box-cli`
Expected: No errors

- [ ] **Step 4: Run clippy**

Run: `cargo clippy -p cli-box-cli -p cli-box-core -- -D warnings`
Expected: No warnings

- [ ] **Step 5: Commit**

```bash
git add crates/cli-box-cli/src/client.rs crates/cli-box-cli/src/main.rs
git commit -m "feat(cli): wait for terminal readiness with progress output"
```

---

### Task 4: Build and verify

- [ ] **Step 1: Run all tests**

Run: `sh test.sh`
Expected: All tests pass

- [ ] **Step 2: Build release**

Run: `sh release.sh`
Expected: Build succeeds

- [ ] **Step 3: Manual test**

```bash
# Kill existing daemon/electron
pkill -f cli-box-daemon; pkill -f "CLI Box"

# Test 1: Fresh start (Electron newly spawned)
./release/cli-box start opencode
# Expected: "Waiting for renderer... done" then "Waiting for terminal... done"

# Test 2: Second sandbox (Electron already running)
./release/cli-box start zsh
# Expected: "Waiting for terminal... done" (no renderer wait)

# Test 3: Screenshot immediately after start
./release/cli-box screenshot --id <zsh-id> -o test.png
# Expected: Screenshot succeeds (no "Terminal not found")

./release/cli-box close <opencode-id>
./release/cli-box close <zsh-id>
```

- [ ] **Step 4: Commit release test report**

```bash
git add release_test/
git commit -m "test: release test for startup readiness"
```
