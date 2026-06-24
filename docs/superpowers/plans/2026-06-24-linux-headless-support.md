# Linux 无头 CLI 支持 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 cli-box 以无头 daemon 形态运行在云端 Linux x86_64 服务器上，保留键盘输入（PTY）与不带 `--with-frame` 的终端截图（Rust 原生渲染器）。

**Architecture:** 在 daemon 现有 renderer 截图路径之外，新增一条 headless 路径：当 Electron renderer 未连接时，由常驻 `HeadlessTerminal`（`vt100` 解析 + `ab_glyph` 栅格化）把 PTY 字节渲染成 PNG。PTY 改用 `cfg(unix)` 守卫释放跨平台实现。macOS GUI 行为完全不变。

**Tech Stack:** Rust（portable-pty · nix · vt100 0.16 · ab_glyph · image · axum）· GitHub Actions（ubuntu-latest）· npm optionalDependencies

## Global Constraints

- 目标平台：macOS（不变）+ Linux x86_64。`cfg(unix)` 同时覆盖两者；Windows 非目标。
- macOS 专属依赖（`core-graphics`/`core-foundation`/`objc`/`screencapturekit`）保持 `cfg(target_os="macos")` 门控，Linux 不引入。
- `portable-pty` 与 `nix` 已是无条件依赖（cli-box-core `[dependencies]`），跨平台可用。
- 嵌入字体：CJK-capable 等宽 TTF（Sarasa Mono SC / Noto Sans Mono CJK），`include_bytes!`。
- 代码与注释用英文；用户交流用中文。
- 提交粒度：小步、可独立编译；实现与测试同提交。Commit 格式 `<type>(<scope>): <desc>`，scope 优先用 `process`/`capture`/`daemon`/`cli`/`ci`/`npm`。
- 不自动合入主分支；PR 保持 open。

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `crates/cli-box-core/Cargo.toml` | 加 `vt100`、`ab_glyph` 依赖 | 修改 |
| `crates/cli-box-core/assets/fonts/SarasaMonoSC-Regular.ttf` | 嵌入 CJK 等宽字体 | 新增（二进制，需下载） |
| `crates/cli-box-core/src/capture/headless.rs` | `HeadlessTerminal`：feed + render_png | 新增 |
| `crates/cli-box-core/src/capture/mod.rs` | 导出 headless 模块 | 修改 |
| `crates/cli-box-core/src/process/mod.rs` | PTY 跨平台化（`cfg(macos)`→`cfg(unix)`，挂载 HeadlessTerminal，删 error 桩） | 修改 |
| `crates/cli-box-core/src/daemon/mod.rs` | screenshot/scrollback headless 路由 | 修改 |
| `crates/cli-box-cli/src/main.rs` | `ensure_healthy_electron` headless 短路 | 修改 |
| `crates/cli-box-core/tests/daemon_integration.rs` | headless screenshot/scrollback IT | 修改 |
| `packages/cli-box-linux-x64/` | npm 平台包 | 新增 |
| `packages/cli-box-skill/package.json` | optionalDependencies 加 linux | 修改 |
| `.github/workflows/ci.yml` | linux clippy/test + headless E2E 门禁 | 修改 |
| `.github/workflows/release.yml` | build-linux job | 修改 |
| `tests/e2e-compound-start-screenshot.sh` | 适配 Linux（bash） | 修改 |

---

### Task 1: Foundation — 依赖与字体资产

**Files:**
- Modify: `crates/cli-box-core/Cargo.toml`
- Create: `crates/cli-box-core/assets/fonts/SarasaMonoSC-Regular.ttf`

**Interfaces:**
- Produces: `vt100`/`ab_glyph` 可用；`SarasaMonoSC-Regular.ttf` 存在，供 Task 3 的 `include_bytes!` 引用。

- [ ] **Step 1: 添加依赖**

在 `crates/cli-box-core/Cargo.toml` 的 `[dependencies]` 末尾（`rusqlite.workspace = true` 之后）追加：

```toml
vt100 = "0.16"
ab_glyph = "0.2"
```

- [ ] **Step 2: 获取 CJK 等宽字体**

```bash
mkdir -p crates/cli-box-core/assets/fonts
# Sarasa Mono SC（等宽 + 中日韩 + 拉丁），约 5MB
curl -L -o /tmp/sarasa.zip "https://github.com/be5invis/Sarasa-Gothic/releases/download/v1.0.26/SarasaMonoSC-1.0.26.zip" || true
# 若 zip 不可用，改用 Noto Sans Mono CJK：
# curl -L -o crates/cli-box-core/assets/fonts/NotoSansMonoCJKsc-Regular.otf "https://github.com/notofonts/noto-cjk/raw/main/Sans/Mono/NotoSansMonoCJKsc-Regular.otf"
```

将解压后的 `sarasa-mono-sc-regular.ttf` 重命名放置为 `crates/cli-box-core/assets/fonts/SarasaMonoSC-Regular.ttf`。确认文件存在且 > 1MB：

```bash
ls -lh crates/cli-box-core/assets/fonts/
```

