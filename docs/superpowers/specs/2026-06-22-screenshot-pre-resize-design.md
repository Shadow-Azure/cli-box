# Screenshot Pre-Resize (Redraw-Settle) Design

**Date:** 2026-06-22
**Branch:** feat/screenshot-pre-resize
**Status:** Approved

---

## Problem Statement

claude 等 heavy TUI 应用的截图（默认渲染端路径，无 `--with-frame`）经常出现布局混乱——文字换行错位、TUI 元素位置不对、或画面是半重绘的旧帧。用户此前曾通过「每次截图前触发一次 resize」修复过同一问题，但该机制在后续截图子系统重写中丢失，导致回归。

---

## Root Cause Analysis

### 默认截图链路

```
cli-box screenshot → daemon screenshot_handler
  → request_renderer_screenshot → WS capture_request
  → Electron renderer captureToPng(scroll) → 返回 PNG
```

### 渲染端入口（现状）`electron-app/src/renderer/components/Terminal.tsx:34-51`

```tsx
async captureToPng(scrollOffset: number = 0): Promise<string> {
  const term = xtermRef.current;
  if (!term) throw new Error("Terminal not initialized");
  if (scrollOffset === 0) {
    // 视口路径：直接读 canvas，没有任何 resize / relayout
    const canvasEl = term.element?.querySelector("canvas");
    if (canvasEl) {
      const dataUrl = canvasEl.toDataURL("image/png");
      return dataUrl.split(",")[1];
    }
  }
  // scrollback 路径：只有本地 fit()，没有 conn.resize()，TUI 收不到 SIGWINCH
  const fitAddon = fitAddonRef.current;
  if (fitAddon) fitAddon.fit();
  return renderBufferToPng(term, term.cols, term.rows, scrollOffset);
}
```

### 三个缺口

1. **视口截图（`scroll=0`，claude 全屏 TUI 常见场景）**：直接 `canvas.toDataURL()`，零 resize。xterm 的 cols/rows 与 PTY 实际尺寸漂移、或 TUI 处于半重绘状态时，canvas 上就是错乱布局。
2. **scrollback 截图**：只 `fitAddon.fit()`（仅本地重算），无 `conn.resize()` → TUI 不 reflow。
3. 真正会发 PTY resize 的 `doFit()`（`Terminal.tsx:115-118`）只在 mount / window resize / container ref 触发，不在截图路径上。

### 为何复发

截图子系统被多次重写（2026-06-05 frame、2026-06-06 size-fix、2026-06-17 start-shell-screenshot）。2026-06-18 reliability fix（commit `17517c2`）只处理超时 / 窗口识别 / 重连，未覆盖截图前 resize。「视口路径直接读 canvas」的写法在这些迭代中引入，丢掉了 resize 逻辑。

---

## Design

### Approach: renderer-side fix in `captureToPng`

| 方案 | 做法 | 取舍 |
|------|------|------|
| **1（采纳）渲染端 `captureToPng` 内修复** | 截图入口统一 fit + resize + settle | 改动最小、落在真实截图点、viewport + scrollback 双路一次性覆盖 |
| 2 daemon 截图前发 resize_request | 跨进程通知渲染端 resize 再 capture | 逻辑跨进程散开、要把 resize 编排进 WS 协议、复杂度高 |
| 3 后台周期 resync | 心搏定时 fit + resize | 不保证截图那一瞬间 canvas 是 fresh 的，治标不治本 |

截图本质是渲染端行为，resize（xterm + PTY WS）也在渲染端，在最贴近截图点修最干净。

### Mechanism: fit → conn.resize → 等 redraw settle（事件驱动 + 超时兜底）

**核心洞察**：无法直接观测 TUI 内部状态，但 TUI 收到 SIGWINCH 后重绘必然产生 PTY 输出回流渲染端。因此「重绘完成」≈「resize 之后那波输出安静下来」。

#### 实现（`electron-app/src/renderer/components/Terminal.tsx`）

**Step 1 — 在现有 `conn.onOutput` 回调（Terminal.tsx:145）追加时间戳：**

```tsx
conn.onOutput((data) => {
  const term = xtermRef.current;
  if (!term) return;
  lastOutputAtRef.current = performance.now();   // ← 新增
  const writeData = typeof data === "string" ? data : decoder.decode(data as Uint8Array);
  term.write(writeData);
});
```

**Step 2 — 新增常量与 helper：**

