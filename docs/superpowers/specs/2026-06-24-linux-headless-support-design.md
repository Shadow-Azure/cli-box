# Linux 无头 CLI 支持 — 设计文档

> **日期**：2026-06-24
> **分支**：`feat/linux-headless-support`
> **状态**：设计已确认，待实现计划
> **方案**：方案 A — Rust 原生终端渲染器（真·无头）

---

## 一、背景与问题

cli-box 当前是 **macOS 专属**的桌面自动化沙箱。需求是让其能以**无头 CLI 形态运行在云端 Linux 服务器**上，保留两项核心能力：

1. **键盘输入** — 向 CLI（如 Claude Code）发送按键
2. **截图（不带 `--with-frame`）** — 对终端输出取图，用于自动化反馈

### 现状分析结论

**1. 现状不会发布 Linux 版本。** `release.yml` 仅 `runs-on: macos-latest`，只产 darwin-arm64 产物与 npm 包；`release.sh` 注释明确要求 macOS；`electron-builder.config.cjs` 仅 `mac.target: ["dmg"]`。

**2. 发布 Linux 必须改代码，不能直接复用。** 代码深度耦合 macOS API（ScreenCaptureKit / CGEvent / AXUIElement），非 macOS 分支全是返回错误的桩函数（这些桩本身能编译）。真正的 Linux 编译阻断在于：`PtySession` 结构体被 `cfg(target_os = "macos")` 门控，但 `SESSIONS` 静态、`list_processes()`、`is_session_alive()` 等**未门控**代码引用了它——因 CI 从不在 Linux 上编译（Clippy/test 跑在 macos-latest），这些未门控引用一直未被捕获。

**3. 改动量整体为「中等」**：键盘输入与 PTY 生命周期已基于跨平台的 `portable-pty`，仅需解开 cfg 守卫（≈60%）；截图需新增 Rust 渲染模块（≈30%）；流水线改造（≈10%）。

---

## 二、目标与非目标

### 目标

- 在 **Linux（x86_64）** 上以无头 daemon 形态运行：CLI 沙箱（PTY）+ 键盘输入 + 终端截图 + scrollback。
- macOS 现有行为 **100% 不变**（GUI + 渲染层截图路径完全保留）。
- headless 模式作为一等概念，与 macOS GUI 路径并存、自动切换。
- 打通 Linux 发布流水线（CI 门禁 + release 产物 + npm 包）。

### 非目标（明确不做）

| 项 | 原因 |
|----|------|
| `--with-frame` / ScreenCaptureKit on Linux | macOS 专属 API，返回现有 "only available on macOS" 错误 |
| app 模式（`spawn_app` 控制 GUI 应用）on Linux | 云无头场景无 GUI 应用可启动 |
| 鼠标 click/scroll 输入 on Linux | 依赖 CGEvent；**仅键盘（PTY）可用** |
| Electron GUI on Linux | 无头，不打包 |
| **`ui-inspect`（AXUIElement）on Linux** | AXUIElement 是 GUI 应用专有的无障碍元素树读取。云无头场景**没有 GUI 应用可读**，语义上不适用。Linux 对等物为 AT-SPI2（`atspi` crate + DBus + X11/Wayland 桌面），实现成本等同或超过截图渲染器，但对此目标**零价值**。返回 "only available on macOS" 错误 |

---

## 三、架构总览

```
                        screenshot (no --with-frame)
                               │
                   ┌───────────┴────────────┐
            renderer 已连接?            renderer 未连接 (headless)
            (macOS GUI，不变)              (Linux / 无 Electron)
                   │                            │
         Electron xterm.js            Rust HeadlessTerminal
         canvas 渲染 (现有)           vt100 解析 + ab_glyph 栅格化 (新增)
```

- macOS：renderer 连上 → 走渲染层（不变）。
- Linux（或任何无 Electron 环境）：renderer 永不连接 → 自动走 headless 渲染器。
- 切换依据：`DaemonState` 中已有的 `screenshot_ws_tx`（renderer 是否连上）。

---

## 四、组件设计

### 组件 1：PTY 跨平台化（`crates/cli-box-core/src/process/mod.rs`）

**成本：小。** 释放现有跨平台代码。

