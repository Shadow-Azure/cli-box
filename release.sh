#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# system-test-sandbox — Release Build Script
# ============================================================
# Builds the CLI binary and packages it into ./release/.
#
# Prerequisites:
#   - Rust >= 1.91
#   - macOS (Apple Silicon or Intel)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RELEASE_DIR="$SCRIPT_DIR/release"
VERSION="0.1.0"

# --- helpers ---
info()  { echo "  ➜  $*"; }
ok()    { echo "  ✓  $*"; }
err()   { echo "  ✗  $*" >&2; exit 1; }
check() {
    if command -v "$1" &>/dev/null; then
        ok "$1 found: $(command -v "$1")"
    else
        err "$1 not found — please install $1"
    fi
}

echo ""
echo "=============================================="
echo " system-test-sandbox v${VERSION} — Release Build"
echo "=============================================="
echo ""

# --- step 1: check prerequisites ---
info "Checking prerequisites..."
check rustc
check cargo
ok "All prerequisites met"

# --- step 2: clean up old processes & registries ---
echo ""
info "Cleaning up old sandbox processes..."
pkill -f "system-test-sandbox" 2>/dev/null || true
pkill -f "sandbox-cli" 2>/dev/null || true
# Only kill our own sandbox binary, not VSCode or other apps that contain "sandbox" in their path
pkill -x "sandbox" 2>/dev/null || true
rm -f ~/.sandbox/instances/*.json 2>/dev/null || true
ok "Cleanup done"

# --- step 3: build CLI binary (release) ---
echo ""
info "Building CLI binary (release)..."
cargo build --release -p sandbox-cli
CLI_BIN="$SCRIPT_DIR/target/release/sandbox"
if [ ! -f "$CLI_BIN" ]; then
    err "CLI binary not found at $CLI_BIN"
fi
ok "CLI binary built: $(du -h "$CLI_BIN" | cut -f1)"

# --- step 4: assemble release folder ---
echo ""
info "Assembling release artifacts -> $RELEASE_DIR"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

cp "$CLI_BIN" "$RELEASE_DIR/sandbox"
chmod +x "$RELEASE_DIR/sandbox"
ok "sandbox CLI binary"

# --- step 5: generate README ---
echo ""
info "Generating README.md..."

BUILD_DATE="$(date '+%Y-%m-%d %H:%M')"

cat > "$RELEASE_DIR/README.md" << 'RELEASEREADME'
# System Test Sandbox — Release v0.1.0

macOS 桌面自动化沙箱 CLI。在 Terminal.app 窗口中启动任意命令，截取窗口截图，支持 PTY 交互。

## 文件说明

```
release/
├── sandbox        # CLI 工具（命令行）
└── README.md      # 本文件
```

## 一、前置条件

| 依赖 | 版本要求 |
|------|---------|
| macOS | 14.0+ (Sonoma) |
| 芯片 | Apple Silicon (M1–M4)，Intel 也支持 |

### 必须授予的权限

> **没有这两个权限，sandbox 无法工作。**

1. **辅助功能 (Accessibility)**：用于 CGEvent 输入模拟 + AXUIElement UI 读取
2. **屏幕录制 (Screen Recording)**：用于 ScreenCaptureKit 截图

授予方式：`系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制`，将 `sandbox` 添加进去并勾选。

## 二、CLI 使用方法

### Phase 1: 在沙箱中运行命令 + 截图

```bash
# 在 Terminal.app 中启动命令（如 Claude Code）
./sandbox start claude

# 截取沙箱窗口截图（自动发现 Terminal 窗口）
./sandbox screenshot -o screenshot.png

# 指定窗口 ID 截图
./sandbox screenshot --window-id 12345 -o screenshot.png

# 列出所有可见窗口
./sandbox windows

# 关闭沙箱（关闭 Terminal 窗口）
./sandbox shutdown
```

### 示例工作流

```bash
# 启动 Claude Code
./sandbox start claude
# 等待 Claude 启动...

# 截图查看状态
./sandbox screenshot -o before.png

# 关闭沙箱
./sandbox shutdown
```

## 三、常见问题

**Q: 截图全黑？**
A: 检查「屏幕录制」权限是否已授予。

**Q: 点击/输入无效？**
A: 检查「辅助功能」权限是否已授予。

**Q: 无法自动发现窗口？**
A: 使用 `./sandbox windows` 列出所有窗口，然后用 `--window-id` 指定。

---

**版本**: v0.1.0 | **构建时间**: __BUILD_DATE__
RELEASEREADME

# Inject build date
sed -i '' "s/__BUILD_DATE__/${BUILD_DATE}/" "$RELEASE_DIR/README.md"

ok "README.md generated"

# --- done ---
echo ""
echo "=============================================="
echo " Release v${VERSION} built successfully!"
echo " Artifacts -> $RELEASE_DIR"
echo "=============================================="
ls -lh "$RELEASE_DIR"
echo ""
