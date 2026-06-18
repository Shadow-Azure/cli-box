export class MockCell {
  constructor(
    private chars: string = " ",
    private fg: number = 0,
    private width: number = 1,
  ) {}
  getChars() { return this.chars; }
  getFgColor() { return this.fg; }
  getWidth() { return this.width; }
}

export class MockBufferLine {
  cells: MockCell[];
  length: number;

  constructor(text: string, fg?: number) {
    this.cells = [...text].map(ch => new MockCell(ch, fg ?? 0));
    this.length = this.cells.length;
  }

  /** Build a line from explicit cells (e.g. wide char + 0-width continuation). */
  static fromCells(cells: MockCell[]): MockBufferLine {
    const line = Object.create(MockBufferLine.prototype) as MockBufferLine;
    line.cells = cells;
    line.length = cells.length;
    return line;
  }

  getCell(x: number) { return this.cells[x] ?? null; }
}

export class MockBuffer {
  baseY: number;
  private lines: MockBufferLine[];
  constructor(lines: MockBufferLine[], baseY: number = 0) {
    this.lines = lines;
    this.baseY = baseY;
  }
  get length() { return this.lines.length; }
  getLine(y: number) { return this.lines[y] ?? null; }
}

export class MockTerminal {
  cols = 80;
  rows = 24;
  buffer = { active: new MockBuffer([]) };
  element: HTMLElement | null = null;

  constructor(lines?: MockBufferLine[]) {
    if (lines) {
      this.buffer = { active: new MockBuffer(lines) };
    }
  }
}