- 把真实 PTY 实现（`portable-pty` + `nix`，二者均跨平台）的 cfg 守卫从 `target_os = "macos"` 改为 `unix`（覆盖 macOS + Linux）。
- 合并/删除当前返回错误的非 macOS 桩函数；修复**未门控**的 `SESSIONS` 静态与 `list_processes()`/`is_session_alive()` 对 macOS 专属 `PtySession` 的引用（将其与真实 PTY 实现一并移到 `cfg(unix)`）。
- `SESSIONS` 静态、`PtyStore`、PTY reader 线程均跨平台，无需改动。
- 风险低：`portable-pty` 在 Linux 原生支持 Unix PTY，`nix` 的 signal/process 在 Linux 可用。

### 组件 2：无头终端渲染器（**新增** `crates/cli-box-core/src/capture/headless.rs`）

**成本：中。** 唯一真正的新代码，边界清晰、可独立 TDD。

**职责**：输入 PTY 字节流 → 维护终端网格 → 输出 PNG。

- 新增依赖：`vt100` crate（增量维护终端网格：行列、ANSI/256 色、光标、scrollback）+ `ab_glyph`（字体栅格化）；复用已有 `image`。
- 类型：`HeadlessTerminal { cols, rows, parser: vt100::Parser, ... }`。
  - `feed(&mut self, bytes: &[u8])` — 增量喂入 PTY 字节，更新网格。
  - `render_png(&self, scroll_offset: usize) -> Result<Vec<u8>>` — 按当前网格（+ 可选滚动偏移）渲染 PNG。
- 渲染逻辑：由 `ab_glyph` 计算等宽字体的 `CHAR_WIDTH/CHAR_HEIGHT`；逐格绘制背景填充 + 前景字形；`image` 编码 PNG。颜色支持 16/256 色调色板 + 默认前后景色。
- 字体：**运行时路径加载**（非嵌入）——`HeadlessTerminal` 按 `CLIBOX_FONT` 环境变量 → `~/.cli-box/font.ttf` → 系统 CJK 字体路径解析。部署时放 Sarasa/Noto 字体或 `apt install fonts-noto-cjk`。理由：原计划 `include_bytes!` 嵌入 CJK 字体（~5–20MB）会膨胀 git/二进制；运行时加载既保证中文正确渲染（反馈环不失效），又避免二进制臃肿、字体可热替换。
- **挂载点**：每个 sandbox 持有一个常驻 `HeadlessTerminal`，存于 PTY session 旁。daemon 现有 reader 线程在写 `PtyStore` 的同时调用 `feed()`（增量解析，保持实时网格）。

**保真度**：近似 xterm.js。CJK/拉丁文本、ANSI 16/256 色、光标、换行均正确渲染（CJK 由嵌入 CJK 字体支持）。**残留降级**：Emoji 仍可能为豆腐块（CJK 等宽字体通常不含彩色 Emoji）、Truecolor（24 位 RGB）可能量化到 256 色、字体连字/字体回退不支持。

### 组件 3：截图 & scrollback 路由（`crates/cli-box-core/src/daemon/mod.rs`）

**成本：小。**

- **截图**：`screenshot_handler` 的 `!with_frame` 分支，判断 `renderer_connected`：
  - 已连接 → 现有 `request_renderer_screenshot`（macOS GUI，不变）。
  - 未连接 → 新增 `screenshot_headless(state, id, scroll, top)`：从对应 sandbox 的 `HeadlessTerminal` 取网格 → `render_png()` → 返回 `source: "headless"`。
- **scrollback**：`scrollback_handler` 同理获得 headless 路径：
  - `raw=true` → 直接读 `pty_store` 原始字节（跨平台，零额外代码）。
  - clean → 读 `HeadlessTerminal` 网格文本。
  - 新增 `scrollback_headless()` helper，镜像 `screenshot_headless()`。
- `--with-frame` 在 Linux 维持返回 "only available on macOS" 错误。

### 组件 4：daemon / CLI headless 短路

**成本：极小。** 大部分基础设施已存在。

- daemon：`create_sandbox_handler` 中 `find_electron_window()` 已 best-effort 返回 `None` 不阻塞，**无需改动**；renderer WS 不连接即触发 headless 路径。
- CLI：`ensure_healthy_electron`（`main.rs`）已能在找不到 Electron 时进入 "headless daemon mode"，但当前会空等 renderer 60s。改为：**非 macOS 或找不到 Electron 二进制时立即短路**，不等待 renderer。

### 组件 5：发布流水线

**成本：中。**

