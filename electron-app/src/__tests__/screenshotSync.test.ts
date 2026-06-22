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
