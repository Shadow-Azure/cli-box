# Screenshot Bounded Burst-Wait Settle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the settle's global-quiet ≤500ms wait with a bounded burst-wait (50ms no-output probe + 30ms quiet early-exit + 120ms hard cap) so continuous TUI output can no longer cause long screenshot waits.

**Architecture:** Single-file change to the pure, dependency-injected `electron-app/src/renderer/screenshotSync.ts`: add a `PROBE_MS` constant, lower `DEFAULT_RESIZE_TIMEOUT_MS` from 500→120, and add a no-output probe branch to `waitForRedrawSettle`. `captureWithResizeSettle` and `Terminal.tsx` are unchanged — they pick up the new defaults automatically. Tests updated to the new timing semantics.

**Tech Stack:** TypeScript · vitest (jsdom) · dependency-injected `SettleClock` (no React/xterm/fake-timer).

## Global Constraints

- **Renderer-side TypeScript only.** No Rust/daemon changes. **`Terminal.tsx` must NOT be touched** — it calls `captureWithResizeSettle(deps, scrollOffset)` with no options, so it inherits the new defaults transparently.
- **Constants (exact values):** `DEFAULT_QUIESCENCE_MS = 30` (unchanged), `PROBE_MS = 50` (new), `DEFAULT_RESIZE_TIMEOUT_MS = 120` (was 500).
- **`waitForRedrawSettle` signature stays compatible:** add `probeMs: number = PROBE_MS` as the last parameter; return type stays `Promise<"settled" | "timeout">`. `captureWithResizeSettle` calls it with 4 args (probeMs uses its default) — do not change that call site.
- **`captureWithResizeSettle` public signature/behavior unchanged** (`(deps, scrollOffset, opts?) => Promise<string>`; resize-before-read guarantee intact).
- **TDD.** Update the settle tests first (RED), then the module (GREEN).
- **Test invocation:** `(cd electron-app && pnpm vitest run src/__tests__/screenshotSync.test.ts)`; full regression `(cd electron-app && pnpm vitest run)`; typecheck `(cd electron-app && pnpm typecheck)`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `electron-app/src/renderer/screenshotSync.ts` | `waitForRedrawSettle` (the settle clock) + `captureWithResizeSettle` (orchestrator) + constants. | Modify |
| `electron-app/src/__tests__/screenshotSync.test.ts` | Unit tests with injected fake clocks. | Modify |

`Terminal.tsx` is intentionally **not** modified.

---

### Task 1: Revise `waitForRedrawSettle` to a bounded burst-wait

**Files:**
- Modify: `electron-app/src/renderer/screenshotSync.ts` (constants at lines 13–16; `waitForRedrawSettle` at lines 28–52; module doc comment at lines 1–11)
- Test: `electron-app/src/__tests__/screenshotSync.test.ts` (settle describe block at lines 9–61; "default options" test at lines 144–161)

**Interfaces:**
- Consumes: existing `SettleClock`, `CaptureDeps`, `captureWithResizeSettle` (unchanged).
- Produces: revised `waitForRedrawSettle(clock, baseline, quietMs, timeoutMs, tickMs?, probeMs?)` — adds the no-output probe branch; same return type. New exported constant `PROBE_MS = 50`; `DEFAULT_RESIZE_TIMEOUT_MS` lowered to 120.

- [ ] **Step 1: Update the settle tests to the new timing semantics (RED)**

In `electron-app/src/__tests__/screenshotSync.test.ts`, replace the entire `describe("waitForRedrawSettle", ...)` block (currently lines 9–61) with:

