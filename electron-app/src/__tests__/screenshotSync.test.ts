import { describe, it, expect } from "vitest";
import {
  waitForRedrawSettle,
  captureWithResizeSettle,
  type SettleClock,
  type CaptureDeps,
} from "../renderer/screenshotSync";

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
