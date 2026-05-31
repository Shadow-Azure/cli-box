# Phase 3: AXUIElement UI Inspection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose AXUIElement UI inspection (inspect_window, find_elements, get_element_value) through daemon HTTP endpoints and CLI commands so agents can read sandbox UI structure.

**Architecture:** The `UiInspector` functions already exist in `sandbox-core/src/automation/ax_ui.rs`. We wire them through the daemon's HTTP routes and add CLI commands + MCP tools.

**Tech Stack:** Rust, axum, clap, serde

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `crates/sandbox-core/src/daemon/mod.rs` | Modify | Add `/sandbox/{id}/ui/inspect`, `/sandbox/{id}/ui/find`, `/sandbox/{id}/ui/value` routes |
| `crates/sandbox-cli/src/main.rs` | Modify | Add `UiInspect`, `UiFind`, `UiValue` CLI commands |
| `crates/sandbox-cli/src/client.rs` | Modify | Add `ui_inspect()`, `ui_find()`, `ui_value()` client methods |

---

### Task 1: Add UI inspection HTTP endpoints to daemon

**Files:**
- Modify: `crates/sandbox-core/src/daemon/mod.rs`

- [ ] **Step 1: Add request/response types**

Add after the existing request types (around line 80):

```rust
#[derive(Deserialize)]
pub struct UiFindRequest {
    pub role: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Serialize)]
pub struct UiValueResponse {
    pub value: Option<String>,
}
```

- [ ] **Step 2: Add route registrations**

Add after the existing `.route(...)` calls (around line 207):

```rust
.route("/sandbox/{id}/ui/inspect", get(ui_inspect_handler))
.route("/sandbox/{id}/ui/find", post(ui_find_handler))
.route("/sandbox/{id}/ui/value", get(ui_value_handler))
```

- [ ] **Step 3: Implement handler functions**

Add after the existing handler functions:

```rust
async fn ui_inspect_handler(
    State(state): State<Arc<Mutex<DaemonState>>>,
    Path(id): Path<String>,
) -> Result<Json<crate::automation::ax_ui::UiElement>, AppError> {
    let state = state.lock().await;
    let sandbox = state.sandboxes.get(&id)
        .ok_or_else(|| AppError::BadRequest(format!("Sandbox not found: {id}")))?;
    let window_id = sandbox.window_id
        .ok_or_else(|| AppError::BadRequest("Sandbox has no window_id".into()))?;
    let element = crate::automation::ax_ui::UiInspector::inspect_window(window_id)?;
    Ok(Json(element))
}

async fn ui_find_handler(
    State(state): State<Arc<Mutex<DaemonState>>>,
    Path(id): Path<String>,
    Json(req): Json<UiFindRequest>,
) -> Result<Json<Vec<crate::automation::ax_ui::UiElement>>, AppError> {
    let state = state.lock().await;
    let sandbox = state.sandboxes.get(&id)
        .ok_or_else(|| AppError::BadRequest(format!("Sandbox not found: {id}")))?;
    let window_id = sandbox.window_id
        .ok_or_else(|| AppError::BadRequest("Sandbox has no window_id".into()))?;
    let elements = crate::automation::ax_ui::UiInspector::find_elements(
        window_id, &req.role, req.title.as_deref()
    )?;
    Ok(Json(elements))
}

async fn ui_value_handler(
    State(state): State<Arc<Mutex<DaemonState>>>,
    Path(id): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<UiValueResponse>, AppError> {
    let _state = state.lock().await;
    let element_id = params.get("element_id")
        .ok_or_else(|| AppError::BadRequest("Missing element_id".into()))?;
    let value = crate::automation::ax_ui::UiInspector::get_element_value(element_id)?;
    Ok(Json(UiValueResponse { value }))
}
```

- [ ] **Step 4: Verify compilation**

Run: `cargo check -p sandbox-core`
Expected: PASS (no errors)

- [ ] **Step 5: Commit**