- **`ci.yml` 新增 Linux 编译/测试门禁**（`rust-clippy-linux` + `rust-test-linux` on `ubuntu-latest`）——关键：正是它缺失才导致前述 cfg 编译 bug 未被发现。`test.sh` 现有的 `uname=Linux && CI` 跳过逻辑需相应调整，让 headless 子集在 Linux 上运行。
- **`release.yml` 新增 `build-linux` job**（`ubuntu-latest`）：仅构建裸 `cli-box` + `cli-box-daemon`（不打 Electron），上传到同一个 GitHub Release。
- **npm**：新增 `packages/cli-box-linux-x64/`；skill 包的 `optionalDependencies` 增加 linux 条目。
- `release.sh` 保持 macOS-only；Linux 发布走 CI。
- Cargo.toml 的 macOS 专属依赖（`core-graphics`/`core-foundation`/`objc`/`screencapturekit`）已正确 `cfg` 门控，Linux 自动不引入。`vt100`/`ab_glyph` 作为 core 的无条件跨平台依赖。

---

## 五、测试策略

| 层级 | 内容 |
|------|------|
| **UT** | `headless.rs`：喂已知 ANSI 序列（纯文本/颜色/光标移动/换行/滚动），断言 PNG 尺寸 + 抽检像素颜色；golden-file 回归（`cargo test`）。PTY 跨平台实现现能在 Linux CI 跑。 |
| **IT** | daemon 在无 renderer（headless）下，`/box/{id}/screenshot` 与 `/box/{id}/scrollback` 返回合法非空结果（`tower::ServiceExt::oneshot`）。 |
| **E2E（CI 必过门禁）** | `e2e-linux-headless` job（ubuntu runner）：`cli-box start bash "命令"` → `cli-box type` → `cli-box screenshot`（默认 + `--top`）→ `cli-box scrollback`，断言 PNG 非空、尺寸正确。**复用 `tests/e2e-compound-start-screenshot.sh` 流程**。 |
| **CI** | 新增 linux clippy + test 门禁；headless E2E 作为必过门禁。 |

E2E 是唯一能端到端验证无头渲染器的环节，**不可只靠单测替代**。

---

## 六、风险与取舍

1. **截图保真度**：服务端 vt100 渲染无法 100% 复刻 xterm.js（残留降级见组件 2：Truecolor 量化、Emoji 豆腐块、字体连字/回退）。CJK/拉丁由嵌入字体正确支持，对 CLI 文本输出场景足够。
2. **运行时字体依赖**：字体不再嵌入，运行时需环境提供（`CLIBOX_FONT` / `~/.cli-box/font.ttf` / 系统字体包）。部署文档须明确安装步骤；未提供字体时 `render_png` 返回清晰错误，不影响 feed/scrollback。
3. **scroll offset 语义**：需对齐现有 `--scroll`/`--top` 查询参数与 vt100 scrollback 的映射。
4. **CI 差异**：ubuntu runner 无 `zsh`，E2E sandbox 命令统一用 `bash`。

---

## 七、改动文件清单（预估）

| 文件 | 改动 |
|------|------|
| `crates/cli-box-core/src/process/mod.rs` | cfg 守卫 `macos`→`unix`；解除 `PtySession`/`SESSIONS`/`list_processes` 未门控引用；合并桩函数 |
| `crates/cli-box-core/src/capture/headless.rs` | **新增**：`HeadlessTerminal` + 渲染 |
| `crates/cli-box-core/src/capture/mod.rs` | 导出 headless 模块 |
| `crates/cli-box-core/src/daemon/mod.rs` | screenshot/scrollback headless 路由；reader 线程 feed |
| `crates/cli-box-core/Cargo.toml` | 加 `vt100`、`ab_glyph` |
| `crates/cli-box-cli/src/main.rs` | `ensure_healthy_electron` headless 短路 |
| `packages/cli-box-linux-x64/` | **新增** npm 包 |
| `packages/cli-box-skill/package.json` | optionalDependencies 加 linux |
| `.github/workflows/ci.yml` | linux clippy/test + headless E2E 门禁 |
| `.github/workflows/release.yml` | build-linux job |
| `tests/e2e-compound-start-screenshot.sh` | 适配 Linux 运行（bash） |
| `crates/cli-box-core/src/capture/headless.rs` 中 `load_font()` | 运行时字体路径解析（无二进制资产） |

---

**版本**：v1.0 | **创建**：2026-06-24 | **方案**：方案 A（Rust 原生终端渲染器）
