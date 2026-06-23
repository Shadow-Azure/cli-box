# Screenshot Pre-Resize (Redraw-Settle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore resize-before-screenshot so heavy TUI apps (claude) screenshot with correct layout — fit → PTY resize (SIGWINCH) → wait for redraw output to settle (500ms timeout fallback) → capture.

**Architecture:** Extract the new capture orchestration into a pure, dependency-injected `renderer/screenshotSync.ts` module (matching the codebase precedent of `renderer/terminalBuffer.ts`, which was extracted from `Terminal.tsx` for testability). `Terminal.tsx`'s `captureToPng` becomes thin glue that builds the deps from its refs and delegates. All novel logic is unit-testable without React/xterm/DOM timers.

**Tech Stack:** TypeScript · React (forwardRef + useImperativeHandle) · xterm.js · vitest (jsdom) · WebSocket → daemon `resize_pty` (SIGWINCH).

## Global Constraints

- **Renderer-side only.** No daemon changes. `--with-frame` (ScreenCaptureKit) path is out of scope.
- **TDD.** Every new function is born from a failing test first.
- **Constants:** `DEFAULT_QUIESCENCE_MS = 30`, `DEFAULT_RESIZE_TIMEOUT_MS = 500` — exported from `screenshotSync.ts`, never magic numbers inline.
- **Always resize.** `captureWithResizeSettle` always calls `resize()` before reading the canvas (same-size SIGWINCH is intentional — it forces a TUI redraw and doubles as a canvas refresh).
- **Test invocation pattern:** tests run via subshell `(cd electron-app && pnpm vitest run <file>)`; typecheck via `(cd electron-app && pnpm typecheck)` — matches `test.sh`.
- **Follow existing test patterns:** vitest + jsdom, dependency-injected mocks (see `src/__tests__/connectPty.test.ts`, `src/__tests__/captureToPng.test.ts`, `src/__tests__/mocks/`).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `electron-app/src/renderer/screenshotSync.ts` | Pure capture orchestration: `waitForRedrawSettle` (settle/timeout clock logic) + `captureWithResizeSettle` (fit→resize→settle→frame→capture). Exports constants. | Create |
| `electron-app/src/__tests__/screenshotSync.test.ts` | Unit tests for both functions with injected fake clocks. | Create |
| `electron-app/src/renderer/components/Terminal.tsx` | Wire `captureWithResizeSettle` into `captureToPng`; add `lastOutputAtRef`; timestamp in `onOutput`. | Modify |

---

### Task 1: `waitForRedrawSettle` — redraw-settle clock logic

**Files:**
- Create: `electron-app/src/renderer/screenshotSync.ts`
- Test: `electron-app/src/__tests__/screenshotSync.test.ts`

**Interfaces:**
- Produces: `SettleClock` interface, `waitForRedrawSettle(clock, baseline, quietMs, timeoutMs, tickMs?)` → `Promise<"settled" | "timeout">`. Consumed by Task 2's `captureWithResizeSettle`.

- [ ] **Step 1: Write the failing tests**

Create `electron-app/src/__tests__/screenshotSync.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { waitForRedrawSettle, type SettleClock } from "../renderer/screenshotSync";

describe("waitForRedrawSettle", () => {
  it("returns 'settled' once output arrives after baseline and goes quiet", async () => {
    let t = 0;
    let lastOut = 0;
    // Simulate TUI redraw output landing at t≈25 (after the baseline of 0).
    const clock: SettleClock = {
      now: () => t,
      getLastOutputAt: () => lastOut,
      sleep: async (ms: number) => {
        t += ms;
        if (lastOut === 0 && t >= 25) lastOut = t;
      },
    };

    const result = await waitForRedrawSettle(clock, /*baseline*/ 0, /*quietMs*/ 30, /*timeoutMs*/ 500);

    expect(result).toBe("settled");
    // output at 25, quietMs 30 → settles once now - 25 >= 30 (i.e. now >= 55)
    expect(t).toBeGreaterThanOrEqual(55);
    expect(t).toBeLessThan(500);
  });

  it("returns 'timeout' when no new output ever arrives", async () => {
    let t = 0;
    const clock: SettleClock = {
      now: () => t,
      getLastOutputAt: () => 0, // never exceeds baseline of 0
      sleep: async (ms: number) => {
        t += ms;
      },
    };

    const result = await waitForRedrawSettle(clock, 0, 30, 500);

    expect(result).toBe("timeout");
    expect(t).toBeGreaterThanOrEqual(500);
  });

  it("returns 'timeout' when only stale (pre-baseline) output exists", async () => {
    let t = 100; // baseline will be 100
    const clock: SettleClock = {
      now: () => t,
      getLastOutputAt: () => 50, // output happened before baseline → not "new"
      sleep: async (ms: number) => {
        t += ms;
      },
    };

    const result = await waitForRedrawSettle(clock, 100, 30, 500);

    expect(result).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd electron-app && pnpm vitest run src/__tests__/screenshotSync.test.ts)`
