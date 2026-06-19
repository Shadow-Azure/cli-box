import { describe, it, expect } from "vitest";
import { readScrollback, type ScrollbackTerminal } from "../renderer/scrollback";
import { MockBufferLine, MockCell, MockTerminal } from "./mocks/xterm";

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

  it("does not pad wide (CJK/emoji) chars with spaces from continuation cells", () => {
    // A double-width char occupies 2 columns: cell N holds the char (width 2),
    // cell N+1 is a 0-width continuation with no glyph. The continuation must
    // be skipped so output is "执行" not "执 行".
    const line = MockBufferLine.fromCells([
      new MockCell("执", 0, 2),
      new MockCell("", 0, 0),
      new MockCell("行", 0, 2),
      new MockCell("", 0, 0),
    ]);
    const t = new MockTerminal([line]) as unknown as ScrollbackTerminal;
    expect(readScrollback(t, { raw: false })).toBe("执行");
  });
});