```ts
describe("waitForRedrawSettle", () => {
  it("returns 'settled' once output arrives after baseline and goes quiet (early-exit)", async () => {
    let t = 0;
    let lastOut = 0;
    // Redraw output lands at the first tick where t >= 25 (i.e. t = 30).
    const clock: SettleClock = {
      now: () => t,
      getLastOutputAt: () => lastOut,
      sleep: async (ms: number) => {
        t += ms;
        if (lastOut === 0 && t >= 25) lastOut = t;
      },
    };

    const result = await waitForRedrawSettle(clock, /*baseline*/ 0, /*quietMs*/ 30, /*timeoutMs*/ 120);

    expect(result).toBe("settled");
    // output at t=30, quietMs 30 → settles once now-30 >= 30 (i.e. now >= 60)
    expect(t).toBeGreaterThanOrEqual(60);
    expect(t).toBeLessThan(120);
  });

  it("returns 'settled' via the probe when no reflow occurs (steady state)", async () => {
    let t = 0;
    const clock: SettleClock = {
      now: () => t,
      getLastOutputAt: () => 0, // no output after baseline → no SIGWINCH/redraw
      sleep: async (ms: number) => {
        t += ms;
      },
    };

    const result = await waitForRedrawSettle(clock, 0, 30, 120);

    expect(result).toBe("settled");
    // PROBE_MS = 50: no output seen → settled at ~50ms, NOT the 120ms cap.
    expect(t).toBeGreaterThanOrEqual(50);
    expect(t).toBeLessThan(120);
  });

  it("returns 'settled' via the probe when only stale (pre-baseline) output exists", async () => {
    let t = 100; // baseline = 100
    const clock: SettleClock = {
      now: () => t,
      getLastOutputAt: () => 50, // before baseline → not "new" output
      sleep: async (ms: number) => {
        t += ms;
      },
    };

    const result = await waitForRedrawSettle(clock, 100, 30, 120);

    expect(result).toBe("settled");
    // probe fires ~50ms after start (no NEW output after baseline).
    expect(t).toBeGreaterThanOrEqual(150);
    expect(t).toBeLessThan(220);
  });

  it("returns 'timeout' (bounded) when output flows continuously and never quiets", async () => {
    let t = 0;
    const clock: SettleClock = {
      now: () => t,
      // output "just happened" every tick → now - lastOutputAt is always 0, never quiet.
      getLastOutputAt: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };

    const result = await waitForRedrawSettle(clock, 0, 30, 120);

    expect(result).toBe("timeout");
    // Hard cap bounds the wait at 120ms even under continuous output (was 500ms).
    expect(t).toBeGreaterThanOrEqual(120);
    expect(t).toBeLessThan(200);
  });
});
```

Also update the "default options" `captureWithResizeSettle` test (currently lines 144–161). Replace its body with:

```ts
  it("uses default options (probe settles quickly when no output)", async () => {
    // No new output → the PROBE branch settles at ~50ms instead of the 120ms cap.
    let waited = 0;
    const { deps } = makeSettlingDeps({
      now: () => waited, // clock must advance with the waited counter
      getLastOutputAt: () => 0, // no new output → probe settles
      sleep: async (ms: number) => {
        waited += ms;
      },
    });

    await captureWithResizeSettle(deps, 0);

    // Default PROBE_MS = 50; loop ticks in 10ms increments until >= 50.
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited).toBeLessThan(120);
  });
```

Leave the other four `captureWithResizeSettle` tests (order guard, viewport canvas, scrollback, null-canvas fallback) and the `makeSettlingDeps` helper unchanged — they use the default-output clock and settle via the quiet branch at ~40ms, unaffected by the probe/cap change.

- [ ] **Step 2: Run the tests to verify the expected ones fail**

Run: `(cd electron-app && pnpm vitest run src/__tests__/screenshotSync.test.ts)`
Expected: **3 failures** — the two rewritten "no output" / "stale output" tests now expect `"settled"` at ~50ms but the current implementation returns `"timeout"` at 500ms; the new "continuous output" test expects `"timeout"` at ~120ms but the current cap is 500ms (so it would hang or return at 500ms). The "early-exit" and four `captureWithResizeSettle` tests still pass.

- [ ] **Step 3: Update `waitForRedrawSettle` + constants in the module**

In `electron-app/src/renderer/screenshotSync.ts`:

Replace the constants block (lines 13–16):

```ts
/** Default quiescence window: output quiet for this long ⇒ redraw burst landed. */
export const DEFAULT_QUIESCENCE_MS = 30;
/** No-output probe window: if no PTY output arrives this long after the resize,
 *  there is no SIGWINCH/redraw to wait for (steady state) — capture immediately. */
export const PROBE_MS = 50;
/** Default hard cap: give up waiting and capture whatever we have. Bounded so
 *  continuous output (spinner / streaming) can't stall a screenshot. */
export const DEFAULT_RESIZE_TIMEOUT_MS = 120;
```

Replace the `waitForRedrawSettle` function AND its doc comment (lines 28–52) with:

```ts
/**
 * Wait for the resize-induced redraw burst to land, bounded so continuous output
 * can't stall the capture. Three exit conditions, cheapest first:
 *
 *  1. Probe (`probeMs`): if NO PTY output has arrived since `baseline`, there was
 *     no SIGWINCH/redraw (TIOCSWINSZ only signals on a real size change) — return
 *     "settled" immediately. Skips the wait entirely in steady state.
 *  2. Quiet (`quietMs`): once output HAS arrived, return "settled" once it goes
 *     quiet — short reflows exit early without paying the full cap.
 *  3. Cap (`timeoutMs`): continuous output never quiets — return "timeout" at the
 *     cap regardless.
 *
 * @returns "settled" (probe or quiet) or "timeout" (cap).
 */
export async function waitForRedrawSettle(
  clock: SettleClock,
  baseline: number,
  quietMs: number,
  timeoutMs: number,
  tickMs: number = 10,
  probeMs: number = PROBE_MS,
): Promise<"settled" | "timeout"> {
  const start = clock.now();
  for (;;) {
    await clock.sleep(tickMs);
    const now = clock.now();
    const lastOutputAt = clock.getLastOutputAt();
    const sawNewOutput = lastOutputAt > baseline;
    const quiet = now - lastOutputAt >= quietMs;
    // 1. Steady state: no reflow to wait for.
    if (!sawNewOutput && now - start >= probeMs) return "settled";
    // 2. Redraw burst landed and went quiet.
    if (sawNewOutput && quiet) return "settled";
    // 3. Bounded cap (continuous output).
    if (now - start >= timeoutMs) return "timeout";
  }
}
```

Also update the module's top doc comment (lines 5–7) so it no longer overstates "global quiet". Replace lines 5–7:

```ts
 * Before capturing a terminal frame we re-sync the terminal's cols/rows to the
 * DOM (fit), push that size to the PTY (resize → SIGWINCH), then wait for the
 * resize-induced redraw burst to land (probe / quiet / bounded cap).
```

Do NOT modify `captureWithResizeSettle`, `CaptureDeps`, `CaptureOptions`, or `SettleClock` — they are unchanged.

- [ ] **Step 4: Run the screenshotSync tests to verify they pass**

Run: `(cd electron-app && pnpm vitest run src/__tests__/screenshotSync.test.ts)`
Expected: PASS — 9 tests (4 `waitForRedrawSettle` + 5 `captureWithResizeSettle`).

- [ ] **Step 5: Run the full renderer suite + typecheck (regression)**

Run: `(cd electron-app && pnpm vitest run)` then `(cd electron-app && pnpm typecheck)`
Expected: both PASS — no regressions to existing capture/scrollback/connect tests; `Terminal.tsx` is untouched so its wiring is unaffected; the inline deps object in `captureToPng` still structurally satisfies `CaptureDeps` (no interface changed).

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/renderer/screenshotSync.ts electron-app/src/__tests__/screenshotSync.test.ts
git commit -m "$(cat <<'EOF'
fix(capture): bound redraw settle — probe + 120ms cap

The settle waited for global output quiet (≤500ms), so continuous TUI
output (spinner/streaming) always hit the 500ms cap and steady-state
screenshots paid the full 500ms for output that never arrives. Both
coupled with the daemon's 2s renderer-screenshot timeout.

Revised: 50ms no-output probe (steady state → capture immediately),
30ms quiet early-exit (short reflows don't pay the full cap), 120ms hard
cap (continuous output bounded). Max added latency ≤120ms, which also
removes the dependency on the never-merged 10s daemon timeout (fb1894f).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Spec §Mechanism (probe + quiet + 120ms cap) → Task 1 Step 3. Spec §behavior table (steady ~50ms / short ~60–90ms / continuous ~120ms) → Task 1 Step 1 tests (probe test asserts ~50ms; early-exit test asserts ~60ms; continuous test asserts ~120ms cap). Spec §"why always resize" (drift fix, not redraw trigger) → reflected in the probe's doc comment + the `PROBE_MS` rationale comment. Spec §Testing (probe / short / continuous) → Task 1 Step 1. Spec §Risks (≤120ms, no 10s dependency) → validated by the bounded tests. `Terminal.tsx` unchanged per spec.
- **No placeholders:** every code/command step is complete and copy-pasteable.
- **Type consistency:** `waitForRedrawSettle` keeps its existing parameter order and return type; `probeMs` is appended last with a default, so `captureWithResizeSettle`'s 4-arg call site (`waitForRedrawSettle(deps, baseline, opts.quietMs, opts.timeoutMs)`) is unchanged and picks up `probeMs = PROBE_MS` by default. `CaptureDeps` / `CaptureOptions` / `SettleClock` field names are untouched.
