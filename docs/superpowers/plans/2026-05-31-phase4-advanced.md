# Phase 4: Advanced Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recording/playback of sandbox operations and screenshot diff capability for automated testing workflows.

**Architecture:** Recording captures every CLI action (type, key, click, screenshot) as a JSONL file. Playback replays the sequence with timing. Screenshot diff uses the `image` crate to compare two PNGs pixel-by-pixel.

**Tech Stack:** Rust, serde_json, image crate, chrono

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `crates/sandbox-core/src/recorder.rs` | Create | JSONL recorder — writes actions to file |
| `crates/sandbox-core/src/player.rs` | Create | JSONL player — reads and replays actions |
| `crates/sandbox-core/src/diff.rs` | Create | Screenshot diff — pixel comparison |
| `crates/sandbox-core/src/lib.rs` | Modify | Add `pub mod recorder; pub mod player; pub mod diff;` |
| `crates/sandbox-cli/src/main.rs` | Modify | Add `Record`, `Playback`, `Diff` commands |
| `crates/sandbox-cli/src/client.rs` | Modify | Add recording client methods |

---

### Task 1: Action types and recorder

**Files:**
- Create: `crates/sandbox-core/src/recorder.rs`
- Modify: `crates/sandbox-core/src/lib.rs`

- [ ] **Step 1: Create the recorder module**

```rust
// crates/sandbox-core/src/recorder.rs
use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::Instant;

/// A recorded action with timing information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedAction {
    /// Milliseconds since recording started
    pub offset_ms: u64,
    /// The action type
    pub action: ActionType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ActionType {
    #[serde(rename = "type")]
    Type { text: String, pty: bool },
    #[serde(rename = "key")]
    Key { key: String, modifiers: Vec<String>, pty: bool },
    #[serde(rename = "click")]
    Click { x: f64, y: f64, button: String },
    #[serde(rename = "screenshot")]
    Screenshot { path: String },
    #[serde(rename = "wait")]
    Wait { ms: u64 },
}

/// Records actions to a JSONL file.
pub struct Recorder {
    writer: BufWriter<File>,
    start: Instant,
}

impl Recorder {
    pub fn start(path: &PathBuf) -> Result<Self> {
        let file = File::create(path)?;
        Ok(Self {
            writer: BufWriter::new(file),
            start: Instant::now(),
        })
    }

    pub fn record(&mut self, action: ActionType) -> Result<()> {
        let offset_ms = self.start.elapsed().as_millis() as u64;
        let entry = RecordedAction { offset_ms, action };
        serde_json::to_writer(&mut self.writer, &entry)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        Ok(())
    }
}
```

- [ ] **Step 2: Register module in lib.rs**

Add to `crates/sandbox-core/src/lib.rs`:

```rust
pub mod recorder;
```

- [ ] **Step 3: Verify compilation**

Run: `cargo check -p sandbox-core`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/sandbox-core/src/recorder.rs crates/sandbox-core/src/lib.rs
git commit -m "feat(core): add JSONL action recorder"
```

---

### Task 2: Player

**Files:**
- Create: `crates/sandbox-core/src/player.rs`
- Modify: `crates/sandbox-core/src/lib.rs`

- [ ] **Step 1: Create the player module**

```rust
// crates/sandbox-core/src/player.rs
use crate::error::Result;
use crate::recorder::RecordedAction;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::sleep;
use tracing::info;

/// Callback invoked for each action during playback.
pub type ActionCallback = Box<dyn Fn(RecordedAction) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> + Send + Sync>;

/// Replays actions from a JSONL file.
pub struct Player;

impl Player {
    pub async fn play(path: &PathBuf, callback: &ActionCallback) -> Result<()> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let mut last_offset: u64 = 0;

        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() { continue; }
            let action: RecordedAction = serde_json::from_str(&line)?;

            // Wait for the appropriate delay
            let delay = action.offset_ms.saturating_sub(last_offset);
            if delay > 0 {
                sleep(Duration::from_millis(delay)).await;
            }
            last_offset = action.offset_ms;

