# Phase 8 — Release Test Bug 修复

**日期**：2026-05-17  
**分支**：`feat/5-multi-instance`  
**状态**：进行中  

## 背景

Phase 5-8 实现后进行了 release test，生成了测试报告 `release_test/2026-05-17-19-09-00/REPORT.md`。报告显示 29 项测试通过，但发现 6 个核心 bug 导致截图和沙箱操作不符合预期。经代码分析定位到以下根因。

## Bug 清单

### B1: `capture_region` 忽略 x/y 参数，截取全屏

- **文件**: `crates/sandbox-core/src/capture/mod.rs:48`
- **根因**: `capture_region(_x: i32, _y: i32, ...)` — 参数前缀下划线表示未使用。函数取第一个显示器全屏截图，width/height 只缩放输出而非裁剪。
- **影响**: 区域截图实际是全屏截图，`screenshot_region.png` 包含整个桌面。

### B2: HTTP 服务器 `AppState.window_id` 永远为 `None`

- **文件**: `src-tauri/src/main.rs:157`, `crates/sandbox-core/src/server/mod.rs:331-342`
- **根因**: 
  1. `AppState.window_id` 初始化为 `None`，从未被设置
  2. `init_sandbox` Tauri 命令已注册但前端从未调用
  3. `Sandbox.window_id` 和 HTTP `AppState.window_id` 是两个独立状态，互不同步
- **影响**: 所有 `/screenshot` HTTP 请求返回 400 错误；通过 `sandbox-cli screenshot --id <id>` 截图永远失败。

### B3: 前端所有操作 handler 为空桩

- **文件**: `sandbox-web/src/main.tsx:25-69`
- **根因**: `handleScreenshot`、`handleSpawnApp`、`handleSpawnCli`、`handleClick`、`handleTypeText`、`handlePressKey` 全部为空函数体或只做前端状态更新（如 `Date.now()` 假 PID），没有调用任何 Tauri 命令或 HTTP API。
- **影响**: ControlPanel 上的任何按钮点击都不会触发后端操作。

### B4: `spawn_app` 使用 `open` 命令，应用在沙箱外独立运行

- **文件**: `crates/sandbox-core/src/process/mod.rs:47-78`
- **根因**: `spawn_app` 调用 `std::process::Command::new("open").arg(app_path)`，启动的应用是独立 macOS 窗口，不会嵌入 Tauri webview。
- **影响**: cc-switch 等应用在沙箱外运行，截图只能截到空沙箱。

> **设计决策**：真正做到 macOS 应用嵌入 Tauri webview 在技术上不可行（需要 NSView reparenting，Tauri/Wry 不支持）。修复策略是接受应用作为独立窗口运行，但通过 ScreenCaptureKit 追踪并截取其窗口。

### B5: xterm.js 终端与 Rust PTY 完全断开

- **文件**: `sandbox-web/src/main.tsx:25-27`, `sandbox-web/src/components/Terminal.tsx`
- **根因**: 
  1. `handleTerminalInput` 为空 — 按键不转发给 PTY
  2. 前端没有轮询 `/pty/output/:pid` — 终端不显示 PTY 输出
  3. 后端 PTY 读写基础设施已完备（`process/mod.rs`），但前端未连接
- **影响**: CLI 进程（如 claude code）在 PTY 中运行但前端终端看不到任何输出。

### B6: Region 截图坐标语义不明确

- **文件**: `crates/sandbox-core/src/capture/mod.rs:48`, `crates/sandbox-core/src/server/mod.rs:345-350`
- **根因**: Region 截图是全局屏幕坐标，但用户期望可能是相对于沙箱窗口的坐标。缺少窗口相对坐标的截图接口。
- **影响**: 无法精确截取沙箱窗口内的特定区域。

## 修复任务

| 任务 ID | 描述 | 优先级 |
|---------|------|--------|
| P8-06 | 修复 `capture_region`：使用 image crate 裁剪 RGBA 数据 | P0 |
| P8-07 | Tauri setup 中自动发现并设置 window_id | P0 |
| P8-08 | 创建前端 API 客户端层 `api.ts` | P0 |
| P8-09 | 连接 main.tsx stub handler 到真实 API | P0 |
| P8-10 | 连接 xterm.js 终端到 Rust PTY | P1 |
| P8-11 | `spawn_app` 增强：追踪启动的应用窗口 ID | P1 |
