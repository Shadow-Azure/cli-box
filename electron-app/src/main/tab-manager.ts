import { BrowserWindow, WebContentsView } from "electron";
import { join } from "path";

export interface SandboxTab {
  id: string;
  kind: "cli" | "app";
  title: string;
  webContentsView: WebContentsView;
}

const tabs: Map<string, SandboxTab> = new Map();
let activeTabId: string | null = null;
let mainWindow: BrowserWindow | null = null;

const TAB_BAR_HEIGHT = 36;
const TITLE_BAR_HEIGHT = 28;

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win;
}

export function createTab(
  sandboxId: string,
  kind: "cli" | "app",
  title: string,
  daemonPort: number,
): SandboxTab {
  if (!mainWindow) throw new Error("No main window");

  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load renderer page with sandbox params
  const baseUrl = process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : `file://${join(__dirname, "../renderer/index.html")}`;

  const url = new URL(baseUrl);
  url.searchParams.set("sandbox_id", sandboxId);
  url.searchParams.set("kind", kind);
  url.searchParams.set("title", title);
  url.searchParams.set("daemon_port", daemonPort.toString());
  view.webContents.loadURL(url.toString());

  const tab: SandboxTab = {
    id: sandboxId,
    kind,
    title,
    webContentsView: view,
  };

  tabs.set(sandboxId, tab);

  // If first tab, activate immediately; otherwise position off-screen
  if (tabs.size === 1) {
    switchToTab(sandboxId);
  } else {
    positionViewOffScreen(view);
  }

  mainWindow.contentView.addChildView(view);
  return tab;
}

export function switchToTab(targetId: string) {
  if (!mainWindow) return;
  const target = tabs.get(targetId);
  if (!target) return;

  const { width, height } = mainWindow.getContentBounds();
  const topOffset = TAB_BAR_HEIGHT + TITLE_BAR_HEIGHT;

  // Move all tabs off-screen except target
  for (const [id, tab] of tabs) {
    if (id === targetId) {
      tab.webContentsView.setBounds({
        x: 0,
        y: topOffset,
        width,
        height: height - topOffset,
      });
    } else {
      positionViewOffScreen(tab.webContentsView);
    }
  }

  activeTabId = targetId;
}

export function closeTab(sandboxId: string) {
  const tab = tabs.get(sandboxId);
  if (!tab) return;

  mainWindow?.contentView.removeChildView(tab.webContentsView);
  tab.webContentsView.webContents.close();
  tabs.delete(sandboxId);

  // If closed active tab, switch to another
  if (activeTabId === sandboxId) {
    const remaining = Array.from(tabs.keys());
    if (remaining.length > 0) {
      switchToTab(remaining[0]);
    } else {
      activeTabId = null;
    }
  }
}

export function getActiveTabId(): string | null {
  return activeTabId;
}

export function getAllTabs(): SandboxTab[] {
  return Array.from(tabs.values());
}

function positionViewOffScreen(view: WebContentsView) {
  view.setBounds({ x: -15000, y: -15000, width: 1200, height: 800 });
}
