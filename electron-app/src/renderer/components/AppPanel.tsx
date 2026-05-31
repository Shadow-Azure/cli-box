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
      setScreenshotUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch (e) {
      console.error("Screenshot failed:", e);
    } finally {
      setLoading(false);
    }
  }, [sandboxId]);

  useEffect(() => {
    refreshScreenshot();
    const interval = setInterval(refreshScreenshot, 5000);
    return () => {
      clearInterval(interval);
    };
  }, [sandboxId, refreshScreenshot]);

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