Expected: FAIL — `Failed to resolve import "../renderer/screenshotSync"` (module does not exist yet).

- [ ] **Step 3: Implement the module**

Create `electron-app/src/renderer/screenshotSync.ts`:

```ts
/**
 * Screenshot pre-resize orchestration, extracted from Terminal.tsx for testing.
 *
 * Before capturing a terminal frame we re-sync the terminal's cols/rows to the
 * DOM (fit), push that size to the PTY (resize → SIGWINCH), then wait for the
 * TUI to finish redrawing. "Redraw done" is approximated by watching PTY output
 * settle (no new output for `quietMs`), capped by `timeoutMs`.
 *
 * Time sources are injected (SettleClock) so the logic is fully deterministic
 * under test without relying on vitest fake-timer mocking of performance.now().
 */

/** Default quiescence window: output quiet for this long ⇒ redraw finished. */
export const DEFAULT_QUIESCENCE_MS = 30;
/** Default hard cap: give up waiting and capture whatever we have. */
export const DEFAULT_RESIZE_TIMEOUT_MS = 500;

/** Injectable monotonic clock + last-output-at probe + async sleep. */
export interface SettleClock {
  /** Monotonic milliseconds (e.g. performance.now()). */
  now(): number;
  /** Monotonic ms timestamp of the most recent PTY output write. */
  getLastOutputAt(): number;
  /** Async delay (e.g. setTimeout). */
  sleep(ms: number): Promise<void>;
}

/**
 * Wait until PTY output has gone quiet for `quietMs` after `baseline`
 * (evidence the TUI reacted to the SIGWINCH and finished its redraw burst),
 * or until `timeoutMs` elapses — whichever comes first.
 *
 * @returns "settled" if output quieted within the timeout, else "timeout".
 */
export async function waitForRedrawSettle(
  clock: SettleClock,
  baseline: number,
  quietMs: number,
  timeoutMs: number,
  tickMs: number = 10,
): Promise<"settled" | "timeout"> {
  const start = clock.now();
  for (;;) {
    await clock.sleep(tickMs);
    const now = clock.now();
    const lastOutputAt = clock.getLastOutputAt();
    const sawNewOutput = lastOutputAt > baseline;
    const quiet = now - lastOutputAt >= quietMs;
    if (sawNewOutput && quiet) return "settled";
    if (now - start >= timeoutMs) return "timeout";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd electron-app && pnpm vitest run src/__tests__/screenshotSync.test.ts)`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/renderer/screenshotSync.ts electron-app/src/__tests__/screenshotSync.test.ts
