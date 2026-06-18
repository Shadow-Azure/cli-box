// Pure, testable extraction of the xterm.js buffer → PNG renderer used by
// Terminal.tsx's captureToPng fallback. Kept free of React so it can be unit
// tested with the xterm mock.

export interface BufferCellLike {
  getChars(): string;
  getFgColor(): number;
  // Cell width in columns. 0 = wide-char continuation (second column of a
  // double-width CJK/emoji char); holds no glyph, so skip it.
  getWidth(): number;
}

export interface BufferLineLike {
  readonly length: number;
  getCell(x: number): BufferCellLike | null | undefined;
}

export interface BufferLike {
  readonly baseY: number;
  getLine(y: number): BufferLineLike | null | undefined;
}

export interface RenderableTerminal {
  readonly cols: number;
  readonly buffer: { readonly active: BufferLike };
}

const FONT_SIZE = 13;
const LINE_HEIGHT = Math.ceil(FONT_SIZE * 1.4);
const CHAR_WIDTH = Math.ceil(FONT_SIZE * 0.6);

/**
 * Render an xterm.js terminal buffer window to a base64 PNG string.
 *
 * `scrollOffset` is the number of lines to scroll UP from the current viewport
 * top (`buffer.baseY`). 0 = the visible viewport (latest content). The start
 * line is clamped to >= 0, so a very large offset jumps to the very top.
 */
export function renderBufferToPng(
  term: RenderableTerminal,
  cols: number,
  rows: number,
  scrollOffset: number = 0,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = cols * CHAR_WIDTH;
  canvas.height = rows * LINE_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2d context for buffer render");

  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${FONT_SIZE}px "SF Mono", "Menlo", "Monaco", monospace`;
  ctx.textBaseline = "top";

  const buffer = term.buffer.active;
  const baseY = buffer.baseY ?? 0;
  const startLine = Math.max(0, baseY - Math.max(0, scrollOffset));

  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(startLine + y);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      // Skip wide-char continuation cells (no glyph of their own).
      if (cell && cell.getWidth() === 0) continue;
      const char = cell?.getChars() || " ";
      const fg = cell?.getFgColor();
      if (fg && fg !== 0) {
        ctx.fillStyle = `rgb(${(fg >> 16) & 0xff},${(fg >> 8) & 0xff},${fg & 0xff})`;
      } else {
        ctx.fillStyle = "#cccccc";
      }
      // NOTE: wide chars (getWidth()===2) are drawn at single CHAR_WIDTH here;
      // making them span two columns is a separate rendering refinement.
      ctx.fillText(char, x * CHAR_WIDTH, y * LINE_HEIGHT);
    }
  }
  return canvas.toDataURL("image/png").split(",")[1];
}
