---
name: cli-box
description: macOS desktop automation sandbox — run CLI tools and macOS apps in isolated sandbox windows with screenshot feedback and input simulation
---

# cli-box

macOS desktop automation sandbox. Launch isolated sandbox windows from the CLI, run any CLI tool (Claude Code, OpenCode, zsh, etc.) inside them, and automate via screenshot + keyboard/mouse simulation.

## Prerequisites

- macOS 14.0+ (Sonoma), Apple Silicon or Intel
- **Accessibility** permission (System Settings → Privacy & Security → Accessibility)
- **Screen Recording** permission (System Settings → Privacy & Security → Screen Recording)

Both permissions must be granted manually. Add `cli-box` and `CLI Box.app` to both lists.

## Installation

```bash
npx cli-box-skill install
```

Choose Claude Code, OpenCode, and/or OpenClaw. Or non-interactively:

```bash
npx cli-box-skill install claude   # claude | opencode | openclaw | all
```

## Upgrade

Upgrade to the latest version (stops running sandboxes first):

```bash
cli-box-skill upgrade
```

Upgrade to a specific version:

```bash
cli-box-skill upgrade 0.3.0
```

> **Note:** `upgrade` does NOT overwrite your SKILL.md. Use `npx cli-box-skill install`
> if you want to reset SKILL.md to the bundled version.

## Quick Start

```bash
# Start a sandbox running Claude Code
cli-box start claude

# Start a sandbox running zsh
cli-box start zsh

# List all active sandboxes
cli-box list

# Take a screenshot of a sandbox
cli-box screenshot --id <sandbox-id> -o screenshot.png

# Type text into a sandbox (auto-detects input mode)
cli-box type --id <sandbox-id> "hello world"

# Press Enter to send
cli-box key --id <sandbox-id> Return

# Close a sandbox
cli-box close <sandbox-id>
```

## Commands

### Sandbox Management

| Command | Description |
|---------|-------------|
| `cli-box start [command]` | Start sandbox (default: zsh). Supports `claude`, `opencode`, `zsh`, `bash`, or any CLI |
| `cli-box start /path/to/App.app` | Start sandbox with a macOS application |
| `cli-box start claude -- -p "question"` | Start sandbox with arguments |
| `cli-box start "cd /path && claude -r"` | Compound commands run via `zsh -lc` (`&&`, `;`, `\|`, `cd`, redirects) |
| `cli-box list` | List all active sandboxes with ID, title, status, port |
| `cli-box close <id>` | Close a sandbox and clean up |
| `cli-box inspect <id>` | Show sandbox details |

### Input Simulation

| Command | Description |
|---------|-------------|
| `cli-box type --id <id> "text"` | Type text (auto-detects PTY vs CGEvent) |
| `cli-box key --id <id> Return` | Press a key (auto-detects PTY vs CGEvent) |
| `cli-box key --id <id> ctrl+c` | Send Ctrl+C |
| `cli-box key --id <id> up` | Arrow keys |
| `cli-box click --id <id> 100 200` | Mouse click at coordinates (CGEvent) |

### Screenshots

By default a screenshot captures the **visible viewport** — the latest content a
human sees — not the top of the scrollback.

| Command | Description |
|---------|-------------|
| `cli-box screenshot --id <id>` | Screenshot to stdout (base64) |
| `cli-box screenshot --id <id> -o file.png` | Screenshot to file (visible viewport) |
| `cli-box screenshot --id <id> --up 100 -o h.png` | Slide the capture window up 100 lines (see older output) |
| `cli-box screenshot --id <id> --top -o top.png` | Jump to the top of the scrollback |

### Session Text (scrollback)

Dump the **entire session** as clean text (ANSI-free) — the full terminal buffer.

| Command | Description |
|---------|-------------|
| `cli-box scrollback --id <id>` | Print whole session text to stdout |
| `cli-box scrollback --id <id> -o session.txt` | Write to a file |
| `cli-box scrollback --id <id> --raw` | Preserve trailing whitespace (default trims) |
| `cli-box scrollback --id <id> --from-line 10 --to-line 50` | 1-based inclusive line range |

### UI Inspection

| Command | Description |
|---------|-------------|
| `cli-box ui-inspect --id <id>` | Print UI element tree (App) or terminal text (CLI/TUI) |
| `cli-box ui-find --id <id> --role <role>` | Find elements by AX role (e.g., AXButton, AXTextField) |
| `cli-box ui-find --id <id> --role <role> --title <title>` | Find elements by role and title |
| `cli-box ui-value --id <id> --element-id <eid>` | Get value of a UI element by its index |

For **App sandboxes** (macOS .app): returns the AX accessibility element tree with element indices, roles, titles, values, and available actions.

For **CLI sandboxes** (CLI tools): returns the terminal text output from the PTY buffer.

For **TUI sandboxes** (vim, htop, etc.): returns parsed terminal content with ANSI escape sequences stripped.

### MCP Integration

Add to `.claude/settings.json` or `.opencode/config.json`:

```json
{
  "mcpServers": {
    "cli-box": {
      "command": "cli-box",
      "args": ["mcp-serve"]
    }
  }
}
```

Then use tools: `start_sandbox`, `screenshot_sandbox` (supports `up`/`top` scroll), `scrollback_sandbox`, `type_text`, `press_key`, `close_sandbox`, `list_sandboxes`.

## Typical Workflow

```bash
# 1. Start sandbox
cli-box start claude
# → Returns: Sandbox started: abc123

# 2. Wait for tool to initialize
sleep 10

# 3. Screenshot to see current state
cli-box screenshot --id abc123 -o state.png

# 4. Interact
cli-box type --id abc123 "Write a hello world function"
cli-box key --id abc123 Return

# 5. Wait and screenshot again
sleep 15
cli-box screenshot --id abc123 -o result.png

# 6. Clean up
cli-box close abc123
```

## Notes

- Input mode is auto-detected: CLI tools use PTY, GUI apps use CGEvent
- Each sandbox gets its own Electron tab and HTTP port
- The daemon auto-starts on first `cli-box start` and manages all sandboxes
