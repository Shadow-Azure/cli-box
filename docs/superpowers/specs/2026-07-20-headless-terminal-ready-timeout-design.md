# Headless terminal_ready Timeout — Design

**Date**: 2026-07-20
**Scope**: `daemon`
**Branch**: `fix/daemon-headless-terminal-ready`

## Problem

On Linux/cloud hosts (the Aliyun headless test env, and any machine without an
Electron binary), `cli-box start` always blocks for the full 60s terminal
readiness timeout before reporting the sandbox ready. The sandbox is actually
usable within milliseconds — the wait is pure waste, and the trailing error
hint ("Terminal not ready within 60s …") is misleading.

## Root Cause

The CLI's terminal-readiness poll (`crates/cli-box-cli/src/main.rs:497-540`)
asks `/readyz?sandbox_id=<id>` every 500 ms and only proceeds when the response
carries `terminal_ready == true`.

`terminal_ready` for a specific sandbox is `true` only when the sandbox id is
present in `DaemonState::terminal_ready_sandboxes`
(`crates/cli-box-core/src/daemon/mod.rs:345-348`). That set is populated by
**exactly one** code path: the Electron renderer sends
`{type:"terminal_ready", sandbox_id}` over the screenshot WebSocket, and the
daemon inserts it (`daemon/mod.rs:1039-1042`).

In headless mode this path cannot fire:

1. No Electron binary ⇒ the CLI starts the daemon with `--headless`
   (`main.rs:1850-1854`) and `ensure_healthy_electron()` returns immediately
   (`main.rs:1923-1928`). No renderer is spawned.
2. With no renderer, the screenshot WebSocket is never opened, so
   `terminal_ready_sandboxes` is never populated.
3. The CLI poll therefore always sees `terminal_ready == false` and times out
   at exactly 60 s.

The "固定 60s" symptom is a guaranteed timeout, not slow startup. The PTY and
the server-side `HeadlessTerminal` grid are ready almost immediately — nothing
just signals that fact in headless mode.

## Solution

Make the daemon itself answer the readiness question in headless mode, since
there is no renderer to do it. A sandbox is terminal-ready in headless mode as
soon as its PTY exists (PTYs are spawned synchronously inside
`create_sandbox_handler` before the response is returned, so this is race-free).

### Change: `readyz_handler` (`daemon/mod.rs:339-358`)

Compute `terminal_ready` based on PTY existence when `state.headless` is set;
leave the non-headless (renderer-driven) path untouched.

```rust
let terminal_ready = match params.get("sandbox_id") {
    None => true,
    Some(sandbox_id) => {
        if s.headless {
            // No renderer in headless mode; the terminal is ready as soon as
            // the sandbox's PTY exists (spawned synchronously at creation).
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

### Why this shape

- **`pty_pid.is_some()` mirrors the CLI's own gate.** The CLI only polls when
  `result.pty_pid.is_some()` (`main.rs:493`), i.e. for CLI sandboxes. App
  sandboxes have `pty_pid: None` and never enter the wait, so returning `false`
  for them is harmless and consistent.
- **Unknown sandbox_id ⇒ `false`.** Same as the non-headless path, which also
  yields `false` for an unknown id.
- **No protocol change.** No new field on `DaemonReadinessResponse`; the CLI,
  MCP, and HTTP clients are unchanged. The `None`-sandbox_id branch keeps
  returning `true` (overall daemon readiness).

## Out of Scope

- The non-headless readiness path is untouched.
- `ensure_healthy_electron()` already early-returns in headless mode, so its
  separate 60s renderer wait is not hit. No change there.
- The CLI's 60s timeout stays as a safety net for the non-headless path; in
  headless it returns on the first poll.
- **`status` and `renderer_connected` are left headless-unaware.** In headless
  mode `renderer_connected` is `false` (no Electron WS — truthful) and so
  `status` stays `"not_ready"` even when `terminal_ready` is `true`. This is
  accepted: in the CLI's `DaemonReadinessResponse` both fields are
  `#[allow(dead_code)]` — the CLI gates solely on `terminal_ready`, and no other
  client reads them. Making `status` consistent is cosmetic and deliberately
  deferred (YAGNI).

## Testing

**IT (integration)** — `crates/cli-box-core/tests/daemon_integration.rs`,
alongside the existing `readyz_returns_not_ready_without_renderer` test and the
`headless_state_with_sandbox(id, pty_pid)` helper (`#[cfg(unix)]`, line 352).

Add a test `readyz_terminal_ready_in_headless_mode` that:

1. Builds the router from `headless_state_with_sandbox("sb-1", 4242)` and sends
   `GET /readyz?sandbox_id=sb-1` ⇒ asserts `terminal_ready == true`. (Do **not**
   assert `status == "ready"` — see "Out of Scope": `renderer_connected` is
   false in headless, so `status` stays `"not_ready"`. The CLI gates solely on
   `terminal_ready`, which is what we assert.)
2. Sends `GET /readyz?sandbox_id=unknown` ⇒ asserts `terminal_ready == false`.

Add `readyz_terminal_ready_uses_renderer_set_when_not_headless` (or extend an
existing test) confirming that with `headless: false`, `terminal_ready` still
follows `terminal_ready_sandboxes` (insert ⇒ true; absent ⇒ false) — guarding
the regression that the headless branch must not affect the GUI path.

**Manual / E2E** — on the Aliyun headless host, `cli-box start` returns
" Sandbox ready" within ~1s instead of 60s, and the misleading 60s error/hint
is no longer printed. (Captured as a release-test step; not a unit assertion.)

## Risks

- **Readiness semantics drift.** Headless readiness now means "PTY spawned"
  rather than "xterm.js mounted". These are equivalent in headless mode (no
  renderer to mount), so no caller is affected.
- **Future caller expecting renderer-based readiness in headless.** None exist
  today; the readiness endpoint remains the single source of truth.
