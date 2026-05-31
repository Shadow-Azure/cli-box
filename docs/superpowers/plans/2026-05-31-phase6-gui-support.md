# Phase 6: GUI App Support & Frontend Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support macOS GUI app sandboxes (launch .app, screenshot preview, control panel) and add a "New Sandbox" dialog in the Electron UI.

**Architecture:** APP mode sandboxes launch a macOS .app via `NSWorkspace`. The Electron tab shows a screenshot preview (refreshed on demand) instead of xterm.js. A "New Sandbox" dialog lets users create CLI or APP sandboxes from the UI.

**Tech Stack:** TypeScript, React, Electron IPC

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `electron-app/src/renderer/api.ts` | Modify | Add `createSandbox()`, `takeScreenshot()`, `closeSandbox()` |
| `electron-app/src/renderer/main.tsx` | Modify | Add New Sandbox dialog, APP mode tab rendering |
| `electron-app/src/renderer/components/AppPanel.tsx` | Create | Screenshot preview + controls for APP sandboxes |
| `electron-app/src/renderer/styles.css` | Modify | Dialog + app panel styles |

---

### Task 1: Extend renderer API

**Files:**
- Modify: `electron-app/src/renderer/api.ts`

- [ ] **Step 1: Add createSandbox function**

Add after `fetchSandboxInfo`:

```typescript
export async function createSandbox(mode: "cli" | "app", command: string, args: string[] = []): Promise<{ id: string; pty_pid: number | null }> {
  const res = await fetch(`${getBaseUrl()}/sandbox/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, command, args }),
  });
  if (!res.ok) throw new Error(`Create failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Add takeScreenshot function**

```typescript
export async function takeScreenshot(sandboxId: string): Promise<Blob> {
  const res = await fetch(`${getBaseUrl()}/sandbox/${sandboxId}/screenshot`);
  if (!res.ok) throw new Error(`Screenshot failed: ${res.status}`);
  return res.blob();
}
```

- [ ] **Step 3: Add closeSandbox function**

```typescript
export async function closeSandbox(sandboxId: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/sandbox/${sandboxId}/close`, { method: "POST" });
  if (!res.ok) throw new Error(`Close failed: ${res.status}`);
}
```

- [ ] **Step 4: Verify TypeScript compilation**

Run: `cd electron-app && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/renderer/api.ts
git commit -m "feat(renderer): add createSandbox, takeScreenshot, closeSandbox API"
```

---

### Task 2: AppPanel component for APP mode sandboxes

**Files:**
- Create: `electron-app/src/renderer/components/AppPanel.tsx`

- [ ] **Step 1: Create AppPanel component**

```tsx
import { useState, useEffect, useCallback } from "react";
import { takeScreenshot } from "../api";

interface AppPanelProps {
  sandboxId: string;
}

export default function AppPanel({ sandboxId }: AppPanelProps) {
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshScreenshot = useCallback(async () => {
    setLoading(true);
    try {
      const blob = await takeScreenshot(sandboxId);
      const url = URL.createObjectURL(blob);
      if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
      setScreenshotUrl(url);
    } catch (e) {
      console.error("Screenshot failed:", e);
    } finally {
      setLoading(false);
    }
  }, [sandboxId, screenshotUrl]);

  useEffect(() => {
    refreshScreenshot();
    const interval = setInterval(refreshScreenshot, 5000);
    return () => {
      clearInterval(interval);
      if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
    };
  }, [sandboxId]);

  return (
    <div className="app-panel">
      {screenshotUrl ? (
        <img src={screenshotUrl} alt="App screenshot" className="app-screenshot" />
      ) : (
        <div className="app-placeholder">
          {loading ? "Loading screenshot..." : "No screenshot available"}
        </div>
      )}
      <div className="app-controls">
        <button onClick={refreshScreenshot} disabled={loading}>
          {loading ? "Capturing..." : "Refresh"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd electron-app && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add electron-app/src/renderer/components/AppPanel.tsx
git commit -m "feat(renderer): add AppPanel component for APP mode sandboxes"
```

---

### Task 3: New Sandbox dialog

**Files:**
- Modify: `electron-app/src/renderer/main.tsx`
- Modify: `electron-app/src/renderer/styles.css`

- [ ] **Step 1: Add dialog state to App component**

Add inside the `App` function:

```typescript
const [showNewDialog, setShowNewDialog] = useState(false);
const [newSandboxCmd, setNewSandboxCmd] = useState("");
const [newSandboxMode, setNewSandboxMode] = useState<"cli" | "app">("cli");
```

- [ ] **Step 2: Add dialog JSX**

Add before the closing `</div>` of `.main-content`:

```tsx
{showNewDialog && (
  <div className="dialog-overlay" onClick={() => setShowNewDialog(false)}>
    <div className="dialog" onClick={(e) => e.stopPropagation()}>
      <div className="dialog-title">New Sandbox</div>
      <div className="dialog-field">
        <label>Mode:</label>
        <select value={newSandboxMode} onChange={(e) => setNewSandboxMode(e.target.value as "cli" | "app")}>
          <option value="cli">CLI</option>
          <option value="app">App</option>
        </select>
      </div>
      <div className="dialog-field">
        <label>{newSandboxMode === "cli" ? "Command:" : "App path:"}</label>
        <input
          type="text"
          value={newSandboxCmd}
          onChange={(e) => setNewSandboxCmd(e.target.value)}
          placeholder={newSandboxMode === "cli" ? "zsh" : "/Applications/TextEdit.app"}
          autoFocus
        />
      </div>
      <div className="dialog-actions">
        <button onClick={() => setShowNewDialog(false)}>Cancel</button>
        <button
          className="primary"
          onClick={async () => {
            if (!newSandboxCmd.trim()) return;
            try {
              await createSandbox(newSandboxMode, newSandboxCmd);
              setShowNewDialog(false);
              setNewSandboxCmd("");
              refreshSandboxes();
            } catch (e) {
              console.error("Failed to create sandbox:", e);
            }
          }}
        >
          Create
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 3: Wire the "+" button**

Replace the existing `onClick` on the `+` button (around line 170):

```tsx
<button className="tab-add" onClick={() => setShowNewDialog(true)} title="New sandbox">+</button>
```

- [ ] **Step 4: Add import for createSandbox**

Add to imports at top of `main.tsx`:

```typescript
import { SandboxInfo, fetchSandboxList, setDaemonPort, getDaemonPort, createSandbox } from "./api";
```

- [ ] **Step 5: Add dialog styles**

Add to `electron-app/src/renderer/styles.css`:

```css
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.dialog {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 24px;
  min-width: 360px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.dialog-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
}

.dialog-field {
  margin-bottom: 12px;
}

.dialog-field label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.dialog-field input,
.dialog-field select {
  width: 100%;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.dialog-actions button {
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
}

.dialog-actions button.primary {
  background: var(--accent-color);
  color: white;
  border-color: var(--accent-color);
}
```

- [ ] **Step 6: Add AppPanel to tab rendering**

Import `AppPanel` and use it for APP mode tabs. Replace the terminal area section in `main.tsx`:

```tsx
import AppPanel from "./components/AppPanel";

// In the terminal area section:
{activeTab ? (
  activeTab.kind === "app" ? (
    <div className="terminal-container">
      <AppPanel sandboxId={activeTab.id} />
    </div>
  ) : (
    <div className="terminal-container">
      <SandboxTerminal key={activeTab.id} sandboxId={activeTab.id} ptyPid={activeTab.sandbox.pty_pid!} />
    </div>
  )
) : (
  <div className="empty-state">...</div>
)}
```

- [ ] **Step 7: Add app panel styles**

```css
.app-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-secondary);
}

.app-screenshot {
  flex: 1;
  object-fit: contain;
  padding: 8px;
}

.app-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 14px;
}

.app-controls {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
  display: flex;
  gap: 8px;
}

.app-controls button {
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}
```

- [ ] **Step 8: Verify TypeScript compilation**

Run: `cd electron-app && pnpm typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add electron-app/src/renderer/main.tsx electron-app/src/renderer/styles.css electron-app/src/renderer/components/AppPanel.tsx
git commit -m "feat(renderer): new sandbox dialog + APP mode panel"
```

---

### Task 4: Window ID reporting from Electron

**Files:**
- Modify: `electron-app/src/renderer/api.ts`

- [ ] **Step 1: Add setWindowId function**

```typescript
export async function setWindowId(sandboxId: string, windowId: number): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/sandbox/${sandboxId}/window`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ window_id: windowId }),
  });
  if (!res.ok) throw new Error(`Set window_id failed: ${res.status}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add electron-app/src/renderer/api.ts
git commit -m "feat(renderer): add setWindowId API call"
```