            info!("Playing action at {}ms: {:?}", action.offset_ms, action.action);
            callback(action).await?;
        }
        Ok(())
    }

    pub fn load_actions(path: &PathBuf) -> Result<Vec<RecordedAction>> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let mut actions = Vec::new();
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() { continue; }
            actions.push(serde_json::from_str(&line)?);
        }
        Ok(actions)
    }
}
```

- [ ] **Step 2: Register module in lib.rs**

Add to `crates/sandbox-core/src/lib.rs`:

```rust
pub mod player;
```

- [ ] **Step 3: Verify compilation**

Run: `cargo check -p sandbox-core`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/sandbox-core/src/player.rs crates/sandbox-core/src/lib.rs
git commit -m "feat(core): add JSONL action player"
```

---

### Task 3: Screenshot diff

**Files:**
- Create: `crates/sandbox-core/src/diff.rs`
- Modify: `crates/sandbox-core/src/lib.rs`

- [ ] **Step 1: Create the diff module**

```rust
// crates/sandbox-core/src/diff.rs
use crate::error::{AppError, Result};
use image::{GenericImageView, Rgba};
use serde::Serialize;

/// Result of comparing two screenshots.
#[derive(Debug, Serialize)]
pub struct DiffResult {
    pub total_pixels: u32,
    pub different_pixels: u32,
    pub diff_percentage: f64,
    pub diff_image: Option<Vec<u8>>,
}

/// Compare two PNG images pixel-by-pixel.
pub fn diff_images(img_a: &[u8], img_b: &[u8], threshold: u8) -> Result<DiffResult> {
    let a = image::load_from_memory(img_a)
        .map_err(|e| AppError::Screenshot(format!("Failed to load image A: {e}")))?;
    let b = image::load_from_memory(img_b)
        .map_err(|e| AppError::Screenshot(format!("Failed to load image B: {e}")))?;

    if a.dimensions() != b.dimensions() {
        return Err(AppError::BadRequest(format!(
            "Image dimensions differ: {:?} vs {:?}",
            a.dimensions(), b.dimensions()
        )));
    }

    let (width, height) = a.dimensions();
    let total = width * height;
    let mut different: u32 = 0;
    let mut diff_buf = image::RgbaImage::new(width, height);

    for y in 0..height {
        for x in 0..width {
            let pa: Rgba<u8> = a.get_pixel(x, y);
            let pb: Rgba<u8> = b.get_pixel(x, y);
            let dr = pa[0].abs_diff(pb[0]);
            let dg = pa[1].abs_diff(pb[1]);
            let db = pa[2].abs_diff(pb[2]);
            if dr > threshold || dg > threshold || db > threshold {
                different += 1;
                diff_buf.put_pixel(x, y, Rgba([255, 0, 0, 255]));
            } else {
                diff_buf.put_pixel(x, y, pa);
            }
        }
    }

    let mut diff_png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut diff_png);
    use image::ImageEncoder;
    encoder.write_image(
        diff_buf.as_raw(),
        width,
        height,
        image::ExtendedColorType::Rgba8,
    ).map_err(|e| AppError::Screenshot(format!("Failed to encode diff: {e}")))?;

    Ok(DiffResult {
        total_pixels: total,
        different_pixels: different,
        diff_percentage: (different as f64 / total as f64) * 100.0,
        diff_image: Some(diff_png),
    })
}
```

- [ ] **Step 2: Register module in lib.rs**

```rust
pub mod diff;
```

- [ ] **Step 3: Verify compilation**

