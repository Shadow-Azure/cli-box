//! Headless terminal renderer: parse PTY bytes into a grid and render to PNG.
//!
//! Pure (bytes in → PNG out), fully unit-testable. Server-side replacement for
//! the Electron xterm.js canvas path when no renderer is connected (headless /
//! Linux). The font is loaded at runtime (not embedded) — see `load_font`.

use crate::error::{AppError, Result};
use std::sync::Mutex;
use vt100::Color;

const DEFAULT_FG: (u8, u8, u8) = (229, 229, 229);
const DEFAULT_BG: (u8, u8, u8) = (0, 0, 0);

/// xterm-style 16-color palette (indices 0–15).
const PALETTE_16: [(u8, u8, u8); 16] = [
    (0, 0, 0),
    (205, 0, 0),
    (0, 205, 0),
    (205, 205, 0),
    (0, 0, 238),
    (205, 0, 205),
    (0, 205, 205),
    (229, 229, 229),
    (127, 127, 127),
    (255, 0, 0),
    (0, 255, 0),
    (255, 255, 0),
    (92, 92, 255),
    (255, 0, 255),
    (0, 255, 255),
    (255, 255, 255),
];

/// Convert a vt100 [`Color`] to an RGB triple. `default` is used for
/// `Color::Default` (caller passes `DEFAULT_FG` or `DEFAULT_BG`).
fn color_rgb(c: Color, default: (u8, u8, u8)) -> (u8, u8, u8) {
    match c {
        Color::Default => default,
        Color::Idx(i) => {
            let i = i as usize;
            if i < 16 {
                PALETTE_16[i]
            } else if i < 232 {
                // 6x6x6 color cube, base index 16.
                let v = (i - 16) as u32;
                let r = v / 36;
                let g = (v / 6) % 6;
                let b = v % 6;
                let lvl = |x: u32| if x == 0 { 0u8 } else { 55 + (x as u8) * 40 };
                (lvl(r), lvl(g), lvl(b))
            } else {
                // Grayscale ramp, base index 232.
                let g = 8 + (i - 232) as u8 * 10;
                (g, g, g)
            }
        }
        Color::Rgb(r, g, b) => (r, g, b),
    }
}

/// Load a font at runtime (NOT embedded). Resolution order:
///   1. `CLIBOX_FONT` env var (path to a TTF/OTF)
///   2. `~/.cli-box/font.ttf`
///   3. Known system CJK/mono font paths (macOS Arial Unicode, Linux noto)
///
/// Returns `None` if no usable font is found. `feed`/`rendered_text` need no
/// font; only `render_png` does, and it errors clearly when `None`.
///
/// TTF/OTF/TTC are all accepted. A `.ttc` collection loads its first face
/// (index 0) — ab_glyph's `try_from_vec` delegates to `try_from_vec_and_index(.., 0)`.
fn load_font() -> Option<ab_glyph::FontVec> {
    use ab_glyph::FontVec;
    let candidates: Vec<std::path::PathBuf> = std::env::var("CLIBOX_FONT")
        .into_iter()
        .map(std::path::PathBuf::from)
        .chain(
            std::env::var("HOME")
                .ok()
                .map(|h| std::path::PathBuf::from(h).join(".cli-box/font.ttf")),
        )
        .chain([
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf".into(),
            "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf".into(),
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc".into(),
        ])
        .collect();
    for p in candidates {
        if let Ok(bytes) = std::fs::read(&p) {
            if let Ok(f) = FontVec::try_from_vec(bytes) {
                tracing::debug!("headless font loaded from {}", p.display());
                return Some(f);
            }
        }
    }
    None
}

/// A persistent headless terminal: maintains a live grid from PTY bytes and can
/// render the screen to PNG. Mirrors the role xterm.js plays in the Electron
/// renderer, but server-side and dependency-free.
pub struct HeadlessTerminal {
    cols: u16,
    rows: u16,
    parser: Mutex<vt100::Parser>,
}

impl HeadlessTerminal {
    pub fn new(cols: u16, rows: u16) -> Self {
        // Keep a generous scrollback so --top / --scroll reach history.
        Self {
            cols,
            rows,
            parser: Mutex::new(vt100::Parser::new(rows, cols, 10_000)),
        }
    }

    /// Feed PTY bytes incrementally, updating the live grid.
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

    /// The current screen as plain text (clean scrollback mode).
    pub fn rendered_text(&self) -> String {
        let p = self.parser.lock().expect("poisoned terminal");
        p.screen().contents().to_string()
    }

