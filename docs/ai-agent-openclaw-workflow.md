---
title: AI Agent + OpenClaw + 飞书实战工作流
---

# AI Agent + OpenClaw + 飞书实战工作流

> 2026-06-22 | 适用 OpenClaw + cli-box + 飞书 DM 环境

## 一、整体架构

```
用户（飞书）
    ↓ 消息
OpenClaw（飞书 DM channel）
    ↓ 调度
Agent（main / isolated / cron）
    ↓ 调用
cli-box（沙盒，macOS Electron tab）
    ↓ 运行
Claude Code / OpenCode（自动化任务）
    ↓ 截图/状态
脚本（notify-with-screenshot.sh → 飞书 API）
```

**核心机制**：
- **cli-box**：在 macOS Electron tab 里跑独立沙盒（zsh / Claude Code / OpenCode 等）
- **OpenClaw**：AI Agent 运行时，接收飞书消息，调度 cron/subagent
- **飞书 DM**：用户与 Agent 的聊天界面（图片/文字）
- **飞书 API 脚本**：绕开 OpenClaw feishu plugin 的图片发送限制，直接调飞书 OpenAPI

## 二、飞书接入配置

### 2.1 飞书应用准备

1. 去 [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用
2. 获取 **App ID** 和 **App Secret**
3. 配置应用权限（至少需要）：
   - `im:message` — 发消息
   - `im:message:send_as_bot` — 发消息作为机器人
4. 发布应用

### 2.2 openclaw.json 配置

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxxxxxxxxxxxxx",
      "appSecret": "***",
      "connectionMode": "websocket",
      "streaming": true
    }
  }
}
```

## 三、飞书发图：绕开 MEDIA: 失败问题

### 3.1 问题现象

OpenClaw 的 `MEDIA:<path>` 指令在飞书 DM channel 下**静默失败**——图片根本不到用户手里，只有文本。

### 3.2 绕开方案：直接调飞书 OpenAPI

用两个脚本绕开 OpenClaw feishu plugin：

**三步调用飞书 OpenAPI**：
1. `POST /open-apis/auth/v3/tenant_access_token/internal` → 获取 tenant token
2. `POST /open-apis/im/v1/images` → 上传图片拿 image_key
3. `POST /open-apis/im/v1/messages?receive_id_type=open_id` → 发 image 消息

### 3.3 完整使用步骤

**第一步：创建脚本文件**

`~/.openclaw/workspace/scripts/send-feishu-image.js`：
```javascript
// 完整脚本：https://github.com/Shadow-Azure/cli-box/blob/main/scripts/send-feishu-image.js
// 核心：fetchTenantToken → uploadImage → sendImageMessage
```

`~/.openclaw/workspace/scripts/notify-with-screenshot.sh`：
```bash
#!/usr/bin/env bash
# 从 openclaw.json 读飞书 credentials，调 send-feishu-image.js 发图
# 从 openclaw.json 读取 appId/appSecret 和默认 open_id
```

**第二步：发图**

```bash
# 方式 A（推荐）：wrapper 自动读 openclaw.json
~/.openclaw/workspace/scripts/notify-with-screenshot.sh /tmp/openclaw/cli-box-shots/shot.png

# 方式 B：直接调 JS，手动给 env
FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx FEISHU_DEFAULT_OPEN_ID=ou_xxx \
  node ~/.openclaw/workspace/scripts/send-feishu-image.js --image /path/to/shot.png
```

### 3.4 图片限制

| 项目 | 限制 |
|------|------|
| 文件大小 | ≤ 10MB |
| 尺寸 | ≤ 12000×12000px |
| 推荐尺寸 | 1200px 以内最佳 |

## 四、cli-box 工作流（OpenClaw Agent 场景）

### 4.1 安装 cli-box

```bash
# 非交互安装
npx cli-box-skill install all   # Claude Code + OpenCode + OpenClaw

# 或只装指定 harness
npx cli-box-skill install claude   # Claude Code
npx cli-box-skill install opencode # OpenCode
```

### 4.2 启动沙盒

```bash
cli-box start claude    # Claude Code 沙盒
cli-box start opencode  # OpenCode 沙盒
cli-box start zsh       # 纯 zsh 沙盒
```

返回：`Sandbox started: <id>`

### 4.3 查看活跃沙盒（永远不硬编码 ID）

```bash
SID=$(cli-box list | sed -n '3p' | awk '{print $1}')
```

### 4.4 核心操作

**截图**（必须保存到 `/tmp/openclaw/` 才有效）：
```bash
TS=$(date +%s)
cli-box screenshot --id "$SID" -o /tmp/openclaw/cli-box-shots/${SID}-${TS}.png
```

**查看进展**（scrollback 是纯文本，比截图更可靠）：
```bash
cli-box scrollback --id "$SID" 2>&1 | tail -n 50
```

**输入文字**：
```bash
cli-box type --id "$SID" -- "你的指令"
cli-box key --id "$SID" Return   # 等 1-2 秒再按回车
```

**关闭沙盒**：
```bash
cli-box close "$SID"
```

### 4.5 OpenClaw Agent 标准 Cron 检查流程

```bash
#!/bin/bash
# 每次 cron 检查的固定姿势

export PATH="$HOME/.npm-global/bin:$PATH"
SID=$(cli-box list | sed -n '3p' | awk '{print $1}')
cli-box scrollback --id "$SID" 2>&1 | tail -n 50

