import { describe, it, expect } from "vitest";
import {
  waitForRedrawSettle,
  captureWithResizeSettle,
  type SettleClock,
  type CaptureDeps,
} from "../renderer/screenshotSync";

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
});
