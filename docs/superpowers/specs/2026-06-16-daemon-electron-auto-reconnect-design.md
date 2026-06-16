# Daemon-Electron Auto-Reconnect Design

> **Date**: 2026-06-16
> **Status**: Design (awaiting implementation plan)

## Problem

When the daemon restarts on a different port, the existing Electron process cannot discover the new daemon. This causes a 60s timeout on `cli-box start` and screenshot failures.

### Root Cause

The `getDaemonPort` IPC handler in `electron-app/src/main/index.ts` caches the daemon port:

```typescript
ipcMain.handle("get-daemon-port", () => {
  if (!daemonPort) {           // Only re-checks when cache is null
    daemonPort = findRunningDaemon();
  }
  return daemonPort;           // Returns cached value forever
});
```

Once `daemonPort` is set, the IPC never re-reads `daemon.json`. When the daemon restarts on a new port (e.g., 15801 → 15802), the old Electron keeps using the stale cached port.

### Why This Causes Timeouts

1. Old daemon on port 15801 is killed
2. Old Electron is still alive (holds single-instance lock)
3. CLI spawns new daemon on port 15802 (15801 unavailable)
4. CLI spawns new Electron → single-instance lock → new Electron quits immediately
5. Old Electron is disconnected but cached port 15801 (dead daemon)
6. Old Electron's `getDaemonPort` IPC returns cached 15801 → never discovers 15802
7. New daemon (15802) waits for renderer WebSocket → 60s timeout

### What Already Works

The existing code has reconnection infrastructure that is correct:

- **Daemon**: 10s ping interval detects dead renderer connections (`daemon/mod.rs:769`)
- **Renderer onclose handler**: Checks `getDaemonPort()` and reconnects with new port (`main.tsx:249-282`)
- **Renderer polling**: Re-arms when daemon is detected as down (`main.tsx:65-101`)

The only missing piece: the IPC cache prevents `getDaemonPort()` from returning the new port.

## Solution

### Change 1: Remove IPC Cache (Core Fix)

**File**: `electron-app/src/main/index.ts`

Make `getDaemonPort` IPC always call `findRunningDaemon()`:

```typescript
ipcMain.handle("get-daemon-port", () => {
  const existingPort = findRunningDaemon();  // Always re-reads daemon.json
  if (existingPort !== daemonPort) {
    daemonPort = existingPort;
    if (existingPort) writeElectronJson(existingPort);
  }
  return daemonPort;
});
```

This ensures that whenever the renderer calls `getDaemonPort()` (via polling or onclose handler), it gets the current port from `daemon.json`.

### Change 2: Simplify CLI Start Flow

**File**: `crates/cli-box-cli/src/main.rs`

With the IPC fix, the old Electron auto-reconnects to new daemon. The CLI no longer needs the band-aid functions (`cleanup_stale_electron_processes`, `probe_running_daemon`, complex retry loops).

Replace with a clean `ensure_healthy_daemon` + `ensure_healthy_electron` flow:

```
cmd_start_daemon(command, args):
  1. ensure_healthy_daemon() → port
     Read daemon.json → check PID alive + /health responds → reuse
     If unhealthy → kill by PID, spawn new, wait for daemon.json + /health

  2. create sandbox on daemon

  3. ensure_healthy_electron(port)
     Read electron.json → check PID alive + renderer_connected → reuse
     (Old Electron will auto-reconnect via onclose handler)
     If PID dead → spawn new Electron, wait for renderer_connected

  4. wait for terminal ready (CLI sandboxes only)
```

**Key difference**: If old Electron is alive but renderer not connected, do NOT kill it. Instead, just wait — the old Electron's onclose handler will detect the new daemon and reconnect. Only spawn new Electron if the old one is completely dead.

### Auto-Recovery Flow (No Code Change Needed)

With Change 1, the existing renderer code handles recovery:

```
Old daemon dies
  ↓ (within 10s, ping timeout)
Old Electron WebSocket onclose fires
  ↓
onclose: getDaemonPort() → IPC re-reads daemon.json
  ↓
┌─ New daemon already started → returns new port → reconnect succeeds
│
└─ New daemon not yet started → returns null
   → setConnected(false) → polling re-arms
   → new daemon starts → polling finds new port → reconnect succeeds
```

## Components

### 1. Electron Main Process (`index.ts`)

- `getDaemonPort` IPC: always re-read daemon.json (remove cache)
- No other changes

### 2. Electron Renderer (`main.tsx`)

- No changes needed. Existing onclose handler + polling logic already handles port changes.
- The only reason it didn't work before was the IPC cache.

### 3. CLI (`main.rs`)

- `ensure_healthy_daemon()`: Check daemon.json PID + /health. Kill stale, spawn new if needed.
- `ensure_healthy_electron(port)`: Check electron.json PID + renderer_connected. Spawn new only if PID dead.
- Remove: `cleanup_stale_electron_processes`, `probe_running_daemon`, `kill_stale_electron` retry loop, `find_running_electron` skip-spawn logic.

## Data Flow

```
daemon.json: { port, pid, started_at }    ← written by daemon after bind
electron.json: { pid, port }              ← written by Electron main process

CLI reads daemon.json → checks pid alive → checks /health
CLI reads electron.json → checks pid alive → checks /readyz (renderer_connected)
```

Both JSON files already contain `pid`. The key insight: use PID + health check to determine process health, and let the renderer auto-reconnect via the IPC fix.

## Error Handling

- **daemon.json missing**: daemon not started → CLI spawns new daemon
- **daemon.json stale (PID dead)**: CLI deletes daemon.json, spawns new daemon
- **daemon.json PID alive but /health fails**: daemon hung → CLI kills by PID, respawns
- **electron.json missing**: Electron not started → CLI spawns new Electron
- **electron.json PID dead**: CLI spawns new Electron
- **electron.json PID alive, renderer not connected**: CLI waits (auto-reconnect in progress)

## Testing

1. **Normal start**: Fresh environment → daemon + Electron start → renderer connects → screenshot works
2. **Daemon restart (same port)**: Kill daemon, start new → Electron auto-reconnects → screenshot works
3. **Daemon restart (different port)**: Kill daemon + daemon.json, start new on different port → Electron auto-reconnects via IPC fix → screenshot works
4. **Old Electron + new daemon**: Old Electron alive, new daemon on new port → onclose handler detects new port → reconnects → no timeout
5. **All processes dead**: Clean restart → everything spawns fresh → works
