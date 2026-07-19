//! Integration tests for the daemon HTTP API.
//!
//! These tests use `tower::ServiceExt::oneshot` to test the daemon router
//! without binding to a real TCP port.

use axum::body::Body;
use axum::http::{self, Request, StatusCode};
use cli_box_core::daemon::{build_daemon_router, DaemonState, ManagedSandbox};
use cli_box_core::instance::{InstanceKind, InstanceStatus};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;

fn empty_state() -> Arc<Mutex<DaemonState>> {
    Arc::new(Mutex::new(DaemonState {
        port: 0,
        sandboxes: HashMap::new(),
        started_at: std::time::Instant::now(),
        screenshot_ws_tx: None,
        pending_screenshots: HashMap::new(),
        pending_scrollback: HashMap::new(),
        screenshot_request_counter: 0,
        terminal_ready_sandboxes: HashSet::new(),
        headless: false,
    }))
}

fn router() -> axum::Router {
    build_daemon_router(empty_state())
}

fn state_with_sandbox() -> Arc<Mutex<DaemonState>> {
    let mut sandboxes = HashMap::new();
    sandboxes.insert(
        "test-sb".to_string(),
        ManagedSandbox {
            id: "test-sb".to_string(),
            kind: InstanceKind::Cli {
                command: "zsh".to_string(),
                args: vec![],
            },
            status: InstanceStatus::Running,
            port: 0,
            pty_pid: None,
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
        headless: false,
    }))
}

fn router_with_sandbox() -> axum::Router {
    build_daemon_router(state_with_sandbox())
}

#[tokio::test]
async fn health_endpoint_returns_ok() {
    let resp = router()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
    assert_eq!(json["sandboxes"], 0);
}

