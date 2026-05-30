import { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import SandboxTerminal from "./components/Terminal";
import { getSandboxId, getKind, getTitle, fetchSandboxInfo } from "./api";

declare global {
  interface Window {
    sandbox: {
      getDaemonPort: () => Promise<number>;
      createTab: (sandboxId: string, kind: string, title: string) => Promise<void>;
      switchTab: (sandboxId: string) => Promise<void>;
      closeTab: (sandboxId: string) => Promise<void>;
      listTabs: () => Promise<{ id: string; kind: string; title: string }[]>;
    };
  }
}

function App() {
  const sandboxId = getSandboxId();
  const kind = getKind();
  const title = getTitle();
  const [ptyPid, setPtyPid] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sandboxId) {
      setError("No sandbox_id provided");
      return;
    }

    fetchSandboxInfo()
      .then((info) => {
        if (info?.pty_pid) {
          setPtyPid(info.pty_pid);
        } else {
          setError("Sandbox has no PTY process");
        }
      })
      .catch((err) => {
        setError(`Failed to fetch sandbox info: ${err}`);
      });
  }, [sandboxId]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center text-red-400">
        <p>{error}</p>
      </div>
    );
  }

  if (!ptyPid) {
    return (
      <div className="flex h-screen items-center justify-center text-neutral-400">
        <p>Connecting to sandbox...</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <SandboxTerminal ptyPid={ptyPid} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