git commit -m "feat(capture): add waitForRedrawSettle clock logic"
```

---

### Task 2: `captureWithResizeSettle` — fit→resize→settle→capture orchestration

**Files:**
- Modify: `electron-app/src/renderer/screenshotSync.ts`
- Test: `electron-app/src/__tests__/screenshotSync.test.ts`

**Interfaces:**
- Consumes: `waitForRedrawSettle`, `SettleClock`, `DEFAULT_QUIESCENCE_MS`, `DEFAULT_RESIZE_TIMEOUT_MS` (from Task 1).
- Produces: `CaptureDeps` interface (extends `SettleClock`), `CaptureOptions`, `captureWithResizeSettle(deps, scrollOffset, opts?)` → `Promise<string>`. Consumed by Task 3's `Terminal.tsx`.

- [ ] **Step 1: Write the failing tests**

Append to `electron-app/src/__tests__/screenshotSync.test.ts` (add the import of `captureWithResizeSettle` and `CaptureDeps` to the existing import line, then add the describe block):

Update the top import line to:

```ts
import {
  waitForRedrawSettle,
  captureWithResizeSettle,
  type SettleClock,
  type CaptureDeps,
} from "../renderer/screenshotSync";
```

Append this helper + describe block at the end of the file:

```ts
/** Builds a CaptureDeps whose injected clock settles quickly (output at t≈5 then quiet). */
function makeSettlingDeps(overrides: Partial<CaptureDeps> = {}): { deps: CaptureDeps; calls: string[] } {
  const calls: string[] = [];
  let t = 0;
  let lastOut = 0;
  const deps: CaptureDeps = {
    now: () => t,
    getLastOutputAt: () => lastOut,
    sleep: async (ms: number) => {
      t += ms;
      if (lastOut === 0 && t >= 5) lastOut = t;
    },
    cols: () => 80,
    rows: () => 24,
    fit: () => {
      calls.push("fit");
    },
    resize: (cols, rows) => {
      calls.push(`resize:${cols}x${rows}`);
    },
    awaitFrame: async () => {
      calls.push("frame");
    },
    readViewportCanvas: () => {
      calls.push("readCanvas");
      return "PNGDATA";
    },
    renderScrollback: (offset) => {
      calls.push(`renderScrollback:${offset}`);
      return `SCROLLBACK:${offset}`;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("captureWithResizeSettle", () => {
  it("resizes and waits a frame BEFORE reading the viewport canvas (order guard)", async () => {
    const { deps, calls } = makeSettlingDeps();

    const result = await captureWithResizeSettle(deps, 0);

    expect(result).toBe("PNGDATA");
    expect(calls.indexOf("resize:80x24")).toBeLessThan(calls.indexOf("readCanvas"));
    expect(calls.indexOf("frame")).toBeLessThan(calls.indexOf("readCanvas"));
    expect(calls).toContain("fit");
  });

  it("returns the viewport canvas PNG for scrollOffset 0", async () => {
    const { deps, calls } = makeSettlingDeps();

    const result = await captureWithResizeSettle(deps, 0);

    expect(result).toBe("PNGDATA");
    expect(calls).not.toContain("renderScrollback:0");
  });

  it("renders scrollback (non-zero offset) and skips the canvas", async () => {
    const { deps, calls } = makeSettlingDeps();

    const result = await captureWithResizeSettle(deps, 5);

    expect(result).toBe("SCROLLBACK:5");
    expect(calls).not.toContain("readCanvas");
    expect(calls).toContain("renderScrollback:5");
  });

  it("falls back to renderScrollback(0) when the viewport canvas is null", async () => {
    const { deps, calls } = makeSettlingDeps({
      readViewportCanvas: () => {
        calls.push("readCanvas");
        return null;
      },
    });

    const result = await captureWithResizeSettle(deps, 0);

    expect(result).toBe("SCROLLBACK:0");
    expect(calls).toContain("renderScrollback:0");
  });

  it("uses default 30ms/500ms options when none given", async () => {
    // Spy on waitForRedrawSettle indirectly: a deps whose sleep records total
    // waited time proves the loop honoured the default timeout when no output.
    let waited = 0;
    const { deps } = makeSettlingDeps({
      getLastOutputAt: () => 0, // no new output → must hit 500ms timeout
      sleep: async (ms: number) => {
        waited += ms;
      },
    });

    await captureWithResizeSettle(deps, 0);

    // Default timeoutMs is 500; loop ticks in 10ms increments until >=500.
    expect(waited).toBeGreaterThanOrEqual(500);
    expect(waited).toBeLessThan(600);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd electron-app && pnpm vitest run src/__tests__/screenshotSync.test.ts)`
Expected: FAIL — `captureWithResizeSettle` / `CaptureDeps` not exported (TS error / runtime undefined).

- [ ] **Step 3: Implement `captureWithResizeSettle`**

Append to `electron-app/src/renderer/screenshotSync.ts` (after the existing `waitForRedrawSettle`):

```ts
/** Injectable terminal/PTY/canvas operations the orchestrator needs. */
export interface CaptureDeps extends SettleClock {
  cols(): number;
  rows(): number;
  /** Recompute cols/rows from the current DOM (xterm FitAddon.fit). */
  fit(): void;
  /** Push new cols/rows to the PTY (WS resize → SIGWINCH). */
  resize(cols: number, rows: number): void;
  /** Wait for the renderer to commit the latest buffer to the canvas (rAF). */
  awaitFrame(): Promise<void>;
  /** Read the viewport canvas as base64 PNG (no data: prefix), or null if absent. */
  readViewportCanvas(): string | null;
  /** Render the scrollback at `scrollOffset` lines up as base64 PNG. */
  renderScrollback(scrollOffset: number): string;
}

export interface CaptureOptions {
  quietMs: number;
  timeoutMs: number;
}

/**
 * Fit → resize → wait for redraw settle → wait one frame → capture.
 *
 * Guarantees `resize()` runs strictly before any canvas/buffer read, so the
 * PTY has been told the current size (and the TUI given a chance to reflow)
 * before we snapshot pixels.
 *
 * For `scrollOffset === 0` the live viewport canvas is preferred; if it is
 * unavailable we fall back to buffer rendering. Non-zero offsets always render
 * from the buffer.
 */
export async function captureWithResizeSettle(
  deps: CaptureDeps,
  scrollOffset: number,
  opts: CaptureOptions = { quietMs: DEFAULT_QUIESCENCE_MS, timeoutMs: DEFAULT_RESIZE_TIMEOUT_MS },
): Promise<string> {
  deps.fit();
  const baseline = deps.now();
  deps.resize(deps.cols(), deps.rows());
  await waitForRedrawSettle(deps, baseline, opts.quietMs, opts.timeoutMs);
  await deps.awaitFrame();

  if (scrollOffset === 0) {
    const canvas = deps.readViewportCanvas();
    if (canvas !== null) return canvas;
  }
  return deps.renderScrollback(scrollOffset);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd electron-app && pnpm vitest run src/__tests__/screenshotSync.test.ts)`
Expected: PASS — all 8 tests (3 from Task 1 + 5 from Task 2).

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/renderer/screenshotSync.ts electron-app/src/__tests__/screenshotSync.test.ts
git commit -m "feat(capture): add captureWithResizeSettle orchestrator"
```

---

### Task 3: Wire `captureWithResizeSettle` into `Terminal.tsx`

**Files:**
- Modify: `electron-app/src/renderer/components/Terminal.tsx`

**Interfaces:**
- Consumes: `captureWithResizeSettle`, `DEFAULT_QUIESCENCE_MS`, `DEFAULT_RESIZE_TIMEOUT_MS` (from Tasks 1–2).
- Produces: unchanged `SandboxTerminalHandle.captureToPng(scrollOffset?)` signature; now internally resizes+settles before capture.

- [ ] **Step 1: Add the import**

In `electron-app/src/renderer/components/Terminal.tsx`, after the existing import of `renderBufferToPng` (line 6), add:

```ts
import { captureWithResizeSettle } from "../screenshotSync";
```

- [ ] **Step 2: Add the `lastOutputAtRef`**

In the same file, after the line `const connRef = useRef<ReturnType<typeof connectPty> | null>(null);` (line 28), add:

```ts
  const lastOutputAtRef = useRef(0);
```

- [ ] **Step 3: Replace the `captureToPng` body**

Replace the entire `captureToPng` method inside `useImperativeHandle` (currently lines 34–51) with:

```tsx
    async captureToPng(scrollOffset: number = 0): Promise<string> {
      const term = xtermRef.current;
      if (!term) throw new Error("Terminal not initialized");
      const fitAddon = fitAddonRef.current;
      const conn = connRef.current;

      // Before mount fully settles (no fit/conn yet): fall back to a direct
      // read without resize, matching prior behavior.
      if (!fitAddon || !conn) {
        if (scrollOffset === 0) {
          const canvasEl = term.element?.querySelector("canvas");
          if (canvasEl) return canvasEl.toDataURL("image/png").split(",")[1];
        }
        return renderBufferToPng(term, term.cols, term.rows, scrollOffset);
      }

      return captureWithResizeSettle(
        {
          now: () => performance.now(),
          getLastOutputAt: () => lastOutputAtRef.current,
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          cols: () => term.cols,
          rows: () => term.rows,
          fit: () => fitAddon.fit(),
          resize: (cols, rows) => conn.resize(cols, rows),
          awaitFrame: () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
          readViewportCanvas: () => {
            const canvasEl = term.element?.querySelector("canvas");
            return canvasEl ? canvasEl.toDataURL("image/png").split(",")[1] : null;
          },
          renderScrollback: (offset) => renderBufferToPng(term, term.cols, term.rows, offset),
        },
        scrollOffset,
      );
    },
```

- [ ] **Step 4: Timestamp PTY output in `onOutput`**

In the same file, update the `conn.onOutput` callback (currently lines 145–150) to record the output timestamp. Replace:

```tsx
    conn.onOutput((data) => {
      const term = xtermRef.current;
      if (!term) return;
      const writeData = typeof data === "string" ? data : decoder.decode(data as Uint8Array);
      term.write(writeData);
    });
```

with:

```tsx
    conn.onOutput((data) => {
      const term = xtermRef.current;
      if (!term) return;
      lastOutputAtRef.current = performance.now();
      const writeData = typeof data === "string" ? data : decoder.decode(data as Uint8Array);
      term.write(writeData);
    });
```

- [ ] **Step 5: Typecheck**

Run: `(cd electron-app && pnpm typecheck)`
Expected: PASS — no errors. (The inline deps object must structurally satisfy `CaptureDeps`.)

- [ ] **Step 6: Run the full renderer test suite (regression)**

Run: `(cd electron-app && pnpm vitest run)`
Expected: PASS — all existing tests (`captureToPng.test.ts`, `connectPty.test.ts`, `terminalBuffer.test.ts`, …) plus the new `screenshotSync.test.ts` green. No existing test imports the component's `captureToPng` method (the existing `captureToPng.test.ts` tests the extracted `renderBufferToPng` module), so wiring changes do not break it.

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/renderer/components/Terminal.tsx
git commit -m "feat(capture): resize + redraw-settle before screenshot in Terminal"
```

---

### Task 4: Release-test scenario + final quality gate

**Files:**
- Modify: `tests/release_test.md`

**Interfaces:**
- Consumes: the wired feature from Task 3.
- Produces: a documented manual release-test scenario covering the layout-corruption regression.

- [ ] **Step 1: Read the existing release-test doc to match format**

Run: read `tests/release_test.md` and locate the scenario-list / heading style used by existing scenarios (e.g. the section numbering and per-step "screenshot + verify" structure).

- [ ] **Step 2: Append a new scenario**

Append the following scenario to `tests/release_test.md`, following the file's existing heading numbering/indentation:

```markdown
## Screenshot layout after resize (pre-resize fix)

Verifies that `screenshot` triggers a PTY resize + redraw-settle before capture,
so heavy TUI apps (claude) show correct layout even after the window is resized.

Steps (CLI only, screenshot each step into the run's screenshot dir):

1. Start a sandbox and run a full-screen TUI:
   - `cli-box start claude --shell` (or any full-screen TUI such as `htop`)
2. Wait for the TUI to fully render, then take a baseline screenshot:
   - `cli-box screenshot <id> --out baseline.png`
   - Verify: layout is intact (header/prompt correctly positioned).
3. Resize the sandbox window (drag the Electron window to a different size),
   wait ~1s, then screenshot:
   - `cli-box screenshot <id> --out after-resize.png`
   - Verify: layout reflowed to the new size — no overlapping/garbled text,
     no stale half-redrawn frame.
4. Resize again (different size), immediately screenshot without manual wait:
   - `cli-box screenshot <id> --out immediate.png`
   - Verify: layout still correct (the redraw-settle handled the fresh frame).

Pass criteria: all three screenshots show a correctly laid-out TUI matching the
current window size. A failure here means the pre-resize mechanism regressed.
```

- [ ] **Step 3: Run the local quality gate**

Run: `sh test.sh`
Expected: PASS — `cargo test`, `cargo clippy -D warnings`, `cargo fmt --check`, `pnpm typecheck`, `pnpm vitest run`, Playwright E2E, skill-install E2E, and the sandbox-residue check all green. (No Rust/daemon code changed, so Rust gates are unchanged; the vitest gate now includes `screenshotSync.test.ts`.)

- [ ] **Step 4: Commit**

```bash
git add tests/release_test.md
git commit -m "test: add screenshot layout-after-resize release scenario"
```

---

## Self-Review Notes

- **Spec coverage:** Spec §Mechanism Steps 1–4 → Task 3 (wiring) + Tasks 1–2 (extracted logic). "Always resize" rationale → encoded in `captureWithResizeSettle` (unconditional `resize()`). Event-driven settle + 500ms timeout → `waitForRedrawSettle` (Tasks 1–2). Order guard → Task 2 "order guard" test. Both paths (viewport + scrollback) → Task 2 tests + Task 3 wiring. Testing strategy (UT + release_test) → Tasks 1–2 + Task 4.
- **Spec Step 4 ("doFit reuse") intentionally dropped:** `doFit` (sync, window-resize path) and `captureWithResizeSettle` (async, capture path) have different semantics; the shared fit+resize is a trivial 2-liner in `doFit` and extracting it would add abstraction without value (YAGNI). `doFit` is left unchanged.
- **Type consistency:** `SettleClock` (Task 1) is extended by `CaptureDeps` (Task 2) and passed to `waitForRedrawSettle` from inside `captureWithResizeSettle`. `CaptureDeps` field names (`cols`/`rows`/`fit`/`resize`/`awaitFrame`/`readViewportCanvas`/`renderScrollback`) match exactly between the interface (Task 2), the tests (Task 2 `makeSettlingDeps`), and the Terminal wiring (Task 3).
- **No placeholders:** every code/command step is complete and copy-pasteable.
