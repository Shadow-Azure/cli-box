# Compound `start`, Viewport Screenshot & OpenClaw Skill — Design

**Date:** 2026-06-17
**Target version:** 0.2.8
**Status:** Draft (awaiting user review)

---

## 1. Problem

Three issues surfaced during release testing of v0.2.7:

### 1.1 OpenClaw cannot access screenshots

When the `cli-box` skill is installed for **OpenClaw**, the installed `SKILL.md`
gives the agent no hint that OpenClaw is sandboxed to `/tmp/openclaw/`. The agent
writes screenshots to the current working directory (the default
`-o screenshot.png`), OpenClaw cannot read them, and the image is never sent.

### 1.2 `cli-box start` rejects compound commands

`cli-box start "cd /path && claude -r"` fails. `spawn_cli_with_size` builds the
PTY child with `CommandBuilder::new(command)`, treating the entire string
(`cd /path && claude -r`) as the executable name. There is no shell in the path,
so `&&`, `;`, `|`, `cd` (a builtin), and redirects are never interpreted. The
same applies to `cli-box start "claude -p hi"` (a command-with-args passed as a
single quoted token).

### 1.3 Screenshots capture the top of the scrollback, not the visible viewport

For a complex/long-running `claude` task, `cli-box screenshot` returns the
**oldest** lines of the session, not what is currently visible. Root cause:
the default screenshot path runs through the Electron renderer's
`captureToPng()` (`Terminal.tsx`). Its buffer-fallback renderer loops
`for (let y = 0; y < rows; y++) buffer.getLine(y)`, which reads lines
`0..rows` — the **top** of the scrollback — instead of the visible viewport
(`buffer.baseY .. baseY+rows`).

Two follow-on needs ride on this:

- **Scroll**: be able to move the capture window up/down through history, like a
  human scrolling — default pinned to the bottom (latest).
- **Full session**: capture the entire `claude` session (research item).

---

## 2. Research: can a screenshot capture the whole session?

- **Pixel screenshot**: no, not in one frame. A window pixel capture only
  contains the visible viewport. Capturing the whole session would require
  scrolling and stitching many frames — slow, lossy, and for a TUI like `claude`
  it produces dirty/overlapping tiles because of dynamic redraws. **Out of scope.**
- **Text**: yes, and clean. The Electron renderer's `xterm.js` buffer has already
  interpreted every escape sequence; reading all lines yields clean text. This is
  far more useful than the raw PTY stream in `PtyStore` (SQLite), which for a TUI
  is a sequence of redraws/escape codes, not clean prose. **Decision: expose the
  whole session as text, sourced from the xterm buffer.**

> Known limitation: `xterm` is configured with `scrollback: 10000` and a TUI may
> use the alternate screen buffer, so the buffer may not hold the *complete*
> history. The implementation must **empirically verify `claude`'s rendering
> mode** (alt-screen vs. normal-buffer scrollback) and record the finding. If the
> buffer is incomplete, that becomes input for future "drive the app's own
> scroll" work — not part of this version.

---

## 3. Solution

### 3.1 OpenClaw screenshot path (per-target SKILL.md)

**Files:** `packages/cli-box-skill/installer/shared.mjs`

`installSkillToTargets` currently writes the identical bundled body into every
harness directory. Add per-target customization:

- New helper `targetSpecificNote(id) -> string`. For `openclaw` it returns a
  section to append under `## Screenshots`; for `claude` / `opencode` it returns
  `""` (unchanged).
- `installSkillToTargets` writes `readBundledSkill() + targetSpecificNote(id)`
  per target (compose the body inline; no separate "body override" parameter).
- The appended note for OpenClaw:

  ```markdown
  ### OpenClaw note

  OpenClaw can only read files under `/tmp/openclaw/`. When you take a
  screenshot, **write the output there** or OpenClaw cannot send the image:

  ```bash
  cli-box screenshot --id <id> -o /tmp/openclaw/screenshot.png
  ```
  ```

No Rust change is needed: `cli-box screenshot -o <dir>/file.png` already
`mkdir -p`s the parent directory.

### 3.2 Shell wrapping for compound commands

**Files:** `crates/cli-box-core/src/process/mod.rs`

Add the heuristic **in the daemon spawn layer** so every caller (CLI, MCP,
Electron new-sandbox dialog) benefits:

- New function `needs_shell(command: &str) -> bool`: returns `true` if `command`
  contains a space or any shell metacharacter from
  `` { '&', ';', '|', '<', '>', '$', '`', '(', ')', '*', '?', '\n', '!' } ``.
- In `spawn_cli_with_size` (the macOS implementation), at the top: if
  `needs_shell(command)`, reconstruct the full line as
  `command + " " + args.join(" ")` and re-spawn as `zsh -lc "<line>"` — i.e.
  `command = "zsh"`, `args = ["-lc", full_line]`. Then proceed through the
  existing PTY spawn path unchanged.
- If `needs_shell` is false, behavior is identical to today (direct `exec` of
  `command` + `args`).
- `zsh -lc` (login shell) is used so PATH / nvm / asdf-installed CLIs resolve,
  matching the "typed into a terminal" expectation.

**Non-collision:** `.app` detection (`ends_with(".app")` → `mode = "app"`) happens
upstream in `cmd_start_daemon` before the cli spawn path is reached, so an
`.app` path containing spaces is never passed through `needs_shell`.

### 3.3 Screenshot viewport fix + scroll + session text

