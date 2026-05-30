/**
 * Daemon API client for Electron renderer.
 * Port comes from URL param (set by tab-manager when creating the WebContentsView).
 */

function getDaemonPort(): number {
  const params = new URLSearchParams(window.location.search);
  const p = params.get("daemon_port");
  return p ? Number(p) : 15801;
}

function getSandboxId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("sandbox_id") || "";
}

function getKind(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("kind") || "cli";
}

function getTitle(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("title") || "";
}

const PORT = getDaemonPort();
const BASE = `http://127.0.0.1:${PORT}`;
export { PORT, getSandboxId, getKind, getTitle };

export interface PtyConnection {
  onOutput: (cb: (data: string | Uint8Array) => void) => () => void;
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

export function connectPty(ptyPid: number): PtyConnection {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sandbox/${getSandboxId()}/pty/ws/${ptyPid}`);
  ws.binaryType = "arraybuffer";
  const outputListeners: ((data: string | Uint8Array) => void)[] = [];

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      for (const cb of outputListeners) cb(new Uint8Array(e.data));
    } else if (typeof e.data === "string") {
      for (const cb of outputListeners) cb(e.data);
    }
  };

  return {
    onOutput(cb) {
      outputListeners.push(cb);
      return () => {
        const idx = outputListeners.indexOf(cb);
        if (idx >= 0) outputListeners.splice(idx, 1);
      };
    },
    sendInput(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    resize(cols, rows) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    },
    close() {
      ws.close();
    },
  };
}

export async function fetchSandboxInfo(): Promise<{
  id: string;
  kind: { type: string; detail: { command: string; args: string[] } };
  status: { type: string };
  pty_pid: number | null;
}> {
  const res = await fetch(`${BASE}/sandbox/list`);
  const list = await res.json();
  return list.find((sb: { id: string }) => sb.id === getSandboxId());
}
