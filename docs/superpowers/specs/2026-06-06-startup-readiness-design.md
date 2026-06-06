# Startup Readiness Design

## Problem

`cli-box start` only waits for the Electron renderer's WebSocket connection. It does not wait for:
- xterm.js terminal component to mount
- Terminal dimensions to be calculated (fitAddon.fit())
- PTY WebSocket to connect

This causes subsequent operations (screenshot, type, key) to fail with "Terminal not found or not mounted" because the terminal isn't ready yet.

Additionally, when Electron is already running (`electron_newly_spawned = false`), the wait is skipped entirely.

## Root Cause

The renderer polls `/box/list` every 3 seconds to discover new sandboxes, then creates xterm.js components asynchronously. There's no signal from renderer to daemon when a terminal is ready.

## Solution

Add a `terminal_ready` message from renderer to daemon over the existing screenshot WebSocket. The daemon tracks which sandboxes have ready terminals. The CLI polls `/readyz?sandbox_id=<id>` and prints progress at each stage.

## Design

### 1. Daemon: Track terminal readiness

**File:** `crates/cli-box-core/src/daemon/mod.rs`

Add to `DaemonState`:
```rust
pub terminal_ready_sandboxes: HashSet<String>,
```

Handle `terminal_ready` message in `handle_screenshot_ws`:
```rust
Some("terminal_ready") => {
    if let Some(sandbox_id) = msg.get("sandbox_id").and_then(|v| v.as_str()) {
        let mut s = state.lock().await;
        s.terminal_ready_sandboxes.insert(sandbox_id.to_string());
        tracing::info!("[screenshot_ws] terminal ready: {}", sandbox_id);
    }
}
```

### 2. Daemon: Update readiness endpoint

**File:** `crates/cli-box-core/src/daemon/mod.rs`

Add `sandbox_id` query parameter to `readyz_handler`:
```rust
async fn readyz_handler(
    State(state): State<Arc<Mutex<DaemonState>>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<DaemonReadinessResponse> {
    let s = state.lock().await;
    let renderer_connected = s.screenshot_ws_tx.is_some();
    let terminal_ready = if let Some(sandbox_id) = params.get("sandbox_id") {
        s.terminal_ready_sandboxes.contains(sandbox_id.as_str())
    } else {
        true // No specific sandbox requested, not applicable
    };
    // ...
}
```

Update `DaemonReadinessResponse`:
```rust
pub struct DaemonReadinessResponse {
    pub status: String,
    pub renderer_connected: bool,
    pub terminal_ready: bool,
}
```

### 3. Renderer: Send terminal_ready on mount

**File:** `electron-app/src/renderer/main.tsx`

After SandboxTerminal mounts (xterm.js initialized), send over WebSocket:
```typescript
ws?.send(JSON.stringify({
    type: "terminal_ready",
    sandbox_id: tab.id,
}));
```

### 4. CLI: Wait for terminal readiness with progress

**File:** `crates/cli-box-cli/src/main.rs`

Refactor `cmd_start_daemon` wait logic:
```
Step 1: "Creating sandbox..." → daemon_create_sandbox
Step 2: "Sandbox created. Waiting for renderer..." → poll /readyz (renderer_connected)
Step 3: "Renderer connected. Waiting for terminal..." → poll /readyz?sandbox_id=<id> (terminal_ready)
Step 4: "Terminal ready." → complete
```

Each step prints a progress line. If Electron is already running, skip step 2 but still wait for step 3.

### 5. Client: Update daemon_readiness to accept sandbox_id

**File:** `crates/cli-box-cli/src/client.rs`

```rust
pub async fn daemon_readiness_for_sandbox(sandbox_id: &str) -> Result<DaemonReadinessResponse> {
    let base = daemon_base_url()?;
    let client = reqwest_client();
    let resp = client
        .get(format!("{base}/readyz?sandbox_id={sandbox_id}"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await?;
    let readiness: DaemonReadinessResponse = resp.json().await?;
    Ok(readiness)
}
```

## Behavior Matrix

| Scenario | Wait For | Progress |
|----------|----------|----------|
| Electron newly spawned | renderer_connected + terminal_ready | "Creating sandbox..." → "Waiting for renderer..." → "Waiting for terminal..." → "Ready." |
| Electron already running | terminal_ready only | "Creating sandbox..." → "Waiting for terminal..." → "Ready." |
| Timeout (60s) | Continue anyway | Warning message |

## Testing

- `cli-box start opencode` → prints progress lines, completes when terminal ready
- `cli-box start zsh` (second sandbox, Electron already running) → prints progress, waits for terminal
- `cli-box screenshot --id <id>` immediately after start → succeeds (no "Terminal not found")