    /// Render the current screen (optionally scrolled back) to PNG bytes.
    /// `scroll_offset` is a line offset into the scrollback (large values clamp
    /// to the top). Returns an error if no font is available for rendering.
    pub fn render_png(&self, scroll_offset: usize) -> Result<Vec<u8>> {
        use ab_glyph::{point, Font, PxScale, ScaleFont};
        use image::{ImageBuffer, Rgba, RgbaImage};
        use std::io::Cursor;

        let font = load_font().ok_or_else(|| {
            AppError::Screenshot(
                "no font available for rendering; set CLIBOX_FONT to a TTF/OTF path".into(),
            )
        })?;

        // Monospace metrics. PxScale.x/y are pixel sizes.
        let line_h = 18.0f32;
        let scale = PxScale {
            x: line_h,
            y: line_h,
        };
        let cell_h = line_h.round() as u32;
        // Monospace cell width ≈ 0.6 * height (avoids glyph_advance unit ambiguity).
        let cell_w = (line_h * 0.6).round() as u32;
        // Baseline offset MUST match how the rasterizer interprets `scale`:
        // ab_glyph's `PxScale.y` maps the font's full `height_unscaled`
        // (ascent - descent) to pixels — NOT `units_per_em`. Dividing the
        // ascent by upem (the old code) overestimates the offset for any font
        // whose ascent-descent exceeds 1em (all CJK faces: Noto CJK, Arial
        // Unicode, ...), pushing the baseline below the cell so the next row's
        // background fill clips the lower half of every tall glyph.
        // `as_scaled(scale).ascent()` divides by height_unscaled and so stays
        // consistent with the outline rasterization above.
        let ascent_px = font.as_scaled(scale).ascent();

        let mut parser = self
            .parser
            .lock()
            .map_err(|e| AppError::Screenshot(format!("terminal lock: {e}")))?;
        parser.screen_mut().set_scrollback(scroll_offset);
        let (rows, cols) = parser.screen().size();

        let img_w = cols as u32 * cell_w;
        let img_h = rows as u32 * cell_h;
        let mut img: RgbaImage = ImageBuffer::from_pixel(
            img_w,
            img_h,
            Rgba([DEFAULT_BG.0, DEFAULT_BG.1, DEFAULT_BG.2, 255]),
        );

        let blend = |bg: u8, fg: u8, a: f32| -> u8 {
            ((bg as f32) * (1.0 - a) + (fg as f32) * a).round() as u8
        };

        for row in 0..rows {
            for col in 0..cols {
                let Some(cell) = parser.screen().cell(row, col) else {
                    continue;
                };
                let bg = color_rgb(
                    if cell.inverse() {
                        cell.fgcolor()
                    } else {
                        cell.bgcolor()
                    },
                    DEFAULT_BG,
                );
                let fg = color_rgb(
                    if cell.inverse() {
                        cell.bgcolor()
                    } else {
                        cell.fgcolor()
                    },
                    DEFAULT_FG,
                );
                let x0 = col as u32 * cell_w;
                let y0 = row as u32 * cell_h;
                // Fill the cell background.
                for py in y0..(y0 + cell_h) {
                    for px in x0..(x0 + cell_w) {
                        img.put_pixel(px, py, Rgba([bg.0, bg.1, bg.2, 255]));
                    }
                }
                // Rasterize the glyph(s) onto the foreground.
                let base_y = y0 as f32 + ascent_px;
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
                        if cov > 0.0 && px < img_w && py < img_h {
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
        let encode_result = img.write_to(&mut buf, image::ImageFormat::Png);
        // Restore the scrollback view to the current screen. render_png sets a
        // scrolled-back view above; if left in place it leaks into the parser's
        // persistent scrollback_offset and corrupts a later rendered_text() (the
        // headless scrollback non-raw path), showing history instead of the screen.
        parser.screen_mut().set_scrollback(0);
        encode_result.map_err(|e| AppError::Screenshot(format!("png encode: {e}")))?;
        Ok(buf.into_inner())
    }

    /// Test helper: clone of the cell at (row, col).
    #[cfg(test)]
    fn screen_cell(&self, row: u16, col: u16) -> Option<vt100::Cell> {
        let p = self.parser.lock().expect("poisoned terminal");
        p.screen().cell(row, col).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_plain_text_appears_on_screen() {
        let term = HeadlessTerminal::new(80, 24);
        term.feed(b"hello");
        assert_eq!(term.screen_cell(0, 0).unwrap().contents(), "h");
        assert_eq!(term.screen_cell(0, 4).unwrap().contents(), "o");
    }

    #[test]
    fn feed_ansi_color_sets_fgcolor() {
        let term = HeadlessTerminal::new(80, 24);
        term.feed(b"\x1b[31mRED\x1b[m");
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

    #[test]
    fn render_png_has_expected_dimensions() {
        // Requires a font reachable via load_font() (e.g. macOS Arial Unicode).
        let term = HeadlessTerminal::new(80, 24);
        term.feed(b"hello world");
        let png = match term.render_png(0) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skipped (no font): {e}");
                return;
            }
        };
        assert_eq!(&png[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        let img = image::load_from_memory(&png).expect("decode").to_rgba8();
        assert_eq!(img.width() % 80, 0, "width must be a multiple of cols");
        assert_eq!(img.height() % 24, 0, "height must be a multiple of rows");
        assert!(img.width() >= 80 * 4 && img.height() >= 24 * 8);
    }

    #[test]
    fn render_png_contains_non_background_pixels() {
        let term = HeadlessTerminal::new(80, 24);
        term.feed(b"\x1b[31mX\x1b[m");
        let png = match term.render_png(0) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skipped (no font): {e}");
                return;
            }
        };
        let img = image::load_from_memory(&png).expect("decode").to_rgba8();
        let has_ink = img.pixels().any(|p| p[0] > 50 || p[1] > 50 || p[2] > 50);
        assert!(has_ink, "rendered PNG should contain non-background pixels");
    }

    #[test]
    fn render_png_tall_glyphs_span_cell_height() {
        // Regression: render_png used `ascent_unscaled / units_per_em` as the
        // baseline offset, but ab_glyph's `PxScale.y` maps the font's full
        // `height_unscaled` (ascent - descent) — not units_per_em — to pixels.
        // For CJK-capable fonts (Arial Unicode, Noto CJK) the height exceeds
        // upem, so the offset was too large and pushed the baseline *below* the
        // cell. Because rows are painted top-to-bottom, the next row's
        // background fill then erased the lower half of every tall glyph —
        // ASCII letters showed only their top, sitting at the bottom of the row.
        // Fix: derive the baseline offset from the rasterizer-consistent
        // `as_scaled(scale).ascent()`.
        let term = HeadlessTerminal::new(8, 2);
        term.feed(b"M");
        let png = match term.render_png(0) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skipped (no font): {e}");
                return;
            }
        };
        let img = image::load_from_memory(&png).expect("decode").to_rgba8();
        let (img_w, img_h) = (img.width(), img.height());
        let cell_h = img_h / 2;

        // Scan the first text row for foreground ink and record its vertical span.
        let is_fg = |p: &image::Rgba<u8>| p[0] > 50 || p[1] > 50 || p[2] > 50;
        let mut top: Option<u32> = None;
        let mut bot: Option<u32> = None;
        for y in 0..cell_h {
            for x in 0..img_w {
                if is_fg(img.get_pixel(x, y)) {
                    top.get_or_insert(y);
                    bot = Some(y);
                }
            }
        }
        let top = top.expect("no foreground ink in row 0");
        let bot = bot.unwrap();

        // With the bug the glyph's top landed past the cell midline (ink only in
        // the bottom band). After the fix it must reach into the top of the cell.
        assert!(
            top < cell_h * 2 / 5,
            "tall glyph top ink at y={top}, cell_h={cell_h}; glyph is shoved to the \
             bottom of its cell (baseline-offset / clipping bug)",
        );
        // Sanity: the glyph still reaches the lower portion of the cell.
        assert!(
            bot >= cell_h / 2,
            "tall glyph bottom ink at y={bot}, cell_h={cell_h}; glyph too short",
        );
    }

    #[test]
    fn render_png_resets_scrollback_offset() {
        // Regression: render_png(scroll) used to mutate the parser's persistent
        // scrollback_offset and never reset it, so a later rendered_text()
        // (headless scrollback non-raw path) returned the scrolled-back view
        // instead of the current screen. 3-row terminal fed 5 lines => the top
        // two lines scroll off into history; current screen holds line-two/three/four.
        let term = HeadlessTerminal::new(20, 3);
        term.feed(b"line-zero\r\nline-one\r\nline-two\r\nline-three\r\nline-four");
        let current = term.rendered_text();
        assert!(
            current.contains("line-four"),
            "baseline must show the current bottom (line-four); got {current:?}"
        );
        // Scroll to the very top. render_png needs a font; when none is available
        // it returns early WITHOUT touching the offset, so this regression
        // assertion is only binding in environments that ship a font (CI does).
        let _ = term.render_png(usize::MAX);
        assert_eq!(
            term.rendered_text(),
            current,
            "render_png must reset scrollback offset — rendered_text leaked the scrolled view"
        );
    }
}
