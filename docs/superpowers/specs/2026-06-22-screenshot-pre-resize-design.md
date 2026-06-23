# Screenshot Pre-Resize (Redraw-Settle) Design

**Date:** 2026-06-22
**Branch:** feat/screenshot-pre-resize
**Status:** Approved (revised 2026-06-23 — settle changed from global-quiet ≤500ms to bounded burst-wait ≤120ms; see Revision Notes)

---

## Revision Notes (2026-06-23)

The release test (scenario 14: layout after window resize) revealed two flaws in the original settle design, both corrected in this revision:

1. **The settle waited for *global* output quiet (≤500ms cap).** Under continuous output (spinner / streaming TUI), output never quiets → every screenshot hit the 500ms cap. And in steady state (size unchanged), the settle waited the full 500ms for output that never arrives. Both coupled with the daemon's renderer-screenshot timeout.
2. **The "always resize triggers a redraw" rationale was wrong for unchanged size.** `ioctl(TIOCSWINSZ)` only sends SIGWINCH when the size actually changes (the kernel compares old vs new). Same-size resize → no signal → no redraw. So "always resize" does NOT double as a canvas refresh on unchanged size.

The revised settle (below) is a **bounded burst-wait**: a no-output probe (skip the wait in steady state), an early-exit when the reflow burst quiets (short reflows don't pay the full cap), and a 120ms hard cap (continuous output can no longer cause long waits). Max added latency ≤120ms, which also **removes the dependency on the (never-merged) 10s daemon timeout** — see Risks.

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

### 渲染端入口（现状）`electron-app/src/renderer/components/Terminal.tsx`

视口路径（`scroll=0`）直接 `canvas.toDataURL()`，零 resize；scrollback 路径只有本地 `fit()`，无 `conn.resize()`。xterm 的 cols/rows 与 PTY 实际尺寸漂移、或 TUI 处于半重绘状态时，canvas 上就是错乱布局。真正会发 PTY resize 的 `doFit()` 只在 mount / window resize / container ref 触发，不在截图路径上。

---

## Design

### Approach: renderer-side fix in `captureToPng`

截图本质是渲染端行为，resize（xterm + PTY WS）也在渲染端，在最贴近截图点修最干净。新逻辑抽成纯的、依赖注入的 `electron-app/src/renderer/screenshotSync.ts`（仿 `terminalBuffer.ts` 先例，无需 React/xterm/fake-timer 即可单测）。

### Mechanism: fit → conn.resize → 有界等重绘爆发（probe + 安静早退 + 120ms 上限）

**核心约束**：「resize 后的正确新布局」只存在于重绘输出被渲染端 `term.write()` 消费完之后。所以等待不可省——但**只需等那一次性重排爆发落地**，不等「全局输出停下」。

**关于 SIGWINCH（纠正）**：`ioctl(TIOCSWINSZ)` 只在尺寸**真正变化**时才向前台进程组发 SIGWINCH；同尺寸 resize 不发信号、不触发重绘。因此：
- `conn.resize(cols, rows)` **照发**——目的是修 PTY 漂移（把 PTY 强制对齐 xterm 当前尺寸），不是为了在稳态触发重绘。
- 「有没有重排要等」由 settle 的**无输出探测**判定：探测窗口内没有任何新 PTY 输出 → 说明没有 SIGWINCH/重排（稳态）→ 立即截，不等。

#### 关键逻辑（`electron-app/src/renderer/screenshotSync.ts`）

```ts
export const DEFAULT_QUIESCENCE_MS = 30;     // 重排爆发安静的判据（早退用）
export const PROBE_MS = 50;                   // 无输出探测窗口：稳态直接截
export const DEFAULT_RESIZE_TIMEOUT_MS = 120; // 有界爆发上限（原 500 → 120）

// 等待 resize 引发的重排爆发落地。三段判据，全部有界：
export async function waitForRedrawSettle(
  clock: SettleClock, baseline: number,
  quietMs = DEFAULT_QUIESCENCE_MS,
  timeoutMs = DEFAULT_RESIZE_TIMEOUT_MS,
  probeMs = PROBE_MS, tickMs = 10,
): Promise<"settled" | "timeout"> {
  const start = clock.now();
  for (;;) {
    await clock.sleep(tickMs);
    const now = clock.now();
    const lastOutputAt = clock.getLastOutputAt();
    const sawOutput = lastOutputAt > baseline;
    // ① 稳态：探测窗口内一直无新输出 → 没有重排 → 立刻返回（不干等）
    if (!sawOutput && now - start >= probeMs) return "settled";
    // ② 爆发已落地：看到输出且安静了 quietMs → 早退（短重排不必等满）
    if (sawOutput && now - lastOutputAt >= quietMs) return "settled";
    // ③ 有界上限：持续输出永不安静 → timeoutMs 到点返回（不再退化）
    if (now - start >= timeoutMs) return "timeout";
  }
}
```

`captureWithResizeSettle(deps, scrollOffset)`：`fit → baseline=now → resize → waitForRedrawSettle → awaitFrame(2×rAF) → capture`，保证 `resize()` 在任何 canvas/buffer 读取之前。`Terminal.tsx` 的 `captureToPng` 委托给它；`onOutput` 追加 `lastOutputAtRef.current = performance.now()` 喂给 settle 时钟。

### 为什么「总是发 resize」而非「尺寸变了才发」

为了修 PTY 漂移：PTY 与 xterm 尺寸不一致时，xterm 的 cols 跟着 DOM、不会变，若只在 cols 变化时才 resize 会漏掉漂移。**总是发 `conn.resize(cols, rows)`** 把 PTY 强制对齐 xterm 当前尺寸。注意：同尺寸时内核不发 SIGWINCH、不会重绘——「有没有重排要等」交给 settle 的无输出探测判定，而不是依赖 resize 去触发重绘。

### 行为对照（有界爆发等待，全部 ≤120ms）

| 场景 | 命中分支 | 表现 |
|------|---------|------|
| 稳态（尺寸没变、无重排） | ① 探测无输出 | **~50ms 后立即截** |
| 短重排（重画完即安静） | ② 爆发落地 + 安静 | **~60–90ms 早退** |
| 持续输出（spinner / 流式） | ③ 永不安静 → 120ms 上限 | **~120ms（不再退化到 500ms）** |

---

## Scope

- **In scope**：默认渲染端截图（viewport + scrollback，CLI sandbox 如 claude）。
- **Out of scope（follow-up）**：`--with-frame`（ScreenCaptureKit 直捕窗口）绕过渲染端，要 resize 需跨进程编排；本次不扩面。

---

## Testing Strategy

### UT（vitest，`screenshotSync.test.ts`）— 回归看护

依赖注入 fake clock，断言真实时序行为：

- **稳态（probe）**：resize 后不回放任何输出，推进 ~50ms，断言立即完成截图（`settled`，不等到 120ms）。
- **短重排早退**：resize 后触发一次 onOutput，推进 >30ms 安静，断言 ~60–90ms 内完成。
- **持续输出有界**：resize 后持续回放输出（永不安静），推进到 120ms，断言到点完成（不再等 500ms）。
- **顺序守卫**：断言 `conn.resize` 在 canvas/buffer 读取之前被调用——这是当初被回退机制的回归守卫。
- 其余 `captureWithResizeSettle` 测试（viewport canvas / scrollback / null-canvas fallback / order-guard）保持。

### E2E / release_test

`tests/release_test.md` item 14：启动全屏 TUI → 基线截图 → 改窗口尺寸 → 截图 → 校验布局按新尺寸重排（无重叠/乱码/半帧）→ 再次改尺寸立即截图 → 校验。截图存档到 `release_test/<时间戳>/`。

---

## Risks

- **延迟**：单次截图最多 +120ms（稳态 ~50ms、短重排 ~60–90ms、持续输出 ~120ms）。
- **不再依赖 10s daemon 超时**：max +120ms 叠在基础截图耗时（大 canvas `toDataURL` + base64 + WS 往返）上仍远低于 daemon 现有 2s 超时，因此本修复**不需要** `fb1894f`（把超时 2s→10s）也能稳定工作。`fb1894f` 经核实**从未合入 main**（仅存在于 `feat/start-shell-screenshot-openclaw`），可独立合入做余量，但非本修复的前提。
- **BURST 上限是启发式**：120ms 是「重排爆发落地」的经验估值；极复杂 TUI 的单次重排理论可能更久 → 截到部分帧。但比原 500ms 全局安静严格更好（后者持续输出下永远顶满，且稳态白等 500ms）。`PROBE_MS` / `DEFAULT_QUIESCENCE_MS` / `DEFAULT_RESIZE_TIMEOUT_MS` 均命名可调。
- **awaitFrame**：2×rAF 保证 canvas 提交最新 buffer；scrollback 路径走 `renderBufferToPng` 不依赖 canvas，harmless。

---

## Out of Scope

- `--with-frame` 路径的截图前 resize（记为 follow-up）。
- 合并 `fb1894f`（daemon 超时 2s→10s）：独立改进，非本修复前提（有界 settle 已与之解耦）。
