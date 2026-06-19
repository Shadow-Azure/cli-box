// Pure extraction of an xterm.js buffer into clean session text.
// The xterm buffer is already ANSI-free (escape sequences are interpreted into
// cells), so this returns readable text. `raw` preserves trailing whitespace;
// the default trims each line's trailing whitespace.

export interface ScrollbackCell {
  getChars(): string;
  // Cell width in columns. 0 = wide-char continuation (the second column of a
  // double-width CJK/emoji char); these hold no character and must be skipped
  // so CJK text isn't padded with spaces ("执 行" → "执行").
  getWidth(): number;
}
export interface ScrollbackLine {
  readonly length: number;
  getCell(x: number): ScrollbackCell | null | undefined;
}
export interface ScrollbackBuffer {
  readonly length: number;
  getLine(y: number): ScrollbackLine | null | undefined;
}
export interface ScrollbackTerminal {
  readonly buffer: { readonly active: ScrollbackBuffer };
}

export interface ScrollbackOptions {
  raw: boolean;
  fromLine?: number | null; // 1-based inclusive
  toLine?: number | null; // 1-based inclusive
}

export function readScrollback(term: ScrollbackTerminal, opts: ScrollbackOptions): string {
  const buffer = term.buffer.active;
  const total = buffer.length;
  const start = opts.fromLine != null ? Math.max(0, opts.fromLine - 1) : 0;
  const end = opts.toLine != null ? Math.min(total, opts.toLine) : total;

  const out: string[] = [];
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    let s = "";
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) {
        s += " ";
        continue;
      }
      // Skip wide-char continuation cells so CJK/emoji text is contiguous.
      if (cell.getWidth() === 0) continue;
      s += cell.getChars() || " ";
    }
    out.push(opts.raw ? s : s.replace(/\s+$/, ""));
  }
  return out.join("\n");
}
