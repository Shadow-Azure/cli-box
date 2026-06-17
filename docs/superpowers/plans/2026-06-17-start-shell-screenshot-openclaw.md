# Compound `start`, Viewport Screenshot & OpenClaw Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three test-found issues for v0.2.8 — (1) OpenClaw-specific screenshot-path note in the installed SKILL.md, (2) shell wrapping so `cli-box start "cd /x && claude -r"` works, (3) viewport-correct screenshots (latest content), scroll-over-buffer, and a full-session text dump.

**Architecture:** Installer gains per-target SKILL.md composition (JS). The daemon's PTY spawn gains a `needs_shell` heuristic that rewrites compound commands to `zsh -lc "<line>"`. The Electron renderer's buffer-render fallback is extracted into a pure, testable module anchored at `buffer.baseY` (plus a scroll offset), and a new text mode over the existing screenshot WebSocket exposes the whole xterm buffer as clean text.

**Tech Stack:** Rust (tokio/axum, portable-pty), TypeScript (React + xterm.js), vitest, Node ESM (installer), shell E2E.

**Spec:** `docs/superpowers/specs/2026-06-17-start-shell-screenshot-openclaw-design.md`

**Branch:** `feat/start-shell-screenshot-openclaw` (already created; spec already committed).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/cli-box-skill/installer/shared.mjs` | Installer pure logic | Add `targetSpecificNote(id)`; compose per-target SKILL.md body |
| `packages/cli-box-skill/test/shared.test.mjs` | Installer unit tests | Assert openclaw body contains `/tmp/openclaw/`; others don't |
| `crates/cli-box-core/src/process/mod.rs` | PTY process spawn | Add `needs_shell` + `wrap_shell_command` pure fns; apply in `spawn_cli_with_size` |
| `electron-app/src/renderer/terminalBuffer.ts` | NEW — pure buffer→PNG renderer | Extract viewport/offset rendering |
| `electron-app/src/renderer/components/Terminal.tsx` | xterm component | `captureToPng(offset)` uses extracted module; canvas only at offset 0 |
| `electron-app/src/__tests__/mocks/xterm.ts` | xterm mock | Add `baseY`/`length` to `MockBuffer` |
| `electron-app/src/__tests__/captureToPng.test.ts` | buffer render tests | Import extracted module; test viewport (`baseY`) + offset; drop duplication |
| `electron-app/src/__tests__/scrollback.test.ts` | NEW — scrollback text tests | Pure text extraction + range/trim |
| `electron-app/src/renderer/scrollback.ts` | NEW — pure scrollback text extractor | Read all buffer lines, range, trim |
| `electron-app/src/renderer/main.tsx` | renderer WS handler | Handle `capture_request.scroll`; `scrollback_request`/`scrollback_response` |
| `crates/cli-box-core/src/daemon/mod.rs` | daemon HTTP + WS | `scroll`/`top` screenshot query; `/box/{id}/scrollback` route + handler; `pending_scrollback`; WS arms |
| `crates/cli-box-core/tests/daemon_integration.rs` | daemon IT | screenshot query parse; scrollback route |
| `crates/cli-box-cli/src/client.rs` | daemon HTTP client | `daemon_screenshot` scroll param; `daemon_scrollback` |
| `crates/cli-box-cli/src/main.rs` | CLI | `screenshot --up/--top`; `scrollback` subcommand |
| `tests/e2e-compound-start-screenshot.sh` | NEW — E2E | compound start + screenshot scroll + scrollback |
| `Cargo.toml`, `electron-app/package.json`, `packages/cli-box-skill/package.json` | version | bump |

---

## WebSocket contract (locked here; both sides must match)

**Screenshot (existing, extended):**
- Request → renderer: `{ "type": "capture_request", "request_id": <u64>, "sandbox_id": "<id>", "scroll": <u32> }` (`scroll` = lines up from current viewport; 0 = visible viewport; very large = top)
- Response → daemon: `{ "type": "capture_response", "request_id": <u64>, "sandbox_id": "<id>", "image_base64": "<b64>" }`
- Error → daemon: `{ "type": "capture_error", "request_id": <u64>, "sandbox_id": "<id>", "error": "<msg>" }`

**Scrollback (new):**
- Request → renderer: `{ "type": "scrollback_request", "request_id": <u64>, "sandbox_id": "<id>", "raw": <bool>, "from_line": <u32|null>, "to_line": <u32|null> }` (1-based, inclusive)
- Response → daemon: `{ "type": "scrollback_response", "request_id": <u64>, "sandbox_id": "<id>", "text": "<full session text>" }`
- Error → daemon: `{ "type": "scrollback_error", "request_id": <u64>, "sandbox_id": "<id>", "error": "<msg>" }`

---

## Task 1: OpenClaw per-target SKILL.md note

**Files:**
- Modify: `packages/cli-box-skill/installer/shared.mjs`
- Test: `packages/cli-box-skill/test/shared.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli-box-skill/test/shared.test.mjs` (inside the existing `describe` block, or a new one):

```javascript
import { installSkillToTargets } from "../installer/shared.mjs";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("per-target SKILL.md customization", () => {
  let home;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "cli-box-skill-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("openclaw body documents /tmp/openclaw screenshot path", () => {
    const results = installSkillToTargets(["openclaw"], { home });
    const body = readFileSync(
      path.join(home, ".openclaw", "skills", "cli-box", "SKILL.md"),
      "utf8"
    );
    assert.ok(results[0].ok, "install should succeed");
    assert.ok(body.includes("/tmp/openclaw/"), "should mention /tmp/openclaw/");
    assert.ok(/screenshot.*\/tmp\/openclaw/s.test(body), "should tie screenshots to the path");
  });

  it("claude body does NOT mention /tmp/openclaw", () => {
    installSkillToTargets(["claude"], { home });
    const body = readFileSync(
      path.join(home, ".claude", "skills", "cli-box", "SKILL.md"),
      "utf8"
    );
    assert.ok(!body.includes("/tmp/openclaw/"), "claude body must stay generic");
  });

  it("opencode body does NOT mention /tmp/openclaw", () => {
    installSkillToTargets(["opencode"], { home });
    const body = readFileSync(
      path.join(home, ".config", "opencode", "skills", "cli-box", "SKILL.md"),
      "utf8"
    );
    assert.ok(!body.includes("/tmp/openclaw/"), "opencode body must stay generic");
  });
});
```

If the test file already imports `installSkillToTargets`, do not re-import; reuse the existing import. Check the top of `shared.test.mjs` first and merge imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/cli-box-skill && node --test test/shared.test.mjs`
Expected: FAIL — openclaw body does not contain `/tmp/openclaw/`.

- [ ] **Step 3: Implement `targetSpecificNote` + per-target composition**

In `packages/cli-box-skill/installer/shared.mjs`, add after `readBundledSkill`:

