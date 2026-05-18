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

**版本**: v0.1.0 | **构建时间**: 2026-05-18 23:07
