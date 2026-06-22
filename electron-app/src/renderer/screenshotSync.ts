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
