# Close Confirmation Dialogs — Design Spec

**Date**: 2026-06-01
**Branch**: `feat/close-confirmation-dialogs`

## Problem

Closing a tab or window in the Electron app does not warn about or clean up running sandboxes. Sandboxes continue running in the daemon after the window closes, creating orphan processes.

## Requirements

### Tab Close (clicking the × button on a tab)

- If the sandbox status is `Running` (PTY alive): show a confirmation dialog asking if the user wants to close the running terminal. Options: **Confirm** (close) / **Cancel** (abort).
- If the sandbox status is not `Running` or the tab is not found: close immediately, no dialog.

### Window Close (red traffic light / Cmd+Q)

- If no sandboxes are open: close the window immediately.
- If any sandboxes are open: show a 3-option dialog:
  - **Cancel** — abort the close, window stays open.
  - **Close Window Only** — close the macOS window, sandboxes keep running in the daemon. Reopening the app shows them again.
  - **Close All Terminals** — send `DELETE /sandbox/{id}` for each sandbox, then close the window.

## Architecture

### Tab Close Flow (renderer-only)

1. User clicks × on a tab.
2. `handleCloseTab` checks `tab.sandbox.status.type`.
3. If `Running` → set dialog state (`closeConfirmTabId`), render `CloseConfirmDialog`.
4. If not `Running` → proceed with existing close logic (DELETE + remove from state).
5. Dialog Confirm → proceed with close. Dialog Cancel → do nothing.

### Window Close Flow (main ↔ renderer IPC)

1. User clicks red traffic light or presses Cmd+Q.
2. Main process `mainWindow.on('close')` handler calls `e.preventDefault()`.
3. Main sends `window-closing` IPC event to renderer with the list of sandbox IDs.
4. Renderer shows `WindowCloseDialog` with the 3 options.
5. User picks an option. Renderer sends `window-close-response` IPC with the choice.
6. Main process acts:
   - `cancel` → do nothing, window stays open.
   - `close-window-only` → remove `close` listener temporarily, call `mainWindow.close()`.
   - `close-all` → renderer sends DELETE for each sandbox, then sends IPC. Main removes listener and closes window.

### IPC Channels

| Channel | Direction | Payload |
|---------|-----------|---------|
| `window-closing` | main → renderer | `{ sandboxIds: string[] }` |
| `window-close-response` | renderer → main | `{ action: 'cancel' \| 'close-window-only' \| 'close-all' }` |

## Files to Change

| File | Change |
|------|--------|
| `electron-app/src/main/index.ts` | Add `close` event handler, `window-closing` / `window-close-response` IPC handlers |
| `electron-app/src/preload/index.ts` | Expose `onWindowClosing(cb)` and `sendCloseResponse(action)` |
| `electron-app/src/renderer/main.tsx` | Add `CloseConfirmDialog` component, `WindowCloseDialog` component, modify `handleCloseTab`, add `onWindowClosing` listener |
| `electron-app/src/renderer/styles.css` | Add dialog styles for confirm dialog (danger variant for close-all button) |

## UI Design

### CloseConfirmDialog (tab close)

Simple confirmation with title, message, and two buttons. Uses existing `.dialog` styles.

### WindowCloseDialog (window close)

Three buttons: Cancel (default), Close Window Only (secondary), Close All Terminals (danger/red). Shows count of running sandboxes.

## No Backend Changes

The existing daemon `DELETE /sandbox/{id}` endpoint handles cleanup (kills PTY, unregisters instance). No Rust changes needed.