Run: `cargo check -p sandbox-core`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/sandbox-core/src/diff.rs crates/sandbox-core/src/lib.rs
git commit -m "feat(core): add screenshot pixel diff"
```

---

### Task 4: CLI commands for record/playback/diff

**Files:**
- Modify: `crates/sandbox-cli/src/main.rs`

- [ ] **Step 1: Add CLI commands**

Add to the `Commands` enum:

```rust
/// Record sandbox actions to a JSONL file
Record {
    /// Sandbox ID
    #[arg(long)]
    id: String,
    /// Output file path
    #[arg(long, short)]
    output: PathBuf,
},
/// Replay actions from a JSONL file
Playback {
    /// Sandbox ID
    #[arg(long)]
    id: String,
    /// JSONL file to replay
    #[arg(long, short)]
    input: PathBuf,
    /// Speed multiplier (1.0 = real-time)
    #[arg(long, default_value = "1.0")]
    speed: f64,
},
/// Compare two screenshots
Diff {
    /// First screenshot path
    #[arg(long)]
    a: PathBuf,
    /// Second screenshot path
    #[arg(long)]
    b: PathBuf,
    /// Pixel difference threshold (0-255)
    #[arg(long, default_value = "10")]
    threshold: u8,
    /// Output diff image path
    #[arg(long, short)]
    output: Option<PathBuf>,
},
```

- [ ] **Step 2: Implement Diff command handler**

```rust
Commands::Diff { a, b, threshold, output } => {
    let img_a = std::fs::read(&a)?;
    let img_b = std::fs::read(&b)?;
    let result = sandbox_core::diff::diff_images(&img_a, &img_b, threshold)?;
    println!("Total pixels: {}", result.total_pixels);
    println!("Different: {} ({:.2}%)", result.different_pixels, result.diff_percentage);
    if let (Some(out_path), Some(img)) = (&output, &result.diff_image) {
        std::fs::write(out_path, img)?;
        println!("Diff image saved to: {}", out_path.display());
    }
}
```

- [ ] **Step 3: Implement Record/Playback stubs**

For now, Record and Playback require the daemon HTTP endpoints (added in a later step). Add stub handlers that print a message:

```rust
Commands::Record { id, output } => {
    println!("Recording sandbox {id} to {}...", output.display());
    println!("Use 'sandbox type', 'sandbox key', 'sandbox click' commands while recording.");
    println!("Recording is integrated into the daemon — use HTTP API for now.");
}
Commands::Playback { id, input, speed } => {
    println!("Playing back {} on sandbox {id} at {speed}x speed...", input.display());
    println!("Use daemon HTTP API for playback execution.");
}
```

- [ ] **Step 4: Verify compilation**

Run: `cargo check -p sandbox-cli`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/sandbox-cli/src/main.rs
git commit -m "feat(cli): add diff command and record/playback stubs"
```

---

### Task 5: Unit tests

**Files:**
- Create: `crates/sandbox-core/tests/diff_test.rs`

- [ ] **Step 1: Write diff test**

```rust
// crates/sandbox-core/tests/diff_test.rs
use sandbox_core::diff::diff_images;

#[test]
fn test_identical_images_return_zero_diff() {
    // Create a 2x2 red PNG
    let img = image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]));
    let mut buf = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut buf);
    use image::ImageEncoder;
    encoder.write_image(img.as_raw(), 2, 2, image::ExtendedColorType::Rgba8).unwrap();

    let result = diff_images(&buf, &buf, 10).unwrap();
    assert_eq!(result.different_pixels, 0);
    assert_eq!(result.diff_percentage, 0.0);
}

#[test]
fn test_different_images_detect_changes() {
    let red = image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]));
    let blue = image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 0, 255, 255]));

    let encode = |img: &image::RgbaImage| -> Vec<u8> {
        let mut buf = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buf);
        use image::ImageEncoder;
        encoder.write_image(img.as_raw(), 2, 2, image::ExtendedColorType::Rgba8).unwrap();
        buf
    };

    let result = diff_images(&encode(&red), &encode(&blue), 10).unwrap();
    assert_eq!(result.different_pixels, 4);
    assert!((result.diff_percentage - 100.0).abs() < 0.01);
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p sandbox-core --test diff_test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/sandbox-core/tests/diff_test.rs
git commit -m "test(core): add screenshot diff unit tests"
```
