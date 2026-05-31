/**
 * Daemon API client for Electron renderer.
 * Connects to sandbox-daemon HTTP/WebSocket API.
 */

let _port = 15801;

export function getDaemonPort(): number {
  return _port;
}

export function setDaemonPort(port: number) {
  _port = port;
}

export function getBaseUrl(): string {
  return `http://127.0.0.1:${_port}`;
}

export interface SandboxInfo {
  id: string;
  kind: { type: string; detail: { command: string; args: string[] } };
  status: { type: string };
  pty_pid: number | null;
  port: number;
}

export async function fetchSandboxList(): Promise<SandboxInfo[]> {
  const res = await fetch(`${getBaseUrl()}/sandbox/list`);
  return res.json();
}

export async function fetchSandboxInfo(id: string): Promise<SandboxInfo | undefined> {
  const list = await fetchSandboxList();
  return list.find((sb) => sb.id === id);
}

export function connectPty(sandboxId: string, ptyPid: number): PtyConnection {
  const ws = new WebSocket(`ws://127.0.0.1:${_port}/sandbox/${sandboxId}/pty/ws/${ptyPid}`);
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

export interface PtyConnection {
  onOutput: (cb: (data: string | Uint8Array) => void) => () => void;
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}
