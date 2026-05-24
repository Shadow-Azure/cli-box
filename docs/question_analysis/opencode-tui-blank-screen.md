# opencode TUI 空白屏幕问题分析

> 分析日期：2026-05-24
> 状态：根因已定位，方案待实施

## 一、问题描述

在沙箱中启动 opencode（一个 TUI 终端应用）后，终端一直显示空白。PTY 写入成功（`{"written":true}`），但 PTY 读取持续报错：`"Process 1000 not found or reader busy"`。截图显示空终端。

## 二、复现步骤

```bash
# 1. 构建 release
./release.sh

# 2. 启动沙箱（运行 opencode）
./target/release/bundle/macos/System\ Test\ Sandbox.app/Contents/MacOS/system-test-sandbox --mode=cli --cmd=opencode

# 3. 通过 HTTP 写入输入
curl -X POST http://127.0.0.1:<port>/pty/write/1000 -d '{"data":"你是谁？"}'

# 4. 截图 — 终端空白
curl http://127.0.0.1:<port>/screenshot -o screenshot.png
```

## 三、关键现象

| 现象 | 证据 |
|------|------|
| opencode 进程正常启动 | PID 1000，status: running |
| PTY 写入成功 | `{"written":true}` |
| PTY 读取持续失败 | `"Process 1000 not found or reader busy"` |
| 截图全部空白 | 61079 bytes，内容一致 |
| zsh/claude 正常工作 | 同一沙箱基础设施，渲染正常 |
| `less` 渲染正常 | 证明 alternate screen buffer 不是问题 |

## 四、根因分析

### 4.1 直接原因：阻塞式 `read()` 无限期占用 reader

`read_output`（`crates/sandbox-core/src/process/mod.rs:320-369`）的 take-read-put-back 模式：

```rust
// Step 1 — 取出 reader（短暂持有锁）
let mut reader = {
    let mut sessions = SESSIONS.lock()...;
    sessions.get_mut(&pid).and_then(|s| s.reader.take())
        .ok_or_else(|| AppError::Process("reader busy"))?
};

// Step 2 — 读取（不持有全局锁，但可能阻塞）
let mut buf = [0u8; 4096];
let result = match reader.read(&mut buf) { ... };

// Step 3 — 放回 reader（短暂持有锁）
{ sessions.get_mut(&pid).session.reader = Some(reader); }
```

**关键问题**：reader 从未被设置为非阻塞模式。`portable_pty 0.9` 不暴露 `set_nonblocking` API。当 PTY 无数据时，`read()` 阻塞调用线程**无限期**。reader 一直被占用不放。

`WouldBlock` 处理器（第 348 行）是死代码 — reader 永远不会返回 `WouldBlock`。

### 4.2 加剧因素：前端错误处理是致命的

```typescript
// sandbox-web/src/components/Terminal.tsx:142-146
} catch {
    if (pollRef.current) {
        clearInterval(pollRef.current);  // 一次性错误，永久停止轮询
        pollRef.current = null;
    }
}
```

一次 `"reader busy"` 错误就杀死整个轮询循环。没有重试机制。

### 4.3 事件时序

```
t=0ms    opencode 启动，渲染 TUI（大量 ANSI 输出，几百行）
t=50ms   轮询 #1：read() 取出 reader，读到数据，放回 ✓
t=100ms  轮询 #2：read() 取出 reader，没有新数据 → 阻塞！
         reader 一直被占用
t=150ms  轮询 #3：s.reader.take() = None → "reader busy"
         前端 catch → 杀掉 setInterval → 终端永久沉默
```

### 4.4 为什么 zsh/claude 不受影响

zsh 和 claude 在启动后会持续产生输出（prompt、流式响应），`read()` 很快就能读到数据并返回。opencode 渲染完 TUI 后就阻塞等待用户输入 — 这是 TUI 应用的标准行为，和阻塞式轮询读取冲突。

## 五、架构对比：我们的方案 vs WaveTerm

| 维度 | system-test-sandbox | WaveTerm |
|------|---------------------|----------|
| PTY 读取方式 | HTTP 轮询（50ms 间隔） | 专用 goroutine 持续读取 |
| 数据流 | 前端 poll → HTTP → `spawn_blocking` → `read()` | goroutine `read()` → buffer → WPS 事件推送 |
| 阻塞处理 | `read()` 阻塞时 reader 被占用 | goroutine 阻塞只是挂起，不影响其他 goroutine |
| 缓冲 | 无（每次 poll 读一次） | 2MB 循环 blockfile |
| 前端接收 | 主动 poll（可能失败） | 被动接收 WPS 推送事件 |
| 容错 | 单次错误终止轮询 | 无轮询概念，不会因错误停止 |

### WaveTerm 为什么不会有这个问题

1. **专用 reader goroutine**：Go 的 goroutine 阻塞只是挂起当前 goroutine，不阻塞线程。`read()` 无限期阻塞也没关系。
2. **无 HTTP 轮询**：没有"reader busy"的概念 — reader 始终被专用 goroutine 持有，不存在竞争。
3. **缓冲层**：数据写入 2MB 循环 blockfile，前端通过 WPS 事件推送接收。即使前端断开，数据也不丢失。
4. **推送而非拉取**：前端不 poll，而是订阅事件。数据产生时主动推送。

## 六、可行解决方案

### 方案 A：专用 Reader 线程（推荐，参照 WaveTerm）

为每个 PTY session 启动一个后台线程，持续从 PTY 读取数据并写入共享缓冲区。HTTP 处理函数从缓冲区非阻塞读取。

**改动范围：**
- `crates/sandbox-core/src/process/mod.rs`：`PtySession` 增加缓冲区，`spawn_cli` 启动 reader 线程
- `crates/sandbox-core/src/server/mod.rs`：`read_output` 从缓冲区读取
- 前端不需要改动

**优点：** 架构清晰，从根本上解决问题，参照 WaveTerm 已验证的模式
**缺点：** 每个 PTY session 多一个线程（轻量级，可接受）

### 方案 B：设置非阻塞 FD + poll/select

从 PTY master 提取 raw file descriptor，调用 `fcntl(F_SETFL, O_NONBLOCK)`，用 `poll()` 加短超时。

**优点：** 不需要额外线程
**缺点：** 需要 `libc::fcntl` + unsafe 代码，`portable_pty` 的 `MasterPty` 是 trait 对象不暴露 `RawFd`

### 方案 C：Tokio timeout 包装

给 `read()` 包一层 `tokio::time::timeout(Duration::from_millis(100), ...)`。

**优点：** 改动最小（约 5 行代码）
**缺点：** 每次空闲轮询仍浪费一个阻塞线程 100ms，不是真正的架构修复

## 七、建议

采用**方案 A（专用 Reader 线程）**，参照 WaveTerm 的 `shellcontroller.go:529-569` 的 reader goroutine 模式。这是最健壮的方案，且有成熟的参考实现。