# 判断：有 "Do you want" 授权弹框？
# 安全命令（grep/cargo/git 读/项目内写/cargo build）→ cli-box key --id "$SID" Return
# 危险命令（rm -rf / git push --force / curl|bash / sudo）→ NO_REPLY 报给用户

# 任务完成判断（无新 prompt / ❯ 提示符 / Claude 在等用户）
if [[ 完成标志 ]]; then
  TS=$(date +%s)
  cli-box screenshot --id "$SID" -o /tmp/openclaw/cli-box-shots/${SID}-${TS}.png
  ~/.openclaw/workspace/scripts/notify-with-screenshot.sh /tmp/openclaw/cli-box-shots/${SID}-${TS}.png
fi
```

## 五、常见坑与解决

### 坑 1：MEDIA: 行图片发不到用户

**现象**：`MEDIA:/path/to/shot.png` 用户收不到，只有文本
**原因**：路径不在 OpenClaw 白名单（`/tmp/openclaw/`）内，或者 feishu plugin DM 场景静默失败
**解决**：永远用 `notify-with-screenshot.sh`

### 坑 2：截图路径不在白名单

**现象**：MEDIA: 路径被拒绝，日志无报错
**白名单路径**：
```
/tmp/openclaw/
~/.openclaw/media/
~/.openclaw/workspace/
~/.openclaw/sandboxes/
```
**解决**：截图永远存到 `/tmp/openclaw/cli-box-shots/`

### 坑 3：cli-box screenshot --with-frame 不存在

**现象**：`--with-frame` flag 不支持
**解决**：直接用 `cli-box screenshot --id "$SID" -o path.png`

### 坑 4：git remote URL 用 SSH 但沙盒里没有 SSH key

**现象**：`git push` 提示 `Permission denied (publickey)`
**解决**：git remote 改为 HTTPS
```bash
git remote set-url origin https://github.com/Owner/repo.git
```

### 坑 5：沙盒里 git push 失败（PAT 缺 workflow scope）

**现象**：`git push` 报错 `missing workflow scope`
**解决**：在**主机终端**（非沙盒）执行：
```bash
gh auth refresh -s workflow --hostname github.com
# 浏览器弹出授权页，点 Authorize
```

### 坑 6：image 工具 vision model normalize bug

**现象**：用 OpenClaw `image` 工具调用 MiniMax vision model 失败
**原因**：OpenClaw 内部把小写改写，API 拒收
**解决**：别用 `image` 工具，改用 `cli-box screenshot` + `send-feishu-image.js`

### 坑 7：feishu lane 5min 硬上限

**现象**：飞书任务排队超 5min 后整个 lane 被 evict
**原因**：OpenClaw feishu channel 的 per-chat task hard cap
**解决**：
- cron 间隔设 5min
- 主 session 不跑 >5min 的任务（拆 subagent）

### 坑 8：cron isolated setup 60s timeout

**现象**：isolated cron 任务 setup 阶段超时
**原因**：model provider 没响应，没有配置 fallback
**解决**：payload 加 `fallbacks: ["minimax-new/MiniMax-M3-highspeed"]` + `timeoutSeconds: 120`

## 六、OpenClaw Agent 授权规则

### 6.1 自动批准

| 命令类型 | 示例 |
|---------|------|
| git 读操作 | `git log`, `git status`, `git diff` |
| git commit | `git add . && git commit -m "..."` |
| 项目内写 | `Write/Edit` 工具在 workspace 内操作 |
| cargo build/test | `cargo build`, `cargo test` |
| cli-box 操作 | `cli-box list/screenshot/scrollback` |

### 6.2 危险命令（必须上报）

| 命令 | 风险 |
|------|------|
| `rm -rf /` | 删除整个系统 |
| `git push --force` | 强制覆盖远程历史 |
| `curl\|bash` | 远程代码执行 |
| `sudo` | 提权操作 |
| `gh auth refresh` | 修改 gh 认证（需浏览器交互） |

## 七、相关文件索引

| 文件 | 路径 | 用途 |
|------|------|------|
| 飞书发图 JS | `~/.openclaw/workspace/scripts/send-feishu-image.js` | 调飞书 OpenAPI 发图片 |
| 截图通知 wrapper | `~/.openclaw/workspace/scripts/notify-with-screenshot.sh` | 读 openclaw.json 调发图脚本 |
| 飞书文本发送 | `~/.openclaw/workspace/scripts/send-feishu-text.js` | 调飞书 OpenAPI 发文本/markdown |
| OpenClaw 配置 | `~/.openclaw/openclaw.json` | 飞书 credentials + 模型配置 |
| cli-box skill | `~/.openclaw/skills/cli-box/SKILL.md` | cli-box 命令参考 |

## 八、快速上手清单

- [ ] 飞书自建应用创建，拿到 App ID + App Secret
- [ ] `openclaw.json` 里配置 `channels.feishu`
- [ ] `send-feishu-image.js` 和 `notify-with-screenshot.sh` 放到 `~/.openclaw/workspace/scripts/`
- [ ] `chmod +x` 两个脚本
- [ ] `npx cli-box-skill install all`
- [ ] 授权 macOS Accessibility + Screen Recording 权限
- [ ] `cli-box start claude` 测试沙盒
- [ ] `cli-box screenshot` 保存到 `/tmp/openclaw/` 确认可用
- [ ] `notify-with-screenshot.sh <path>` 测试发图到飞书

---

*文档版本：2026-06-22 | 作者：ice ❄️ | 适用版本：OpenClaw + cli-box 0.2.8+*