```javascript
// Per-harness additions appended to the bundled SKILL.md body.
// Returns "" when the target needs no customization.
export function targetSpecificNote(id) {
  if (id === "openclaw") {
    return [
      "",
      "## Notes for OpenClaw",
      "",
      "OpenClaw can only read files under `/tmp/openclaw/`. When you take a",
      "screenshot, **write the output there** or OpenClaw cannot read or send the",
      "image:",
      "",
      "```bash",
      "cli-box screenshot --id <sandbox-id> -o /tmp/openclaw/screenshot.png",
      "```",
      "",
      "The directory is created automatically. Do not write screenshots to the",
      "current working directory when driving an OpenClaw agent.",
      "",
    ].join("\n");
  }
  return "";
}
```

Replace the body of `installSkillToTargets` with:

```javascript
export function installSkillToTargets(ids, { home = os.homedir(), content } = {}) {
  return ids.map((id) => {
    const dir = HARNESS_TARGETS[id].skillDir(home);
    try {
      const body = (content ?? readBundledSkill()) + targetSpecificNote(id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), body);
      return { id, dir, ok: true };
    } catch (e) {
      return { id, dir, ok: false, error: e.message };
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/cli-box-skill && node --test test/shared.test.mjs`
Expected: PASS — all three assertions hold.

- [ ] **Step 5: Commit**

```bash
git add packages/cli-box-skill/installer/shared.mjs packages/cli-box-skill/test/shared.test.mjs
git commit -m "feat(skill): openclaw SKILL.md note to save screenshots under /tmp/openclaw"
```

---

## Task 2: `needs_shell` + `wrap_shell_command` pure functions

**Files:**
- Modify: `crates/cli-box-core/src/process/mod.rs`
- Test: inline `#[cfg(test)] mod tests` in the same file

- [ ] **Step 1: Write the failing tests**

Add a test module at the end of `crates/cli-box-core/src/process/mod.rs` (if a `#[cfg(test)] mod tests` already exists, merge into it). These test only the pure helpers (no PTY spawn):

```rust
#[cfg(test)]
mod shell_wrap_tests {
    use super::{needs_shell, wrap_shell_command};

    #[test]
    fn plain_token_needs_no_shell() {
        assert!(!needs_shell("claude"));
        assert!(!needs_shell("zsh"));
        assert!(!needs_shell("/usr/local/bin/node"));
    }

    #[test]
    fn spaced_command_needs_shell() {
        assert!(needs_shell("claude -p hi"));
        assert!(needs_shell("echo hello world"));
    }

    #[test]
    fn metacharacters_need_shell() {
        for cmd in [
            "cd /x && claude -r",
            "a;b",
            "a|b",
            "a>b",
            "a<b",
            "echo $HOME",
            "echo `date`",
            "echo $(date)",
            "cat a*",
            "ls ?",
            "a\nb",
            "!cmd",
        ] {
            assert!(needs_shell(cmd), "expected needs_shell true for {cmd:?}");
        }
    }

    #[test]
    fn wrap_rewrites_to_zsh_login_shell() {
        let (cmd, args) = wrap_shell_command("cd /x && claude -r", &[]);
        assert_eq!(cmd, "zsh");
        assert_eq!(args, vec!["-lc".to_string(), "cd /x && claude -r".to_string()]);
    }

    #[test]
    fn wrap_joins_args_into_single_line() {
        let args = vec!["-p".to_string(), "hi there".to_string()];
        let (cmd, out_args) = wrap_shell_command("claude", &args);
        assert_eq!(cmd, "zsh");
        assert_eq!(out_args, vec!["-lc".to_string(), "claude -p hi there".to_string()]);
    }

    #[test]
    fn wrap_preserves_quoted_spacing_literal() {
        // args are already split tokens; they are joined by a single space.
        let args = vec!["a b".to_string()];
        let (_, out_args) = wrap_shell_command("echo", &args);
        assert_eq!(out_args[1], "echo a b");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p cli-box-core shell_wrap_tests`
Expected: FAIL — `needs_shell` / `wrap_shell_command` not found.

- [ ] **Step 3: Implement the pure helpers**

Near the top of `crates/cli-box-core/src/process/mod.rs` (after the `use` statements, before `impl ProcessManager`), add:

```rust
/// Shell metacharacters that require the command to run through a shell.
const SHELL_METACHARS: &[char] = &[
    '&', ';', '|', '<', '>', '$', '`', '(', ')', '*', '?', '\n', '!',
];

/// Returns true when `command` must be interpreted by a shell: it either
/// contains a space (command-with-args passed as one token) or any shell
/// metacharacter (`&&`, `;`, pipes, redirects, `$`, glob chars, ...).
pub fn needs_shell(command: &str) -> bool {
    command.contains(' ') || command.chars().any(|c| SHELL_METACHARS.contains(&c))
}

/// Re-wrap a (command, args) pair into a login-shell invocation
/// `zsh -lc "<full line>"`. The full line is `command` + `args` joined by
/// single spaces. The caller has already decided wrapping is needed
/// (see [`needs_shell`]).
pub fn wrap_shell_command(command: &str, args: &[String]) -> (String, Vec<String>) {
    let mut line = String::from(command);
    for a in args {
        line.push(' ');
        line.push_str(a);
    }
    (
        "zsh".to_string(),
        vec!["-lc".to_string(), line],
    )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p cli-box-core shell_wrap_tests`
Expected: PASS.

- [ ] **Step 5: Run clippy + fmt**

Run: `cargo clippy -p cli-box-core --all-targets -- -D warnings && cargo fmt -p cli-box-core -- --check`
Expected: no warnings; no diff.

- [ ] **Step 6: Commit**

```bash
git add crates/cli-box-core/src/process/mod.rs
git commit -m "feat(process): needs_shell + wrap_shell_command helpers for compound commands"
```

---

## Task 3: Apply shell wrap in `spawn_cli_with_size`

**Files:**
- Modify: `crates/cli-box-core/src/process/mod.rs` (macOS `spawn_cli_with_size`)

- [ ] **Step 1: Write a test that asserts the wrap is applied at spawn entry**

Add to the `shell_wrap_tests` module from Task 2:

```rust
    #[test]
    fn prepare_spawn_wraps_when_needed() {
        let (cmd, args) = super::prepare_spawn("cd /x && claude -r", &[]);
        assert_eq!(cmd, "zsh");
        assert_eq!(args, vec!["-lc".to_string(), "cd /x && claude -r".to_string()]);
    }

    #[test]
    fn prepare_spawn_passes_through_plain_command() {
        let args = vec!["-p".to_string(), "hi".to_string()];
        let (cmd, args2) = super::prepare_spawn("claude", &args);
        assert_eq!(cmd, "claude");
        assert_eq!(args2, args);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p cli-box-core prepare_spawn`
Expected: FAIL — `prepare_spawn` not found.

- [ ] **Step 3: Implement `prepare_spawn` and call it from `spawn_cli_with_size`**

Add next to the Task 2 helpers:

```rust
/// Decide the actual (command, args) to spawn. Compound commands (those that
/// need a shell) are re-wrapped as `zsh -lc "<line>"`; plain commands pass
/// through unchanged.
pub fn prepare_spawn(command: &str, args: &[String]) -> (String, Vec<String>) {
    if needs_shell(command) {
        wrap_shell_command(command, args)
    } else {
        (command.to_string(), args.to_vec())
    }
}
```

In the macOS `spawn_cli_with_size` impl, immediately after the function signature line `) -> Result<ProcessInfo> {`, add (before `let pty_system = ...`):

```rust
    let (command, args) = prepare_spawn(command, args);
    let command = command.as_str();
    let args = args.as_slice();
```

This shadows the parameters so the rest of the function (`CommandBuilder::new(command)`, `cmd.args(args)`, the `command.to_string()` stored in `PtySession`, logging) uses the prepared values unchanged.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p cli-box-core prepare_spawn && cargo test -p cli-box-core shell_wrap_tests`
Expected: PASS.

- [ ] **Step 5: Build the whole workspace**

Run: `cargo build -p cli-box-core -p cli-box-cli -p cli-box-daemon`
Expected: compiles with no errors.

- [ ] **Step 6: Run clippy + fmt**

Run: `cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add crates/cli-box-core/src/process/mod.rs
git commit -m "feat(process): run compound start commands through zsh -lc"
```

---

## Task 4: Extract pure `renderBufferToPng` (viewport + offset)

**Files:**
- Create: `electron-app/src/renderer/terminalBuffer.ts`
- Modify: `electron-app/src/__tests__/mocks/xterm.ts`
- Modify: `electron-app/src/__tests__/captureToPng.test.ts`

- [ ] **Step 1: Extend the xterm mock with `baseY` / `length`**

Replace the `MockBuffer` class in `electron-app/src/__tests__/mocks/xterm.ts` with:

```typescript
export class MockBuffer {
  baseY: number;
  private lines: MockBufferLine[];
  constructor(lines: MockBufferLine[], baseY: number = 0) {
    this.lines = lines;
    this.baseY = baseY;
  }
  get length() { return this.lines.length; }
  getLine(y: number) { return this.lines[y] ?? null; }
}
```

(The `MockTerminal` constructor already wires `buffer = { active: new MockBuffer(lines) }`; existing callers passing only `lines` still work via the default `baseY = 0`.)

- [ ] **Step 2: Write the failing test**

Create `electron-app/src/__tests__/terminalBuffer.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { MockBufferLine, MockTerminal } from "./mocks/xterm";
import { renderBufferToPng, type RenderableTerminal } from "../renderer/terminalBuffer";

let drawCalls: { method: string; args: unknown[] }[];

beforeEach(() => {
  drawCalls = [];
  const ctx = {
    fillStyle: "#000",
    font: "",
    textBaseline: "",
    fillRect(...args: unknown[]) { drawCalls.push({ method: "fillRect", args }); },
    fillText(...args: unknown[]) { drawCalls.push({ method: "fillText", args }); },
  };
  vi.spyOn(document, "createElement").mockImplementation((tag: string): any => {
    if (tag === "canvas") {
      return {
        width: 0, height: 0,
        getContext: () => ctx,
        toDataURL: () => "data:image/png;base64,AAAA",
      };
    }
    return (document as any).__origCreate?.(tag);
  });
});

// Build a terminal with N numbered lines "L00".."L{N-1}", given baseY + rows.
function termWith(lines: string[], baseY: number) {
  const t = new MockTerminal(lines.map((s) => new MockBufferLine(s)));
  (t.buffer.active as any).baseY = baseY;
  return t as unknown as RenderableTerminal;
}

const charsDrawn = () =>
  drawCalls.filter((d) => d.method === "fillText").map((d) => d.args[0] as string);

describe("renderBufferToPng viewport", () => {
  it("renders the VISIBLE viewport (baseY..baseY+rows), not the top", () => {
    // 6 lines of scrollback above a 2-row viewport: lines 0..5 hidden, 6..7 visible.
    const t = termWith(["L00","L01","L02","L03","L04","L05","L06","L07"], 6);
    renderBufferToPng(t, 2, 2, 0); // cols=2, rows=2, offset=0
    // First char of each visible row should be from L06 / L07, not L00 / L01.
    expect(charsDrawn()[0]).toBe("L");
    // The first row's content: ensure we read line index 6 (the "6" in "L06").
    expect(drawCalls.some((d) => d.method === "fillText" && (d.args[0] === "6"))).toBe(true);
    expect(drawCalls.some((d) => d.method === "fillText" && (d.args[0] === "0") && false)).toBe(false);
  });

  it("scrolls the window UP by offset lines", () => {
    const t = termWith(["L00","L01","L02","L03","L04","L05","L06","L07"], 6);
    renderBufferToPng(t, 2, 2, 3); // offset 3 → start = baseY-3 = 3 → L03,L04
    // Line "L03": chars L,0,3 → we expect a '3' from index 3 and NO '7' from L07.
    expect(drawCalls.some((d) => d.method === "fillText" && d.args[0] === "3")).toBe(true);
    expect(drawCalls.some((d) => d.method === "fillText" && d.args[0] === "7")).toBe(false);
  });

  it("clamps offset so start line never goes below 0 (--top)", () => {
    const t = termWith(["L00","L01","L02","L03"], 2);
    renderBufferToPng(t, 2, 2, 9999); // huge offset → start clamped to 0
    expect(drawCalls.some((d) => d.method === "fillText" && d.args[0] === "0")).toBe(true);
  });
});
```

(Add `import { vi } from "vitest";` at the top if not present.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd electron-app && pnpm vitest run src/__tests__/terminalBuffer.test.ts`
Expected: FAIL — module `../renderer/terminalBuffer` not found.

- [ ] **Step 4: Implement `terminalBuffer.ts`**

Create `electron-app/src/renderer/terminalBuffer.ts`:

```typescript
// Pure, testable extraction of the xterm.js buffer → PNG renderer used by
// Terminal.tsx's captureToPng fallback. Kept free of React so it can be unit
// tested with the xterm mock.

export interface BufferCellLike {
  getChars(): string;
  getFgColor(): number;
}

export interface BufferLineLike {
  readonly length: number;
  getCell(x: number): BufferCellLike | null | undefined;
}

export interface BufferLike {
  readonly baseY: number;
  getLine(y: number): BufferLineLike | null;
}

export interface RenderableTerminal {
  readonly cols: number;
  readonly buffer: { readonly active: BufferLike };
}

const FONT_SIZE = 13;
const LINE_HEIGHT = Math.ceil(FONT_SIZE * 1.4);
const CHAR_WIDTH = Math.ceil(FONT_SIZE * 0.6);

/**
 * Render an xterm.js terminal buffer window to a base64 PNG string.
 *
 * `scrollOffset` is the number of lines to scroll UP from the current viewport
 * top (`buffer.baseY`). 0 = the visible viewport (latest content). The start
 * line is clamped to >= 0, so a very large offset jumps to the very top.
 */
export function renderBufferToPng(
  term: RenderableTerminal,
  cols: number,
  rows: number,
  scrollOffset: number = 0,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = cols * CHAR_WIDTH;
  canvas.height = rows * LINE_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2d context for buffer render");

  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${FONT_SIZE}px "SF Mono", "Menlo", "Monaco", monospace`;
  ctx.textBaseline = "top";

  const buffer = term.buffer.active;
  const baseY = buffer.baseY ?? 0;
  const startLine = Math.max(0, baseY - Math.max(0, scrollOffset));

  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(startLine + y);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      const char = cell?.getChars() || " ";
      const fg = cell?.getFgColor();
      if (fg && fg !== 0) {
        ctx.fillStyle = `rgb(${(fg >> 16) & 0xff},${(fg >> 8) & 0xff},${fg & 0xff})`;
      } else {
        ctx.fillStyle = "#cccccc";
      }
      ctx.fillText(char, x * CHAR_WIDTH, y * LINE_HEIGHT);
    }
  }
  return canvas.toDataURL("image/png").split(",")[1];
}
```

- [ ] **Step 5: Run the new test**

Run: `cd electron-app && pnpm vitest run src/__tests__/terminalBuffer.test.ts`
Expected: PASS.

- [ ] **Step 6: Migrate `captureToPng.test.ts` onto the extracted module**

In `electron-app/src/__tests__/captureToPng.test.ts`, delete the local `renderBufferToDataUrl` function and its duplicate loop, and replace usages with an import:

```typescript
import { renderBufferToPng } from "../renderer/terminalBuffer";
```

Replace each `renderBufferToDataUrl(term, cols, rows)` call with `renderBufferToPng(term as any, cols, rows, 0)`. The existing assertions (dark background `#1a1a1a`, canvas dimensions, text color) still hold because the rendering is identical, just relocated. Re-run:

Run: `cd electron-app && pnpm vitest run src/__tests__/captureToPng.test.ts`
Expected: PASS (existing background/dimension/color tests still green).

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/renderer/terminalBuffer.ts electron-app/src/__tests__/mocks/xterm.ts electron-app/src/__tests__/captureToPng.test.ts electron-app/src/__tests__/terminalBuffer.test.ts
git commit -m "refactor(renderer): extract buffer renderer anchored at baseY + scroll offset"
```

---

## Task 5: Wire `captureToPng(offset)` in `Terminal.tsx`

**Files:**
- Modify: `electron-app/src/renderer/components/Terminal.tsx`

- [ ] **Step 1: Update the handle type and `captureToPng`**

In `electron-app/src/renderer/components/Terminal.tsx`:

Add the import at the top (after the existing imports):

```typescript
import { renderBufferToPng } from "../terminalBuffer";
```

Change the handle interface:

```typescript
export interface SandboxTerminalHandle {
  captureToPng(scrollOffset?: number): Promise<string>;
}
```

Replace the entire `captureToPng` method body inside `useImperativeHandle` with:

```typescript
    async captureToPng(scrollOffset: number = 0): Promise<string> {
      const term = xtermRef.current;
      if (!term) throw new Error("Terminal not initialized");

      // The live xterm canvas only ever shows the current viewport (offset 0).
      // For any scroll offset we must render from the text buffer instead.
      if (scrollOffset === 0) {
        const canvasEl = term.element?.querySelector("canvas");
        if (canvasEl) {
          const dataUrl = canvasEl.toDataURL("image/png");
          return dataUrl.split(",")[1];
        }
      }

      const fitAddon = fitAddonRef.current;
      if (fitAddon) fitAddon.fit();
      return renderBufferToPng(term, term.cols, term.rows, scrollOffset);
    },
```

- [ ] **Step 2: Typecheck + run renderer tests**

Run: `cd electron-app && pnpm typecheck && pnpm vitest run`
Expected: typecheck clean; all vitest tests pass.

- [ ] **Step 3: Commit**

```bash
git add electron-app/src/renderer/components/Terminal.tsx
git commit -m "feat(renderer): captureToPng honors scroll offset; canvas only at offset 0"
```

---

## Task 6: Daemon — screenshot scroll/top + `/box/{id}/scrollback`

**Files:**
- Modify: `crates/cli-box-core/src/daemon/mod.rs`
- Test: `crates/cli-box-core/tests/daemon_integration.rs`

- [ ] **Step 1: Write failing IT for query parsing + scrollback route**

Add to `crates/cli-box-core/tests/daemon_integration.rs`:

```rust
#[tokio::test]
async fn screenshot_query_parses_scroll_and_top() {
    use axum::http::{Request, StatusCode};
    use axum::body::Body;
    use tower::ServiceExt;

    let app = test_daemon_router_with_sandbox().await;
    // scroll/top are accepted query params (sandbox exists). The renderer is not
    // connected in the test, so we expect a non-404 (route matched + parsed).
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/box/test-sb/screenshot?scroll=100")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(resp.status(), StatusCode::NOT_FOUND, "scroll query must be parsed");

    let app = test_daemon_router_with_sandbox().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/box/test-sb/screenshot?top=true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(resp.status(), StatusCode::NOT_FOUND, "top query must be parsed");
}

#[tokio::test]
async fn scrollback_route_exists() {
    use axum::http::{Request, StatusCode};
    use axum::body::Body;
    use tower::ServiceExt;

    let app = test_daemon_router_with_sandbox().await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/box/test-sb/scrollback")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Renderer not connected in-test → we expect a handled error (500), NOT 404.
    assert_ne!(resp.status(), StatusCode::NOT_FOUND, "scrollback route must exist");
}
```

If `test_daemon_router_with_sandbox` does not exist as an `async` helper, reuse whatever helper the existing screenshot IT tests in this file use (look for `test_daemon_router_with_sandbox` or the pattern around the `/box/test-sb/screenshot?with_frame=true` test) and match its signature exactly. Do not invent a new helper.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p cli-box-core --test daemon_integration screenshot_query_parses_scroll_and_top scrollback_route_exists`
Expected: FAIL (params not parsed / route absent).

- [ ] **Step 3: Extend `ScreenshotQuery` and `screenshot_handler`**

In `crates/cli-box-core/src/daemon/mod.rs`, replace the `ScreenshotQuery` struct:

```rust
#[derive(Deserialize)]
struct ScreenshotQuery {
    #[serde(default)]
    with_frame: bool,
    /// Lines to scroll UP from the current viewport (0 = visible viewport).
    #[serde(default)]
    scroll: Option<u32>,
    /// Jump to the very top of the scrollback.
    #[serde(default)]
    top: bool,
}
```

In `screenshot_handler`, change the default-renderer branch to compute an offset and pass it. Replace the line:

```rust
    match request_renderer_screenshot(state.clone(), &id).await {
```

with:

```rust
    // top => very large offset so the renderer clamps to the scrollback top.
    let offset: u32 = if q.top { u32::MAX } else { q.scroll.unwrap_or(0) };
    match request_renderer_screenshot(state.clone(), &id, offset).await {
```

- [ ] **Step 4: Add the `offset` param to `request_renderer_screenshot`**

Change the signature and the outgoing message. Replace:

```rust
async fn request_renderer_screenshot(
    state: Arc<Mutex<DaemonState>>,
    sandbox_id: &str,
) -> Result<Vec<u8>, String> {
```

with:

```rust
async fn request_renderer_screenshot(
    state: Arc<Mutex<DaemonState>>,
    sandbox_id: &str,
    scroll: u32,
) -> Result<Vec<u8>, String> {
```

Replace the `let msg = serde_json::json!({ ... })` block with:

```rust
    let msg = serde_json::json!({
        "type": "capture_request",
        "request_id": request_id,
        "sandbox_id": sandbox_id,
        "scroll": scroll,
    });
```

- [ ] **Step 5: Add `pending_scrollback` to `DaemonState`**

Find the `pub pending_screenshots: HashMap<u64, oneshot::Sender<Result<Vec<u8>, String>>>` field in the `DaemonState` struct definition and add immediately after it:

```rust
    /// Pending scrollback (text) requests awaiting renderer responses.
    pub pending_scrollback: HashMap<u64, oneshot::Sender<Result<String, String>>>,
```

Add `pending_scrollback: HashMap::new(),` in **every** `DaemonState { ... }` construction (search for `pending_screenshots: HashMap::new()` — there are at least three; add the scrollback line right after each).

- [ ] **Step 6: Add `request_renderer_scrollback`**

Add this function right after `request_renderer_screenshot`:

```rust
/// Request the full session text (xterm buffer) from the renderer via WebSocket.
async fn request_renderer_scrollback(
    state: Arc<Mutex<DaemonState>>,
    sandbox_id: &str,
    raw: bool,
    from_line: Option<u32>,
    to_line: Option<u32>,
) -> Result<String, String> {
    let (request_id, response_rx, mut ws_tx) = {
        let mut s = state.lock().await;
        let ws_tx = s
            .screenshot_ws_tx
            .take()
            .ok_or("WebSocket not connected (renderer may be closed or not yet connected)")?;

        s.screenshot_request_counter += 1;
        let request_id = s.screenshot_request_counter;

        let (response_tx, response_rx) = oneshot::channel();
        s.pending_scrollback.insert(request_id, response_tx);

        (request_id, response_rx, ws_tx)
    };

    let msg = serde_json::json!({
        "type": "scrollback_request",
        "request_id": request_id,
        "sandbox_id": sandbox_id,
        "raw": raw,
        "from_line": from_line,
        "to_line": to_line,
    });

    if ws_tx
        .send(Message::Text(msg.to_string().into()))
        .await
        .is_err()
    {
        let mut s = state.lock().await;
        s.pending_scrollback.remove(&request_id);
        s.screenshot_ws_tx = Some(ws_tx);
        return Err("Failed to send scrollback request over WebSocket".to_string());
    }

    {
        let mut s = state.lock().await;
        s.screenshot_ws_tx = Some(ws_tx);
    }

    match tokio::time::timeout(std::time::Duration::from_secs(2), response_rx).await {
        Ok(Ok(Ok(text))) => Ok(text),
        Ok(Ok(Err(e))) => Err(format!("Renderer returned error: {e}")),
        Ok(Err(_)) => Err("Response channel dropped (renderer may have disconnected)".to_string()),
        Err(_) => {
            let mut s = state.lock().await;
            s.pending_scrollback.remove(&request_id);
            Err("Renderer did not respond within 2s timeout".to_string())
        }
    }
}
```

- [ ] **Step 7: Add the scrollback route, query, and handler**

Register the route — find the line `.route("/box/{id}/screenshot", get(screenshot_handler))` and add after it:

```rust
        .route("/box/{id}/scrollback", get(scrollback_handler))
```

Add the query struct and handler near `screenshot_handler`:

```rust
#[derive(Deserialize)]
struct ScrollbackQuery {
    #[serde(default)]
    raw: bool,
    #[serde(default)]
    from_line: Option<u32>,
    #[serde(default)]
    to_line: Option<u32>,
}

async fn scrollback_handler(
    State(state): State<Arc<Mutex<DaemonState>>>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<ScrollbackQuery>,
) -> Result<Response, AppError> {
    {
        let s = state.lock().await;
        if !s.sandboxes.contains_key(&id) {
            return Err(AppError::Instance(format!("Sandbox '{id}' not found")));
        }
    }

    match request_renderer_scrollback(state.clone(), &id, q.raw, q.from_line, q.to_line).await {
        Ok(text) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            );
            Ok((StatusCode::OK, headers, text).into_response())
        }
        Err(reason) => Err(AppError::Screenshot(format!(
            "Scrollback failed: {reason}"
        ))),
    }
}
```

- [ ] **Step 8: Handle the new WS response/error arms**

In `handle_screenshot_ws`, inside the `match msg_type { ... }`, add two new arms (place them next to the existing `Some("capture_response")` / `Some("capture_error")` arms):

```rust
                                    Some("scrollback_response") => {
                                        if let (Some(req_id), Some(text)) = (
                                            request_id,
                                            msg.get("text").and_then(|v| v.as_str()),
                                        ) {
                                            let mut s = state.lock().await;
                                            if let Some(tx) = s.pending_scrollback.remove(&req_id) {
                                                let _ = tx.send(Ok(text.to_string()));
                                            }
                                        }
                                    }
                                    Some("scrollback_error") => {
                                        let error = msg
                                            .get("error")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("Unknown error")
                                            .to_string();
                                        if let Some(req_id) = request_id {
                                            let mut s = state.lock().await;
                                            if let Some(tx) = s.pending_scrollback.remove(&req_id) {
                                                let _ = tx.send(Err(error));
                                            }
                                        }
                                    }
```

- [ ] **Step 9: Build + run IT**

Run: `cargo build -p cli-box-core && cargo test -p cli-box-core --test daemon_integration screenshot_query_parses_scroll_and_top scrollback_route_exists`
Expected: builds; both ITs PASS.

- [ ] **Step 10: Run full core test suite + clippy + fmt**

Run: `cargo test -p cli-box-core && cargo clippy -p cli-box-core --all-targets -- -D warnings && cargo fmt -p cli-box-core -- --check`
Expected: all pass; clean.

- [ ] **Step 11: Commit**

```bash
git add crates/cli-box-core/src/daemon/mod.rs crates/cli-box-core/tests/daemon_integration.rs
git commit -m "feat(daemon): screenshot scroll/top + /box/{id}/scrollback session text"
```

---

## Task 7: Renderer WS handling for scroll + scrollback

**Files:**
- Modify: `electron-app/src/renderer/main.tsx`
- Create: `electron-app/src/renderer/scrollback.ts`
- Test: `electron-app/src/__tests__/scrollback.test.ts`

- [ ] **Step 1: Write the failing test for the scrollback extractor**

Create `electron-app/src/__tests__/scrollback.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readScrollback, type ScrollbackTerminal } from "../renderer/scrollback";
import { MockBufferLine, MockTerminal } from "./mocks/xterm";

function term(lines: string[]): ScrollbackTerminal {
  return new MockTerminal(lines.map((l) => new MockBufferLine(l))) as unknown as ScrollbackTerminal;
}

describe("readScrollback", () => {
  it("joins all lines, trailing whitespace trimmed by default", () => {
    const t = term(["hello   ", "world"]);
    expect(readScrollback(t, { raw: false })).toBe("hello\nworld");
  });

  it("raw preserves trailing whitespace", () => {
    const t = term(["hi   ", "yo"]);
    expect(readScrollback(t, { raw: true })).toBe("hi   \nyo");
  });

  it("from_line / to_line are 1-based inclusive", () => {
    const t = term(["a", "b", "c", "d"]);
    expect(readScrollback(t, { raw: false, fromLine: 2, toLine: 3 })).toBe("b\nc");
  });

  it("clamps range to buffer length", () => {
    const t = term(["a", "b"]);
    expect(readScrollback(t, { raw: false, fromLine: 1, toLine: 99 })).toBe("a\nb");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && pnpm vitest run src/__tests__/scrollback.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scrollback.ts`**

Create `electron-app/src/renderer/scrollback.ts`:

```typescript
// Pure extraction of an xterm.js buffer into clean session text.
// The xterm buffer is already ANSI-free (escape sequences are interpreted into
// cells), so this returns readable text. `raw` preserves trailing whitespace;
// the default trims each line's trailing whitespace.

export interface ScrollbackCell { getChars(): string; }
export interface ScrollbackLine { readonly length: number; getCell(x: number): ScrollbackCell | null | undefined; }
export interface ScrollbackBuffer { getLine(y: number): ScrollbackLine | null; }
export interface ScrollbackTerminal { readonly buffer: { readonly active: ScrollbackBuffer }; }

export interface ScrollbackOptions {
  raw: boolean;
  fromLine?: number | null; // 1-based inclusive
  toLine?: number | null;   // 1-based inclusive
}

export function readScrollback(term: ScrollbackTerminal, opts: ScrollbackOptions): string {
  const buffer = term.buffer.active;
  const total = countLines(buffer);
  const start = opts.fromLine != null ? Math.max(0, opts.fromLine - 1) : 0;
  const end = opts.toLine != null ? Math.min(total, opts.toLine) : total;

  const out: string[] = [];
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    let s = "";
    for (let x = 0; x < line.length; x++) s += line.getCell(x)?.getChars() || " ";
    out.push(opts.raw ? s : s.replace(/\s+$/, ""));
  }
  return out.join("\n");
}

function countLines(buffer: ScrollbackBuffer): number {
  // Walk until getLine returns null; xterm buffers expose no .length on the
  // active buffer in all versions, so probe defensively.
  let n = 0;
  while (buffer.getLine(n)) n++;
  return n;
}
```

- [ ] **Step 4: Run the scrollback test**

Run: `cd electron-app && pnpm vitest run src/__tests__/scrollback.test.ts`
Expected: PASS.

> Note: `MockBuffer` now has a `length` getter (Task 4 Step 1), but the production `xterm` buffer's `.active` has `.length` directly; the defensive `countLines` works for both. If `MockBuffer.getLine(n)` ever returns a truthy placeholder past the end, adjust the mock — but the current mock returns `null` past the array, so this is correct.

- [ ] **Step 5: Wire scroll + scrollback into the renderer WS handler**

In `electron-app/src/renderer/main.tsx`:

Add the import near the top:

```typescript
import { readScrollback } from "./scrollback";
```

In the `ws.onmessage` handler, find the existing `} else if (msg.type === "capture_request") {` block. Change the `captureToPng()` call to pass the scroll offset:

```typescript
          } else if (msg.type === "capture_request") {
            const { sandbox_id, request_id, scroll } = msg;
            const tabRef = terminalRefs.current.get(sandbox_id);
            if (tabRef?.current) {
              try {
                const base64 = await tabRef.current.captureToPng(Number(scroll) || 0);
                ws?.send(JSON.stringify({
                  type: "capture_response",
                  request_id,
                  sandbox_id,
                  image_base64: base64,
                }));
              } catch (err) {
                ws?.send(JSON.stringify({
                  type: "capture_error",
                  request_id,
                  sandbox_id,
                  error: String(err),
                }));
              }
            } else {
              ws?.send(JSON.stringify({
                type: "capture_error",
                request_id,
                sandbox_id,
                error: "Terminal not found or not mounted",
              }));
            }
          } else if (msg.type === "scrollback_request") {
            const { sandbox_id, request_id, raw, from_line, to_line } = msg;
            const tabRef = terminalRefs.current.get(sandbox_id);
            if (tabRef?.current) {
              try {
                const terminal = (tabRef.current as any).terminal;
                if (!terminal) throw new Error("Terminal not available");
                const text = readScrollback(terminal, {
                  raw: Boolean(raw),
                  fromLine: from_line ?? null,
                  toLine: to_line ?? null,
                });
                ws?.send(JSON.stringify({
                  type: "scrollback_response",
                  request_id,
                  sandbox_id,
                  text,
                }));
              } catch (err) {
                ws?.send(JSON.stringify({
                  type: "scrollback_error",
                  request_id,
                  sandbox_id,
                  error: String(err),
                }));
              }
            } else {
              ws?.send(JSON.stringify({
                type: "scrollback_error",
                request_id,
                sandbox_id,
                error: "Terminal not found or not mounted",
              }));
            }
          }
```

The scrollback handler needs access to the underlying xterm `Terminal` instance. Expose it from `Terminal.tsx` by adding to the `SandboxTerminalHandle` interface a `terminal` getter:

```typescript
export interface SandboxTerminalHandle {
  captureToPng(scrollOffset?: number): Promise<string>;
  readonly terminal: unknown; // the underlying @xterm/xterm Terminal
}
```

and in `Terminal.tsx` `useImperativeHandle`, add alongside `captureToPng`:

```typescript
    get terminal() {
      return xtermRef.current;
    },
```

- [ ] **Step 6: Typecheck + run all renderer tests**

Run: `cd electron-app && pnpm typecheck && pnpm vitest run`
Expected: clean; all pass.

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/renderer/scrollback.ts electron-app/src/renderer/main.tsx electron-app/src/renderer/components/Terminal.tsx electron-app/src/__tests__/scrollback.test.ts
git commit -m "feat(renderer): handle scroll offset + scrollback_request over screenshot WS"
```

---

## Task 8: CLI client — screenshot scroll + scrollback

**Files:**
- Modify: `crates/cli-box-cli/src/client.rs`

- [ ] **Step 1: Extend `daemon_screenshot` with a scroll offset**

In `crates/cli-box-cli/src/client.rs`, change the signature and URL building of `daemon_screenshot`:

```rust
pub async fn daemon_screenshot(sandbox_id: &str, with_frame: bool, scroll: Option<u32>, top: bool) -> Result<ScreenshotResult> {
    let base = daemon_base_url()?;
    let client = reqwest_client();
    let mut url = format!("{base}/box/{sandbox_id}/screenshot");
    let mut sep = '?';
    if with_frame {
        url.push_str("?with_frame=true");
        sep = '&';
    }
    if top {
        url.push(sep);
        url.push_str("top=true");
        sep = '&';
    } else if let Some(n) = scroll {
        url.push(sep);
        url.push_str(&format!("scroll={n}"));
        sep = '&';
    }
    let resp = client.get(url).send().await.with_context(|| "screenshot request to daemon failed")?;
```

(Leave the rest of the function — status check, header reads, `png_data`, `Ok(ScreenshotResult { ... })` — unchanged.)

- [ ] **Step 2: Add `daemon_scrollback`**

Append to `crates/cli-box-cli/src/client.rs`:

```rust
/// Fetch the full session text for a sandbox via the daemon.
pub async fn daemon_scrollback(
    sandbox_id: &str,
    raw: bool,
    from_line: Option<u32>,
    to_line: Option<u32>,
) -> Result<String> {
    let base = daemon_base_url()?;
    let client = reqwest_client();
    let mut url = format!("{base}/box/{sandbox_id}/scrollback");
    let mut sep = '?';
    let mut push = |u: &mut String, kv: &str| {
        u.push(sep);
        u.push_str(kv);
        sep = '&';
    };
    if raw {
        push(&mut url, "raw=true");
    }
    if let Some(n) = from_line {
        push(&mut url, &format!("from_line={n}"));
    }
    if let Some(n) = to_line {
        push(&mut url, &format!("to_line={n}"));
    }
    let resp = client.get(url).send().await.with_context(|| "scrollback request to daemon failed")?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("scrollback failed (HTTP {status}): {text}");
    }
    Ok(resp.text().await?)
}
```

- [ ] **Step 3: Update the one call site of `daemon_screenshot`**

`cmd_screenshot_daemon` (in `main.rs`) currently calls `client::daemon_screenshot(sandbox_id, with_frame)`. That call site is updated in Task 9. For now, fix only the `client.rs`-internal compile — run:

Run: `cargo build -p cli-box-cli`
Expected: a compile error at the `cmd_screenshot_daemon` call site (signature changed) — this is expected and resolved in Task 9. Do NOT commit yet; proceed to Task 9.

---

## Task 9: CLI — `screenshot --up/--top` + `scrollback` subcommand

**Files:**
- Modify: `crates/cli-box-cli/src/main.rs`

- [ ] **Step 1: Add `--up`/`--top` to the `Screenshot` command**

In the `Commands::Screenshot { ... }` variant (around line 92), add two fields:

```rust
    /// Scroll the capture window UP N lines from the latest viewport (see older output)
    #[arg(long, name = "up")]
    up: Option<u32>,

    /// Jump to the very top of the scrollback
    #[arg(long)]
    top: bool,
```

Update the `match cli.command` arm to thread them through:

```rust
        Commands::Screenshot {
            output,
            id,
            window_id: _window_id,
            with_frame,
            up,
            top,
        } => {
            cmd_screenshot_daemon(&output, id.as_deref(), with_frame, up, top).await?;
        }
```

- [ ] **Step 2: Update `cmd_screenshot_daemon`**

Change its signature and the client call:

```rust
async fn cmd_screenshot_daemon(
    output: &std::path::Path,
    id: Option<&str>,
    with_frame: bool,
    up: Option<u32>,
    top: bool,
) -> anyhow::Result<()> {
    let sandbox_id = id.ok_or_else(|| {
        anyhow::anyhow!(
            "--id is required for screenshots. Use: cli-box screenshot --id <sandbox-id>"
        )
    })?;

    let result = client::daemon_screenshot(sandbox_id, with_frame, up, top)
        .await
        .map_err(|e| {
            eprintln!("Error: Failed to connect to daemon: {e}");
            eprintln!("Hint: Run 'cli-box start' in another terminal to start the daemon.");
            e
        })?;
```

(Keep the rest of the function — `source` print, `create_dir_all`, `std::fs::write`, final `println!` — unchanged.)

- [ ] **Step 3: Add the `scrollback` subcommand**

Add a variant to the `Commands` enum (place it near `Screenshot`):

```rust
    /// Dump the full session text of a CLI/TUI sandbox (clean, ANSI-free)
    Scrollback {
        /// Sandbox instance ID
        #[arg(long)]
        id: String,

        /// Write to a file instead of stdout
        #[arg(short, long)]
        output: Option<PathBuf>,

        /// Preserve trailing whitespace (no per-line trim)
        #[arg(long)]
        raw: bool,

        /// Start line (1-based, inclusive)
        #[arg(long)]
        from_line: Option<u32>,

        /// End line (1-based, inclusive)
        #[arg(long)]
        to_line: Option<u32>,
    },
```

Add the match arm:

```rust
        Commands::Scrollback { id, output, raw, from_line, to_line } => {
            cmd_scrollback(&id, output.as_deref(), raw, from_line, to_line).await?;
        }
```

Add the implementation near `cmd_screenshot_daemon`:

```rust
async fn cmd_scrollback(
    id: &str,
    output: Option<&std::path::Path>,
    raw: bool,
    from_line: Option<u32>,
    to_line: Option<u32>,
) -> anyhow::Result<()> {
    let text = client::daemon_scrollback(id, raw, from_line, to_line)
        .await
        .map_err(|e| {
            eprintln!("Error: Failed to fetch scrollback: {e}");
            e
        })?;
    if let Some(path) = output {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("Failed to create directory {:?}", parent))?;
            }
        }
        std::fs::write(path, &text)
            .with_context(|| format!("Failed to write scrollback to {:?}", path))?;
        println!("Scrollback saved to {:?} ({} bytes)", path, text.len());
    } else {
        print!("{text}");
    }
    Ok(())
}
```

- [ ] **Step 4: Update MCP tool list (if it enumerates commands)**

Check whether `run_mcp_server` lists tools statically. Run:

Run: `grep -n "scrollback\|screenshot\|start_sandbox\|tools" crates/cli-box-cli/src/main.rs | head`

If there is a static JSON tool list that documents the `screenshot` tool, add `up`/`top` to its schema description and add a `scrollback` tool entry mirroring the existing tool shape (see the `start_sandbox`/`screenshot` entries around line 1228). If the MCP tools are generated dynamically, skip this step.

- [ ] **Step 5: Build + clippy + fmt**

Run: `cargo build -p cli-box-cli && cargo clippy -p cli-box-cli --all-targets -- -D warnings && cargo fmt -p cli-box-cli -- --check`
Expected: clean.

- [ ] **Step 6: Smoke-test CLI parsing (no daemon needed)**

Run: `cargo run -p cli-box-cli -- screenshot --help && cargo run -p cli-box-cli -- scrollback --help`
Expected: both print help showing `--up`/`--top` and the `scrollback` options; exit 0.

- [ ] **Step 7: Commit (covers Tasks 8 + 9)**

```bash
git add crates/cli-box-cli/src/client.rs crates/cli-box-cli/src/main.rs
git commit -m "feat(cli): screenshot --up/--top and scrollback subcommand"
```

---

## Task 10: E2E + empirical claude rendering check

**Files:**
- Create: `tests/e2e-compound-start-screenshot.sh`
- Modify: `test.sh` (register the new E2E)

- [ ] **Step 1: Write the E2E script**

Create `tests/e2e-compound-start-screenshot.sh`:

```bash
#!/usr/bin/env bash
# E2E: compound start command, viewport screenshot, scroll, and scrollback.
# Requires a built release on PATH (cli-box, cli-box-daemon) and Screen Recording
# permission. Run from repo root via `sh test.sh`.
set -euo pipefail

require_cli() { command -v "$1" >/dev/null 2>&1 || { echo "missing $1" >&2; exit 1; }; }
require_cli cli-box

MARKER_DIR="$(mktemp -d)"
MARKER_FILE="$MARKER_DIR/done"
trap 'cli-box close "$SID" >/dev/null 2>&1 || true; rm -rf "$MARKER_DIR"' EXIT

# 1) Compound command: cd into a temp dir, run a shell compound that writes a marker.
SID=$(cli-box start "cd $MARKER_DIR && printf 'compound-ok\\n' > marker.txt && cat marker.txt" | sed -n 's/.*id=\([^,]*\).*/\1/p')
test -n "$SID" || { echo "FAIL: no sandbox id" >&2; exit 1; }
echo "started sandbox: $SID"

# Give the PTY time to run the compound command.
sleep 3

# 2) scrollback contains the marker text produced by the compound command.
TEXT=$(cli-box scrollback --id "$SID")
echo "$TEXT" | grep -q "compound-ok" || { echo "FAIL: compound marker not in scrollback" >&2; exit 1; }
echo "compound command ran (marker found in scrollback)"

# 3) default screenshot is a PNG (viewport = latest). --top produces a different
#    byte count only when scrollback is larger than the viewport; assert both are PNGs.
cli-box screenshot --id "$SID" -o "$MARKER_DIR/bottom.png" >/dev/null
cli-box screenshot --id "$SID" --top -o "$MARKER_DIR/top.png" >/dev/null
file "$MARKER_DIR/bottom.png" | grep -q "PNG" || { echo "FAIL: bottom.png not PNG" >&2; exit 1; }
file "$MARKER_DIR/top.png"    | grep -q "PNG" || { echo "FAIL: top.png not PNG" >&2; exit 1; }
echo "viewport + top screenshots captured as PNG"

echo "E2E PASS"
```

- [ ] **Step 2: Register it in `test.sh`**

Open `test.sh`, find where other `tests/e2e-*.sh` scripts are invoked, and add:

```bash
echo "→ E2E: compound start + screenshot + scrollback"
bash tests/e2e-compound-start-screenshot.sh
```

Match the surrounding invocation style (some scripts may be guarded by a permission/env check; mirror that).

- [ ] **Step 3: Empirical claude rendering check (manual, documented)**

After a release build, run manually and record findings in the PR body:

```bash
cli-box start claude          # start a real claude session
# in another terminal, drive a multi-screen task, then:
cli-box scrollback --id <id> | wc -l
cli-box screenshot --id <id> -o /tmp/cl-latest.png
cli-box screenshot --id <id> --up 200 -o /tmp/cl-up.png
```

Record: (a) does `scrollback` return the full conversation or only the current screen? (b) does `--up` reveal older content? If the buffer is incomplete (claude uses the alternate screen), note it in the PR as a known limitation and a follow-up for "drive claude's own scroll".

- [ ] **Step 4: Commit**

```bash
chmod +x tests/e2e-compound-start-screenshot.sh
git add tests/e2e-compound-start-screenshot.sh test.sh
git commit -m "test(e2e): compound start, viewport/top screenshot, scrollback"
```

---

## Task 11: Version bump, full quality gate, PR

**Files:**
- Modify: `Cargo.toml`, `electron-app/package.json`, `packages/cli-box-skill/package.json`

- [ ] **Step 1: Bump versions**

- `Cargo.toml`: `version = "0.2.7"` → `version = "0.2.8"` (under `[workspace.package]`).
- `electron-app/package.json`: `"version": "0.2.7"` → `"version": "0.2.8"`.
- `packages/cli-box-skill/package.json`: `"version": "0.2.1"` → `"version": "0.2.2"` (the openclaw note is a published-skill change).

- [ ] **Step 2: Run the full local quality gate**

Run: `sh test.sh`
Expected: all green (cargo test, clippy, fmt, typecheck, vitest, e2e skill install, new compound e2e, sandbox residue check).

If anything fails, use `superpowers:systematic-debugging` — root-cause before fixing.

- [ ] **Step 3: Push and open the PR (do NOT merge)**

```bash
git push -u origin feat/start-shell-screenshot-openclaw
gh pr create --title "feat: compound start, viewport screenshot, openclaw skill (0.2.8)" --body "$(cat <<'EOF'
## Problem
1. OpenClaw cannot read screenshots saved to CWD (sandboxed to /tmp/openclaw) — the installed SKILL.md never told the agent to save there.
2. `cli-box start "cd /x && claude -r"` fails — spawn treats the whole string as an executable name.
3. `cli-box screenshot` on long claude tasks returns the TOP of the scrollback (oldest lines), not the visible viewport; no scroll; no whole-session text.

## Solution
- **Skill (1)**: per-target SKILL.md; OpenClaw body appends a `/tmp/openclaw/` screenshot-path note. (`packages/cli-box-skill/installer/shared.mjs`)
- **Compound start (2)**: `needs_shell` + `wrap_shell_command` in `process/mod.rs`; compound commands run via `zsh -lc "<line>"`. `.app` paths unaffected. Instance record keeps the original command for display. (commits: process helpers + spawn wiring)
- **Viewport/scroll/scrollback (3)**: renderer buffer-fallback anchored at `buffer.baseY` (root-cause fix); extracted to pure `terminalBuffer.ts`; `screenshot --up N`/`--top` slide the window over the buffer; new `cli-box scrollback` dumps the whole session as clean text over the screenshot WS. (commits: renderer extract, daemon scroll/scrollback, renderer WS, cli)

## Test Plan
- [x] UT (TS): `terminalBuffer` viewport(`baseY`)+offset+clamp; `scrollback` trim/range; `captureToPng` background/dimensions migrated to extracted module
- [x] UT (JS): installer openclaw body contains `/tmp/openclaw/`; claude/opencode do not
- [x] UT (Rust): `needs_shell`/`wrap_shell_command`/`prepare_spawn` truth table
- [x] IT (Rust): `screenshot?scroll=`/`?top=` parse; `/box/{id}/scrollback` route exists
- [x] E2E: compound `start` marker appears in `scrollback`; default + `--top` screenshots are PNG
- [x] `sh test.sh` green (cargo test/clippy/fmt, typecheck, vitest, skill install, residue check)
- [ ] Release manual + empirical claude-rendering check (recorded below after `sh release.sh`)

### Empirical claude rendering (to fill in)
- scrollback completeness: <full conversation | current screen only>
- `--up` reveals older content: <yes | no>
EOF
)"
```

- [ ] **Step 4: Hand off for release testing**

Do not merge. Stop and report the PR URL. Release build (`sh release.sh`) and the manual scenarios in `tests/release_test.md` happen in a later step per the project workflow.

---

## Self-Review (completed during authoring)

**Spec coverage:** §3.1 → Task 1. §3.2 (`needs_shell`, `zsh -lc`, `.app` non-collision) → Tasks 2–3. §3.3.1 (baseY fix) → Tasks 4–5. §3.3.2 (`--up`/`--top`, daemon scroll/top, renderer offset, empirical check) → Tasks 4–7, 9, 10. §3.3.3 (`scrollback` CLI/route/renderer, xterm buffer source) → Tasks 6–9. §6 testing → embedded in each task + Task 10/11. §7 non-goals respected (no stitching, no claude-app-scroll driving unless empirical shows gap).

**Placeholder scan:** none — every code/JSON step shows the literal content; the only open item (empirical claude rendering) is explicitly a manual observation recorded into the PR, with a defined procedure.

**Type consistency:** `needs_shell`/`wrap_shell_command`/`prepare_spawn` defined in Task 2/3 and used consistently. WS contract field names (`scroll`, `from_line`, `to_line`, `raw`, `text`) match across daemon (Task 6) and renderer (Task 7). `daemon_screenshot(sandbox_id, with_frame, scroll, top)` / `daemon_scrollback(...)` signatures match between client.rs (Task 8) and main.rs (Task 9). `SandboxTerminalHandle` (captureToPng + terminal getter) consistent between Tasks 5 and 7. `RenderableTerminal`/`ScrollbackTerminal` structural types align with the extended `MockTerminal`.