> 说明：字体是二进制资产，无法在计划中以文本提供。若上述 URL 不可达，实现者从 [Sarasa Gothic releases](https://github.com/be5invis/Sarasa-Gothic/releases) 或 [Google Noto](https://fonts.google.com/noto) 手动下载任一 CJK 等宽字体（Sarasa Mono SC / Noto Sans Mono CJK SC / Source Han Mono），文件名需与 Task 3 的 `include_bytes!` 路径一致。若文件名为 `.otf`，Task 3 的常量名/路径相应调整。

- [ ] **Step 3: 验证依赖编译**

```bash
cargo build -p cli-box-core 2>&1 | tail -5
```
Expected: 编译通过（新依赖被拉取）。

- [ ] **Step 4: 提交**

```bash
git add crates/cli-box-core/Cargo.toml crates/cli-box-core/assets/fonts/
git commit -m "chore(core): add vt100/ab_glyph deps and CJK font asset"
```

---

### Task 2: PTY 跨平台化（`process/mod.rs`）

**Files:**
- Modify: `crates/cli-box-core/src/process/mod.rs`（约 18–21 行 use、35–53 行 PtySession、各 PTY 方法 + error 桩）

**Interfaces:**
- Produces: `ProcessManager::spawn_cli_with_size / send_input / resize_pty / read_output / subscribe_output / get_store / kill_process / list_processes / is_session_alive` 在所有 unix（macOS + Linux）上可用（此前仅 macOS）。
- Consumes: `portable-pty`、`nix`（已是 cli-box-core 无条件依赖）。

> 此 Task 不引入新功能，仅把已有跨平台 PTY 实现从 `cfg(target_os="macos")` 释放为 `cfg(unix)`，并删除返回错误的非 macOS 桩。本机验证（macOS）证明不回归；Linux 编译的权威证明在 Task 7 的 CI 门禁。

- [ ] **Step 1: 解除 import 守卫**

`process/mod.rs` 第 18 行附近：

```rust
#[cfg(target_os = "macos")]
use {
    nix::sys::signal::{kill, Signal},
    nix::unistd::Pid,
    portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize},
};
```
改为：

```rust
#[cfg(unix)]
use {
    nix::sys::signal::{kill, Signal},
    nix::unistd::Pid,
    portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize},
};
```

- [ ] **Step 2: 解除 PtySession 守卫**

第 35 行 `#[cfg(target_os = "macos")]` 上方的 `struct PtySession { ... }`，把其 `#[cfg(target_os = "macos")]` 改为 `#[cfg(unix)]`。结构体字段不变。

- [ ] **Step 3: 把所有 PTY 方法的 macOS 守卫改为 unix**

对以下方法的 `#[cfg(target_os = "macos")]` 全部改为 `#[cfg(unix)]`（用编辑器逐个替换，或脚本）：
`spawn_app`（保留 macOS-only：见 Step 4）、`spawn_cli`、`spawn_cli_with_size`、`send_input`、`resize_pty`、`read_output`、`peek_output`、`subscribe_output`、`get_store`、`kill_process`。

> 注意：`spawn_app` / `spawn_app_with_window` / `find_pids_by_app_name` 等 macOS GUI 应用启动逻辑**保持 `cfg(target_os="macos")` 不变**（app 模式非 Linux 目标）。只改 PTY 相关方法。

- [ ] **Step 4: 删除所有返回错误的非 macOS 桩**

删除所有 `#[cfg(not(target_os = "macos"))]` 的 PTY 桩函数（`spawn_app` 非 macOS 桩可保留或删除，删除更干净；`spawn_cli`/`spawn_cli_with_size`/`kill_process`/`send_input`/`resize_pty`/`read_output`/`peek_output`/`subscribe_output`/`get_store` 的非 macOS 桩**全部删除**）。

验证删除后无残留 `cfg(not(target_os = "macos"))` PTY 桩：

```bash
grep -n "cfg(not(target_os = \"macos\"))" crates/cli-box-core/src/process/mod.rs
```
Expected: 仅剩 `spawn_app` 相关（若保留）或为空。

- [ ] **Step 5: 验证本机编译 + 现有 PTY 测试不回归**

```bash
cargo build -p cli-box-core -p cli-box-cli -p cli-box-daemon 2>&1 | tail -5
cargo test -p cli-box-core --test pty_reader_test 2>&1 | tail -15
cargo clippy -p cli-box-core --all-targets -- -D warnings 2>&1 | tail -5
```
Expected: 全部通过（macOS 上行为不变；PTY 方法现在 `cfg(unix)` 仍覆盖 macOS）。

- [ ] **Step 6: 提交**

```bash
git add crates/cli-box-core/src/process/mod.rs
git commit -m "feat(process): un-gate PTY implementation to cfg(unix)

The portable-pty + nix based PTY implementation was cfg(macos)-gated
with error-returning stubs on other platforms, and ungated SESSIONS/
list_processes/is_session_alive referenced the gated PtySession type
(a Linux compile blocker). Move the real impl to cfg(unix) and drop
the stubs. No macOS behavior change."
```

---

### Task 3: HeadlessTerminal 模块（`capture/headless.rs`）

**Files:**
- Create: `crates/cli-box-core/src/capture/headless.rs`
- Modify: `crates/cli-box-core/src/capture/mod.rs`（追加 `pub mod headless; pub use headless::HeadlessTerminal;`）

**Interfaces:**
- Produces:
  - `HeadlessTerminal::new(cols: u16, rows: u16) -> Self`
  - `HeadlessTerminal::feed(&self, bytes: &[u8])` — 增量喂入 PTY 字节
  - `HeadlessTerminal::render_png(&self, scroll_offset: usize) -> Result<Vec<u8>>` — 渲染当前屏幕为 PNG
  - `HeadlessTerminal::rendered_text(&self) -> String` — 当前屏幕纯文本（scrollback clean 模式用）
  - `HeadlessTerminal::cols() -> u16`、`rows() -> u16`
- Consumes: `vt100 = "0.16"`、`ab_glyph = "0.2"`、`image`（已是依赖）、Task 1 的字体。

> vt100 API 已核对（docs.rs 0.16.2）：`Parser::new(rows, cols, scrollback)`、`process(&[u8])`、`screen().cell(row, col) -> Option<&Cell>`、`Cell::{contents, fgcolor, bgcolor, inverse}`、`Color::{Default, Idx(u8), Rgb(u8,u8,u8)}`、`screen().set_scroll(usize)`、`screen().size() -> (usize, usize)`。
> ab_glyph：`FontRef::try_from_slice`、`glyph_id`、`outline_glyph`、`OutlinedGlyph::px_bounds` + `draw(|x,y,coverage|)`。实现时若 `draw` 坐标原点语义与本计划假设不符，以 docs.rs 为准调整 offset——属同一逻辑，非占位。

- [ ] **Step 1: 写失败测试 — feed 后网格内容/颜色**

在 `crates/cli-box-core/src/capture/headless.rs` 顶部先写测试模块（TDD）：

```rust
//! Headless terminal renderer: parse PTY bytes into a grid and render to PNG.
//! Pure (bytes in → PNG out), fully unit-testable. Headless/Linux screenshot path.

use crate::error::{AppError, Result};
use std::sync::Mutex;
use vt100::{Color, Screen};

/// Embedded CJK-capable monospace font (Latin + CJK; emoji not included).
const FONT_BYTES: &[u8] = include_bytes!("../assets/fonts/SarasaMonoSC-Regular.ttf");

const DEFAULT_FG: (u8, u8, u8) = (229, 229, 229);
const DEFAULT_BG: (u8, u8, u8) = (0, 0, 0);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_plain_text_appears_on_screen() {
        let term = HeadlessTerminal::new(80, 24);
        term.feed(b"hello");
        // row 0, col 0 = 'h'
        let cell = term.screen_cell(0, 0).unwrap();
        assert_eq!(cell.contents(), "h");
        assert_eq!(term.screen_cell(0, 4).unwrap().contents(), "o");
    }

    #[test]
    fn feed_ansi_color_sets_fgcolor() {
        let term = HeadlessTerminal::new(80, 24);
        term.feed(b"\x1b[31mRED\x1b[m");
        // cell(0,0) foreground = indexed red = Idx(1)
        assert_eq!(term.screen_cell(0, 0).unwrap().fgcolor(), Color::Idx(1));
    }

    #[test]
    fn rendered_text_matches_screen_contents() {
        let term = HeadlessTerminal::new(80, 24);
        term.feed(b"line one\nline two");
        let text = term.rendered_text();
        assert!(text.contains("line one"));
        assert!(text.contains("line two"));
    }
}
```

注意：测试引用了 `term.screen_cell(row, col)`（测试辅助），在 Step 3 实现里提供。

- [ ] **Step 2: 运行测试确认失败**

```bash
cargo test -p cli-box-core capture::headless 2>&1 | tail -15
```
Expected: 编译失败（`HeadlessTerminal` 未定义）。

- [ ] **Step 3: 实现 HeadlessTerminal 基础（new/feed/screen_cell/rendered_text）**

在 `headless.rs`（测试模块之后）实现：

```rust
/// xterm-style 16-color palette (indices 0–15).
const PALETTE_16: [(u8, u8, u8); 16] = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
    (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
    (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
    (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
];

/// Convert a vt100 Color to RGB. `default` is used for Color::Default
/// (caller passes DEFAULT_FG or DEFAULT_BG as appropriate).
fn color_rgb(c: Color, default: (u8, u8, u8)) -> (u8, u8, u8) {
    match c {
        Color::Default => default,
        Color::Idx(i) => {
            let i = i as usize;
            if i < 16 {
                PALETTE_16[i]
            } else if i < 232 {
                // 6x6x6 cube, base 16
                let v = (i - 16) as u32;
                let r = v / 36;
                let g = (v / 6) % 6;
                let b = v % 6;
                let lvl = |x: u32| if x == 0 { 0u8 } else { 55 + (x as u8) * 40 };
                (lvl(r), lvl(g), lvl(b))
            } else {
                let g = 8 + (i - 232) as u8 * 10;
                (g, g, g)
            }
        }
        Color::Rgb(r, g, b) => (r, g, b),
    }
}

/// A persistent headless terminal: maintains a live grid from PTY bytes
/// and can render the screen to PNG. Mirrors the role xterm.js plays in the
/// Electron renderer, but server-side and dependency-free.
pub struct HeadlessTerminal {
    cols: u16,
    rows: u16,
    parser: Mutex<vt100::Parser>,
}

impl HeadlessTerminal {
    pub fn new(cols: u16, rows: u16) -> Self {
        // scrollback of 10000 lines keeps history for --top / --scroll.
        Self {
            cols,
            rows,
            parser: Mutex::new(vt100::Parser::new(rows, cols, 10_000)),
        }
    }

    pub fn feed(&self, bytes: &[u8]) {
        if let Ok(mut p) = self.parser.lock() {
            p.process(bytes);
        }
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }
    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// Render the current screen as plain text (clean scrollback mode).
    pub fn rendered_text(&self) -> String {
        let p = self.parser.lock().expect("poisoned terminal");
        p.screen().contents().to_string()
    }

    /// Test helper: read a cell's clone at (row, col).
    #[cfg(test)]
    fn screen_cell(&self, row: usize, col: usize) -> Option<vt100::Cell> {
        let p = self.parser.lock().expect("poisoned terminal");
        p.screen().cell(row, col).cloned()
    }
}
```

- [ ] **Step 4: 运行测试确认前 3 个通过**

```bash
cargo test -p cli-box-core capture::headless 2>&1 | tail -15
```
Expected: 3 个测试 PASS。

- [ ] **Step 5: 写失败测试 — render_png 产出有效 PNG**

在 `tests` 模块追加：

```rust
    #[test]
    fn render_png_has_expected_dimensions() {
        let term = HeadlessTerminal::new(80, 24);
        term.feed(b"hello world");
        let png = term.render_png(0).expect("render failed");
        // PNG magic header
        assert_eq!(&png[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        // decode and check size = 80*w x 24*h, non-trivial
        let img = image::load_from_memory(&png).expect("decode").to_rgba8();
        assert_eq!(img.width() % 80, 0, "width must be multiple of cols");
        assert_eq!(img.height() % 24, 0, "height must be multiple of rows");
        assert!(img.width() >= 80 * 4 && img.height() >= 24 * 8);
    }

    #[test]
    fn render_png_contains_non_background_pixels() {
        let term = HeadlessTerminal::new(80, 24);
        term.feed(b"\x1b[31mX\x1b[m");
        let png = term.render_png(0).expect("render failed");
        let img = image::load_from_memory(&png).expect("decode").to_rgba8();
        // At least one non-black pixel (the red 'X' on black bg).
        let has_ink = img.pixels().any(|p| p[0] > 50 || p[1] > 50 || p[2] > 50);
        assert!(has_ink, "rendered PNG should contain non-background pixels");
    }
```

- [ ] **Step 6: 运行确认失败**

```bash
cargo test -p cli-box-core capture::headless::tests::render_png 2>&1 | tail -15
```
Expected: 编译失败（`render_png` 未定义）。

- [ ] **Step 7: 实现 render_png**

在 `impl HeadlessTerminal` 追加：

```rust
    /// Render the current screen (optionally scrolled back) to PNG bytes.
    pub fn render_png(&self, scroll_offset: usize) -> Result<Vec<u8>> {
        use ab_glyph::{point, Font, FontRef, PxScale};
        use image::{ImageBuffer, Rgba, RgbaImage};
        use std::io::Cursor;

        let font =
            FontRef::try_from_slice(FONT_BYTES).map_err(|e| AppError::Screenshot(format!("font load: {e}")))?;

        // Monospace metrics. PxScale: x = advance-ish, y = line height.
        let line_h = 18.0f32;
        let scale = PxScale { x: line_h, y: line_h };
        let ascent = font.ascent() / font.units_per_em().max(1.0) * line_h;

        // Monospace cell width: advance of 'M' in unscaled font units * scale.
        let m_advance = font.glyph_advance(font.glyph_id('M'));
        let cell_w = ((m_advance * scale.x).round() as u32).max(8);
        let cell_h = line_h.round() as u32;

        let parser = self
            .parser
            .lock()
            .map_err(|e| AppError::Screenshot(format!("terminal lock: {e}")))?;
        parser.screen().set_scroll(scroll_offset);
        let (rows, cols) = parser.screen().size();

        let img_w = cols as u32 * cell_w;
        let img_h = rows as u32 * cell_h;
        let mut img: RgbaImage =
            ImageBuffer::from_pixel(img_w, img_h, Rgba([DEFAULT_BG.0, DEFAULT_BG.1, DEFAULT_BG.2, 255]));

        let blend = |bg: u8, fg: u8, a: f32| -> u8 {
            ((bg as f32) * (1.0 - a) + (fg as f32) * a).round() as u8
        };

        for row in 0..rows {
            for col in 0..cols {
                let Some(cell) = parser.screen().cell(row, col) else {
                    continue;
                };
                let bg = color_rgb(
                    if cell.inverse() { cell.fgcolor() } else { cell.bgcolor() },
                    DEFAULT_BG,
                );
                let fg = color_rgb(
                    if cell.inverse() { cell.bgcolor() } else { cell.fgcolor() },
                    DEFAULT_FG,
                );
                let x0 = col as u32 * cell_w;
                let y0 = row as u32 * cell_h;
                // fill background
                for py in y0..(y0 + cell_h) {
                    for px in x0..(x0 + cell_w) {
                        img.put_pixel(px, py, Rgba([bg.0, bg.1, bg.2, 255]));
                    }
                }
                // rasterize glyph(s)
                let base_y = y0 as f32 + ascent;
                for ch in cell.contents().chars() {
                    let glyph = font
                        .glyph_id(ch)
                        .with_scale_and_position(scale, point(x0 as f32, base_y));
                    let Some(outlined) = font.outline_glyph(glyph) else {
                        continue;
                    };
                    let bb = outlined.px_bounds();
                    let min_x = bb.min.x.round() as i32;
                    let min_y = bb.min.y.round() as i32;
                    outlined.draw(|gx, gy, cov| {
                        let px = (min_x + gx as i32) as u32;
                        let py = (min_y + gy as i32) as u32;
                        if px < img_w && py < img_h && cov > 0.0 {
                            let p = img.get_pixel_mut(px, py);
                            p[0] = blend(p[0], fg.0, cov);
                            p[1] = blend(p[1], fg.1, cov);
                            p[2] = blend(p[2], fg.2, cov);
                        }
                    });
                }
            }
        }

        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| AppError::Screenshot(format!("png encode: {e}")))?;
        Ok(buf.into_inner())
    }
```

> 实现者注意：`OutlinedGlyph::draw(|x, y, coverage|)` 的 `(x, y)` 在 ab_glyph 中是相对 `px_bounds().min` 的像素偏移；上面用 `min_x/min_y` 偏移到绝对坐标。若所用 ab_glyph 版本的 `draw` 已返回绝对坐标，去掉偏移即可。以 `cargo test render_png` 通过为准。

- [ ] **Step 8: 运行全部 headless 测试**

```bash
cargo test -p cli-box-core capture::headless 2>&1 | tail -15
cargo clippy -p cli-box-core --all-targets -- -D warnings 2>&1 | tail -5
```
Expected: 5 个测试全 PASS；clippy 无 warning。

- [ ] **Step 9: 导出模块**

在 `crates/cli-box-core/src/capture/mod.rs` 末尾追加：

```rust
pub mod headless;
pub use headless::HeadlessTerminal;
```

- [ ] **Step 10: 提交**

```bash
git add crates/cli-box-core/src/capture/headless.rs crates/cli-box-core/src/capture/mod.rs
git commit -m "feat(capture): add HeadlessTerminal (vt100 + ab_glyph PNG renderer)

Pure module: feed PTY bytes -> live vt100 grid -> render PNG. Replaces
the Electron xterm.js canvas path when no renderer is connected (headless).
CJK-capable via embedded monospace font. Fully unit-tested."
```

---

### Task 4: 在 PTY session 挂载 HeadlessTerminal（reader 线程 feed）

**Files:**
- Modify: `crates/cli-box-core/src/process/mod.rs`

**Interfaces:**
- Produces: `ProcessManager::get_terminal(pid: u32) -> Result<Arc<HeadlessTerminal>>`（新增），供 Task 5 的 daemon 路由使用。
- Consumes: `crate::capture::HeadlessTerminal`（Task 3）。

- [ ] **Step 1: PtySession 增加 terminal 字段**

在 `PtySession` 结构体（现 `cfg(unix)`）追加字段：

```rust
struct PtySession {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn MasterPty>,
    #[allow(dead_code)]
    child_pid: u32,
    command: String,
    store: Arc<PtyStore>,
    /// Headless terminal grid fed incrementally by the reader thread.
    terminal: Arc<crate::capture::HeadlessTerminal>,
    stop_flag: Arc<AtomicBool>,
    reader_thread: Option<std::thread::JoinHandle<()>>,
    output_tx: broadcast::Sender<String>,
}
```

- [ ] **Step 2: 创建 terminal 并在 reader 线程 feed**

在 `spawn_cli_with_size` 中，创建 store 后、创建 reader 线程前，加：

```rust
        let terminal = Arc::new(crate::capture::HeadlessTerminal::new(cols, rows));
        let thread_terminal = Arc::clone(&terminal);
```

在 reader 线程的 `Ok(n) => { ... }` 分支内，`thread_store.append(&text)?` 之后、`thread_tx.send` 之前，加：

```rust
                            // Feed raw bytes to the headless terminal grid (for screenshots).
                            thread_terminal.feed(&read_buf[..n]);
```

> 用原始字节 `read_buf[..n]`，不用 lossy 转换后的 `text`（避免 UTF-8 边界被破坏）。

并在 `sessions.insert(tracked_id, PtySession { ... })` 的字段列表中加入 `terminal,`。

- [ ] **Step 3: 实现 get_terminal 访问器**

在 `impl ProcessManager` 中（与 `get_store` 相邻），加（`cfg(unix)`）：

```rust
    /// Get the HeadlessTerminal for a session (for headless screenshots).
    #[cfg(unix)]
    pub fn get_terminal(pid: u32) -> Result<Arc<crate::capture::HeadlessTerminal>> {
        let sessions = SESSIONS
            .lock()
            .map_err(|e| AppError::Process(e.to_string()))?;
        let session = sessions
            .get(&pid)
            .ok_or_else(|| AppError::Process(format!("Process {pid} not found")))?;
        Ok(Arc::clone(&session.terminal))
    }
```

- [ ] **Step 4: 编译 + 现有 PTY 测试不回归**

```bash
cargo build -p cli-box-core 2>&1 | tail -5
cargo test -p cli-box-core --test pty_reader_test 2>&1 | tail -15
cargo clippy -p cli-box-core --all-targets -- -D warnings 2>&1 | tail -5
```
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add crates/cli-box-core/src/process/mod.rs
git commit -m "feat(process): mount HeadlessTerminal on PTY sessions

Each PTY session now holds a persistent HeadlessTerminal, fed
incrementally by the existing reader thread alongside PtyStore. Adds
get_terminal(pid) accessor for the headless screenshot path."
```

---

### Task 5: Headless 截图 & scrollback 路由（`daemon/mod.rs`）

**Files:**
- Modify: `crates/cli-box-core/src/daemon/mod.rs`（DaemonState 字段、run_daemon 签名、screenshot_handler、scrollback_handler、新增 2 个函数、test helpers）
- Modify: `crates/cli-box-daemon/src/main.rs`（`--headless` 参数）
- Modify: `crates/cli-box-core/tests/daemon_integration.rs`（test helpers + headless IT）

**Interfaces:**
- Consumes: `ProcessManager::get_terminal`（Task 4）、`ProcessManager::get_store`（已有）。
- Produces: daemon `--headless` 模式；`DaemonState.headless: bool`；截图/scrollback 在 headless 模式下走服务端渲染。

> 设计选择：headless 走显式 `--headless` 标志而非"renderer 未连接即 headless"，确保 macOS（有 Electron）行为 100% 不变；仅 Linux/无 Electron 时 CLI 传 `--headless`。

- [ ] **Step 1: DaemonState 增加 headless 字段**

`daemon/mod.rs` 结构体 `DaemonState` 末尾（`terminal_ready_sandboxes` 之后）加：

```rust
pub struct DaemonState {
    // ... existing fields ...
    pub terminal_ready_sandboxes: HashSet<String>,
    /// True when running without the Electron renderer (Linux / no GUI).
    /// Routes screenshots/scrollback to the server-side HeadlessTerminal.
    pub headless: bool,
}
```

并更新**所有** `DaemonState { ... }` 字面构造，加入 `headless: <bool>`：
- `run_daemon`（约 1600 行）：用传入参数（Step 2 改签名）。
- `test_daemon_state`（约 1806）、`test_daemon_state_with_sandbox`（约 1834）：`headless: false`。
- IT 文件 `daemon_integration.rs` 的 `empty_state` 与 `state_with_sandbox`：`headless: false`。

```bash
grep -rn "terminal_ready_sandboxes: HashSet::new()\|terminal_ready_sandboxes: " crates/ 2>/dev/null
```
逐一在这些构造后补 `headless: false,`（run_daemon 用参数变量）。

- [ ] **Step 2: run_daemon 接收 headless 参数**

```rust
pub async fn run_daemon(port: u16, headless: bool) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("Daemon starting on port {port} (pid={}, headless={headless})", std::process::id());
    let state = Arc::new(Mutex::new(DaemonState {
        port,
        sandboxes: HashMap::new(),
        started_at: Instant::now(),
        screenshot_ws_tx: None,
        pending_screenshots: HashMap::new(),
        pending_scrollback: HashMap::new(),
        screenshot_request_counter: 0,
        terminal_ready_sandboxes: HashSet::new(),
        headless,
    }));
    // ... rest unchanged ...
```

- [ ] **Step 3: daemon main 解析 --headless**

`crates/cli-box-daemon/src/main.rs`，在 `--version`/`--help` 判断之后、`find_available_port` 之前加：

```rust
    let headless = args.iter().any(|a| a == "--headless");
```

并把启动行改为：

```rust
    rt.block_on(async move { cli_box_core::daemon::run_daemon(port, headless).await })
        .expect("Daemon exited with error");
```

并在 `--help` 文本追加：`eprintln!("      --headless      Run without Electron (headless, Linux)");`

- [ ] **Step 4: 新增 screenshot_headless 函数**

在 `screenshot_with_frame` 函数之后加：

```rust
/// Capture a screenshot by rendering the PTY terminal grid server-side.
/// Used when running headless (no Electron renderer). `scroll` is a line
/// offset into the scrollback; large values (e.g. from --top) clamp to top.
async fn screenshot_headless(
    state: Arc<Mutex<DaemonState>>,
    id: &str,
    scroll: u32,
) -> Result<Response, AppError> {
    let pty_pid: u32 = {
        let s = state.lock().await;
        let sb = s
            .sandboxes
            .get(id)
            .ok_or_else(|| AppError::Instance(format!("Sandbox '{id}' not found")))?;
        sb.pty_pid
            .ok_or_else(|| AppError::Process(format!("Sandbox {id} has no PTY")))?
    };
    let terminal = tokio::task::spawn_blocking(move || {
        crate::process::ProcessManager::get_terminal(pty_pid)
    })
    .await
    .map_err(|e| AppError::Screenshot(format!("get_terminal task failed: {e}")))??;
    let png_data = tokio::task::spawn_blocking(move || terminal.render_png(scroll as usize))
        .await
        .map_err(|e| AppError::Screenshot(format!("render task failed: {e}")))??;
    Ok(screenshot_response(png_data, "headless", None))
}
```

- [ ] **Step 5: 新增 scrollback_headless 函数**

在 `request_renderer_scrollback` 之后加：

```rust
/// Read scrollback from server-side state (headless). `raw` returns the raw
/// PTY bytes from PtyStore; otherwise the parsed terminal grid text.
async fn scrollback_headless(
    state: Arc<Mutex<DaemonState>>,
    id: &str,
    raw: bool,
) -> Result<String, AppError> {
    let (pty_pid,) = {
        let s = state.lock().await;
        let sb = s
            .sandboxes
            .get(id)
            .ok_or_else(|| AppError::Instance(format!("Sandbox '{id}' not found")))?;
        (sb.pty_pid
            .ok_or_else(|| AppError::Process(format!("Sandbox {id} has no PTY")))?,)
    };
    if raw {
        let store = tokio::task::spawn_blocking(move || {
            crate::process::ProcessManager::get_store(pty_pid)
        })
        .await
        .map_err(|e| AppError::Process(format!("get_store task failed: {e}")))??;
        let chunks = store
            .read_all()
            .map_err(|e| AppError::Process(format!("read_all failed: {e}")))?;
        Ok(chunks.into_iter().map(|c| c.data).collect())
    } else {
        let terminal = tokio::task::spawn_blocking(move || {
            crate::process::ProcessManager::get_terminal(pty_pid)
        })
        .await
        .map_err(|e| AppError::Screenshot(format!("get_terminal task failed: {e}")))??;
        Ok(terminal.rendered_text())
    }
}
```

- [ ] **Step 6: screenshot_handler 路由 headless**

在 `screenshot_handler` 中，`if q.with_frame { ... }` 之后、`let offset = ...` 之后，在 `match request_renderer_screenshot(...)` **之前**插入 headless 短路：

```rust
    let offset: u32 = if q.top { u32::MAX } else { q.scroll.unwrap_or(0) };

    // Headless: render server-side when no Electron renderer is attached.
    if state.lock().await.headless {
        return screenshot_headless(state.clone(), &id, offset).await;
    }

    // Default: renderer only, no SCK fallback
    match request_renderer_screenshot(state.clone(), &id, offset).await {
        // ... unchanged ...
```

- [ ] **Step 7: scrollback_handler 路由 headless**

在 `scrollback_handler` 中，`match request_renderer_scrollback(...)` **之前**插入：

```rust
    if state.lock().await.headless {
        let text = scrollback_headless(state.clone(), &id, q.raw).await?;
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        return Ok((StatusCode::OK, headers, text).into_response());
    }
    match request_renderer_scrollback(state.clone(), &id, q.raw, q.from_line, q.to_line).await {
        // ... unchanged ...
```

- [ ] **Step 8: 写 IT 测试 — headless 截图返回 PNG**

在 `crates/cli-box-core/tests/daemon_integration.rs` 末尾追加（`cfg(unix)`，spawn 真实 PTY）：

```rust
#[cfg(unix)]
#[tokio::test]
async fn headless_screenshot_renders_png() {
    use cli_box_core::process::ProcessManager;

    // Spawn a real CLI whose output feeds the HeadlessTerminal via the reader thread.
    let info = ProcessManager::spawn_cli("printf", &["hello-headless".into()])
        .expect("spawn_cli");
    // allow the reader thread to drain output into the terminal
    std::thread::sleep(std::time::Duration::from_millis(300));

    let mut sandboxes = HashMap::new();
    sandboxes.insert(
        "hsb".to_string(),
        ManagedSandbox {
            id: "hsb".to_string(),
            kind: InstanceKind::Cli { command: "printf".into(), args: vec![] },
            status: InstanceStatus::Running,
            port: 0,
            pty_pid: Some(info.pid),
            window_id: None,
        },
    );
    let state = Arc::new(Mutex::new(DaemonState {
        port: 0,
        sandboxes,
        started_at: std::time::Instant::now(),
        screenshot_ws_tx: None,
        pending_screenshots: HashMap::new(),
        pending_scrollback: HashMap::new(),
        screenshot_request_counter: 0,
        terminal_ready_sandboxes: HashSet::new(),
        headless: true,
    }));
    let router = build_daemon_router(state);

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/box/hsb/screenshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get("x-screenshot-source").unwrap(),
        "headless"
    );
    // cleanup
    let _ = ProcessManager::kill_process(info.pid);
}
```

- [ ] **Step 9: 编译 + 测试**

```bash
cargo build -p cli-box-core -p cli-box-cli -p cli-box-daemon 2>&1 | tail -5
cargo test -p cli-box-core --test daemon_integration headless 2>&1 | tail -15
cargo clippy -p cli-box-core -p cli-box-daemon --all-targets -- -D warnings 2>&1 | tail -5
```
Expected: headless_screenshot_renders_png PASS；其余测试不回归。

- [ ] **Step 10: 提交**

```bash
git add crates/cli-box-core/src/daemon/mod.rs crates/cli-box-daemon/src/main.rs crates/cli-box-core/tests/daemon_integration.rs
git commit -m "feat(daemon): route screenshots/scrollback to headless renderer

Add --headless daemon mode (DaemonState.headless). When headless,
/box/{id}/screenshot renders the PTY terminal grid via HeadlessTerminal
and /box/{id}/scrollback reads PtyStore/grid text — no Electron needed.
macOS (non-headless) behavior unchanged."
```

---

### Task 6: CLI headless 短路 + 传 `--headless` 给 daemon（`main.rs`）

**Files:**
- Modify: `crates/cli-box-cli/src/main.rs`

**Interfaces:**
- Consumes: `find_electron_binary()`（已有）、daemon `--headless`（Task 5）。
- Produces: 无 Electron 时 CLI 不等待 renderer，并把 `--headless` 传给 daemon。

- [ ] **Step 1: 定位 daemon 启动点**

```bash
grep -n "find_daemon_binary\|Command::new.*daemon\|run_daemon\|spawn.*daemon" crates/cli-box-cli/src/main.rs
```
找到 CLI 用 `find_daemon_binary()` 拿到路径后 `Command::new(daemon_bin)` 启动 daemon 的位置（通常在 `ensure_daemon` 或 `ensure_healthy_daemon` 类函数中）。

- [ ] **Step 2: 启动 daemon 时按需追加 --headless**

在该 `Command::new(&daemon_bin)` 处，根据是否有 Electron 决定是否追加 `--headless`：

```rust
let mut cmd = Command::new(&daemon_bin);
// Headless when no Electron app is available (Linux / no GUI).
if find_electron_binary().is_none() {
    cmd.arg("--headless");
}
cmd.spawn()  // 或当前等价调用
```

> 用 `find_electron_binary().is_none()` 作为 headless 判据：macOS 有 Electron → 不传 → daemon 走 renderer（不变）；Linux/无 Electron → 传 `--headless` → daemon 走 headless 渲染。

- [ ] **Step 3: ensure_healthy_electron 显式短路**

在 `ensure_healthy_electron` 函数**最开头**加显式短路（避免 macOS 路径探测）：

```rust
async fn ensure_healthy_electron() {
    use std::io::Write;

    // Headless: no Electron app present (Linux / cloud). Don't spawn or wait.
    if find_electron_binary().is_none() {
        eprintln!("Running in headless mode (no Electron). Screenshots use the server-side renderer.");
        return;
    }

    // ... existing body unchanged ...
```

- [ ] **Step 4: 编译 + 类型检查**

```bash
cargo build -p cli-box-cli 2>&1 | tail -5
cargo clippy -p cli-box-cli --all-targets -- -D warnings 2>&1 | tail -5
```
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add crates/cli-box-cli/src/main.rs
git commit -m "feat(cli): pass --headless to daemon and short-circuit Electron wait

When no Electron app is found (Linux/cloud), the CLI no longer waits
for a renderer and starts the daemon in --headless mode."
```

---

### Task 7: Linux 编译/测试 CI 门禁（`ci.yml`）

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:** 无（基础设施）。

> 此 Task 是 Linux 编译的**权威验证**——它会捕获 Task 2 未在本机（macOS）暴露的任何残留 `cfg` 问题。

- [ ] **Step 1: 新增 Linux clippy 门禁**

在 `ci.yml` 末尾（`frontend-test` job 之后）追加：

```yaml
  # ==================== Rust Clippy + Test (Linux) ====================
  # Validates that the core/CLI/daemon compile and test on Linux.
  # Catches cfg(unix) gating issues not exercised on the macOS jobs.
  rust-linux:
    name: Rust 编译/测试
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: 检出代码
        uses: actions/checkout@v4

      - name: 安装 Rust ${{ env.RUST_VERSION }}
        uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: ${{ env.RUST_VERSION }}
          components: clippy

      - name: 设置 Rust 缓存
        uses: Swatinem/rust-cache@v2
        with:
          cache-on-failure: true
          key: "v2-linux"

      - name: 安装系统依赖
        run: sudo apt-get update && sudo apt-get install -y pkg-config

      - name: cargo check (all crates)
        run: cargo check -p cli-box-core -p cli-box-cli -p cli-box-daemon

      - name: cargo clippy
        run: cargo clippy -p cli-box-core -p cli-box-cli -p cli-box-daemon --all-targets -- -D warnings

      - name: cargo test (core)
        run: cargo test -p cli-box-core
```

> 注：`rusqlite` 用 bundled 特性（已是 `features=["bundled"]`），无需系统 sqlite。`vt100`/`ab_glyph` 纯 Rust，无系统依赖。

- [ ] **Step 2: 验证 YAML 语法**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml OK')"
```
Expected: `ci.yml OK`。

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add Linux compile/clippy/test gate

Builds and tests cli-box-core/cli/daemon on ubuntu-latest to validate
cfg(unix) gating and the headless path on Linux."
```

---

### Task 8: Linux headless E2E 门禁

**Files:**
- Modify: `tests/e2e-compound-start-screenshot.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:** 无（端到端验证）。

- [ ] **Step 1: 适配 E2E 脚本支持 Linux**

`tests/e2e-compound-start-screenshot.sh` 顶部现有的 skip 守卫，把"Linux 跳过"改为"Linux 走 headless 子集"。在脚本开头加平台检测与命令选择：

```bash
# Detect platform: on Linux use bash and skip --with-frame (no ScreenCaptureKit).
OS="$(uname)"
if [ "$OS" = "Darwin" ]; then
  SHELL_CMD="zsh"
else
  SHELL_CMD="bash"
fi
```

并把脚本中 `cli-box start "..."` 的 sandbox 命令、`--with-frame` 相关断言用 `$OS` 条件跳过（Linux 上只验证默认 screenshot + `--top` + scrollback，跳过 `--with-frame`）。具体：
- 把所有硬编码 `zsh` 换为 `$SHELL_CMD`（或 `printf`/`echo` 这类跨平台命令）。
- `--with-frame` 用例包裹 `if [ "$OS" = "Darwin" ]; then ... fi`。

> 若改动复杂，最小可用方案：保留原 macOS 脚本不动，**新增** `tests/e2e-linux-headless.sh` 只覆盖 `start bash` → `screenshot`（默认 + `--top`）→ `scrollback`，并在 Step 2 的 CI job 调用它。二选一即可，推荐后者更清晰。

- [ ] **Step 2: 新增 ci.yml headless E2E job**

在 `ci.yml` 追加：

```yaml
  # ==================== Headless E2E (Linux) ====================
  # End-to-end: start a CLI sandbox, type, screenshot, scrollback — all headless.
  e2e-linux-headless:
    name: Headless E2E (Linux)
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: 检出代码
        uses: actions/checkout@v4

      - name: 安装 Rust ${{ env.RUST_VERSION }}
        uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: ${{ env.RUST_VERSION }}

      - name: 构建 CLI + daemon (release)
        run: cargo build --release -p cli-box-cli -p cli-box-daemon

      - name: 置于 PATH
        run: |
          mkdir -p ~/.local/bin
          ln -sf "$PWD/target/release/cli-box" ~/.local/bin/cli-box
          ln -sf "$PWD/target/release/cli-box-daemon" ~/.local/bin/cli-box-daemon
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - name: 运行 headless E2E
        env:
          CLI_BOX_HEADLESS: "1"
        run: bash tests/e2e-linux-headless.sh
```

- [ ] **Step 3: 创建 headless E2E 脚本（若 Step 1 选了新脚本方案）**

```bash
cat > tests/e2e-linux-headless.sh << 'E2EOF'
#!/usr/bin/env bash
set -euo pipefail
# Headless E2E (Linux): start -> type -> screenshot -> scrollback, no Electron.

MARKER_DIR="$(mktemp -d)"
trap 'rm -rf "$MARKER_DIR"' EXIT

echo "➜ start bash sandbox"
SID=$(cli-box start "printf 'headless-ok\n'" 2>/dev/null | grep -oE 'cli-box-[a-zA-Z0-9_-]+' | head -1)
[ -n "$SID" ] || { echo "FAIL: no sandbox id"; exit 1; }
sleep 1

echo "➜ default screenshot"
cli-box screenshot --id "$SID" -o "$MARKER_DIR/bottom.png" >/dev/null \
  || { echo "FAIL: default screenshot"; exit 1; }
[ -s "$MARKER_DIR/bottom.png" ] || { echo "FAIL: empty png"; exit 1; }

echo "➜ --top screenshot"
cli-box screenshot --id "$SID" --top -o "$MARKER_DIR/top.png" >/dev/null \
  || { echo "FAIL: --top screenshot"; exit 1; }
[ -s "$MARKER_DIR/top.png" ] || { echo "FAIL: empty top png"; exit 1; }

echo "➜ scrollback"
SB=$(cli-box scrollback --id "$SID" 2>/dev/null || true)
echo "$SB" | grep -q "headless-ok" || { echo "FAIL: scrollback missing marker"; exit 1; }

echo "✓ headless E2E passed"
E2EOF
chmod +x tests/e2e-linux-headless.sh
```

- [ ] **Step 4: YAML 校验 + 提交**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml OK')"
git add tests/e2e-compound-start-screenshot.sh tests/e2e-linux-headless.sh .github/workflows/ci.yml
git commit -m "test(e2e): add Linux headless E2E gate

Start/type/screenshot/scrollback against a headless daemon on
ubuntu-latest — the only end-to-end exercise of HeadlessTerminal."
```

---

### Task 9: Release 流水线 + npm linux-x64 包

**Files:**
- Modify: `.github/workflows/release.yml`
- Create: `packages/cli-box-linux-x64/package.json`
- Modify: `packages/cli-box-skill/package.json`

**Interfaces:** 无。

- [ ] **Step 1: 新增 npm 平台包**

`mkdir -p packages/cli-box-linux-x64`，创建 `packages/cli-box-linux-x64/package.json`：

```json
{
  "name": "cli-box-linux-x64",
  "version": "0.3.0",
  "description": "cli-box binaries for Linux x86_64 (headless)",
  "license": "Apache-2.0",
  "os": ["linux"],
  "cpu": ["x64"],
  "bin": {
    "cli-box": "bin/cli-box",
    "cli-box-daemon": "bin/cli-box-daemon"
  },
  "files": ["bin/"]
}
```

- [ ] **Step 2: release.yml 新增 build-linux job**

在 `release.yml` 的 `build-and-release` job 之后，追加一个 Linux job（与 macOS job 平级，各自上传到同一 Release）：

```yaml
  build-linux:
    name: Build Linux (headless)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', github.event.inputs.tag) || github.ref }}

      - name: Install Rust ${{ env.RUST_VERSION }}
        uses: dtolnay/rust-toolchain@master
        with:
          toolchain: ${{ env.RUST_VERSION }}

      - name: Rust cache
        uses: Swatinem/rust-cache@v2
        with:
          cache-on-failure: true
          key: "v2-linux-release"

      - name: Build CLI + daemon (release)
        run: cargo build --release -p cli-box-cli -p cli-box-daemon

      - name: Collect artifacts
        run: |
          mkdir -p release
          cp target/release/cli-box release/cli-box-linux-x64
          cp target/release/cli-box-daemon release/cli-box-daemon-linux-x64
          chmod +x release/cli-box-linux-x64 release/cli-box-daemon-linux-x64
          cd release && tar czf cli-box-linux-x64.tar.gz cli-box-linux-x64 cli-box-daemon-linux-x64 && cd ..

      - name: Upload to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.event_name == 'workflow_dispatch' && github.event.inputs.tag || github.ref_name }}
          files: release/cli-box-linux-x64.tar.gz
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Publish npm platform package
        if: github.event_name == 'release'
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          echo "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}" > ~/.npmrc
          VERSION="${GITHUB_REF_NAME#v}"
          mkdir -p packages/cli-box-linux-x64/bin
          cp target/release/cli-box packages/cli-box-linux-x64/bin/
          cp target/release/cli-box-daemon packages/cli-box-linux-x64/bin/
          chmod +x packages/cli-box-linux-x64/bin/*
          node -e "const fs=require('fs');const f='packages/cli-box-linux-x64/package.json';const p=JSON.parse(fs.readFileSync(f,'utf8'));p.version='$VERSION';fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n');"
          npm publish ./packages/cli-box-linux-x64 --access public
```

- [ ] **Step 3: skill 包 optionalDependencies 加 linux**

在 `packages/cli-box-skill/package.json` 的 `optionalDependencies`（若存在）中加入；若无该字段则新增：

```json
  "optionalDependencies": {
    "cli-box-darwin-arm64": "0.3.0",
    "cli-box-linux-x64": "0.3.0"
  }
```

> 实现者：核对 `packages/cli-box-skill/package.json` 现有结构，保持版本号与其他平台包一致；release.yml 的 "Package npm platform packages" 步骤里更新版本号的 node 脚本需把 `packages/cli-box-linux-x64/package.json` 加入文件列表（参考现有 darwin-arm64 处理）。

- [ ] **Step 4: 提交**

```bash
git add packages/cli-box-linux-x64/ packages/cli-box-skill/package.json .github/workflows/release.yml
git commit -m "ci(npm): publish cli-box-linux-x64 and add build-linux release job

Headless Linux binaries (cli-box + cli-box-daemon, no Electron) built
on ubuntu-latest and published as cli-box-linux-x64 npm package +
GitHub Release tarball."
```

---

## 全部完成后的收尾

- [ ] **Step 1: 本地完整门禁（macOS 不回归）**

```bash
sh test.sh
```
Expected: macOS 全部门禁通过。

- [ ] **Step 2: 推送 + 开 PR**

```bash
git push -u origin feat/linux-headless-support
gh pr create --title "feat: Linux headless CLI support" --body "$(cat <<'PR'
## Problem
cli-box 仅支持 macOS。需要以无头 daemon 形态运行在云端 Linux 服务器，保留键盘输入与终端截图。

## Solution
- 方案 A：Rust 原生终端渲染器（vt100 + ab_glyph），无 Electron 依赖
- PTY 实现从 cfg(macos) 释放为 cfg(unix)（portable-pty 本就跨平台）
- 截图/scrollback 在 headless 模式走服务端渲染（HeadlessTerminal）
- Linux CI 编译/测试门禁 + headless E2E + build-linux release + cli-box-linux-x64 npm 包
- ui-inspect / --with-frame / app 模式 / 鼠标输入 在 Linux 明确不支持（文档标注）

## Test Plan
- [x] headless.rs 单测（feed/颜色/render_png 尺寸/非空）
- [x] daemon_integration headless 截图 IT（真实 PTY）
- [x] Linux cargo check/clippy/test 门禁
- [x] Linux headless E2E（start→screenshot→scrollback）
- [ ] macOS test.sh 不回归
PR
)"
```
Expected: PR 创建并保持 open（不合入）。

- [ ] **Step 3: 关注 CI，按需修复**

等待 PR 的 CI（含新增 Linux 门禁）全部通过；失败则按 `superpowers:systematic-debugging` 定位修复后重推。

