# Auto Input Routing Design

## Problem

The `key` and `type` CLI commands require `--pty` flag for CLI/TUI apps (like Claude Code, zsh). Without it, they default to CGEvent mode, which doesn't reliably reach PTY-based processes. Users must remember to add `--pty` for every CLI/TUI sandbox interaction.

## Root Cause

The input routing decision is entirely on the CLI side. The daemon already knows the sandbox type via `InstanceKind` (`Cli` or `App`), but the CLI doesn't use this information to auto-select the input method.

## Solution

Auto-detect the sandbox type by querying the daemon's `/box/list` endpoint, and route input accordingly:
- `InstanceKind::Cli` → PTY write (direct stdin)
- `InstanceKind::App` → CGEvent (macOS-level key events)

Keep `--pty` flag as an explicit override for edge cases.

## Design

### File: `crates/cli-box-cli/src/main.rs`

#### 1. Add helper function to query sandbox kind

```rust
async fn resolve_sandbox_kind(id: &str) -> anyhow::Result<cli_box_core::instance::InstanceKind> {
    let sandboxes = client::daemon_list_sandboxes().await?;
    sandboxes
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.kind.clone())
        .ok_or_else(|| anyhow::anyhow!("Sandbox '{}' not found", id))
}
```

#### 2. Modify `cmd_type_daemon` signature and logic

Change `pty: bool` to `pty: Option<bool>`:
- `Some(true)` → force PTY (explicit `--pty`)
- `Some(false)` → force CGEvent (explicit `--no-pty` or similar, if needed)
- `None` → auto-detect via `resolve_sandbox_kind`

```rust
async fn cmd_type_daemon(text: &str, id: &str, pty: Option<bool>) -> anyhow::Result<()> {
    let use_pty = match pty {
        Some(explicit) => explicit,
        None => matches!(resolve_sandbox_kind(id).await?, InstanceKind::Cli { .. }),
    };
    if use_pty {
        client::daemon_pty_write(id, text).await?;
        println!("Typed (PTY): {:?} -> sandbox {}", text, id);
    } else {
        client::daemon_type(id, text).await?;
        println!("Typed: {:?} -> sandbox {}", text, id);
    }
    Ok(())
}
```

#### 3. Modify `cmd_key_daemon` with same pattern

Same `pty: Option<bool>` pattern, auto-detect via `resolve_sandbox_kind`.

#### 4. Update CLI argument parsing

Change `--pty` from `bool` flag to `Option<bool>`:
- `--pty` present → `Some(true)`
- absent → `None` (auto-detect)

```rust
/// Use PTY write instead of CGEvent (auto-detected if omitted)
#[arg(long)]
pty: Option<bool>,
```

### File: `crates/cli-box-cli/src/client.rs`

No changes needed. `daemon_list_sandboxes()` already returns `Vec<DaemonSandbox>` with `kind: InstanceKind`.

### File: `crates/cli-box-core/src/daemon/mod.rs`

No changes needed. `/box/list` already returns `ManagedSandbox` with `kind` field.

## Behavior Matrix

| Sandbox Kind | `--pty` flag | Result |
|-------------|-------------|--------|
| `Cli` | absent | PTY write (auto) |
| `Cli` | `--pty` | PTY write (explicit) |
| `App` | absent | CGEvent (auto) |
| `App` | `--pty` | PTY write (override) |

## Testing

- `cli-box type --id <cli-sandbox> "hello"` → should use PTY without `--pty` flag
- `cli-box key --id <cli-sandbox> return` → should use PTY without `--pty` flag
- `cli-box type --id <app-sandbox> "hello"` → should use CGEvent
- `cli-box type --id <cli-sandbox> --pty "hello"` → explicit PTY still works