#### 3.3.1 Fix the default viewport (root-cause bug)

**Files:** `electron-app/src/renderer/components/Terminal.tsx`

In `captureToPng`, anchor the fallback renderer at the visible viewport:

- `const baseY = term.buffer.active.baseY;`
- loop `for (let y = 0; y < rows; y++) term.buffer.active.getLine(baseY + y)`.

The canvas-first path is retained; the fallback now reflects what a human sees
(the latest state). Extend `captureToPng` with an optional `scrollOffset = 0`
(relative to the viewport top, upward in lines) for 3.3.2.

#### 3.3.2 Scroll the capture window over the buffer

**CLI** — new flags on `screenshot`:

| Flag | Effect |
|------|--------|
| *(default)* | bottom — visible viewport (latest) |
| `--up N` | move the window `N` lines up from the bottom |
| `--top` | jump to the top of the scrollback |

**Daemon** — extend `/box/{id}/screenshot` query params: `scroll=<N>` (lines up
from bottom, `0` = bottom) and `top=true`. The handler forwards the resolved
offset in the existing `capture_request` over `/screenshot/ws`.

**Renderer** — `main.tsx` passes the offset from `capture_request` into
`captureToPng(offset)`; `Terminal.tsx` renders `baseY - offset .. baseY - offset + rows`
(clamped to `[0, buffer.length - rows]`).

Empirical step: verify `claude` rendering mode. If the buffer does not contain
full history, record it; driving `claude`'s own scroll is explicitly out of scope
for this version.

#### 3.3.3 Full session text

**New CLI command:** `cli-box scrollback --id <id>`

- Prints the entire `xterm` terminal buffer as **clean text** (ANSI stripped by
  default) to stdout.
- Options: `-o <file>` (write to file), `--raw` (keep ANSI),
  `--from-line <N> --to-line <N>` (1-based line range).
- Source: renderer xterm buffer, transported over the existing `/screenshot/ws`
  channel via a new `scrollback_request` / `scrollback_response` (text) message
  pair (same connection, new message types).
- CLI surfaces it via the daemon route `/box/{id}/scrollback` and
  `client::daemon_scrollback`.

---

## 4. Components & data flow

```
cli-box start "cd /x && claude -r"
  └─ daemon_create_sandbox(mode=cli, command, args)
       └─ spawn_cli_with_size: needs_shell("cd /x && claude -r")=true
            └─ re-spawn as zsh -lc "cd /x && claude -r"  (PTY)

cli-box screenshot --id X                # bottom (latest)
cli-box screenshot --id X --up 100       # 100 lines up
cli-box screenshot --id X --top          # scrollback top
  └─ /box/X/screenshot?scroll=100|top=true
       └─ /screenshot/ws → capture_request{offset}
            └─ captureToPng(offset) → capture_response{image_base64}

cli-box scrollback --id X                # whole session, clean text
  └─ /box/X/scrollback
       └─ /screenshot/ws → scrollback_request
            └─ (read all buffer lines) → scrollback_response{text}
```

---

## 5. Error handling

- **`needs_shell` off by one**: if a legit single-binary name ever contained a
  space (none on macOS), it would be wrapped in `zsh -lc` — still correct, just
  via shell. Safe degradation.
- **Scroll clamping**: offset clamped so the window never starts below 0 or ends
  past `buffer.length`. `--top` on a buffer shorter than the viewport returns the
  whole buffer.
- **`scrollback` with no renderer**: if the renderer is not connected, return a
  clear error (same as the existing screenshot-no-renderer path) with a hint to
  ensure the Electron window is up.
- **Shell spawn failure** (`zsh` missing): propagated as the existing
  `AppError::Process("Failed to spawn command: ...")`.

---

## 6. Testing strategy

| Layer | Scope |
|-------|-------|
| UT (TS) | Extend `captureToPng.test.ts` to assert the fallback reads from `baseY` (not line 0) and honors `scrollOffset`; assert clamp behavior. New `scrollback` text extraction (all lines, ANSI-strip, range). |
| UT (TS) | Installer: `installSkillToTargets(['openclaw'])` body contains `/tmp/openclaw/`; `['claude']` and `['opencode']` bodies do not. Extend `shared.test.mjs`. |
| UT (Rust) | `needs_shell` truth table (plain token vs. each metacharacter vs. spaced command). `spawn_cli` rewrites to `zsh -lc "<line>"` argv (mock/spy on the spawn builder). |
| IT (Rust) | `daemon_integration.rs`: `/box/{id}/screenshot?scroll=N` and `?top=true` query parsing; `/box/{id}/scrollback` route returns text (renderer-mocked). |
| E2E | `cli-box start "cd <tmpdir> && <marker-cmd>"` actually executes (assert marker appears in output/screenshot). `screenshot --up/--top` differs from default. `scrollback` emits session text. |
| Regression | Existing `e2e-skill-install.sh` still passes; existing screenshot tests still pass. |

---

## 7. Scope & non-goals

**In scope:** per-target OpenClaw SKILL.md note; shell wrapping of compound
`start` commands; viewport-correct default screenshot; scroll-over-buffer flags;
whole-session text dump.

**Out of scope (this version):**

- Image stitching / long-image capture (rejected by design — text + window only).
- Driving `claude`'s own app-level scroll (方案 2); revisit only if 3.3.2's
  empirical check shows the buffer lacks history.
- Changing existing `ui-inspect` behavior.
- Changing `xterm` `scrollback` cap beyond the empirical finding.
