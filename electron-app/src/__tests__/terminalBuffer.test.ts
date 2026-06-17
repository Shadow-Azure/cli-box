import { describe, it, expect, beforeEach, vi } from "vitest";
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
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string): any => {
    if (tag === "canvas") {
      return {
        width: 0, height: 0,
        getContext: () => ctx,
        toDataURL: () => "data:image/png;base64,AAAA",
      };
    }
    return origCreate(tag);
  });
});

// Build a terminal where line N is the single character chr('a'+N) (so each
// line has a unique, identifiable glyph). baseY selects the viewport top.
function termWith(lineCount: number, baseY: number) {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) lines.push(String.fromCharCode("a".charCodeAt(0) + i));
  const t = new MockTerminal(lines.map((s) => new MockBufferLine(s)));
  (t.buffer.active as any).baseY = baseY;
  return t as unknown as RenderableTerminal;
}

const char = (n: number) => String.fromCharCode("a".charCodeAt(0) + n);

describe("renderBufferToPng viewport", () => {
  it("renders the VISIBLE viewport (baseY..baseY+rows), not the top", () => {
    // 6 lines above a 2-row viewport: lines 0..5 hidden, 6..7 visible.
    const t = termWith(8, 6);
    renderBufferToPng(t, 1, 2, 0); // cols=1, rows=2, offset=0
    // Viewport starts at baseY=6 → chars 'g' (line 6) and 'h' (line 7) drawn.
    expect(drawCalls.some((d) => d.method === "fillText" && d.args[0] === char(6))).toBe(true);
    expect(drawCalls.some((d) => d.method === "fillText" && d.args[0] === char(0))).toBe(false);
  });

  it("scrolls the window UP by offset lines", () => {
    const t = termWith(8, 6);
    renderBufferToPng(t, 1, 2, 3); // offset 3 → start = baseY-3 = 3 → chars 'd','e'
    expect(drawCalls.some((d) => d.method === "fillText" && d.args[0] === char(3))).toBe(true);
    expect(drawCalls.some((d) => d.method === "fillText" && d.args[0] === char(7))).toBe(false);
  });

  it("clamps offset so start line never goes below 0 (--top)", () => {
    const t = termWith(4, 2);
    renderBufferToPng(t, 1, 2, 9999); // huge offset → start clamped to 0
    expect(drawCalls.some((d) => d.method === "fillText" && d.args[0] === char(0))).toBe(true);
  });

  it("treats a negative scroll offset as 0 (no-op)", () => {
    const t = termWith(4, 2);
    renderBufferToPng(t, 1, 2, -5); // negative → clamp to 0 → start = baseY = 2
    // baseY=2, rows=2 → visible lines 2,3 → chars 'c' (line 2), 'd' (line 3).
    expect(drawCalls.some((d) => d.method === "fillText" && d.args[0] === char(2))).toBe(true);
  });
});