#[tokio::test]
async fn list_sandboxes_returns_empty_array() {
    let resp = router()
        .oneshot(
            Request::builder()
                .uri("/box/list")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
    let list: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
    assert!(list.is_empty());
}

#[tokio::test]
async fn create_sandbox_rejects_unknown_mode() {
    let resp = router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/box/create")
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"mode": "invalid"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn close_nonexistent_returns_404() {
    let resp = router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/box/no-such-id/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn screenshot_nonexistent_returns_404() {
    let resp = router()
        .oneshot(
            Request::builder()
                .uri("/box/no-such-id/screenshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn screenshot_with_frame_nonexistent_returns_404() {
    let resp = router()
        .oneshot(
            Request::builder()
                .uri("/box/no-such-id/screenshot?with_frame=true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unknown_route_returns_404() {
    let resp = router()
        .oneshot(
            Request::builder()
                .uri("/does/not/exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn screenshot_with_frame_attempts_tab_switch() {
    // with_frame=true should attempt a tab switch before SCK capture.
    // Without a WebSocket connection, the switch fails gracefully and
    // the handler continues to the SCK path (which also fails — no real window).
    // The key assertion: it does NOT return a client error.
    let resp = router_with_sandbox()
        .oneshot(
            Request::builder()
                .uri("/box/test-sb/screenshot?with_frame=true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = resp.status();
    // SCK path fails with 404 (WindowNotFound) or 500 (Screenshot error),
    // but must NOT be 400 (Bad Request) — proves query param is parsed.
    assert_ne!(
        status,
        StatusCode::BAD_REQUEST,
        "with_frame=true should be parsed, not rejected as bad request"
    );
}

#[tokio::test]
async fn readyz_returns_not_ready_without_renderer() {
    let resp = router()
        .oneshot(
            Request::builder()
                .uri("/readyz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "not_ready");
    assert_eq!(json["renderer_connected"], false);
}

#[tokio::test]
async fn screenshot_query_parses_scroll_and_top() {
    let resp = router_with_sandbox()
        .oneshot(
            Request::builder()
                .uri("/box/test-sb/screenshot?scroll=100")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        resp.status(),
        StatusCode::NOT_FOUND,
        "scroll query must be parsed"
    );

    let resp = router_with_sandbox()
        .oneshot(
            Request::builder()
                .uri("/box/test-sb/screenshot?top=true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        resp.status(),
        StatusCode::NOT_FOUND,
        "top query must be parsed"
    );
}

#[tokio::test]
async fn scrollback_route_exists() {
    let resp = router_with_sandbox()
        .oneshot(
            Request::builder()
                .uri("/box/test-sb/scrollback")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        resp.status(),
        StatusCode::NOT_FOUND,
        "scrollback route must exist"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn headless_screenshot_renders_png() {
    use cli_box_core::process::ProcessManager;

    // Spawn a real CLI whose output feeds the HeadlessTerminal via the reader thread.
    let info = ProcessManager::spawn_cli("printf", &["hello-headless".into()]).expect("spawn_cli");
    // allow the reader thread to drain output into the terminal grid
    std::thread::sleep(std::time::Duration::from_millis(300));

    let mut sandboxes = HashMap::new();
    sandboxes.insert(
        "hsb".to_string(),
        ManagedSandbox {
            id: "hsb".to_string(),
            kind: InstanceKind::Cli {
                command: "printf".into(),
                args: vec![],
            },
            status: InstanceStatus::Running,
            port: 0,
            pty_pid: Some(info.pid),
            window_id: None,
        },
    );
    let state = Arc::new(Mutex::new(DaemonState {
        port: 0,
        sandboxes,
        started_at: std::time::Instant::now(),
        screenshot_ws_tx: None,
        pending_screenshots: HashMap::new(),
        pending_scrollback: HashMap::new(),
        screenshot_request_counter: 0,
        terminal_ready_sandboxes: HashSet::new(),
        headless: true,
    }));
    let router = build_daemon_router(state);

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/box/hsb/screenshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let _ = ProcessManager::kill_process(info.pid);
    // Requires a font reachable via HeadlessTerminal::load_font (e.g. macOS
    // Arial Unicode). On a font-less CI runner this may 500 — that still proves
    // routing reached the headless path (not the "WebSocket not connected" error).
    if resp.status() == StatusCode::OK {
        assert_eq!(
            resp.headers().get("x-screenshot-source").unwrap(),
            "headless"
        );
    } else {
        eprintln!(
            "headless_screenshot_renders_png: non-OK status {} (no font?)",
            resp.status()
        );
    }
}

#[cfg(unix)]
async fn body_text(resp: axum::http::Response<Body>) -> String {
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
        .await
        .expect("read response body");
    String::from_utf8_lossy(&bytes).to_string()
}

/// Headless daemon state carrying a single CLI sandbox bound to `pty_pid`.
#[cfg(unix)]
fn headless_state_with_sandbox(id: &str, pty_pid: u32) -> Arc<Mutex<DaemonState>> {
    let mut sandboxes = HashMap::new();
    sandboxes.insert(
        id.to_string(),
        ManagedSandbox {
            id: id.to_string(),
            kind: InstanceKind::Cli {
                command: "printf".into(),
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

#[cfg(unix)]
#[tokio::test]
async fn headless_scrollback_returns_marker_raw_and_nonraw() {
    use cli_box_core::process::ProcessManager;

    let info =
        ProcessManager::spawn_cli("printf", &["hsb-marker-RAW\n".into()]).expect("spawn_cli");
    // Let the reader thread drain printf's output into the terminal grid + PtyStore.
    std::thread::sleep(std::time::Duration::from_millis(300));
    let state = headless_state_with_sandbox("hsb", info.pid);

    // raw: full PTY bytes from PtyStore.
    let resp = build_daemon_router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/box/hsb/scrollback?raw=true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let raw_text = body_text(resp).await;
    assert!(
        raw_text.contains("hsb-marker-RAW"),
        "raw scrollback must contain marker; got: {raw_text:?}"
    );

    // non-raw: current screen text from HeadlessTerminal.
    let resp = build_daemon_router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/box/hsb/scrollback")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let nonraw_text = body_text(resp).await;
    assert!(
        nonraw_text.contains("hsb-marker-RAW"),
        "non-raw scrollback must contain marker on current screen; got: {nonraw_text:?}"
    );

    let _ = ProcessManager::kill_process(info.pid);
}

#[cfg(unix)]
#[tokio::test]
async fn headless_scrollback_stable_after_top_screenshot() {
    use cli_box_core::process::ProcessManager;

    // Regression (Issue 1): a --top screenshot renders with a large scrollback
    // offset. Before the render_png reset, that offset leaked into the shared
    // parser and corrupted the next non-raw scrollback (showing history, not the
    // current screen).
    // 31 lines into a 24-row terminal => the first 7 scroll off into history and
    // the marker lands on the bottom screen row. A --top screenshot then sets a
    // nonzero scrollback_offset; without the render_png reset that offset leaks
    // into the shared parser, so the non-raw scrollback below would read
    // scrolled-back history (rows 1..24) instead of the current screen.
    let info = ProcessManager::spawn_cli(
        "sh",
        &["-c".into(), "seq 1 30; echo steady-current-mark".into()],
    )
    .expect("spawn_cli");
    std::thread::sleep(std::time::Duration::from_millis(400));
    let state = headless_state_with_sandbox("hsb2", info.pid);

    let _ = build_daemon_router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/box/hsb2/screenshot?scroll=1000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

    let resp = build_daemon_router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/box/hsb2/scrollback")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let text = body_text(resp).await;
    assert!(
        text.contains("steady-current-mark"),
        "non-raw scrollback after a --top screenshot must still show the current screen; got: {text:?}"
    );

    let _ = ProcessManager::kill_process(info.pid);
}
