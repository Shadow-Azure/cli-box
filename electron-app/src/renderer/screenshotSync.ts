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