```bash
git add crates/sandbox-core/src/daemon/mod.rs
git commit -m "feat(daemon): add UI inspection HTTP endpoints"
```

---

### Task 2: Add UI inspection CLI commands

**Files:**
- Modify: `crates/sandbox-cli/src/main.rs`
- Modify: `crates/sandbox-cli/src/client.rs`

- [ ] **Step 1: Add client methods**

Add to `crates/sandbox-cli/src/client.rs` after existing `daemon_*` functions, following the same pattern:

```rust
pub async fn daemon_ui_inspect(sandbox_id: &str) -> Result<serde_json::Value> {
    let base = daemon_base_url()?;
    let url = format!("{base}/sandbox/{sandbox_id}/ui/inspect");
    let resp = reqwest::Client::new().get(&url).send().await?.error_for_status()?;
    Ok(resp.json().await?)
}

pub async fn daemon_ui_find(sandbox_id: &str, role: &str, title: Option<&str>) -> Result<serde_json::Value> {
    let base = daemon_base_url()?;
    let url = format!("{base}/sandbox/{sandbox_id}/ui/find");
    let mut body = serde_json::json!({ "role": role });
    if let Some(t) = title {
        body["title"] = serde_json::json!(t);
    }
    let resp = reqwest::Client::new().post(&url).json(&body).send().await?.error_for_status()?;
    Ok(resp.json().await?)
}

pub async fn daemon_ui_value(sandbox_id: &str, element_id: &str) -> Result<serde_json::Value> {
    let base = daemon_base_url()?;
    let url = format!("{base}/sandbox/{sandbox_id}/ui/value?element_id={element_id}");
    let resp = reqwest::Client::new().get(&url).send().await?.error_for_status()?;
    Ok(resp.json().await?)
}
```

- [ ] **Step 2: Add CLI command variants**

Add to the `Commands` enum in `main.rs`:

```rust
/// Inspect UI tree of a sandbox window
UiInspect {
    /// Sandbox ID
    #[arg(long)]
    id: String,
},
/// Find UI elements by role/title
UiFind {
    /// Sandbox ID
    #[arg(long)]
    id: String,
    /// AX role (e.g., AXButton, AXTextField)
    #[arg(long)]
    role: String,
    /// Optional title filter
    #[arg(long)]
    title: Option<String>,
},
/// Get value of a UI element
UiValue {
    /// Sandbox ID
    #[arg(long)]
    id: String,
    /// Element ID
    #[arg(long)]
    element_id: String,
},
```

- [ ] **Step 3: Add command handlers**

Add match arms in the command dispatch:

```rust
Commands::UiInspect { id } => {
    let tree = client::daemon_ui_inspect(&id).await?;
    println!("{}", serde_json::to_string_pretty(&tree)?);
}
Commands::UiFind { id, role, title } => {
    let elements = client::daemon_ui_find(&id, &role, title.as_deref()).await?;
    println!("{}", serde_json::to_string_pretty(&elements)?);
}
Commands::UiValue { id, element_id } => {
    let value = client::daemon_ui_value(&id, &element_id).await?;
    println!("{}", serde_json::to_string_pretty(&value)?);
}
```

- [ ] **Step 4: Verify compilation**

Run: `cargo check -p sandbox-cli`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/sandbox-cli/src/main.rs crates/sandbox-cli/src/client.rs
git commit -m "feat(cli): add ui-inspect, ui-find, ui-value commands"
```

---

### Task 3: Manual verification

- [ ] **Step 1: Build and run**

Run: `cargo build -p sandbox-cli && cargo build -p sandbox-daemon`

- [ ] **Step 2: Start a sandbox**

Run: `cargo run -p sandbox-cli -- start zsh`

- [ ] **Step 3: Test UI inspect**

Run: `cargo run -p sandbox-cli -- ui-inspect --id <sandbox-id>`
Expected: JSON tree of AX elements (or error if no window_id — expected for CLI sandboxes)

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "feat(phase3): UI inspection endpoints and CLI commands"
```