```tsx
const SYNC_RESIZE_TIMEOUT_MS = 500;    // 超时兜底：到点直接截
const OUTPUT_QUIESCENCE_MS = 30;       // 输出停顿 ≥30ms 视为这波重绘完成

// fit 到当前 DOM 尺寸 + 同步给 PTY（触发 SIGWINCH）+ 等重绘稳定
const syncResizeAndSettle = async () => {
  const term = xtermRef.current;
  const fitAddon = fitAddonRef.current;
  const conn = connRef.current;
  if (!term || !fitAddon || !conn) return;
  fitAddon.fit();
  const baseline = performance.now();          // 记录发 resize 的时刻
  conn.resize(term.cols, term.rows);           // → SIGWINCH → TUI 重绘 → 输出回流
  await waitForRedrawSettle(baseline, OUTPUT_QUIESCENCE_MS, SYNC_RESIZE_TIMEOUT_MS);
  await nextFrame();                           // 让 xterm 把最新 buffer 提交到 canvas（2×rAF）
};

// 阻塞：等到「resize 后有新输出 且 安静 30ms」，或 500ms 超时
async function waitForRedrawSettle(baseline: number, quietMs: number, timeoutMs: number) {
  const start = performance.now();
  while (true) {
    await tick(10);                            // rAF 或 10ms 步进
    const now = performance.now();
    const sawNewOutput = lastOutputAtRef.current > baseline;  // resize 后有新输出
    const quiet = now - lastOutputAtRef.current >= quietMs;   // 这波输出停了
    if ((sawNewOutput && quiet) || now - start >= timeoutMs) break;
  }
}
```

**Step 3 — `captureToPng` 入口统一调用（覆盖 viewport + scrollback）：**

```tsx
async captureToPng(scrollOffset: number = 0): Promise<string> {
  const term = xtermRef.current;
  if (!term) throw new Error("Terminal not initialized");
  await syncResizeAndSettle();                 // ← 新增：截图前 resize + 等稳定
  if (scrollOffset === 0) {
    const canvasEl = term.element?.querySelector("canvas");
    if (canvasEl) {
      const dataUrl = canvasEl.toDataURL("image/png");
      return dataUrl.split(",")[1];
    }
  }
  return renderBufferToPng(term, term.cols, term.rows, scrollOffset);
}
```

**Step 4 — `doFit`（Terminal.tsx:115-118）复用相同 fit+resize**（去掉 settle），消除重复，保持单一来源。

### 为什么「总是发 resize」而非「尺寸变了才发」

PTY 尺寸漂移时，xterm 的 cols 不变（DOM 没变），若只在 cols 变化时才 resize 会漏掉漂移场景。**总是发 `conn.resize(cols, rows)`**：daemon 侧 `resize_pty` 幂等，且同尺寸 SIGWINCH 也会触发全屏 TUI 重绘——顺带解决「canvas 是旧帧」的 stale 问题，等于免费做一次强制刷新。

### 行为对照（事件驱动 + 超时兜底）

| 场景 | 表现 |
|------|------|
| heavy TUI 收到 SIGWINCH 重绘 | 输出回流 → 安静 30ms → **快路径，几十 ms 就截** |
| 同尺寸 SIGWINCH / TUI 无反应 | 无新输出 → **500ms 超时兜底，直接截** |
| TUI 持续输出（spinner） | 永不安静 → **500ms 超时兜底截** |

---

## Scope

- **In scope**：默认渲染端截图（viewport + scrollback，CLI sandbox 如 claude）。
- **Out of scope（follow-up）**：`--with-frame`（ScreenCaptureKit 直捕窗口）绕过渲染端，要 resize 需跨进程编排，复杂度高；claude 问题在默认路径，本次不扩面。

---

## Testing Strategy

### UT（vitest）— 回归看护（最重要）

mock xterm + conn（参考 `electron-app/src/__tests__/connectPty.test.ts`）：

- **快路径**：`captureToPng(0)` 后用 fake timer 推进，resize 后触发一次 onOutput 再推进 30ms，断言 `toDataURL` 在 settle 之后才被调用。
- **超时兜底**：mock conn 不回放任何输出，推进 500ms，断言仍完成截图（兜底生效）。
- **顺序守卫**：断言 `conn.resize` 在 canvas/buffer 读取之前被调用——这正是当初被回退掉机制的回归守卫。

### E2E / release_test

按 `tests/release_test.md` 流程：启动 sandbox → 跑全屏 TUI → 改窗口尺寸 → 截图 → 人工核对布局正确，截图存档到 `release_test/YYYY-MM-DD-HH-MM-SS/`。

---

## Risks

- **延迟**：单次截图最多 +500ms（仅当 TUI 无输出回流时；正常快路径几十 ms）。daemon renderer 超时已为 10s（commit `fb1894f`），预算充足。
- **quiescence 偏紧**：极重绘机器上 30ms 可能偏短，导致快路径提前触发；两个常量已命名（`SYNC_RESIZE_TIMEOUT_MS` / `OUTPUT_QUIESCENCE_MS`），后续可调。
- **nextFrame**：用 2×rAF 保证 canvas 提交最新 buffer；scrollback 路径走 `renderBufferToPng` 不依赖 canvas，harmless。

---

## Out of Scope

- `--with-frame` 路径的截图前 resize（记为 follow-up）。
- 调整 daemon renderer 超时（已 10s，无需动）。
