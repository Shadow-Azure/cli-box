/**
 * Screenshot pre-resize orchestration, extracted from Terminal.tsx for testing.
 *
 * Before capturing a terminal frame we re-sync the terminal's cols/rows to the
 * DOM (fit), push that size to the PTY (resize → SIGWINCH), then wait for the
 * resize-induced redraw burst to land (probe / quiet / bounded cap).
 *
 * Time sources are injected (SettleClock) so the logic is fully deterministic
 * under test without relying on vitest fake-timer mocking of performance.now().
 */

/** Default quiescence window: output quiet for this long ⇒ redraw burst landed. */
export const DEFAULT_QUIESCENCE_MS = 30;
/** No-output probe window: if no PTY output arrives this long after the resize,
 *  there is no SIGWINCH/redraw to wait for (steady state) — capture immediately. */
export const PROBE_MS = 50;
/** Default hard cap: give up waiting and capture whatever we have. Bounded so
 *  continuous output (spinner / streaming) can't stall a screenshot. */
export const DEFAULT_RESIZE_TIMEOUT_MS = 120;

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
